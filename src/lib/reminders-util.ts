/** Small pieces shared by the proposal and reminder modules, kept apart so neither imports the other's Chat side. */
import { sql } from "./db";
import { daysFromNow } from "./when";

export const daysFromNowMorning = (now: Date, days: number) => daysFromNow(now, days);

export interface ReminderInput { messageId?: string | null; requestId?: string | null; clientId?: string | null; ownerName: string; ownerUser?: string | null; text: string; dueAt: Date; threadKey?: string | null }

export async function createReminder(r: ReminderInput): Promise<{ id: string; dueAt: Date }> {
  const rows = await sql()`insert into reminders (message_id, request_id, client_id, owner_name, owner_user, text, due_at, thread_key)
    values (${r.messageId ?? null}, ${r.requestId ?? null}, ${r.clientId ?? null}, ${r.ownerName}, ${r.ownerUser ?? null}, ${r.text}, ${r.dueAt.toISOString()}, ${r.threadKey ?? null}) returning id`;
  return { id: String(rows[0].id), dueAt: r.dueAt };
}

/**
 * `<users/123>` when the hub knows the person's Chat account (Chat renders it as a real @mention that notifies them),
 * else "@Name" as plain text. Only a numeric Chat id is used: an email inside <users/…> is not guaranteed to render.
 */
export function mention(p: { ownerUser?: string | null; ownerName: string }): string {
  const u = (p.ownerUser ?? "").trim();
  if (/^users\/\d+$/.test(u)) return `<${u}>`;
  return `@${p.ownerName.replace(/\s*<[^>]+>\s*$/, "")}`;
}
