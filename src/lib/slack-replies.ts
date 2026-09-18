import { sql, enqueue } from "./db";
import { noise } from "./config";
import * as gchat from "./gchat";
import { postFeed, rememberThread, sourceLabel } from "./review";
import type { Message } from "./types";

/**
 * A client wrote in their Slack and nobody from MangoEyes has replied. Reminders go to the feed at the marks in
 * `reply_nudge_minutes` (20 min, 1 hour, 1 day): one headline each, the client's words and an "Acknowledged" button in
 * its thread. Any staff reply in that channel clears the rest; so does the button, or "ack" / "handled" typed in the
 * thread. One reminder per channel per mark, however many messages the client sent.
 */

export const ACK_WORDS = /\b(ack|acknowledged?|handled|replied|answered|done|sorted|dealt with|on it|taken care)\b/i;

export function markLabel(mins: number): string {
  if (mins >= 1440) return `${Math.round(mins / 1440)} day${mins >= 2880 ? "s" : ""}`;
  if (mins >= 60) return `${Math.round(mins / 60)} hour${mins >= 120 ? "s" : ""}`;
  return `${mins} min`;
}

/** `💬 *Abela* · no reply for 20 min · Slack`: the headline says only what the thread is about; words, names and the link are inside. */
export function reminderHeadline(p: { clientName: string; mins: number }): string {
  const icon = p.mins >= 1440 ? "🔴" : p.mins >= 60 ? "⏰" : "💬";
  return `${icon} *${p.clientName}* · no reply for ${markLabel(p.mins)} · Slack`;
}

const ackKey = (channelId: string) => `reply_acked:${channelId}`;

/** Mark a channel as handled from this moment: reminders for messages before it stop. */
export async function acknowledgeReplies(channelId: string, who: string): Promise<void> {
  await sql()`insert into settings (key, value) values (${ackKey(channelId)}, ${JSON.stringify({ at: new Date().toISOString(), who })}::jsonb)
    on conflict (key) do update set value = excluded.value, updated_at = now()`;
}

async function ackedAfter(channelId: string, sentAt: Date): Promise<boolean> {
  const r = await sql()`select value from settings where key = ${ackKey(channelId)}`;
  if (!r.length) return false;
  const at = (r[0].value as { at?: string } | null)?.at;
  return !!at && new Date(at).getTime() >= sentAt.getTime();
}

async function staffRepliedSince(channelId: string, sentAt: Date): Promise<boolean> {
  const r = await sql()`select 1 from messages r where r.channel = 'slack' and r.sender_is_staff and r.sent_at > ${sentAt.toISOString()}
    and split_part(r.external_id, ':', 1) = ${channelId} limit 1`;
  return r.length > 0;
}

/** Messages that never need a reply: acknowledgements and the like, filtered before any model call, or judged closing by the model. */
const CLOSED_REASONS = new Set(["acknowledgement", "too_short", "bot_message", "dismissed_by_human", "exact_duplicate", "likely_duplicate"]);

/** After the last configured mark the reminder repeats daily until someone replies or acknowledges. */
export function nextMark(mins: number, marks: number[]): number | null {
  const sorted = [...marks].sort((a, b) => a - b);
  const i = sorted.indexOf(mins);
  if (i >= 0 && i < sorted.length - 1) return sorted[i + 1];
  return mins + 1440;
}

/** The `reply_check` queue job: due `mins` minutes after a client's Slack message. */
export async function replyCheck(messageId: string, mins: number): Promise<"replied" | "acked" | "already" | "posted" | "gone" | "closed"> {
  const rows = await sql()`select m.*, c.name as client_name from messages m left join clients c on c.id = m.client_id where m.id = ${messageId}`;
  if (!rows.length) return "gone";
  const m = rows[0];
  const raw = (m.raw as { mentions?: string[]; needsReply?: boolean } | null) ?? {};
  const reason = String(m.skip_reason ?? "");
  if (CLOSED_REASONS.has(reason) || reason.startsWith("subtype:") || raw.needsReply === false) return "closed";
  const sentAt = new Date(m.sent_at as string);
  const channelId = String(m.external_id).split(":")[0];
  if (await staffRepliedSince(channelId, sentAt)) return "replied";
  if (await ackedAfter(channelId, sentAt)) return "acked";
  // Past the last mark: come back tomorrow, and every day, until a reply or an acknowledgement.
  const marks = noise().reply_nudge_minutes;
  if (mins >= Math.max(...marks)) await enqueue("reply_check", { messageId, mins: mins + 1440 }, 1440 * 60);
  // One reminder per channel per mark, however many messages the client sent in that window; from a day on, one a day.
  const key = `reply_nudged:${channelId}:${mins >= 1440 ? "daily" : mins}`;
  const last = await sql()`select value from settings where key = ${key}`;
  if (last.length && Date.now() - new Date(last[0].value as string).getTime() < Math.min(mins, 1440) * 60 * 1000) return "already";
  await sql()`insert into settings (key, value) values (${key}, ${JSON.stringify(new Date().toISOString())}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`;

  const tagged = (raw.mentions ?? []).filter(Boolean);
  const msg: Message = { channel: "slack", externalId: String(m.external_id), teamId: null, clientId: m.client_id as string | null, scope: "client", sender: String(m.sender), senderIsStaff: false, sentAt, text: String(m.text), permalink: (m.permalink as string | null) ?? null, threadRef: null, raw: m.raw };
  const clientName = String(m.client_name ?? "A client");
  const headline = reminderHeadline({ clientName, mins });
  const detail = [
    `${sourceLabel(msg).replace(" · ", ", ")}: "${String(m.text).trim()}"`,
    tagged.length ? `Tagged: ${tagged.join(", ")}` : "",
    m.permalink ? `<${m.permalink}|Open in Slack>` : "",
    "Reply in Slack and the reminders stop. Or mark it acknowledged below (or type \"ack\" here).",
  ].filter(Boolean).join("\n");
  const threadKey = `nudge-${messageId}-${mins}`;
  await postFeed({ headline, detail, threadKey });
  try {
    const sent = await gchat.sendCard(gchat.reviewSpace(), gchat.ackCard({ messageId, channelId, clientName }), "Acknowledged?", `ack-${messageId}-${mins}`, threadKey);
    await rememberThread(sent.thread, { kind: "nudge", messageId, channelId });
  } catch (e) { console.error("ack card failed", (e as Error).message); }
  return "posted";
}

/** Client Slack messages still waiting for a team reply (for the brief): older than the first mark, not acknowledged. */
export async function unansweredClientMessages(limit = 10): Promise<Array<{ client: string; text: string; sender: string; minutes: number; permalink: string | null }>> {
  const first = Math.min(...(noise().reply_nudge_minutes.length ? noise().reply_nudge_minutes : [20]));
  const rows = await sql()`
    select m.id, m.text, m.sender, m.sent_at, m.permalink, split_part(m.external_id, ':', 1) as channel_id, coalesce(c.name, 'Unknown') as client,
           extract(epoch from now() - m.sent_at)::int / 60 as minutes
    from messages m left join clients c on c.id = m.client_id
    where m.channel = 'slack' and not m.sender_is_staff and m.scope = 'client'
      and m.sent_at < now() - (${first} || ' minutes')::interval and m.sent_at > now() - interval '3 days'
      and coalesce(m.skip_reason, '') not in ('bot_message', 'acknowledgement', 'too_short', 'dismissed_by_human', 'exact_duplicate', 'likely_duplicate')
      and coalesce(m.skip_reason, '') not like 'subtype:%' and coalesce(m.raw->>'needsReply', 'true') <> 'false'
      and not exists (select 1 from messages r where r.channel = 'slack' and r.sender_is_staff and r.sent_at > m.sent_at and split_part(r.external_id, ':', 1) = split_part(m.external_id, ':', 1))
      and not exists (select 1 from settings s where s.key = 'reply_acked:' || split_part(m.external_id, ':', 1) and (s.value->>'at')::timestamptz >= m.sent_at)
    order by m.sent_at asc limit ${limit}`;
  return rows.map((r) => ({ client: String(r.client), text: String(r.text), sender: String(r.sender), minutes: Number(r.minutes), permalink: (r.permalink as string | null) ?? null }));
}
