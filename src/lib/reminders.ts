import { sql } from "./db";
import * as gchat from "./gchat";
import { rememberThread, postText, sourceLabel } from "./review";
import { parseWhen, daysFromNow, whenLabel, isMorningMinute } from "./when";
import type { Message } from "./types";

/**
 * A reminder belongs to the person who asked for it ("remind me tomorrow", or "Remind me instead" on a proposal).
 * It comes back in the feed at its time, @mentioning them, with a Done button; unanswered, it comes back every
 * morning (10:00 India) until Done. A client never gets a reminder set: their waiting is covered by the Slack
 * reply reminders. Decision 2026-09-22.
 */

export const DEFAULT_DAYS = 1; // "remind me" with no day means tomorrow at 10:00 (Arun, 2026-09-23: a default must be certain)
export { createReminder, mention } from "./reminders-util";
import { createReminder, mention } from "./reminders-util";
export type { ReminderInput } from "./reminders-util";

/** The due moment from the sender's words, else tomorrow at 10:00. */
export function dueFromWords(words: string | null | undefined, now = new Date()): Date {
  return parseWhen(words, now) ?? daysFromNow(now, DEFAULT_DAYS);
}

/** The line the owner sees: who it is for, what, and what to do. */
export function reminderLine(r: { ownerName: string; ownerUser?: string | null; text: string; dueAt: Date; clientName?: string | null; repeat?: boolean }): string {
  const who = mention(r);
  const client = r.clientName ? `*${r.clientName}* · ` : "";
  return `⏰ ${who}: ${r.repeat ? "still open, " : ""}reminder you asked for · ${client}${r.text} · press Done when handled`;
}

async function clientName(clientId: string | null | undefined): Promise<string | null> {
  if (!clientId) return null;
  const r = await sql()`select name from clients where id = ${clientId}`;
  return r.length ? String(r[0].name) : null;
}

/** Post one reminder: the line with the @mention, then the Done button in its thread. */
export async function postReminder(id: string, repeat: boolean): Promise<void> {
  const r = (await sql()`select * from reminders where id = ${id}`)[0];
  if (!r || r.done_at) return;
  const threadKey = String(r.thread_key ?? `rem-${id}`);
  const line = reminderLine({ ownerName: String(r.owner_name), ownerUser: r.owner_user as string | null, text: String(r.text), dueAt: new Date(String(r.due_at)), clientName: await clientName(r.client_id as string | null), repeat });
  let postName: string | null = null;
  if (gchat.gchatConfigured()) {
    postName = await gchat.sendText(gchat.reviewSpace(), line, undefined, threadKey);
    try {
      const sent = await gchat.sendCard(gchat.reviewSpace(), gchat.doneCard({ reminderId: id }), "Done?", `remdone-${id}-${Date.now()}`, threadKey);
      await rememberThread(sent.thread, { kind: "reminder", reminderId: id });
      await sql()`update reminders set last_posted_at = now(), post_name = ${sent.name ?? postName}, thread_key = ${threadKey} where id = ${id}`;
      return;
    } catch (e) { console.error("done card failed", (e as Error).message); }
  } else await postText(line, { threadKey });
  await sql()`update reminders set last_posted_at = now(), post_name = ${postName}, thread_key = ${threadKey} where id = ${id}`;
}

/**
 * Called every minute: a reminder posts once when its time comes, then again each morning until Done.
 * Returns how many were posted, for the tick report.
 */
export async function postDueReminders(now = new Date()): Promise<{ posted: number; errors: string[] }> {
  const out = { posted: 0, errors: [] as string[] };
  const morning = isMorningMinute(now);
  const due = await sql()`select id, last_posted_at from reminders where done_at is null and due_at <= ${now.toISOString()}
    and (last_posted_at is null or (${morning} and last_posted_at < now() - interval '20 hours')) order by due_at limit 30`;
  for (const r of due) {
    try { await postReminder(String(r.id), !!r.last_posted_at); out.posted++; }
    catch (e) { out.errors.push(`reminder ${String(r.id).slice(0, 8)}: ${(e as Error).message.slice(0, 120)}`); }
  }
  return out;
}

export async function markReminderDone(id: string, who: string): Promise<string> {
  const r = await sql()`update reminders set done_at = now(), done_by = ${who} where id = ${id} and done_at is null returning text`;
  return r.length ? `✅ Done · ${who} · ${whenLabel(new Date(), true)} · ${String(r[0].text)}` : `Already marked done.`;
}

/** A typed day in the reminder's thread moves it: "Friday", "next week", "tomorrow 4pm". */
export async function moveReminder(id: string, words: string, who: string): Promise<string | null> {
  const when = parseWhen(words);
  if (!when) return null;
  await sql()`update reminders set due_at = ${when.toISOString()}, last_posted_at = null where id = ${id} and done_at is null`;
  return `⏰ Moved to ${whenLabel(when, true)} · by ${who}`;
}

/** From a message: "remind me on Friday to chase the GP" → a reminder for the sender. */
export async function reminderFromMessage(p: { m: Message; messageId: string; text: string; remindAt: string | null; requestId?: string | null }): Promise<{ id: string; dueAt: Date }> {
  const senderUser = ((p.m.raw as { senderUser?: string } | null)?.senderUser ?? (p.m.channel === "email" ? p.m.sender.match(/<([^>]+)>/)?.[1] : null)) ?? null;
  const dueAt = dueFromWords(p.remindAt ?? p.text, new Date());
  return createReminder({ messageId: p.messageId, requestId: p.requestId ?? null, clientId: p.m.clientId, ownerName: senderName(p.m), ownerUser: senderUser, text: p.text, dueAt });
}

/** "Heena Ganotra <heena@…>" → "Heena Ganotra"; "Anuj via Claude-Arun" stays. */
export const senderName = (m: Message): string => m.sender.replace(/\s*<[^>]+>\s*$/, "").trim() || sourceLabel(m);

/** Open reminders for the brief: whose, what, since when. */
export async function openReminders(): Promise<Array<{ id: string; ownerName: string; ownerUser: string | null; text: string; dueAt: Date; client: string | null }>> {
  const rows = await sql()`select r.id, r.owner_name, r.owner_user, r.text, r.due_at, c.name as client from reminders r left join clients c on c.id = r.client_id
    where r.done_at is null and r.due_at <= now() order by r.due_at`;
  return rows.map((r) => ({ id: String(r.id), ownerName: String(r.owner_name), ownerUser: (r.owner_user as string | null) ?? null, text: String(r.text), dueAt: new Date(String(r.due_at)), client: (r.client as string | null) ?? null }));
}
