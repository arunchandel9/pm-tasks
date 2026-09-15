/**
 * The daily brief for the feed: one headline line at the top level, the detail as one reply in its thread, so it
 * takes one line of the feed and reads in under a minute. Only what a PM acts on: new cards, what waits on a person,
 * issues, overdue hub cards, done. Empty sections are left out; sheet history is never counted as "today".
 * (The MCP `daily_summary` tool keeps its fuller text in hub.ts.)
 */
import { sql } from "./db";
import { pulp } from "./pulp";

export interface BriefData {
  day: string;
  newToday: Array<{ client: string; title: string; link: string | null; priority: string; hold: boolean }>;
  stale: Array<{ client: string; title: string; days: number; link: string | null }>;
  questions: Array<{ text: string; source: string; why: string }>;
  waitingOnClient: Array<{ client: string; title: string; days: number }>;
  issues: string[];
  overdue: Array<{ client: string; title: string; priority: string; due: string; link: string | null }>;
  done: Array<{ client: string; title: string }>;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const link = (boardId: unknown, cardId: unknown) => (cardId ? pulp.cardUrl(String(boardId ?? ""), String(cardId)) : null);
const card = (l: string | null) => (l ? ` · <${l}|card>` : "");
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

export async function collectBrief(): Promise<BriefData> {
  const day = new Date().toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
  const newToday = (await sql()`
    select coalesce(c.name,'Internal') as client, t.title, t.board_id, t.pulp_card_id, t.priority, t.staging
    from tasks t left join clients c on c.id = t.client_id
    where t.origin = 'hub' and t.created_at > now() - interval '1 day' order by t.priority, c.name`)
    .map((r) => ({ client: String(r.client), title: String(r.title), link: link(r.board_id, r.pulp_card_id), priority: String(r.priority), hold: !!r.staging }));
  const stale = (await sql()`
    select coalesce(c.name,'Unknown') as client, t.title, t.board_id, t.pulp_card_id, extract(day from now() - t.created_at)::int as days
    from tasks t left join clients c on c.id = t.client_id
    where t.origin = 'hub' and t.staging = true and t.completed_at is null and t.created_at < now() - interval '1 day' order by t.created_at`)
    .map((r) => ({ client: String(r.client), title: String(r.title), days: Number(r.days), link: link(r.board_id, r.pulp_card_id) }));
  // Questions nobody answered: a real message (three words or more), not a stray "ok" or "test".
  const questions = (await sql()`
    select left(m.text, 70) as text, m.channel, m.sender, m.skip_reason from messages m
    where m.skip_reason in ('unknown_client','attachment_only','client_unhappy') and m.created_at > now() - interval '3 days'
      and (m.skip_reason <> 'unknown_client' and m.created_at > now() - interval '1 day' or array_length(regexp_split_to_array(trim(m.text), '\s+'), 1) >= 3)
    order by m.created_at desc limit 10`)
    .map((r) => ({ text: String(r.text), source: `${{ slack: "Slack", intake: "Task Hub", email: "Email", meet: "Meeting" }[String(r.channel)] ?? String(r.channel)}, ${String(r.sender).replace(/<[^>]+>/, "").trim()}`, why: r.skip_reason === "attachment_only" ? "image only, needs the ask typed" : r.skip_reason === "client_unhappy" ? "client sounded unhappy, reply needed:" : "which client?" }));
  // Clients still waiting for a reply in Slack (no team reply, not acknowledged).
  try {
    const { unansweredClientMessages } = await import("./slack-replies");
    for (const u of await unansweredClientMessages(5)) {
      const age = u.minutes >= 1440 ? `${Math.round(u.minutes / 1440)} d` : u.minutes >= 60 ? `${Math.round(u.minutes / 60)} h` : `${u.minutes} min`;
      questions.push({ text: clip(u.text.replace(/\s+/g, " "), 70), source: `Slack, ${u.sender}`, why: `no reply from the team for ${age} (${u.client}):` });
    }
  } catch (e) { console.error("unanswered check failed", (e as Error).message); }
  const waitingOnClient = (await sql()`
    select coalesce(c.name,'Internal') as client, t.title, extract(day from now() - t.waiting_on_client_since)::int as days
    from tasks t left join clients c on c.id = t.client_id where t.waiting_on_client_since is not null and t.completed_at is null order by t.waiting_on_client_since`)
    .map((r) => ({ client: String(r.client), title: String(r.title), days: Number(r.days) }));

  const issues: string[] = [];
  for (const r of await sql()`select coalesce(c.name,'Unknown') as client, left(m.text, 50) as text, m.skip_reason from messages m left join clients c on c.id = m.client_id
      where m.skip_reason in ('failed','transcription_failed') and m.created_at > now() - interval '1 day'`)
    issues.push(`${r.skip_reason === "transcription_failed" ? "Voice note could not be transcribed" : "Message could not be processed"}: ${r.client} · "${r.text}"`);
  for (const r of await sql()`select coalesce(c.name,'Unknown') as client, t.title from tasks t left join clients c on c.id = t.client_id
      where t.origin = 'hub' and t.pulp_card_id is null and t.completed_at is null and t.created_at < now() - interval '10 minutes' and t.created_at > now() - interval '7 days'`)
    issues.push(`No Pulp card yet: ${r.client} · ${r.title}`);
  for (const r of await sql()`select kind, left(coalesce(last_error,''), 80) as err from queue where last_error like 'abandoned:%' and done_at > now() - interval '1 day' limit 5`)
    issues.push(`Background step gave up: ${r.kind} · ${String(r.err).replace(/^abandoned:\s*/, "")}`);
  const polls = await sql()`select key, value from settings where key in ('gmail_poll_last','chat_inbox_last','meet_poll_last','pulp_poll_last','sheet_cards_last','tick_last')`;
  const names: Record<string, string> = { gmail_poll_last: "Mailbox", chat_inbox_last: "Task Hub Drop", meet_poll_last: "Meet notes", pulp_poll_last: "Pulp", sheet_cards_last: "Sheet cards" };
  for (const p of polls) {
    if (p.key === "tick_last") { const age = (Date.now() - new Date(String(p.value)).getTime()) / 60000; if (age > 5) issues.push(`The minute loop last ran ${Math.round(age)} min ago`); continue; }
    const errs = (p.value as { errors?: string[] } | null)?.errors ?? [];
    if (errs.length) issues.push(`${names[String(p.key)]} read failed: ${clip(String(errs[0]), 90)}`);
  }

  const overdue = (await sql()`
    select coalesce(c.name,'Internal') as client, t.title, t.priority, t.board_id, t.pulp_card_id, to_char(t.due_at,'Dy DD Mon') as due
    from tasks t left join clients c on c.id = t.client_id
    where t.origin = 'hub' and t.completed_at is null and t.staging = false and t.due_at < now()
    order by case when t.priority = 'P1' then 0 when t.priority = 'P2' then 1 else 2 end, t.due_at`)
    .map((r) => ({ client: String(r.client), title: String(r.title), priority: String(r.priority), due: String(r.due), link: link(r.board_id, r.pulp_card_id) }));
  const done = (await sql()`
    select coalesce(c.name,'Internal') as client, t.title from tasks t left join clients c on c.id = t.client_id
    where t.origin = 'hub' and t.completed_at > now() - interval '1 day' order by c.name`)
    .map((r) => ({ client: String(r.client), title: String(r.title) }));
  return { day, newToday, stale, questions, waitingOnClient, issues, overdue, done };
}

/** Headline for the feed (one line) and the detail for its thread (null when there is nothing to say). */
export function renderBrief(d: BriefData): { headline: string; detail: string | null } {
  const waiting = d.stale.length + d.questions.length;
  const counts = [
    d.newToday.length ? plural(d.newToday.length, "new") : null,
    waiting ? `${waiting} waiting on you` : null,
    d.issues.length ? plural(d.issues.length, "issue") : null,
    d.overdue.length ? `${d.overdue.length} overdue` : null,
    d.done.length ? `${d.done.length} done` : null,
  ].filter(Boolean);
  const title = `📋 *Daily brief · ${d.day}*`;
  if (!counts.length) return { headline: `${title} · quiet day: nothing new, nothing waiting, no issues.`, detail: null };
  const headline = `${title} · ${counts.join(" · ")}${waiting || d.issues.length ? " · details in the thread" : ""}`;

  const s: string[] = [];
  if (d.newToday.length) {
    s.push(`*New today (${d.newToday.length})*`);
    for (const t of d.newToday.slice(0, 10)) s.push(`• ${t.priority === "P1" ? "🔴 " : ""}${t.client} · ${clip(t.title, 70)}${t.hold ? " · in Staging" : ""}${card(t.link)}`);
    if (d.newToday.length > 10) s.push(`• … and ${d.newToday.length - 10} more (ask the hub)`);
  }
  if (waiting) {
    s.push(`*Waiting on you (${waiting})*`);
    if (d.stale.length) {
      s.push(`• ${plural(d.stale.length, "card")} in Staging for more than a day: drag them where they belong, or delete.`);
      for (const t of d.stale.slice(0, 3)) s.push(`   ${t.client} · ${clip(t.title, 60)} · ${t.days} d${card(t.link)}`);
      if (d.stale.length > 3) s.push(`   … and ${d.stale.length - 3} more`);
    }
    for (const q of d.questions.slice(0, 3)) s.push(`• ${q.why} "${clip(q.text, 60)}" (${q.source})`);
    if (d.questions.length > 3) s.push(`• … and ${d.questions.length - 3} more questions`);
  }
  if (d.waitingOnClient.length) {
    s.push(`*Waiting on a client (${d.waitingOnClient.length})*`);
    for (const t of d.waitingOnClient.slice(0, 3)) s.push(`• ${t.client} · ${clip(t.title, 60)} · ${t.days} d`);
  }
  if (d.issues.length) {
    s.push(`*Issues (${d.issues.length})*`);
    for (const i of d.issues.slice(0, 5)) s.push(`• ${i}`);
  }
  if (d.overdue.length) {
    s.push(`*Overdue (${d.overdue.length})*`);
    for (const t of d.overdue.slice(0, 5)) s.push(`• ${t.priority === "P1" ? "🔴 " : ""}${t.client} · ${clip(t.title, 60)} · due ${t.due}${card(t.link)}`);
    if (d.overdue.length > 5) s.push(`• … and ${d.overdue.length - 5} more (ask the hub)`);
  }
  if (d.done.length) {
    s.push(`*Done today (${d.done.length})*`);
    if (d.done.length <= 5) for (const t of d.done) s.push(`• ${t.client} · ${clip(t.title, 60)}`);
  }
  return { headline, detail: s.join("\n") };
}
