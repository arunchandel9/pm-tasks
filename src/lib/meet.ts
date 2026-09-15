import { google, type drive_v3 } from "googleapis";
import { sql, allClients, enqueue } from "./db";
import { resolveClientFromText } from "./resolve";
import { sortMeeting } from "./llm/meeting";
import { processMessage } from "./pipeline";
import { postHeadline, editHeadline, postDetail } from "./review";
import type { Client, Message } from "./types";

/**
 * Meeting notes. Google Meet writes "<title> - Notes by Gemini" docs into the organiser's Drive, under "Meet
 * Recordings" or "Google Meet/<meeting>/". Each organiser shares that folder with the service account once; the hub
 * finds every notes doc it can see at any depth, plus any notes doc shared directly. New docs are read every 5 minutes.
 *
 * Every meeting is sorted into four buckets (one model call): actions go through the normal pipeline per client
 * (dedupe against open tasks, Staging card, feed line); ideas and decisions are stored and get one line each;
 * discussion stays in the stored notes. Internal meetings use the MangoEyes client.
 */

function credentials() {
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_B64;
  if (!b64) throw new Error("GOOGLE_NOT_CONFIGURED");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}
let _drive: drive_v3.Drive | null = null;
export function drive(): drive_v3.Drive {
  if (!_drive) _drive = google.drive({ version: "v3", auth: new google.auth.GoogleAuth({ credentials: credentials(), scopes: ["https://www.googleapis.com/auth/drive.readonly"] }) });
  return _drive;
}
export const meetConfigured = () => !!process.env.GOOGLE_SERVICE_ACCOUNT_B64;

const NOTES_TITLE = /\s*[-–—]\s*(Notes by Gemini|Gemini notes|notes)\s*$/i;
const TRANSCRIPT_TITLE = /\s*[-–—]\s*transcript\s*$/i;

export interface NoteDoc { id: string; name: string; modifiedTime: string; owner: string | null; folder: string | null }

/**
 * Every Gemini notes doc the hub can see, at any depth. Google files them differently over time: directly in
 * "Meet Recordings", or under "Google Meet/<meeting> - <date>/", sometimes as a shortcut in a recurring meeting's
 * folder. So this does not walk folders at all: one Drive query for anything named "… Notes by Gemini" (documents
 * and shortcuts to documents) modified since the watermark, wherever it sits. Sharing any ancestor folder with the
 * service account is enough; a doc shared directly counts too. Shortcuts resolve to their target and dedupe.
 */
export async function findNoteDocs(days = 3): Promise<NoteDoc[]> {
  const d = drive();
  const since = new Date(Date.now() - days * 86400 * 1000).toISOString();
  const out = new Map<string, NoteDoc>();
  const parentNames = new Map<string, string>();
  const folderName = async (id: string | undefined): Promise<string | null> => {
    if (!id) return null;
    if (!parentNames.has(id)) {
      try { const r = await d.files.get({ fileId: id, fields: "name", supportsAllDrives: true }); parentNames.set(id, r.data.name ?? id); }
      catch { parentNames.set(id, id); }
    }
    return parentNames.get(id) ?? null;
  };
  let pageToken: string | undefined;
  do {
    const res = await d.files.list({
      q: `name contains 'Notes by Gemini' and (mimeType = 'application/vnd.google-apps.document' or mimeType = 'application/vnd.google-apps.shortcut') and modifiedTime > '${since}' and trashed = false`,
      fields: "nextPageToken, files(id,name,mimeType,modifiedTime,owners(emailAddress),parents,shortcutDetails(targetId,targetMimeType))",
      pageSize: 100, orderBy: "modifiedTime", supportsAllDrives: true, includeItemsFromAllDrives: true, pageToken,
    });
    for (const f of res.data.files ?? []) {
      if (!f.id || !f.name || TRANSCRIPT_TITLE.test(f.name) || !NOTES_TITLE.test(f.name)) continue;
      let id = f.id;
      if (f.mimeType === "application/vnd.google-apps.shortcut") {
        if (f.shortcutDetails?.targetMimeType !== "application/vnd.google-apps.document" || !f.shortcutDetails.targetId) continue;
        id = f.shortcutDetails.targetId;
      }
      if (out.has(id)) continue;
      out.set(id, { id, name: f.name, modifiedTime: f.modifiedTime ?? since, owner: f.owners?.[0]?.emailAddress ?? null, folder: await folderName(f.parents?.[0]) });
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return [...out.values()].sort((a, b) => a.modifiedTime.localeCompare(b.modifiedTime));
}

async function docText(id: string): Promise<string> {
  const res = await drive().files.export({ fileId: id, mimeType: "text/plain" }, { responseType: "text" });
  return String(res.data ?? "").replace(/\r\n/g, "\n").trim();
}

/** People the doc is shared with (Meet shares the notes with attendees). Best effort; viewers may not see this. */
async function attendeesOf(id: string): Promise<string[]> {
  try {
    const res = await drive().permissions.list({ fileId: id, fields: "permissions(emailAddress,type)", supportsAllDrives: true });
    return (res.data.permissions ?? []).map((p) => p.emailAddress ?? "").filter((e) => e && !e.endsWith("gserviceaccount.com"));
  } catch { return []; }
}

/** "HOH monthly review - Notes by Gemini" → "HOH monthly review". Gemini also puts the date in the doc body. */
export const meetingTitle = (name: string) => name.replace(NOTES_TITLE, "").trim();

/** Gemini notes start with a line like "Sep 9, 2026" or "Tue, 9 Sep 2026 · 3:00 PM". Fall back to the file time. */
export function heldAtFrom(notes: string, fallback: string): Date {
  const head = notes.slice(0, 400);
  const m = head.match(/\b(\d{1,2})\s+([A-Z][a-z]{2,8})\s+(\d{4})\b/) ?? head.match(/\b([A-Z][a-z]{2,8})\s+(\d{1,2}),?\s+(\d{4})\b/);
  if (m) {
    const d = new Date(`${m[0]} 12:00 UTC`);
    if (!isNaN(d.getTime())) return d;
  }
  return new Date(fallback);
}

function clientByName(name: string | null | undefined, clients: Client[]): Client | null {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  return clients.find((c) => c.name.toLowerCase() === n || c.id.toLowerCase() === n || (c.aliases ?? []).some((a) => a.toLowerCase() === n))
    ?? clients.find((c) => c.name.toLowerCase().includes(n) || n.includes(c.name.toLowerCase()))
    ?? (/mango\s*eyes|internal/i.test(n) ? clients.find((c) => c.scope === "internal") ?? null : null);
}

/**
 * Gemini creates the notes doc when the call ends and fills it in over the next minutes; the transcript can lag
 * further. A doc read too early looks empty or says the notes are still being generated. Such a doc is not recorded:
 * it is tried again (every 30 minutes, for up to 6 hours after its last change) until it has real content, so a
 * meeting is never written off as "nothing to act on" because the hub was quicker than Gemini.
 */
const NOT_READY = /\b(still (being )?(generat|process|transcrib|prepar)|will (be|appear) (available|here|shortly)|notes? (are|is) (being|not yet)|transcript(ion)? (is )?(in progress|pending|not (yet )?available|failed|unavailable)|transcription (issue|problem|error)|no usable|no (content|transcript|notes)\b|not captured|could not be (captured|transcribed))/i;
export function notesNotReady(notes: string, summary: string[] = [], items = 0): boolean {
  const t = notes.trim();
  if (t.length < 400) return true;
  if (NOT_READY.test(t.slice(0, 1500))) return true;
  return items === 0 && summary.some((s) => NOT_READY.test(s));
}
const RETRY_MINUTES = 30, GIVE_UP_HOURS = 6;

export async function processNoteDoc(doc: NoteDoc): Promise<string> {
  const exists = await sql()`select id from meetings where drive_file_id = ${doc.id}`;
  if (exists.length) return `${doc.name}: already read`;
  // Not before the retry gap, so a doc that is still being written is not exported every five minutes.
  const retryKey = `meet_retry:${doc.id}`;
  const last = await sql()`select value from settings where key = ${retryKey}`;
  if (last.length && Date.now() - new Date(String(last[0].value)).getTime() < RETRY_MINUTES * 60_000) return `${doc.name}: waiting for Gemini to finish`;
  const notes = await docText(doc.id);
  const clients = await allClients();
  const title = meetingTitle(doc.name);
  const attendees = await attendeesOf(doc.id);
  const heldAt = heldAtFrom(notes, doc.modifiedTime);
  const docUrl = `https://docs.google.com/document/d/${doc.id}/edit`;
  const ageHours = (Date.now() - new Date(doc.modifiedTime).getTime()) / 3_600_000;
  const notReady = async (why: string) => {
    if (ageHours < GIVE_UP_HOURS) {
      await sql()`insert into settings (key, value) values (${retryKey}, ${JSON.stringify(new Date().toISOString())}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`;
      return `${doc.name}: ${why}, will read again later`;
    }
    await sql()`insert into meetings (drive_file_id, title, held_at, organiser, attendees, client_id, scope, doc_url, notes, summary)
      values (${doc.id}, ${title}, ${heldAt.toISOString()}, ${doc.owner}, ${JSON.stringify(attendees)}::jsonb, null, 'unknown', ${docUrl}, ${notes}, ${JSON.stringify([`No notes were produced for this meeting (${why}).`])}::jsonb) on conflict (drive_file_id) do nothing`;
    await sql()`delete from settings where key = ${retryKey}`;
    return `${doc.name}: ${why} after ${GIVE_UP_HOURS} hours, recorded as no notes`;
  };
  if (notesNotReady(notes)) return notReady(notes.trim().length < 400 ? "notes not written yet" : "Gemini still writing");

  // Meeting-level client: title, attendee domains, then the sorter's own view.
  const byTitle = resolveClientFromText(title, clients)?.client ?? null;
  const byAttendee = attendees.map((e) => resolveClientFromText(e, clients)?.client ?? null).find(Boolean) ?? null;
  const sorted = await sortMeeting({ title, notes, attendees, clients: clients.map((c) => `${c.name}${c.aliases?.length ? `; ${c.aliases.join(", ")}` : ""}`) });
  if (notesNotReady(notes, sorted.summary ?? [], sorted.items.length)) return notReady("no usable content yet");
  await sql()`delete from settings where key = ${retryKey}`;
  const internal = clients.find((c) => c.scope === "internal") ?? null;
  const meetingClient = byTitle ?? byAttendee ?? clientByName(sorted.meeting_client, clients) ?? null;

  const ins = await sql()`insert into meetings (drive_file_id, title, held_at, organiser, attendees, client_id, scope, doc_url, notes, summary)
    values (${doc.id}, ${title}, ${heldAt.toISOString()}, ${doc.owner}, ${JSON.stringify(attendees)}::jsonb, ${meetingClient?.id ?? null}, ${meetingClient ? meetingClient.scope : "unknown"}, ${docUrl}, ${notes}, ${JSON.stringify(sorted.summary)}::jsonb)
    returning id`;
  const meetingId = String(ins[0].id);

  // Ideas, decisions and discussion are stored now. Actions are grouped per client and handed to the queue: one job
  // per client, each in its own time budget, so a call with many action items can never outrun one web request
  // (that left a meeting stuck at "reading the notes…" on 2026-09-15). The headline tally follows as jobs finish.
  const groups = new Map<string, { client: Client | null; items: typeof sorted.items }>();
  const ideaLines: string[] = [];
  for (const it of sorted.items) {
    const c = clientByName(it.client, clients) ?? meetingClient ?? (it.kind === "action" ? internal : null);
    if (it.kind === "action") {
      const key = c?.id ?? "?";
      if (!groups.has(key)) groups.set(key, { client: c, items: [] });
      groups.get(key)!.items.push(it);
      // Recorded now as pending; the group job sets the outcome once the pipeline has run.
      await sql()`insert into meeting_items (meeting_id, kind, client_id, text, owner, due_text, outcome) values (${meetingId}, 'action', ${c?.id ?? null}, ${it.text}, ${it.owner}, ${it.due}, 'pending')`;
      continue;
    }
    const outcome = it.kind === "idea" ? "idea" : it.kind === "decision" ? "decision" : "noted";
    await sql()`insert into meeting_items (meeting_id, kind, client_id, text, owner, due_text, outcome) values (${meetingId}, ${it.kind}, ${c?.id ?? null}, ${it.text}, ${it.owner}, ${it.due}, ${outcome})`;
    if (it.kind === "idea" && ideaLines.length < 6) ideaLines.push(`💡 *${c?.name ?? "Unassigned"}* · ${it.text}`);
    if (it.kind === "decision" && ideaLines.length < 6) ideaLines.push(`📌 *${c?.name ?? "Unassigned"}* · ${it.text}`);
  }

  // One headline in the feed per meeting; the cards, ideas, decisions and summary all go inside its thread.
  const threadKey = `meet-${meetingId}`;
  const who = meetingClient ? meetingClient.name : sorted.meeting_client?.toLowerCase().includes("mango") ? "MangoEyes internal" : "client unclear";
  const day = heldAt.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
  const headName = await postHeadline(`📝 *Meeting · ${who}* · ${day} · ${groups.size ? "reading the notes…" : await tallyText(meetingId)} · <${docUrl}|notes>`, threadKey);
  await sql()`insert into settings (key, value) values (${"meet_head:" + meetingId}, ${JSON.stringify({ name: headName, who, day, docUrl })}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`;
  const summary = (sorted.summary ?? []).slice(0, 4).map((x) => `• ${x}`).join("\n");
  await postDetail([summary ? `*In short*\n${summary}` : "", ideaLines.length ? `*Raised*\n${ideaLines.join("\n")}` : ""].filter(Boolean).join("\n\n"), threadKey);

  for (const [, g] of groups) {
    const text = g.items.map((it) => `- ${it.text}${it.owner ? ` (${it.owner})` : ""}${it.due ? ` — ${it.due}` : ""}`).join("\n");
    await enqueue("meet_group", { meetingId, docId: doc.id, docUrl, title, owner: doc.owner, heldAt: heldAt.toISOString(), clientId: g.client?.id ?? null, text, threadKey });
  }
  return `${title}: ${groups.size ? `${groups.size} action group${groups.size > 1 ? "s" : ""} queued` : await tallyText(meetingId)}`;
}

/** The headline tally from what is recorded: cards made, on existing cards, ideas, decisions, actions without a client. */
export async function tallyText(meetingId: string): Promise<string> {
  const r = (await sql()`
    select count(*) filter (where kind = 'action' and outcome = 'task')::int as tasks,
           count(*) filter (where kind = 'action' and outcome = 'on_existing_card')::int as on_card,
           count(*) filter (where kind = 'idea')::int as ideas,
           count(*) filter (where kind = 'decision')::int as decisions,
           count(*) filter (where kind = 'action' and client_id is null)::int as unclear,
           count(*) filter (where kind = 'action' and outcome = 'pending')::int as pending
    from meeting_items where meeting_id = ${meetingId}`)[0];
  const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
  return [
    Number(r.tasks) ? n(Number(r.tasks), "card") : null, Number(r.on_card) ? `${r.on_card} on existing cards` : null,
    Number(r.ideas) ? n(Number(r.ideas), "idea") : null, Number(r.decisions) ? n(Number(r.decisions), "decision") : null,
    Number(r.unclear) ? `${r.unclear} with no clear client` : null, Number(r.pending) ? `${r.pending} still reading` : null,
  ].filter(Boolean).join(" · ") || "nothing to act on";
}

/** Rewrite the meeting's headline with the current tally. */
export async function refreshMeetingHeadline(meetingId: string): Promise<void> {
  const r = await sql()`select value from settings where key = ${"meet_head:" + meetingId}`;
  if (!r.length) return;
  const h = r[0].value as { name: string | null; who: string; day: string; docUrl: string };
  await editHeadline(h.name, `📝 *Meeting · ${h.who}* · ${h.day} · ${await tallyText(meetingId)} · <${h.docUrl}|notes>`);
}

/**
 * The `meet_group` queue job: one client's action items from one meeting through the normal pipeline (dedupe, Staging
 * cards, feed lines inside the meeting's thread). Re-run safe: the message is upserted, so a retry never doubles cards.
 */
export async function runMeetGroup(p: { meetingId: string; docId: string; docUrl: string; title: string; owner: string | null; heldAt: string; clientId: string | null; text: string; threadKey: string }): Promise<string> {
  const clients = await allClients();
  const client = p.clientId ? clients.find((c) => c.id === p.clientId) ?? null : null;
  const m: Message = {
    channel: "meet", externalId: `meet:${p.docId}:${client?.id ?? "unassigned"}`, teamId: null, clientId: client?.id ?? null, scope: client ? client.scope : "unknown",
    sender: p.owner ?? "meeting", senderIsStaff: true, sentAt: new Date(p.heldAt), text: `Action items from the meeting "${p.title}":\n${p.text}`, permalink: p.docUrl, threadRef: null,
    raw: { meeting: { id: p.meetingId, driveFileId: p.docId, title: p.title }, feedThreadKey: p.threadKey },
  };
  const r = await processMessage(m, { skip: false, reason: null }, { rerun: true });
  const made = r.outcome === "review" ? (r.requestIds?.length ?? 0) : 0;
  const outcome = made ? "task" : r.outcome === "attached" ? "on_existing_card" : "noted";
  await sql()`update meeting_items set outcome = ${outcome} where meeting_id = ${p.meetingId} and kind = 'action' and outcome = 'pending' and client_id is not distinct from ${client?.id ?? null}`;
  await refreshMeetingHeadline(p.meetingId);
  return `${client?.name ?? "unassigned"}: ${outcome}`;
}

/** Forget one meeting and read its notes doc again now (a doc read before Gemini finished, or notes edited by hand). */
export async function rereadNoteDoc(fileId: string): Promise<string> {
  const meta = await drive().files.get({ fileId, fields: "id,name,modifiedTime,owners(emailAddress),parents", supportsAllDrives: true });
  const doc: NoteDoc = { id: fileId, name: meta.data.name ?? fileId, modifiedTime: meta.data.modifiedTime ?? new Date().toISOString(), owner: meta.data.owners?.[0]?.emailAddress ?? null, folder: null };
  const old = await sql()`select id from meetings where drive_file_id = ${fileId}`;
  for (const m of old) {
    await sql()`delete from meeting_items where meeting_id = ${m.id}`;
    await sql()`delete from meetings where id = ${m.id}`;
    // The old headline goes, so the feed shows one line for the meeting, not a stale one beside the new one.
    const head = await sql()`select value from settings where key = ${"meet_head:" + m.id}`;
    const name = (head[0]?.value as { name?: string | null } | undefined)?.name;
    if (name) { try { const { deleteMessage } = await import("./gchat"); await deleteMessage(name); } catch (e) { console.error("old headline not deleted", (e as Error).message); } }
    await sql()`delete from settings where key = ${"meet_head:" + m.id}`;
    await sql()`delete from queue where done_at is null and kind = 'meet_group' and payload->>'meetingId' = ${String(m.id)}`;
  }
  await sql()`delete from settings where key = ${"meet_retry:" + fileId}`;
  return processNoteDoc(doc);
}

/** Meetings are read from the moment the hub first looked (settings `meet_since`), never the backlog before that. */
async function meetSince(): Promise<Date> {
  const r = await sql()`select value from settings where key = 'meet_since'`;
  if (r.length) return new Date(String(r[0].value));
  const since = new Date(Date.now() - 60 * 60 * 1000);
  await sql()`insert into settings (key, value) values ('meet_since', ${JSON.stringify(since.toISOString())}::jsonb) on conflict (key) do nothing`;
  return since;
}

export async function pollMeetings(): Promise<{ found: number; processed: string[]; errors: string[] }> {
  const processed: string[] = [], errors: string[] = [];
  let docs: NoteDoc[] = [];
  try {
    const since = await meetSince();
    docs = (await findNoteDocs()).filter((d) => new Date(d.modifiedTime) > since);
  } catch (e) {
    // A failed Drive query must show on health and in the brief, not vanish.
    const report = { found: 0, processed, errors: [`drive: ${(e as Error).message.slice(0, 200)}`], at: new Date().toISOString() };
    try { await sql()`insert into settings (key, value) values ('meet_poll_last', ${JSON.stringify(report)}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`; } catch { /* ignore */ }
    return report;
  }
  const known = new Set((await sql()`select drive_file_id from meetings where drive_file_id = any(${docs.map((d) => d.id)}::text[])`).map((r) => String(r.drive_file_id)));
  let done = 0;
  for (const doc of docs) {
    if (known.has(doc.id)) continue;
    if (done >= 3) break; // bound one tick
    try { processed.push(await processNoteDoc(doc)); done++; }
    catch (e) {
      const msg = (e as Error).message;
      if (/File not found|"code":\s*404/.test(msg)) {
        // Deleted, or a shortcut to a doc the hub cannot open: remember it so it is not tried every five minutes.
        await sql()`insert into meetings (drive_file_id, title, held_at, organiser, attendees, client_id, scope, doc_url, notes, summary)
          values (${doc.id}, ${doc.name}, ${doc.modifiedTime}, null, '{}', null, 'unknown', null, '', 'not readable: deleted or a dead shortcut') on conflict (drive_file_id) do nothing`;
        processed.push(`${doc.name.slice(0, 40)}: not readable, skipped`);
        continue;
      }
      errors.push(`${doc.name.slice(0, 40)}: ${msg.slice(0, 160)}`);
    }
  }
  const report = { found: docs.length, processed, errors, at: new Date().toISOString() };
  try { await sql()`insert into settings (key, value) values ('meet_poll_last', ${JSON.stringify(report)}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`; } catch { /* ignore */ }
  return report;
}
