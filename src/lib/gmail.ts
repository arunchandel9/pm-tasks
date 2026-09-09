import { google, type gmail_v1 } from "googleapis";
import { resolveClientFromText, stripClientPrefix } from "./resolve";
import { emailNoise, stripQuotedHistory } from "./filter/noise";
import { noise as noiseConfig } from "./config";
import { allClients, sql } from "./db";
import { processMessage } from "./pipeline";
import { postAck, humanOutcome } from "./review";
import type { Message } from "./types";

/**
 * Email intake: one mailbox (intake@mangoeyesagency.com), read every minute through the service account with
 * domain-wide delegation. Clients' emails and ad-platform alerts are forwarded there; forwarded WhatsApp emails too.
 * Each unseen mail is turned into a Message on channel "email" and run through the same pipeline as Slack and Chat.
 * Processed mails get the Gmail label "Task Hub" so the same mail is never read twice, and the DB dedupes by id anyway.
 */

const LABEL = "Task Hub";
export const gmailConfigured = () => !!process.env.GOOGLE_SERVICE_ACCOUNT_B64 && !!process.env.GMAIL_MAILBOX;
/** The Google Workspace user the hub reads as. An alias is not a user: set the real mailbox that owns the alias. */
export const mailbox = () => (process.env.GMAIL_MAILBOX ?? "").trim().toLowerCase();
/** The address mails are sent to (the alias), used to filter the inbox. Defaults to the mailbox. */
export const intakeAddress = () => (process.env.GMAIL_INTAKE_ADDRESS ?? process.env.GMAIL_MAILBOX ?? "").trim().toLowerCase();

let _gmail: gmail_v1.Gmail | null = null;
export function gmail(): gmail_v1.Gmail {
  if (_gmail) return _gmail;
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_B64;
  if (!b64 || !mailbox()) throw new Error("GMAIL_NOT_CONFIGURED");
  const creds = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as { client_email: string; private_key: string };
  const auth = new google.auth.JWT({
    email: creds.client_email, key: creds.private_key, subject: mailbox(),
    scopes: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.modify"],
  });
  _gmail = google.gmail({ version: "v1", auth });
  return _gmail;
}

// ---- parsing ----

const b64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

function header(msg: gmail_v1.Schema$Message, name: string): string {
  return msg.payload?.headers?.find((h) => (h.name ?? "").toLowerCase() === name.toLowerCase())?.value ?? "";
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Prefer text/plain; fall back to text/html stripped. Walks nested multiparts. */
export function bodyText(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return "";
  let plain = "", html = "";
  const walk = (p: gmail_v1.Schema$MessagePart) => {
    const mime = (p.mimeType ?? "").toLowerCase();
    if (p.body?.data) {
      if (mime === "text/plain" && !plain) plain = b64url(p.body.data);
      else if (mime === "text/html" && !html) html = b64url(p.body.data);
    }
    for (const c of p.parts ?? []) walk(c);
  };
  walk(payload);
  return (plain || htmlToText(html)).replace(/\r\n/g, "\n");
}

export interface ParsedMail {
  id: string; threadId: string; subject: string; from: string; fromEmail: string; to: string; date: Date;
  isForward: boolean; originalFrom: string | null; originalFromEmail: string | null; note: string; body: string; headers: Record<string, string>;
}

const emailOf = (s: string) => (s.match(/<([^>]+)>/)?.[1] ?? s).trim().toLowerCase();

/**
 * A forwarded mail is read from the inside out: the forwarder's note above the marker, then the original sender
 * and body below it. Anything quoted deeper than that (earlier replies) is dropped.
 */
export function parseMail(raw: gmail_v1.Schema$Message): ParsedMail {
  const subject = header(raw, "Subject");
  const from = header(raw, "From");
  const text = bodyText(raw.payload);
  const headers: Record<string, string> = {};
  for (const h of raw.payload?.headers ?? []) if (h.name && h.value) headers[h.name] = h.value;
  const marker = text.search(/^-{2,}\s*(Forwarded message|Original message)\s*-{2,}\s*$/im);
  const isForward = /^\s*(fwd?|fw)\s*:/i.test(subject) || marker >= 0;
  let note = "", body = text, originalFrom: string | null = null;
  if (marker >= 0) {
    note = text.slice(0, marker).trim();
    const block = text.slice(marker).split("\n").slice(1); // drop the marker line
    // Header lines of the forwarded block: From / Date / Subject / To / Cc, then a blank line, then the body.
    let i = 0;
    for (; i < block.length; i++) {
      const l = block[i].trim();
      if (!l) { if (i > 0) { i++; break; } continue; }
      const m = l.match(/^(From|Date|Subject|To|Cc|Sent)\s*:\s*(.*)$/i);
      if (!m) break;
      if (m[1].toLowerCase() === "from") originalFrom = m[2].trim();
    }
    body = block.slice(i).join("\n");
  }
  body = stripQuotedHistory(body).trim();
  note = stripQuotedHistory(note).trim();
  return {
    id: raw.id ?? "", threadId: raw.threadId ?? "", subject, from, fromEmail: emailOf(from), to: header(raw, "To"),
    date: raw.internalDate ? new Date(Number(raw.internalDate)) : new Date(),
    isForward, originalFrom, originalFromEmail: originalFrom ? emailOf(originalFrom) : null, note, body, headers,
  };
}

// ---- reading the mailbox ----

async function labelId(): Promise<string> {
  const g = gmail();
  const list = await g.users.labels.list({ userId: "me" });
  const hit = list.data.labels?.find((l) => (l.name ?? "").toLowerCase() === LABEL.toLowerCase());
  if (hit?.id) return hit.id;
  const created = await g.users.labels.create({ userId: "me", requestBody: { name: LABEL, labelListVisibility: "labelShow", messageListVisibility: "show" } });
  return created.data.id!;
}

/** Unread-by-the-hub mails to the intake address, newest 20, oldest first. */
export async function fetchNewMails(): Promise<gmail_v1.Schema$Message[]> {
  const g = gmail();
  const addr = intakeAddress();
  const q = `${addr ? `to:${addr} ` : ""}-label:"${LABEL}" newer_than:3d -in:spam -in:trash`;
  const list = await g.users.messages.list({ userId: "me", q, maxResults: 20 });
  const ids = (list.data.messages ?? []).map((m) => m.id!).reverse();
  const out: gmail_v1.Schema$Message[] = [];
  for (const id of ids) out.push((await g.users.messages.get({ userId: "me", id, format: "full" })).data);
  return out;
}

export async function markProcessed(id: string): Promise<void> {
  await gmail().users.messages.modify({ userId: "me", id, requestBody: { addLabelIds: [await labelId()] } });
}

const staffDomains = () => (process.env.STAFF_EMAIL_DOMAINS ?? "mangoeyesagency.com").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
const isStaffEmail = (e: string) => staffDomains().some((d) => e.endsWith("@" + d));

/** Turn one mail into a hub Message and run it. Returns a short outcome for the poll report. */
export async function ingestMail(raw: gmail_v1.Schema$Message): Promise<string> {
  const mail = parseMail(raw);
  const clients = await allClients();
  // Who really wrote it: the original sender of a forward, else the From.
  const senderEmail = mail.originalFromEmail ?? mail.fromEmail;
  const senderName = (mail.originalFrom ?? mail.from).replace(/<[^>]+>/, "").replace(/"/g, "").trim() || senderEmail;
  const senderIsStaff = isStaffEmail(senderEmail);
  const subjectClean = mail.subject.replace(/^\s*((fwd?|fw|re)\s*:\s*)+/i, "").trim();
  const composed = [subjectClean ? `Subject: ${subjectClean}` : "", mail.note, mail.body].filter(Boolean).join("\n\n").trim();

  const verdict = emailNoise({ from: senderEmail, fromIsStaff: senderIsStaff, isForward: mail.isForward, headers: mail.headers, text: composed }, noiseConfig());

  // Client: the subject/note ("HOH: ...", "[PSS]"), the original sender's domain, then the forwarder's note text.
  const hit = resolveClientFromText(`${subjectClean}\n${mail.note}`, clients)
    ?? resolveClientFromText(senderEmail, clients)
    ?? resolveClientFromText(composed.slice(0, 400), clients);
  const m: Message = {
    channel: "email", externalId: mail.id, teamId: null, clientId: hit?.client.id ?? null, scope: hit ? hit.client.scope : "unknown",
    sender: `${senderName} <${senderEmail}>`, senderIsStaff, sentAt: mail.date,
    text: hit ? stripClientPrefix(composed, hit.client) : composed,
    permalink: `https://mail.google.com/mail/u/0/#all/${mail.id}`, threadRef: mail.threadId,
    raw: { gmail: { id: mail.id, threadId: mail.threadId, subject: mail.subject, from: mail.from, to: mail.to, isForward: mail.isForward, originalFrom: mail.originalFrom } },
  };
  const result = await processMessage(m, verdict);
  const n = result.requestIds?.length ?? 0;
  if (!(result.outcome === "review" && n) && !(result.outcome === "skipped" && verdict.skip)) {
    await postAck({ message: { ...m, text: subjectClean || m.text }, outcome: result.outcome, detail: humanOutcome(result.outcome, result.reason) });
  }
  return `${subjectClean.slice(0, 40)} → ${result.outcome}${result.reason ? ` (${result.reason})` : ""}`;
}

/** One poll: read new mails, process each, label it. Errors are per mail so one bad mail never blocks the rest. */
export async function pollMailbox(): Promise<{ read: number; outcomes: string[]; errors: string[] }> {
  const outcomes: string[] = [], errors: string[] = [];
  let mails: gmail_v1.Schema$Message[] = [];
  try { mails = await fetchNewMails(); } catch (e) { return { read: 0, outcomes, errors: [(e as Error).message.slice(0, 200)] }; }
  for (const raw of mails) {
    try {
      outcomes.push(await ingestMail(raw));
    } catch (e) { errors.push(`${header(raw, "Subject").slice(0, 40)}: ${(e as Error).message.slice(0, 160)}`); }
    try { await markProcessed(raw.id!); } catch (e) { errors.push(`label ${raw.id}: ${(e as Error).message.slice(0, 120)}`); }
  }
  const report = { read: mails.length, outcomes, errors };
  try {
    await sql()`insert into settings (key, value) values ('gmail_poll_last', ${JSON.stringify({ at: new Date().toISOString(), ...report })}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`;
  } catch { /* ignore */ }
  return report;
}
