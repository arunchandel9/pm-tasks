import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/auth";
import { sql, upsertClient, enqueue } from "@/lib/db";
import { readConfigTab, sheetsConfigured } from "@/lib/sheets";
import { pulp, isDoneList } from "@/lib/pulp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120; // a round that reads meeting notes (model call, feed posts) must never be cut short

/**
 * Every minute (Vercel Cron). Does three things, each isolated so one failing doesn't stop the others:
 *  1. Refresh the client map from the sheet's Config tab.
 *  2. Drain the retry queue (card comments, failed card creates, failed sheet writes, re-queued messages).
 *  3. Poll Pulp for moved cards (until Pulp's own webhook exists).
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return new NextResponse("unauthorized", { status: 401 });
  const report: Record<string, unknown> = {};
  const started = Date.now();
  const elapsed = () => Date.now() - started;

  // 1. Client map
  if (sheetsConfigured()) {
    try {
      const { clients, errors } = await readConfigTab();
      for (const c of clients) await upsertClient(c);
      report.clients = { upserted: clients.length, errors };
    } catch (e) { report.clients = { error: (e as Error).message }; }
  }

  // 1a. Sheet → hub mirror every 10 minutes (history and hand-added rows), so the MCP hub answers from the PMs' record.
  if (sheetsConfigured() && new Date().getMinutes() % 10 === 0) {
    try {
      const { syncSheet } = await import("@/lib/sheet-sync");
      const r = await syncSheet();
      report.sheetSync = { tabs: Object.keys(r.tabs).length, imported: Object.values(r.tabs).reduce((a, t) => a + t.imported, 0), errors: r.errors };
    } catch (e) { report.sheetSync = { error: (e as Error).message }; }
  }

  // 1c. Meeting notes are read by /api/meet-tick (every 5 minutes, its own budget), not here.

  // 1b. Mailbox
  {
    const { gmailConfigured, pollMailbox } = await import("@/lib/gmail");
    if (gmailConfigured()) {
      try { report.gmail = await pollMailbox(); } catch (e) { report.gmail = { error: (e as Error).message }; }
    }
  }

  // 1c. The Drop space is read by /api/inbox-tick (three times a minute), not here.

  // 2. Queue
  const due = await sql()`select id, kind, payload, attempts from queue where done_at is null and next_run_at <= now() order by next_run_at limit 20`;
  let ok = 0, failed = 0;
  for (const job of due) {
    // The minute has a budget: a job that is long (a meeting group, a transcription) leaves the rest for the next minute
    // rather than pushing this run past its limit and losing the Pulp poll and the heartbeat with it.
    if (elapsed() > 50_000) { report.queueDeferred = due.length - ok - failed; break; }
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

  // 3. Pulp poll: each hub card is fetched by id (GET /cards/{id}); the board-cards list is capped at 1000 and the
  //    sprint boards are bigger than that. A card whose list differs from ours has been moved. The sheet is reconciled
  //    independently: the status the sheet last got (settings sheet_stage:<task>) is compared with the card's current
  //    list, so a failed write is retried and nothing is lost.
  //    Cost (2026-09-18): Vercel bills the function for every second it is alive, and fetching 80 cards one after
  //    another kept it alive most of the minute. Cards are fetched ten at a time, and only Staging cards every minute;
  //    a card already out of Staging is looked at every two minutes (its move is a status change, not an approval).
  if (pulp.configured()) {
    const errors: string[] = [];
    const seen: Array<Record<string, unknown>> = [];
    let synced = 0, sheetUpdates = 0, checked = 0;
    try {
      const { sheetsConfigured, updateTaskCells, sheetConfig, locateTaskRow, moveRowBelowDivider } = await import("@/lib/sheets");
      const { moveOutcome, sheetIsManual, cardChangedBoard, writeSheetRow, approveRequest } = await import("@/lib/tasks");
      const { fetchCards } = await import("@/lib/sheet-cards");
      const ours = await sql()`select t.id, t.pulp_card_id, t.list_id, t.staging, t.title, t.board_id, t.sheet_row, c.name as client_name, tab.value as tab, st.value as sheet_stage
        from tasks t left join clients c on c.id = t.client_id left join settings tab on tab.key = 'sheet_tab:' || t.id::text left join settings st on st.key = 'sheet_stage:' || t.id::text
        where t.pulp_card_id is not null and t.origin = 'hub' and (t.completed_at is null or t.completed_at > now() - interval '7 days')
          and (t.staging or t.pulp_checked_at is null or t.pulp_checked_at < now() - interval '2 minutes')
        order by t.pulp_checked_at asc nulls first, t.last_moved_at asc nulls first limit 150`;
      if (ours.length) await sql()`update tasks set pulp_checked_at = now() where id = any(${ours.map((t) => String(t.id))}::uuid[])`;
      for await (const { row: t, card, error } of fetchCards(ours, () => elapsed() > 95_000)) {
        if (error === "timeout") { errors.push(`stopped after ${checked} cards: out of time this minute`); break; }
        if (!card) {
          if (/→ 404/.test(error ?? "")) { seen.push({ title: String(t.title).slice(0, 40), found: false }); continue; } // archived or deleted in Pulp: leave the sheet as it is
          errors.push(`card ${String(t.title).slice(0, 40)}: ${(error ?? "").slice(0, 160)}`); continue;
        }
        checked++;
        const listName = card.listName ?? (await pulp.listsOnBoard(card.boardId)).find((l) => l.id === card.listId)?.name ?? card.listId;
        const done = isDoneList(listName);
        const boardChanged = !!card.boardId && card.boardId !== t.board_id;
        seen.push({ title: String(t.title).slice(0, 40), listName, done, tab: t.tab ?? null, sheetStage: t.sheet_stage ?? null, moved: card.listId !== t.list_id, boardChanged });

        if (card.listId !== t.list_id) {
          const wasStaging = t.staging as boolean;
          // Moved to another board (Development Staging → Writers To Do, PMs board → SEO): the department follows the board.
          if (boardChanged) {
            try { await cardChangedBoard(String(t.id), card.id, card.boardId, (t.client_name as string | null) ?? null); t.board_id = card.boardId; }
            catch (e) { errors.push(`board ${String(t.title).slice(0, 40)}: ${(e as Error).message.slice(0, 160)}`); }
          }
          await sql()`update tasks set list_id = ${card.listId}, staging = false, last_moved_at = now() where id = ${t.id}`;
          await sql()`insert into status_events (task_id, from_list, to_list, source) values (${t.id}, ${t.list_id}, ${card.listId}, 'poll')`;
          if (done) await sql()`update tasks set completed_at = now() where id = ${t.id} and completed_at is null`;
          else await sql()`update tasks set completed_at = null where id = ${t.id}`; // moved back out of Done
          // Dragging out of Staging is the approval, wherever the card went. The sheet row is written the first time
          // the card sits on a board whose rows the hub writes: at once on a department board, later for a PMs-board
          // card once it is moved to a department board (within the PMs board the PM adds the row by hand).
          const outcome = moveOutcome({ wasStaging, hasRow: !!t.tab, manualBoard: await sheetIsManual(card.boardId) });
          try {
            let wrote = false;
            if (outcome.approve) {
              const req = await sql()`select r.id from requests r join tasks t2 on t2.request_id = r.id where t2.id = ${t.id} and r.status in ('pending_review','needs_scope')`;
              if (req.length) { await approveRequest(String(req[0].id), "pulp:drag", { moveCard: false }); wrote = outcome.writeRow; }
            }
            if (outcome.writeRow && !wrote) {
              const req = await sql()`select r.decided_by from requests r join tasks t2 on t2.request_id = r.id where t2.id = ${t.id}`;
              wrote = await writeSheetRow(String(t.id), String(req[0]?.decided_by ?? "pulp:drag"));
            }
            if (wrote) {
              t.tab = (await sql()`select value from settings where key = ${"sheet_tab:" + t.id}`)[0]?.value ?? null;
              t.sheet_stage = sheetConfig().stage_values.created; // the row was written with the initial status
            }
          } catch (e) { errors.push(`approve ${String(t.title).slice(0, 40)}: ${(e as Error).message}`); }
          synced++;
        } else {
          await sql()`update tasks set last_moved_at = coalesce(last_moved_at, now()) where id = ${t.id}`;
        }

        // Sheet reconciliation: bring Status (and Date Completed, row position) in line with the card's list.
        const wanted = done ? sheetConfig().stage_values.done : listName;
        if (!sheetsConfigured() || !t.tab || t.sheet_stage === wanted) continue;
        try {
          const tab = String(t.tab);
          const link = pulp.cardUrl(card.boardId || String(t.board_id), card.id);
          const row = (await locateTaskRow(tab, { pulpLink: link, title: String(t.title) })) ?? (t.sheet_row ? Number(t.sheet_row) : null);
          if (!row) { errors.push(`row not found for ${String(t.title).slice(0, 40)} in ${tab}`); continue; }
          await updateTaskCells(tab, row, { stage: wanted, completed: done ? new Date() : undefined });
          const finalRow = done ? await moveRowBelowDivider(tab, row) : row;
          await sql()`update tasks set sheet_row = ${finalRow} where id = ${t.id}`;
          await sql()`insert into settings (key, value) values (${"sheet_stage:" + t.id}, ${JSON.stringify(wanted)}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`;
          sheetUpdates++;
        } catch (e) { errors.push(`sheet ${String(t.title).slice(0, 40)}: ${(e as Error).message.slice(0, 160)}`); }
      }
    } catch (e) { errors.push((e as Error).message); }
    report.pulp = { checked, synced, sheetUpdates, errors };
    try {
      await sql()`insert into settings (key, value) values ('pulp_poll_last', ${JSON.stringify({ at: new Date().toISOString(), checked, synced, sheetUpdates, tickSeconds: Math.round(elapsed() / 100) / 10, errors, tasks: seen.slice(0, 10) })}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`;
    } catch { /* ignore */ }
  }

  // 3a. Cards made by hand in Pulp and linked in the sheet by a PM: each looked at every two minutes, ten at a time,
  //     Status written only when the card moved.
  if (pulp.configured() && sheetsConfigured()) {
    try {
      const { pollSheetCards } = await import("@/lib/sheet-cards");
      report.sheetCards = await pollSheetCards(60, () => elapsed() > 100_000);
    } catch (e) { report.sheetCards = { error: (e as Error).message }; }
  }

  // 4. Housekeeping, off by default: RAW_RETENTION_DAYS=90 would drop the raw envelope of old messages.
  // Text, sender, links, classifications, decisions, tasks and status history are always kept.
  const retention = Number(process.env.RAW_RETENTION_DAYS || 0);
  if (retention > 0 && new Date().getMinutes() === 7) {
    try {
      const r = await sql()`update messages set raw = null where raw is not null and created_at < now() - (${retention} || ' days')::interval`;
      report.housekeeping = { rawCleared: (r as unknown as { length?: number }).length ?? "ok" };
    } catch (e) { report.housekeeping = { error: (e as Error).message }; }
  }

  // 5. Watchdog every 10 minutes: nothing stored may stay half-done, and nothing may fail quietly.
  if (new Date().getMinutes() % 10 === 5) {
    try { report.watchdog = await watchdog(); } catch (e) { report.watchdog = { error: (e as Error).message }; }
  }

  // Heartbeat for /api/health and uptime monitors.
  try { await sql()`insert into settings (key, value) values ('tick_last', ${JSON.stringify(new Date().toISOString())}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`; } catch { /* ignore */ }
  return NextResponse.json(report);
}

/**
 * Three sweeps. Each problem is retried up to three times; after that one ⚠️ line goes to PM Review with the link,
 * the item is marked so it is never re-flagged, and the daily summary lists it under "Needs attention".
 */
async function watchdog(): Promise<Record<string, unknown>> {
  const { postText } = await import("@/lib/review");
  const out = { messagesRetried: 0, messagesFailed: 0, cardsCreated: 0, cardsFailed: 0, jobsAbandoned: 0 };
  const strikes = async (key: string) => {
    const r = await sql()`insert into settings (key, value) values (${key}, '1'::jsonb) on conflict (key) do update set value = (coalesce((settings.value)::text::int, 0) + 1)::text::jsonb, updated_at = now() returning value`;
    return Number(r[0].value);
  };

  // a. Stored but never finished: no outcome, no request, older than 3 minutes, not waiting on anything.
  const orphans = await sql()`
    select m.id, m.channel, m.sender, left(m.text, 80) as text, m.permalink from messages m
    where m.skip_reason is null and m.created_at < now() - interval '3 minutes' and m.created_at > now() - interval '3 days'
      and not exists (select 1 from requests r where r.message_id = m.id)
      and not exists (select 1 from queue q where q.done_at is null and q.payload->>'messageId' = m.id::text)
    limit 20`;
  for (const m of orphans) {
    const n = await strikes(`watchdog:msg:${m.id}`);
    if (n <= 3) { await enqueue("process_message", { messageId: m.id }, 0); out.messagesRetried++; continue; }
    await sql()`update messages set skip_reason = 'failed' where id = ${m.id}`;
    await postText(`⚠️ Could not process a ${m.channel} message from ${m.sender} after 3 tries: "${m.text}…"${m.permalink ? `\n${m.permalink}` : ""}\nPlease file it by hand with /task.`);
    out.messagesFailed++;
  }

  // b. Tasks without a Pulp card (hub-made, open, older than 3 minutes).
  if (pulp.configured()) {
    const { createCardForTask } = await import("@/lib/tasks");
    const noCard = await sql()`select t.id, t.title, c.name as client from tasks t left join clients c on c.id = t.client_id
      where t.origin = 'hub' and t.pulp_card_id is null and t.completed_at is null and t.created_at < now() - interval '3 minutes' and t.created_at > now() - interval '3 days'
        and not exists (select 1 from requests r where r.id = t.request_id and r.status in ('dismissed','merged')) limit 20`;
    for (const t of noCard) {
      const n = await strikes(`watchdog:card:${t.id}`);
      if (n > 4) continue; // already reported
      try { if (await createCardForTask(String(t.id))) out.cardsCreated++; }
      catch (e) {
        if (n === 4) { await postText(`⚠️ No Pulp card could be created for *${t.client ?? "Unknown"}* · ${t.title} after 3 tries (${(e as Error).message.slice(0, 100)}). Please create it by hand.`); out.cardsFailed++; }
      }
    }
  }

  // c. Queue jobs that keep failing: report once at 5 attempts, abandon at 8.
  const stuck = await sql()`select id, kind, attempts, left(last_error, 120) as last_error from queue where done_at is null and attempts >= 5`;
  for (const j of stuck) {
    const warned = await sql()`select 1 from settings where key = ${"watchdog:job:" + j.id}`;
    if (!warned.length) {
      await sql()`insert into settings (key, value) values (${"watchdog:job:" + j.id}, '1'::jsonb) on conflict (key) do nothing`;
      await postText(`⚠️ A background step (${j.kind}) has failed ${j.attempts} times: ${j.last_error}. I keep retrying; if this persists, tell Arun.`);
    }
    if (Number(j.attempts) >= 8) { await sql()`update queue set done_at = now(), last_error = 'abandoned: ' || coalesce(last_error, '') where id = ${j.id}`; out.jobsAbandoned++; }
  }
  return out;
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
    case "meet_group": {
      // One client's action items from one meeting, in its own budget (src/lib/meet.ts).
      const { runMeetGroup } = await import("@/lib/meet");
      await runMeetGroup(payload as Parameters<typeof runMeetGroup>[0]);
      return;
    }
    case "process_message": {
      // Re-run of a stored message (queue fallback; the Chat and Slack handlers run it inline).
      const { reprocessMessage } = await import("@/lib/reprocess");
      await reprocessMessage(payload.messageId as string);
      return;
    }
    case "transcribe_poll": {
      // A long voice note: is Google done? If not, ask again in a minute (a fresh job, so the backoff never slows it).
      const { pollLongTranscription } = await import("@/lib/transcribe");
      const job = payload.job as import("@/lib/transcribe").LongJob;
      const r = await pollLongTranscription(job);
      if (!r.done) { await enqueue("transcribe_poll", payload, 60); return; }
      const { postText } = await import("@/lib/review");
      if ("error" in r) {
        await sql()`update messages set skip_reason = 'transcription_failed' where id = ${payload.messageId as string}`;
        await postText(`🎙️ The long voice note could not be transcribed (${r.error.slice(0, 120)}). Please type the ask.`);
        return;
      }
      const typed = String(payload.typed ?? "").trim();
      const text = [typed, r.text].filter(Boolean).join("\n");
      if (!text.trim()) { await postText("🎙️ The long voice note came back empty (no speech recognised). Please type the ask."); return; }
      // Resolve the client from the transcript, then run the normal pipeline via process_message.
      const { resolveClientFromText, stripClientPrefix } = await import("@/lib/resolve");
      const { allClients } = await import("@/lib/db");
      const hit = resolveClientFromText(text, await allClients());
      // A name in the words wins; otherwise the client the message already had (a Slack workspace's client) stays.
      await sql()`update messages set text = ${hit ? stripClientPrefix(text, hit.client) : text}, client_id = coalesce(${hit?.client.id ?? null}::text, client_id), scope = coalesce(${hit ? hit.client.scope : null}::text, scope), skip_reason = null,
        raw = coalesce(raw, '{}'::jsonb) || ${JSON.stringify({ transcript: r.text, audio: job.gsUri })}::jsonb where id = ${payload.messageId as string}`;
      await enqueue("process_message", { messageId: payload.messageId }, 0);
      return;
    }
    case "reply_check": {
      // A client wrote in Slack: has a MangoEyes person replied since? If not, one reminder in the feed (src/lib/slack-replies.ts).
      const { replyCheck } = await import("@/lib/slack-replies");
      await replyCheck(String(payload.messageId), Number(payload.mins ?? 60));
      return;
    }
    case "create_card": {
      // The Staging card failed at intake: create it now for the existing task. Never approves.
      const { createCardForTask } = await import("@/lib/tasks");
      const tid = payload.taskId ?? (await sql()`select id from tasks where request_id = ${payload.requestId as string}`)[0]?.id;
      if (tid) await createCardForTask(String(tid));
      return;
    }
    case "sync_sheet": {
      // The sheet row failed after approval: re-run the approval, which keeps the original approver.
      const { approveRequest } = await import("@/lib/tasks");
      const rid = payload.requestId ?? (await sql()`select request_id from tasks where id = ${payload.taskId as string}`)[0]?.request_id;
      if (rid) await approveRequest(rid as string, "system:retry", { moveCard: false });
      return;
    }
    default:
      throw new Error(`unknown job kind ${kind}`);
  }
}
