import { google, type drive_v3 } from "googleapis";
import { sql, allClients } from "./db";
import { resolveClientFromText } from "./resolve";
import { sortMeeting } from "./llm/meeting";
import { processMessage } from "./pipeline";
import { postText } from "./review";
import type { Client, Message } from "./types";

/**
 * Meeting notes. Google Meet writes "<title> - Notes by Gemini" docs into the organiser's Drive folder
 * "Meet Recordings". Each organiser shares that folder with the service account once; the hub finds every such
 * folder shared with it, plus any notes doc shared directly. New docs are read every 5 minutes.
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

const FOLDER_NAMES = (process.env.MEET_FOLDER_NAMES ?? "Meet Recordings,Task Hub Notes").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const NOTES_TITLE = /\s*[-–—]\s*(Notes by Gemini|Gemini notes|notes)\s*$/i;
const TRANSCRIPT_TITLE = /\s*[-–—]\s*transcript\s*$/i;

export interface NoteDoc { id: string; name: string; modifiedTime: string; owner: string | null; folder: string | null }

/** Folders shared with the hub by name, then their Gemini notes docs; plus notes docs shared directly. */
export async function findNoteDocs(days = 3): Promise<NoteDoc[]> {
  const d = drive();
  const since = new Date(Date.now() - days * 86400 * 1000).toISOString();
  const out = new Map<string, NoteDoc>();
  const add = (f: drive_v3.Schema$File, folder: string | null) => {
    if (!f.id || !f.name || TRANSCRIPT_TITLE.test(f.name)) return;
    out.set(f.id, { id: f.id, name: f.name, modifiedTime: f.modifiedTime ?? since, owner: f.owners?.[0]?.emailAddress ?? null, folder });
  };
  const folders = await d.files.list({ q: "sharedWithMe and mimeType = 'application/vnd.google-apps.folder' and trashed = false", fields: "files(id,name,owners(emailAddress))", pageSize: 100, supportsAllDrives: true, includeItemsFromAllDrives: true });
  for (const folder of folders.data.files ?? []) {
    if (!folder.id || !FOLDER_NAMES.includes((folder.name ?? "").trim().toLowerCase())) continue;
    const docs = await d.files.list({
      q: `'${folder.id}' in parents and mimeType = 'application/vnd.google-apps.document' and modifiedTime > '${since}' and trashed = false`,
      fields: "files(id,name,modifiedTime,owners(emailAddress))", pageSize: 50, orderBy: "modifiedTime", supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    for (const f of docs.data.files ?? []) add(f, `${folder.name} (${folder.owners?.[0]?.emailAddress ?? "?"})`);
  }
  const direct = await d.files.list({ q: `sharedWithMe and mimeType = 'application/vnd.google-apps.document' and modifiedTime > '${since}' and trashed = false`, fields: "files(id,name,modifiedTime,owners(emailAddress))", pageSize: 50 });
  for (const f of direct.data.files ?? []) if (NOTES_TITLE.test(f.name ?? "")) add(f, null);
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

export async function processNoteDoc(doc: NoteDoc): Promise<string> {
  const exists = await sql()`select id from meetings where drive_file_id = ${doc.id}`;
  if (exists.length) return `${doc.name}: already read`;
  const notes = await docText(doc.id);
  if (notes.length < 40) return `${doc.name}: empty`;
  const clients = await allClients();
  const title = meetingTitle(doc.name);
  const attendees = await attendeesOf(doc.id);
  const heldAt = heldAtFrom(notes, doc.modifiedTime);
  const docUrl = `https://docs.google.com/document/d/${doc.id}/edit`;

  // Meeting-level client: title, attendee domains, then the sorter's own view.
  const byTitle = resolveClientFromText(title, clients)?.client ?? null;
  const byAttendee = attendees.map((e) => resolveClientFromText(e, clients)?.client ?? null).find(Boolean) ?? null;
  const sorted = await sortMeeting({ title, notes, attendees, clients: clients.map((c) => `${c.name}${c.aliases?.length ? `; ${c.aliases.join(", ")}` : ""}`) });
  const internal = clients.find((c) => c.scope === "internal") ?? null;
  const meetingClient = byTitle ?? byAttendee ?? clientByName(sorted.meeting_client, clients) ?? null;

  const ins = await sql()`insert into meetings (drive_file_id, title, held_at, organiser, attendees, client_id, scope, doc_url, notes, summary)
    values (${doc.id}, ${title}, ${heldAt.toISOString()}, ${doc.owner}, ${JSON.stringify(attendees)}::jsonb, ${meetingClient?.id ?? null}, ${meetingClient ? meetingClient.scope : "unknown"}, ${docUrl}, ${notes}, ${JSON.stringify(sorted.summary)}::jsonb)
    returning id`;
  const meetingId = String(ins[0].id);

  // Actions: group per client and run each group through the normal pipeline (dedupe, cards, feed lines).
  const groups = new Map<string, { client: Client | null; items: typeof sorted.items }>();
  const counts = { tasks: 0, onCard: 0, ideas: 0, decisions: 0, unclear: 0 };
  const ideaLines: string[] = [];
  for (const it of sorted.items) {
    const c = clientByName(it.client, clients) ?? meetingClient ?? (it.kind === "action" ? internal : null);
    if (it.kind === "action") {
      const key = c?.id ?? "?";
      if (!groups.has(key)) groups.set(key, { client: c, items: [] });
      groups.get(key)!.items.push(it);
      continue;
    }
    const outcome = it.kind === "idea" ? "idea" : it.kind === "decision" ? "decision" : "noted";
    await sql()`insert into meeting_items (meeting_id, kind, client_id, text, owner, due_text, outcome) values (${meetingId}, ${it.kind}, ${c?.id ?? null}, ${it.text}, ${it.owner}, ${it.due}, ${outcome})`;
    if (it.kind === "idea") { counts.ideas++; if (ideaLines.length < 6) ideaLines.push(`💡 *${c?.name ?? "Unassigned"}* · ${it.text}`); }
    if (it.kind === "decision") { counts.decisions++; if (ideaLines.length < 6) ideaLines.push(`📌 *${c?.name ?? "Unassigned"}* · ${it.text}`); }
  }

  const header = `📝 *Meeting* · ${title} · ${heldAt.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" })} · ${meetingClient?.name ?? "Internal / unclear"} · <${docUrl}|notes>`;
  await postText(header);

  for (const [, g] of groups) {
    const text = g.items.map((it) => `- ${it.text}${it.owner ? ` (${it.owner})` : ""}${it.due ? ` — ${it.due}` : ""}`).join("\n");
    const m: Message = {
      channel: "meet", externalId: `meet:${doc.id}:${g.client?.id ?? "unassigned"}`, teamId: null, clientId: g.client?.id ?? null, scope: g.client ? g.client.scope : "unknown",
      sender: doc.owner ?? "meeting", senderIsStaff: true, sentAt: heldAt, text: `Action items from the meeting "${title}":\n${text}`, permalink: docUrl, threadRef: null,
      raw: { meeting: { id: meetingId, driveFileId: doc.id, title } },
    };
    const r = await processMessage(m, { skip: false, reason: null });
    const n = r.requestIds?.length ?? 0;
    const made = r.outcome === "review" ? n : 0;
    counts.tasks += made;
    if (r.outcome === "attached") counts.onCard += 1;
    if (!g.client) counts.unclear += g.items.length;
    for (const it of g.items) {
      await sql()`insert into meeting_items (meeting_id, kind, client_id, text, owner, due_text, outcome) values (${meetingId}, 'action', ${g.client?.id ?? null}, ${it.text}, ${it.owner}, ${it.due}, ${made ? "task" : r.outcome === "attached" ? "on_existing_card" : "noted"})`;
    }
  }

  const tail = [
    `${counts.tasks} to Staging`, counts.onCard ? `${counts.onCard} on existing cards` : null, counts.ideas ? `${counts.ideas} ideas` : null,
    counts.decisions ? `${counts.decisions} decisions` : null, counts.unclear ? `${counts.unclear} actions with no clear client (card above)` : null,
  ].filter(Boolean).join(" · ");
  if (ideaLines.length || tail) await postText([tail ? `↳ ${tail}` : null, ...ideaLines].filter(Boolean).join("\n"));
  return `${title}: ${tail || "nothing actionable"}`;
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
  } catch (e) { return { found: 0, processed, errors: [(e as Error).message.slice(0, 200)] }; }
  const known = new Set((await sql()`select drive_file_id from meetings where drive_file_id = any(${docs.map((d) => d.id)}::text[])`).map((r) => String(r.drive_file_id)));
  let done = 0;
  for (const doc of docs) {
    if (known.has(doc.id)) continue;
    if (done >= 3) break; // bound one tick
    try { processed.push(await processNoteDoc(doc)); done++; } catch (e) { errors.push(`${doc.name.slice(0, 40)}: ${(e as Error).message.slice(0, 160)}`); }
  }
  const report = { found: docs.length, processed, errors, at: new Date().toISOString() };
  try { await sql()`insert into settings (key, value) values ('meet_poll_last', ${JSON.stringify(report)}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`; } catch { /* ignore */ }
  return report;
}
