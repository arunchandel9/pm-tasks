/**
 * The daily brief (10:00 India, Monday to Friday): a line appears only when a named person has to do something
 * about it today. Nothing else. No post at all when nothing is waiting (Arun, 2026-09-22: the old brief was a log,
 * not a brief). Everything is listed in full; nothing is cut to "and N more".
 * (The MCP `daily_summary` tool keeps its fuller text in hub.ts.)
 */
import { sql } from "./db";
import { pulp } from "./pulp";
import { mention } from "./reminders-util";
import { whenLabel } from "./when";

export interface Waiting { who: string; whoUser: string | null; client: string; what: string; since: string; link?: string | null }
export interface BriefData {
  day: string;
  waiting: Waiting[];
  overdue: Array<{ client: string; title: string; priority: string; due: string; assignee: string | null; link: string | null }>;
  yesterday: { created: number; done: number; noCard: number; reminders: number };
  issues: string[];
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const link = (boardId: unknown, cardId: unknown) => (cardId ? pulp.cardUrl(String(boardId ?? ""), String(cardId)) : null);
const card = (l: string | null | undefined) => (l ? ` · <${l}|card>` : "");
const ago = (d: Date, now = new Date()) => { const h = (now.getTime() - d.getTime()) / 3_600_000; return h < 1 ? "just now" : h < 24 ? `${Math.round(h)} h ago` : `since ${whenLabel(d)}`; };
const PMS = "PMs";

export async function collectBrief(now = new Date()): Promise<BriefData> {
  const day = now.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
  const waiting: Waiting[] = [];

  // Proposals nobody has answered: the person who sent the message, or the PMs for a client's Slack message or a meeting.
  for (const r of await sql()`
    select r.id, r.draft->>'title' as title, r.asked_user, r.created_at, coalesce(c.name, 'Internal') as client, m.sender, m.sender_is_staff, m.channel
    from requests r left join clients c on c.id = r.client_id join messages m on m.id = r.message_id
    where r.status = 'proposed' order by r.created_at`) {
    const staff = !!r.sender_is_staff && r.channel !== "meet";
    waiting.push({ who: staff ? String(r.sender).replace(/\s*<[^>]+>\s*$/, "") : PMS, whoUser: staff ? (r.asked_user as string | null) ?? null : null, client: String(r.client), what: `task to confirm: "${clip(String(r.title), 80)}"`, since: ago(new Date(String(r.created_at)), now) });
  }
  // Reminders that are due and not done.
  for (const r of await sql()`select r.owner_name, r.owner_user, r.text, r.due_at, c.name as client from reminders r left join clients c on c.id = r.client_id where r.done_at is null and r.due_at <= ${now.toISOString()} order by r.due_at`)
    waiting.push({ who: String(r.owner_name), whoUser: (r.owner_user as string | null) ?? null, client: String(r.client ?? "Internal"), what: `reminder: ${clip(String(r.text), 80)}`, since: `due ${whenLabel(new Date(String(r.due_at)), true)}` });
  // Clients still waiting for a reply in Slack (no team reply, not acknowledged).
  try {
    const { unansweredClientMessages } = await import("./slack-replies");
    for (const u of await unansweredClientMessages(5)) {
      const age = u.minutes >= 1440 ? `${Math.round(u.minutes / 1440)} d` : u.minutes >= 60 ? `${Math.round(u.minutes / 60)} h` : `${u.minutes} min`;
      waiting.push({ who: PMS, whoUser: null, client: u.client, what: `${u.sender} is waiting for a reply in Slack: "${clip(u.text.replace(/\s+/g, " "), 60)}"`, since: `${age} without a reply` });
    }
  } catch (e) { console.error("unanswered check failed", (e as Error).message); }
  // "Which client?" and image-only messages nobody answered (three words or more, not a stray "ok").
  for (const r of await sql()`
    select left(m.text, 70) as text, m.channel, m.sender, m.sender_is_staff, m.skip_reason, m.created_at, m.sender_user from messages m
    where m.skip_reason in ('unknown_client','attachment_only','client_unhappy') and m.created_at > now() - interval '3 days'
      and (m.skip_reason <> 'unknown_client' and m.created_at > now() - interval '1 day' or array_length(regexp_split_to_array(trim(m.text), '\s+'), 1) >= 3)
    order by m.created_at desc limit 20`) {
    const staff = !!r.sender_is_staff;
    const what = r.skip_reason === "attachment_only" ? "sent an image with no words: type what it asks for" : r.skip_reason === "client_unhappy" ? `a client sounds unhappy, reply needed: "${String(r.text)}"` : `say which client this is for: "${String(r.text)}"`;
    waiting.push({ who: staff ? String(r.sender).replace(/\s*<[^>]+>\s*$/, "") : PMS, whoUser: staff ? (r.sender_user as string | null) ?? null : null, client: "", what, since: ago(new Date(String(r.created_at)), now) });
  }

  // Overdue: hub cards with a due date the hub set, open, P1 first. Never the sheet's history.
  const overdue = (await sql()`
    select coalesce(c.name,'Internal') as client, t.title, t.priority, t.assignee, t.board_id, t.pulp_card_id, t.due_at
    from tasks t left join clients c on c.id = t.client_id
    where t.origin = 'hub' and t.completed_at is null and t.staging = false and t.due_at < ${now.toISOString()}
    order by case when t.priority = 'P1' then 0 when t.priority = 'P2' then 1 else 2 end, t.due_at`)
    .map((r) => ({ client: String(r.client), title: String(r.title), priority: String(r.priority), assignee: (r.assignee as string | null) ?? null, due: whenLabel(new Date(String(r.due_at))), link: link(r.board_id, r.pulp_card_id) }));

  const y = (await sql()`
    select (select count(*) from tasks where origin = 'hub' and created_at > ${now.toISOString()}::timestamptz - interval '1 day')::int as created,
           (select count(*) from tasks where origin = 'hub' and completed_at > ${now.toISOString()}::timestamptz - interval '1 day')::int as done,
           (select count(*) from requests where status = 'dismissed' and decided_at > ${now.toISOString()}::timestamptz - interval '1 day' and decided_by not like 'system:%')::int as no_card,
           (select count(*) from reminders where created_at > ${now.toISOString()}::timestamptz - interval '1 day')::int as reminders`)[0];

  // Issues stay: a reader that stopped or a message that failed is something Arun must do something about.
  const issues: string[] = [];
  for (const r of await sql()`select coalesce(c.name,'Unknown') as client, left(m.text, 50) as text, m.skip_reason from messages m left join clients c on c.id = m.client_id
      where m.skip_reason in ('failed','transcription_failed') and m.created_at > now() - interval '1 day'`)
    issues.push(`${r.skip_reason === "transcription_failed" ? "Voice note could not be transcribed" : "Message could not be processed"}: ${r.client} · "${r.text}"`);
  for (const r of await sql()`select kind, left(coalesce(last_error,''), 80) as err from queue where last_error like 'abandoned:%' and done_at > now() - interval '1 day' limit 5`)
    issues.push(`Background step gave up: ${r.kind} · ${String(r.err).replace(/^abandoned:\s*/, "")}`);
  const polls = await sql()`select key, value from settings where key in ('gmail_poll_last','chat_inbox_last','meet_poll_last','pulp_poll_last','sheet_cards_last','tick_last')`;
  const names: Record<string, string> = { gmail_poll_last: "Mailbox", chat_inbox_last: "Task Hub Drop", meet_poll_last: "Meet notes", pulp_poll_last: "Pulp", sheet_cards_last: "Sheet cards" };
  const limitMin: Record<string, number> = { gmail_poll_last: 5, chat_inbox_last: 5, meet_poll_last: 20, pulp_poll_last: 5, sheet_cards_last: 5 };
  for (const key of Object.keys(names)) if (!polls.some((p) => p.key === key)) issues.push(`${names[key]} has never run`);
  for (const p of polls) {
    if (p.key === "tick_last") { const age = (Date.now() - new Date(String(p.value)).getTime()) / 60000; if (age > 5) issues.push(`The minute loop last ran ${Math.round(age)} min ago`); continue; }
    const v = p.value as { errors?: string[]; at?: string } | null;
    const errs = v?.errors ?? [];
    if (errs.length) issues.push(`${names[String(p.key)]} read failed: ${clip(String(errs[0]), 90)}`);
    const age = v?.at ? (Date.now() - new Date(v.at).getTime()) / 60000 : Infinity;
    if (age > (limitMin[String(p.key)] ?? 60)) issues.push(`${names[String(p.key)]} last ran ${age === Infinity ? "never" : `${Math.round(age)} min ago`}`);
  }

  return { day, waiting, overdue, yesterday: { created: Number(y.created), done: Number(y.done), noCard: Number(y.no_card), reminders: Number(y.reminders) }, issues };
}

/** "3 things waiting on Heena, 1 on Sneha, 2 on the PMs" */
export function waitingSummary(waiting: Waiting[]): string {
  const by = new Map<string, number>();
  for (const w of waiting) by.set(w.who, (by.get(w.who) ?? 0) + 1);
  const parts = [...by.entries()].sort((a, b) => b[1] - a[1]).map(([who, n], i) => `${n} ${i === 0 ? (n === 1 ? "thing" : "things") : ""} ${i === 0 ? "waiting " : ""}on ${who === PMS ? "the PMs" : who}`.replace(/\s+/g, " ").trim());
  return parts.join(", ");
}

/** Headline and thread. `null` when there is nothing anyone has to do: then nothing is posted. */
export function renderBrief(d: BriefData): { headline: string; detail: string } | null {
  if (!d.waiting.length && !d.overdue.length && !d.issues.length) return null;
  const parts: string[] = [];
  if (d.waiting.length) parts.push(waitingSummary(d.waiting));
  if (d.overdue.length) parts.push(`${d.overdue.length} overdue`);
  if (d.issues.length) parts.push(`${d.issues.length} issue${d.issues.length === 1 ? "" : "s"} for Arun`);
  const headline = `📋 Today · ${d.day} · ${parts.join(" · ")}`;

  const s: string[] = [];
  if (d.waiting.length) {
    s.push(`*Waiting on you*`);
    // Grouped by person, each line addressed to them by @mention so nobody can miss their own.
    const by = new Map<string, Waiting[]>();
    for (const w of d.waiting) { const k = w.who; if (!by.has(k)) by.set(k, []); by.get(k)!.push(w); }
    for (const [who, list] of by) {
      const tag = who === PMS ? "PMs" : mention({ ownerName: who, ownerUser: list.find((x) => x.whoUser)?.whoUser ?? null });
      for (const w of list) s.push(`• ${tag}: ${w.client ? `*${w.client}* · ` : ""}${w.what} · ${w.since}${card(w.link)}`);
    }
  }
  if (d.overdue.length) {
    s.push(`*Overdue*`);
    for (const t of d.overdue) s.push(`• ${t.priority === "P1" ? "🔴 " : ""}${t.assignee ? `${t.assignee}: ` : "nobody assigned: "}*${t.client}* · ${clip(t.title, 70)} · was due ${t.due}${card(t.link)}`);
  }
  if (d.issues.length) {
    s.push(`*Issues (Arun)*`);
    for (const i of d.issues) s.push(`• ${i}`);
  }
  const y = d.yesterday;
  s.push(`*Yesterday* · ${y.created} card${y.created === 1 ? "" : "s"} created · ${y.done} done · ${y.noCard} no card · ${y.reminders} reminder${y.reminders === 1 ? "" : "s"} set`);
  return { headline, detail: s.join("\n") };
}
