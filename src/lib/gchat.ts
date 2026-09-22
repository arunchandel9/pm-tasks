import { google, type chat_v1 } from "googleapis";
import { OAuth2Client } from "google-auth-library";

/**
 * Google Chat: the team-facing side of the hub. Two spaces: PM Review (drafts, acks, alerts, summary)
 * and Intake (paste WhatsApp text, drop voice notes, /task form). One service account, same as Sheets.
 */

function credentials() {
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_B64;
  if (!b64) throw new Error("GOOGLE_NOT_CONFIGURED");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

let _chat: chat_v1.Chat | null = null;
export function chat(): chat_v1.Chat {
  if (!_chat) {
    const auth = new google.auth.GoogleAuth({ credentials: credentials(), scopes: ["https://www.googleapis.com/auth/chat.bot"] });
    _chat = google.chat({ version: "v1", auth });
  }
  return _chat;
}

/** Where Google Chat calls us. In add-on style apps a button's `function` must be this URL, with the handler name as ?fn=. */
export const endpointUrl = () => (process.env.GCHAT_ENDPOINT_URL || "https://pm-tasks.vercel.app/api/gchat").replace(/\/$/, "");
export const fnRef = (name: string) => `${endpointUrl()}?fn=${encodeURIComponent(name)}`;
/** Recover the handler name from an invokedFunction that may be a bare name or our URL form. */
export function fnName(invoked: string | null | undefined): string {
  if (!invoked) return "";
  const m = invoked.match(/[?&]fn=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : invoked;
}

/**
 * The hub reading Chat as a person (domain-wide delegation, same service account and user as the mailbox): needed to
 * read a space without being mentioned. Scope to authorise in the Admin console: chat.messages.readonly.
 */
export const chatReader = () => (process.env.CHAT_READER ?? process.env.GMAIL_MAILBOX ?? "").trim().toLowerCase();
let _chatUser: chat_v1.Chat | null = null;
export function chatAsUser(): chat_v1.Chat {
  if (_chatUser) return _chatUser;
  const c = credentials() as { client_email: string; private_key: string };
  if (!chatReader()) throw new Error("CHAT_READER_NOT_CONFIGURED");
  const auth = new google.auth.JWT({ email: c.client_email, key: c.private_key, subject: chatReader(), scopes: ["https://www.googleapis.com/auth/chat.messages.readonly"] });
  _chatUser = google.chat({ version: "v1", auth });
  return _chatUser;
}

/** The space people share into from the phone. Found by name among the spaces the app is a member of. */
export const inboxSpaceName = () => (process.env.GCHAT_INBOX_NAME ?? "Task Hub Drop").trim();
export async function rememberInboxSpace(space: string): Promise<void> {
  const { sql } = await import("./db");
  await sql()`insert into settings (key, value) values ('chat_inbox_space', ${JSON.stringify(space)}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`;
}
/**
 * Delete every message the app itself posted in a space (feed lines, cards, thread details, replies). Messages by
 * people are left alone: app credentials cannot delete them, and the hub never should. Returns how many went.
 */
export async function clearOwnMessages(space: string): Promise<{ deleted: number; kept: number; errors: string[] }> {
  const out = { deleted: 0, kept: 0, errors: [] as string[] };
  let pageToken: string | undefined;
  const mine: string[] = [];
  // Listing a space is a person's read (the app cannot list); deleting the app's own messages is the app's right.
  do {
    const res = await chatAsUser().spaces.messages.list({ parent: space, pageSize: 100, pageToken });
    for (const m of res.data.messages ?? []) {
      if (m.sender?.type === "BOT" && m.name) mine.push(m.name); else out.kept++;
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  for (const name of mine) {
    try { await chat().spaces.messages.delete({ name }); out.deleted++; }
    catch (e) { const msg = (e as Error).message; if (!/404|NOT_FOUND/.test(msg)) out.errors.push(msg.slice(0, 100)); }
  }
  return out;
}

/** Every space the app has been added to (app credentials). */
export async function appSpaces(): Promise<Array<{ name: string; displayName: string; spaceType: string }>> {
  const out: Array<{ name: string; displayName: string; spaceType: string }> = [];
  let pageToken: string | undefined;
  do {
    const res = await chat().spaces.list({ pageSize: 100, pageToken });
    for (const s of res.data.spaces ?? []) out.push({ name: s.name ?? "", displayName: s.displayName ?? "", spaceType: s.spaceType ?? "" });
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

export const gchatConfigured = () => !!process.env.GOOGLE_SERVICE_ACCOUNT_B64 && !!process.env.GCHAT_REVIEW_SPACE && !!process.env.GOOGLE_PROJECT_NUMBER;
export const reviewSpace = () => normSpace(process.env.GCHAT_REVIEW_SPACE ?? "");
export const intakeSpace = () => normSpace(process.env.GCHAT_INTAKE_SPACE ?? "");
function normSpace(s: string): string {
  s = s.trim();
  if (!s) return "";
  return s.startsWith("spaces/") ? s : `spaces/${s}`;
}

/**
 * Every request from Google Chat carries a JWT signed by Google. Audience is the project number (classic apps) or
 * the endpoint URL (add-on style apps); the caller is Chat's system account or, for add-on deployments, the
 * Workspace add-ons service agent. Returns the reason on failure so /api/health can show it.
 */
export async function verifyChatRequest(authHeader: string | null, calledUrl?: string): Promise<{ ok: boolean; reason?: string; caller?: string }> {
  const projectNumber = process.env.GOOGLE_PROJECT_NUMBER;
  if (!projectNumber) return { ok: false, reason: "GOOGLE_PROJECT_NUMBER not set" };
  if (!authHeader?.startsWith("Bearer ")) return { ok: false, reason: "no bearer token" };
  const audiences = [projectNumber, endpointUrl()];
  if (calledUrl) { try { const u = new URL(calledUrl); audiences.push(calledUrl, `${u.origin}${u.pathname}`); } catch { /* ignore */ } }
  try {
    const client = new OAuth2Client();
    const ticket = await client.verifyIdToken({ idToken: authHeader.slice(7), audience: audiences });
    const p = ticket.getPayload();
    const email = p?.email ?? "";
    const trusted = email === "chat@system.gserviceaccount.com" || /^service-\d+@gcp-sa-gsuiteaddons\.iam\.gserviceaccount\.com$/.test(email);
    if (!trusted || p?.email_verified !== true) return { ok: false, reason: `caller not trusted: ${email || "(no email)"} aud=${String(p?.aud)}`, caller: email };
    return { ok: true, caller: email };
  } catch (e) {
    return { ok: false, reason: `jwt: ${(e as Error).message.slice(0, 200)}` };
  }
}

// ---- sending ----

/**
 * Threads: a message can join an existing thread by its name, or by a threadKey the hub chooses (Chat creates the
 * thread on first use and reuses it after). The feed keys every post by the source message (`msg-<id>`), so the
 * "which client?" card, the "client set" line and the task lines for one forwarded message sit in one thread.
 */
export async function sendText(space: string, text: string, threadName?: string, threadKey?: string): Promise<string | null> {
  const thread = threadName ? { name: threadName } : threadKey ? { threadKey } : undefined;
  const res = await chat().spaces.messages.create({
    parent: space,
    messageReplyOption: thread ? "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD" : undefined,
    requestBody: { text, thread },
  });
  return res.data.name ?? null;
}

export async function sendCard(space: string, card: chat_v1.Schema$GoogleAppsCardV1Card, fallbackText: string, cardId: string, threadKey?: string): Promise<{ name: string | null; thread: string | null }> {
  const res = await chat().spaces.messages.create({
    parent: space,
    messageReplyOption: threadKey ? "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD" : undefined,
    requestBody: { text: fallbackText, cardsV2: [{ cardId, card }], thread: threadKey ? { threadKey } : undefined },
  });
  return { name: res.data.name ?? null, thread: res.data.thread?.name ?? null };
}

/** Remove one of the app's own messages (a headline being replaced). Missing already is fine. */
export async function deleteMessage(messageName: string): Promise<void> {
  try { await chat().spaces.messages.delete({ name: messageName }); }
  catch (e) { if (!/404|NOT_FOUND/.test((e as Error).message)) throw e; }
}

export async function updateMessageText(messageName: string, text: string): Promise<void> {
  await chat().spaces.messages.patch({ name: messageName, updateMask: "text,cardsV2", requestBody: { text, cardsV2: [] } });
}

export async function downloadAttachment(resourceName: string): Promise<Buffer> {
  try {
    const res = await chat().media.download({ resourceName, alt: "media" }, { responseType: "arraybuffer" });
    return Buffer.from(res.data as ArrayBuffer);
  } catch (e) {
    // A file shared into the Drop space was not delivered to the app; read it as the person the hub reads Chat as.
    if (!chatReader()) throw e;
    const res = await chatAsUser().media.download({ resourceName, alt: "media" }, { responseType: "arraybuffer" });
    return Buffer.from(res.data as ArrayBuffer);
  }
}

// ---- card builders (Cards v2) ----

type Btn = { text: string; fn: string; params: Record<string, string>; primary?: boolean; danger?: boolean };

function buttons(list: Btn[]): chat_v1.Schema$GoogleAppsCardV1Widget {
  return {
    buttonList: {
      buttons: list.map((b) => ({
        text: b.text,
        onClick: { action: { function: fnRef(b.fn), parameters: Object.entries(b.params).map(([key, value]) => ({ key, value })) } },
        color: b.primary ? { red: 0.16, green: 0.48, blue: 0.35, alpha: 1 } : b.danger ? { red: 0.7, green: 0.2, blue: 0.2, alpha: 1 } : undefined,
      })),
    },
  };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function draftCard(p: {
  requestId: string; clientName: string; scopeTag: string; department: string; priority: string; gated: boolean;
  confidence: number; title: string; firstLine: string; quote: string; source: string; permalink: string | null; reason: string; pulpLine: string;
}): chat_v1.Schema$GoogleAppsCardV1Card {
  const src = p.permalink ? `<a href="${p.permalink}">${esc(p.source)}</a>` : esc(p.source);
  return {
    header: { title: `${p.clientName}${p.scopeTag} · ${p.department} · ${p.priority}${p.gated ? " · Needs scope" : ""}`, subtitle: `confidence ${p.confidence.toFixed(2)} · ${p.source}` },
    sections: [{
      widgets: [
        { decoratedText: { topLabel: "Draft task", text: `<b>${esc(p.title)}</b>`, wrapText: true } },
        { textParagraph: { text: esc(p.firstLine) } },
        { textParagraph: { text: `<i>"${esc(p.quote.slice(0, 300))}"</i>` } },
        { textParagraph: { text: `${src} · ${esc(p.reason)} · ${esc(p.pulpLine)}` } },
        buttons([
          { text: "Approve", fn: "approve", params: { requestId: p.requestId }, primary: true },
          { text: "Edit", fn: "edit", params: { requestId: p.requestId } },
          { text: "Merge into…", fn: "merge", params: { requestId: p.requestId } },
          { text: "Not a task", fn: "dismiss", params: { requestId: p.requestId }, danger: true },
        ]),
      ],
    }],
  };
}

export function needsHumanCard(p: { messageId: string; clientName: string; why: string; text: string; source: string; permalink: string | null; clients: Array<{ id: string; name: string }> }): chat_v1.Schema$GoogleAppsCardV1Card {
  const src = p.permalink ? `<a href="${p.permalink}">${esc(p.source)}</a>` : esc(p.source);
  const widgets: chat_v1.Schema$GoogleAppsCardV1Widget[] = [
    { textParagraph: { text: `<i>"${esc(p.text.slice(0, 400) || "(no text)")}"</i>` } },
    { textParagraph: { text: `${src} · ${esc(p.why.replace(/_/g, " "))}` } },
  ];
  if (p.clients.length) {
    widgets.push({
      selectionInput: {
        name: "client", label: "Which client?", type: "DROPDOWN",
        items: p.clients.map((c) => ({ text: c.name, value: c.id, selected: false })),
        onChangeAction: { function: fnRef("pick_client"), parameters: [{ key: "messageId", value: p.messageId }] },
      },
    });
  }
  widgets.push(buttons([
    { text: "Make it a task", fn: "make_task", params: { messageId: p.messageId }, primary: true },
    { text: "Not a task", fn: "dismiss_message", params: { messageId: p.messageId }, danger: true },
  ]));
  const ask = p.why.startsWith("unknown") ? "Which client is this for? Pick it below, or reply here with the name." : p.why === "attachment_only" ? "This came with no words. Reply here with what it asks for, and the client." : "This needs a person: read it and decide below.";
  return { header: { title: `${p.clientName} · ${ask.split("?")[0].split(".")[0]}`, subtitle: ask }, sections: [{ widgets }] };
}

/**
 * The proposal (2026-09-22): a task is made only after one tap here. Four dropdowns, pre-filled and changeable, all
 * visible, then three buttons. Create card puts it in To Do, assigned; Remind me instead sets a reminder for the
 * person who tapped; No card records it and makes nothing. The card is replaced by the outcome line.
 */
export interface ProposalOptions {
  requestId: string; askedName: string | null; askedUser: string | null; clientName: string; title: string; description: string; quote: string;
  departments: Array<{ value: string; text: string }>; department: string;
  people: string[]; assignee: string | null;
  priority: "P1" | "P2" | "P3";
  dues: Array<{ value: string; text: string }>; due: string;
  rules: string[]; urgentReason: string | null;
}
export function proposalCard(p: ProposalOptions): chat_v1.Schema$GoogleAppsCardV1Card {
  const who = p.askedUser && /^users\/\d+$/.test(p.askedUser) ? `<${p.askedUser}>` : p.askedName ? `@${esc(p.askedName)}` : "PMs";
  const widgets: chat_v1.Schema$GoogleAppsCardV1Widget[] = [
    { textParagraph: { text: `${who}: this needs your decision. Check the four fields, then tap one button.` } },
    { decoratedText: { topLabel: "Task", text: `<b>${esc(p.title)}</b>`, wrapText: true } },
    ...(p.description.trim() ? [{ textParagraph: { text: esc(p.description.slice(0, 600)) } }] : []),
    ...(p.urgentReason ? [{ textParagraph: { text: `🔴 <b>P1</b>: ${esc(p.urgentReason)}` } }] : []),
    ...(p.rules.length ? [{ textParagraph: { text: `<b>${esc(p.clientName)} rules:</b> ${p.rules.map(esc).join(" · ")}` } }] : []),
    { selectionInput: { name: "department", label: "Department", type: "DROPDOWN", items: p.departments.map((d) => ({ text: d.text, value: d.value, selected: d.value === p.department })) } },
    { selectionInput: { name: "assignee", label: "Assign to", type: "DROPDOWN", items: [{ text: "choose…", value: "", selected: !p.assignee }, ...p.people.map((n) => ({ text: n, value: n, selected: n === p.assignee }))] } },
    { selectionInput: { name: "priority", label: "Priority", type: "DROPDOWN", items: (["P1", "P2", "P3"] as const).map((x) => ({ text: x === "P1" ? "P1 · urgent, due in 4 hours" : x === "P2" ? "P2 · normal" : "P3 · when there is time", value: x, selected: x === p.priority })) } },
    { selectionInput: { name: "due", label: "Due", type: "DROPDOWN", items: p.dues.map((d) => ({ text: d.text, value: d.value, selected: d.value === p.due })) } },
    buttons([
      { text: "Create card", fn: "proposal_create", params: { requestId: p.requestId }, primary: true },
      { text: "Remind me instead", fn: "proposal_remind", params: { requestId: p.requestId } },
      { text: "No card", fn: "proposal_no", params: { requestId: p.requestId }, danger: true },
    ]),
  ];
  return { header: { title: `${p.clientName} · task to confirm`, subtitle: `"${p.quote.replace(/\s+/g, " ").slice(0, 90)}${p.quote.length > 90 ? "…" : ""}"` }, sections: [{ widgets }] };
}

/** Under a reminder: the one button that closes it. */
export function doneCard(p: { reminderId: string }): chat_v1.Schema$GoogleAppsCardV1Card {
  return { sections: [{ widgets: [buttons([{ text: "Done", fn: "reminder_done", params: { reminderId: p.reminderId }, primary: true }])] }] };
}

/** Monday's list: one card per idea, two decisions. */
export function ideaCard(p: { ideaId: string; threadKey: string; clientName: string; text: string; saidBy: string | null; source: string | null; sourceLink: string | null; since: string; weeks: number }): chat_v1.Schema$GoogleAppsCardV1Card {
  const src = p.sourceLink ? `<a href="${p.sourceLink}">${esc(p.source ?? "source")}</a>` : esc(p.source ?? "");
  const age = p.weeks >= 1 ? ` · still waiting for a decision since ${esc(p.since)}` : ` · ${esc(p.since)}`;
  return {
    sections: [{
      widgets: [
        { decoratedText: { topLabel: p.clientName, text: `<b>${esc(p.text)}</b>`, wrapText: true } },
        { textParagraph: { text: `${p.saidBy ? esc(p.saidBy) + " · " : ""}${src}${age}` } },
        buttons([
          { text: "Make it a task", fn: "idea_task", params: { ideaId: p.ideaId, threadKey: p.threadKey }, primary: true },
          { text: "Not now", fn: "idea_not_now", params: { ideaId: p.ideaId, threadKey: p.threadKey } },
        ]),
      ],
    }],
  };
}

/** Under a "no reply yet" reminder: one button that stops the reminders for that Slack channel. */
export function ackCard(p: { messageId: string; channelId: string; clientName: string }): chat_v1.Schema$GoogleAppsCardV1Card {
  return { sections: [{ widgets: [buttons([{ text: "Acknowledged", fn: "ack_reply", params: { messageId: p.messageId, channelId: p.channelId, clientName: p.clientName }, primary: true }])] }] };
}

export function duplicateCard(p: { requestId: string; duplicateOf: string; clientName: string; label: string; text: string; source: string; permalink: string | null }): chat_v1.Schema$GoogleAppsCardV1Card {
  const src = p.permalink ? `<a href="${p.permalink}">${esc(p.source)}</a>` : esc(p.source);
  return {
    header: { title: `${p.clientName} · ${p.label}`, subtitle: `of request ${p.duplicateOf.slice(0, 8)}` },
    sections: [{
      widgets: [
        { textParagraph: { text: `<i>"${esc(p.text.slice(0, 300))}"</i>` } },
        { textParagraph: { text: src } },
        buttons([
          { text: "Merge into it", fn: "merge_into", params: { requestId: p.requestId, into: p.duplicateOf }, primary: true },
          { text: "Separate task", fn: "approve", params: { requestId: p.requestId } },
          { text: "Not a task", fn: "dismiss", params: { requestId: p.requestId }, danger: true },
        ]),
      ],
    }],
  };
}

/** The /task dialog body: client dropdown, request text, notes, priority. Wrapped per event format by the route. */
export function taskDialogBody(clients: Array<{ id: string; name: string }>) {
  return {
            header: { title: "Add a request" },
            sections: [{
              widgets: [
                { selectionInput: { name: "client", label: "Client", type: "DROPDOWN", items: clients.map((c, i) => ({ text: c.name, value: c.id, selected: i === 0 })) } },
                { textInput: { name: "request", label: "What was asked (the client's words, as close as possible)", type: "MULTIPLE_LINE" } },
                { textInput: { name: "notes", label: "Notes for the team (optional)", type: "MULTIPLE_LINE" } },
                { selectionInput: { name: "priority", label: "Priority", type: "RADIO_BUTTON", items: [
                  { text: "Normal", value: "P3", selected: true }, { text: "Important", value: "P2", selected: false }, { text: "Urgent (P1)", value: "P1", selected: false },
                ] } },
                { textInput: { name: "source", label: "Where it came from (WhatsApp, phone, email…) (optional)", type: "SINGLE_LINE" } },
                { buttonList: { buttons: [{ text: "Add request", onClick: { action: { function: fnRef("submit_task") } } }] } },
              ],
            }],
  };
}
