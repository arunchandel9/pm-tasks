import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/auth";
import { sql, upsertClient } from "@/lib/db";
import { readConfigTab, sheetsConfigured } from "@/lib/sheets";
import { pulp } from "@/lib/pulp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Every minute (Vercel Cron). Does three things, each isolated so one failing doesn't stop the others:
 *  1. Refresh the client map from the sheet's Config tab.
 *  2. Drain the retry queue (card comments, failed card creates, failed sheet writes, re-queued messages).
 *  3. Poll Pulp for moved cards (until Pulp's own webhook exists).
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return new NextResponse("unauthorized", { status: 401 });
  const report: Record<string, unknown> = {};

  // 1. Client map
  if (sheetsConfigured()) {
    try {
      const { clients, errors } = await readConfigTab();
      for (const c of clients) await upsertClient(c);
      report.clients = { upserted: clients.length, errors };
    } catch (e) { report.clients = { error: (e as Error).message }; }
  }

  // 2. Queue
  const due = await sql()`select id, kind, payload, attempts from queue where done_at is null and next_run_at <= now() order by next_run_at limit 20`;
  let ok = 0, failed = 0;
  for (const job of due) {
    try {
      await runJob(job.kind as string, job.payload as Record<string, unknown>);
      await sql()`update queue set done_at = now() where id = ${job.id}`;
      ok++;
    } catch (e) {
      failed++;
      const attempts = Number(job.attempts) + 1;
      const backoff = Math.min(60 * 2 ** attempts, 3600);
      await sql()`update queue set attempts = ${attempts}, last_error = ${(e as Error).message}, next_run_at = now() + (${backoff} || ' seconds')::interval where id = ${job.id}`;
    }
  }
  report.queue = { ok, failed };

  // 3. Pulp poll
  if (pulp.configured()) {
    try {
      const last = await sql()`select value from settings where key = 'pulp_poll_since'`;
      const since = last.length ? new Date(last[0].value as string) : new Date(Date.now() - 5 * 60 * 1000);
      const moved = await pulp.cardsUpdatedSince(since);
      let synced = 0;
      for (const card of moved) {
        const t = await sql()`select id, list_id, staging from tasks where pulp_card_id = ${card.id}`;
        if (!t.length || t[0].list_id === card.listId) continue;
        const wasStaging = t[0].staging as boolean;
        await sql()`update tasks set list_id = ${card.listId}, staging = false, last_moved_at = now() where id = ${t[0].id}`;
        await sql()`insert into status_events (task_id, from_list, to_list, source) values (${t[0].id}, ${t[0].list_id}, ${card.listId}, 'poll')`;
        if (wasStaging) {
          // Dragging out of Staging counts as approval.
          await sql()`update requests r set status = 'created', decided_by = 'pulp:drag', decided_at = now() from tasks t where t.request_id = r.id and t.id = ${t[0].id} and r.status = 'pending_review'`;
        }
        synced++;
      }
      await sql()`insert into settings (key, value) values ('pulp_poll_since', ${JSON.stringify(new Date().toISOString())}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`;
      report.pulp = { synced };
    } catch (e) { report.pulp = { error: (e as Error).message }; }
  }

  return NextResponse.json(report);
}

async function runJob(kind: string, payload: Record<string, unknown>) {
  switch (kind) {
    case "card_comment": {
      if (!payload.taskId) return;
      const t = await sql()`select pulp_card_id from tasks where id = ${payload.taskId as string}`;
      if (!t.length || !t[0].pulp_card_id) return;
      if (!pulp.configured()) throw new Error("PULP_NOT_CONFIGURED");
      const flag = payload.flag === "client_waiting" ? "⏳ Client is waiting on this.\n" : "";
      await pulp.addComment(t[0].pulp_card_id as string, `${flag}${payload.text as string}${payload.permalink ? `\n${payload.permalink}` : ""}`);
      if (payload.flag === "client_waiting") await sql()`update tasks set waiting_on_client_since = null where id = ${payload.taskId as string}`;
      return;
    }
    case "process_message": {
      // Re-run of a stored message (after pause, or "Make it a task"). Rebuilt from the stored raw payload.
      const { processMessage } = await import("@/lib/pipeline");
      const rows = await sql()`select * from messages where id = ${payload.messageId as string}`;
      if (!rows.length) return;
      const r = rows[0];
      await sql()`delete from messages where id = ${r.id}`; // processMessage re-inserts idempotently
      await processMessage({
        channel: r.channel, externalId: r.external_id, teamId: (r.raw as { team?: string } | null)?.team ?? null, clientId: r.client_id, scope: r.scope, sender: r.sender,
        senderIsStaff: r.sender_is_staff, sentAt: new Date(r.sent_at), text: r.text, permalink: r.permalink, threadRef: r.thread_ref, raw: r.raw,
      }, { skip: false, reason: null });
      return;
    }
    case "reply_check": {
      // Has a MangoEyes person replied in the same channel (or thread) since the client's message? If not, one nudge.
      const rows = await sql()`select m.*, c.name as client_name from messages m left join clients c on c.id = m.client_id where m.id = ${payload.messageId as string}`;
      if (!rows.length) return;
      const m = rows[0];
      const channelId = String(m.external_id).split(":")[0];
      const replied = await sql()`
        select 1 from messages r where r.channel = 'slack' and r.sender_is_staff and r.sent_at > ${m.sent_at}
          and split_part(r.external_id, ':', 1) = ${channelId} limit 1`;
      if (replied.length) return;
      // One nudge per channel per window, however many messages the client sent.
      const last = await sql()`select value from settings where key = ${"reply_nudged:" + channelId}`;
      const { noise: noiseCfg } = await import("@/lib/config");
      if (last.length && Date.now() - new Date(last[0].value as string).getTime() < noiseCfg().reply_nudge_minutes * 60 * 1000) return;
      await sql()`insert into settings (key, value) values (${"reply_nudged:" + channelId}, ${JSON.stringify(new Date().toISOString())}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`;
      const { postText } = await import("@/lib/review");
      const { noise } = await import("@/lib/config");
      const mins = noise().reply_nudge_minutes;
      const quote = String(m.text).replace(/\s+/g, " ").slice(0, 160);
      await postText(`⏰ *${m.client_name ?? "A client"}* wrote ${mins} min ago in their Slack and nobody from the team has replied yet: "${quote}${String(m.text).length > 160 ? "…" : ""}"${m.permalink ? `\n${m.permalink}` : ""}`);
      return;
    }
    case "create_card":
    case "sync_sheet":
      // Both are re-driven by approveRequest; a retry simply re-approves.
      {
        const { approveRequest } = await import("@/lib/tasks");
        const rid = payload.requestId ?? (await sql()`select request_id from tasks where id = ${payload.taskId as string}`)[0]?.request_id;
        if (rid) await approveRequest(rid as string, "system:retry");
      }
      return;
    default:
      throw new Error(`unknown job kind ${kind}`);
  }
}
