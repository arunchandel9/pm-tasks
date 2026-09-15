/**
 * Re-run a stored message right now: after a client was picked or typed, "Make it a task", a long transcript arriving,
 * or a pause lifting. Used inline from the Chat and Slack handlers (so the person sees the result in seconds) and by
 * the queue job as the fallback. The stored row is updated in place (never deleted), so a run that dies leaves the
 * message for the watchdog rather than losing it.
 */
import { sql } from "./db";
import { processMessage } from "./pipeline";
import { postAck, humanOutcome, askWhichClient } from "./review";
import { sendText } from "./gchat";
import type { Message } from "./types";

export async function reprocessMessage(messageId: string): Promise<void> {
  const rows = await sql()`select * from messages where id = ${messageId}`;
  if (!rows.length) return;
  const r = rows[0];
  const m: Message = {
    channel: r.channel as Message["channel"], externalId: String(r.external_id), teamId: (r.raw as { team?: string } | null)?.team ?? null, clientId: (r.client_id as string | null) ?? null,
    scope: r.scope as Message["scope"], sender: String(r.sender), senderIsStaff: !!r.sender_is_staff, sentAt: new Date(r.sent_at as string), text: String(r.text),
    permalink: (r.permalink as string | null) ?? null, threadRef: (r.thread_ref as string | null) ?? null, raw: r.raw,
  };
  const result = await processMessage(m, { skip: false, reason: null }, { rerun: true });
  if (m.channel === "intake" || m.channel === "task_cmd") {
    const n = result.requestIds?.length ?? 0;
    if (!(result.outcome === "review" && n)) {
      const threadRef = typeof m.threadRef === "string" && m.threadRef.includes("/threads/") ? m.threadRef : null;
      if (threadRef) {
        // The sender's own thread, same as the live path: the feed carries finals only.
        const line = result.reason === "unknown_client" ? askWhichClient({ text: m.text, raw: m.raw }) : `Nothing created: ${humanOutcome(result.outcome, result.reason)}`;
        await sendText(threadRef.split("/threads/")[0], line, threadRef);
      } else await postAck({ message: m, outcome: result.outcome, detail: humanOutcome(result.outcome, result.reason) });
    }
  }
}

/** Run now in the background of a web request; the queue is the fallback if the request dies first. */
export function reprocessSoon(messageId: string, waitUntil: (p: Promise<unknown>) => void): void {
  waitUntil(reprocessMessage(messageId).catch(async (e) => {
    console.error("reprocess failed, queued", (e as Error).message);
    await sql()`insert into queue (kind, payload, next_run_at) values ('process_message', ${JSON.stringify({ messageId })}::jsonb, now())`;
  }));
}
