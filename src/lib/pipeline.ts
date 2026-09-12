import { sql, allClients, channelPaused, enqueue } from "./db";
import { noise } from "./config";
import { pulp } from "./pulp";
import { dedupe, textHash } from "./dedupe";
import { extract } from "./llm/extract";
import { classify } from "./llm/classify";
import { route } from "./route";
import type { Message, Client } from "./types";
import { addReaction, postThreadFollowupComment } from "./slack";
import { postReview, postP1Ping, postText, reviewMode, draftLine, followupLine, messageThreadKey } from "./review";
import { createStagingCard } from "./tasks";

export interface ProcessResult {
  messageId: string;
  outcome: "skipped" | "attached" | "review" | "paused";
  reason?: string;
  requestIds?: string[];
}

/**
 * Store → filter → dedupe → extract → classify → route → review.
 * Every branch is recorded. Nothing is silently dropped.
 */
export const PROBLEM = /\b(not working|isn'?t working|doesn'?t work|broken|down|error|bug|issue|missing|stopped|failing|fails|crash|wrong|please fix|fix)\b/i;

export async function processMessage(m: Message, noiseVerdict: { skip: boolean; reason: string | null }): Promise<ProcessResult> {
  const hash = textHash(m.text);

  // Store first, always. Idempotent on (channel, external_id).
  const stored = await sql()`
    insert into messages (channel, external_id, client_id, scope, sender, sender_is_staff, sent_at, text, text_hash, permalink, thread_ref, raw, skip_reason)
    values (${m.channel}, ${m.externalId}, ${m.clientId}, ${m.scope}, ${m.sender}, ${m.senderIsStaff}, ${m.sentAt.toISOString()},
            ${m.text}, ${hash}, ${m.permalink}, ${m.threadRef}, ${JSON.stringify(m.raw)}::jsonb,
            ${noiseVerdict.skip ? noiseVerdict.reason : null})
    on conflict (channel, external_id) do nothing
    returning id`;
  if (!stored.length) return { messageId: "", outcome: "skipped", reason: "already_seen" };
  const messageId = stored[0].id as string;

  // Unanswered-client-message nudge: any client-authored Slack message starts a timer, request or not.
  if (m.channel === "slack" && !m.senderIsStaff && m.scope === "client" && !noiseVerdict.skip) {
    for (const mins of noise().reply_nudge_minutes) await enqueue("reply_check", { messageId, mins }, mins * 60);
  }

  if (noiseVerdict.skip) return { messageId, outcome: "skipped", reason: noiseVerdict.reason ?? "noise" };

  if (await channelPaused(m.channel)) {
    await enqueue("process_message", { messageId }, 300);
    return { messageId, outcome: "paused" };
  }

  const clients = await allClients();
  const client = clients.find((c) => c.id === m.clientId) ?? null;

  // Attachment only, or unknown client: a person decides, no model call.
  if (noiseVerdict.reason === "attachment_only" || m.scope === "unknown") {
    await sql()`update messages set skip_reason = ${noiseVerdict.reason ?? "unknown_client"} where id = ${messageId}`;
    // A DM sender is asked in their own thread (gchat route); the feed only carries finals. Other channels have no
    // thread to ask in, so the question goes to the feed as a card.
    if (m.channel !== "intake") await postReview({ kind: "needs_human", messageId, client, message: m, why: noiseVerdict.reason ?? "unknown_client" });
    return { messageId, outcome: "review", reason: noiseVerdict.reason ?? "unknown_client" };
  }

  // A short reply inside a thread that already became a task belongs to that task: comment on its card, no model call.
  // Slack threads are keyed by the root message id; Chat DM threads by the thread name, following any merge to the card
  // the root itself was attached to.
  const shortReply = m.text.trim().split(/\s+/).length <= 12;
  if (m.threadRef && (noiseVerdict.reason === "thread_followup" || (m.channel === "intake" && shortReply))) {
    const root = m.channel === "intake"
      ? await sql()`
        select coalesce(r.merged_into, r.id) as request_id, t.id as task_id, pm.id as root_message_id,
               coalesce(mt.draft->>'title', r.draft->>'title') as title
        from messages pm join requests r on r.message_id = pm.id
        left join requests mt on mt.id = r.merged_into
        left join tasks t on t.request_id = coalesce(r.merged_into, r.id)
        where pm.channel = 'intake' and pm.thread_ref = ${m.threadRef} and pm.id <> ${messageId}
        order by pm.created_at asc, r.ask_index limit 1`
      : await sql()`
        select r.id as request_id, t.id as task_id, pm.id as root_message_id, r.draft->>'title' as title from messages pm
        join requests r on r.message_id = pm.id left join tasks t on t.request_id = r.id
        where pm.channel = ${m.channel} and pm.external_id = ${m.threadRef} order by r.ask_index limit 1`;
    if (root.length) {
      const chasing = /\b(any update|update on|status|eta|any news|when will|still waiting|following up|follow up)\b|\?\s*$/i.test(m.text);
      await postThreadFollowupComment({ taskId: root[0].task_id, requestId: root[0].request_id, message: m, flag: chasing ? "client_waiting" : undefined });
      if (m.channel === "intake" && reviewMode() === "notify") {
        await postText(followupLine({ client, existingTitle: String(root[0].title ?? "the task"), kind: "followup_change", message: m }), { threadKey: messageThreadKey(String(root[0].root_message_id)) });
      }
      return { messageId, outcome: "attached", requestIds: [String(root[0].request_id)] };
    }
  }

  // Dedupe before any model call.
  const dd = await dedupe(m.clientId, m.text, hash);
  if (dd.kind === "exact_duplicate" || dd.kind === "likely_duplicate") {
    await sql()`update messages set skip_reason = ${dd.kind} where id = ${messageId}`;
    await addReaction(m, "repeat");
    await postThreadFollowupComment({ taskId: dd.taskId, requestId: dd.requestId, message: m });
    return { messageId, outcome: "attached", reason: dd.kind, requestIds: [dd.requestId] };
  }

  // Daily cap per client: safety valve.
  if (m.clientId) {
    const cap = noise().per_client_daily_llm_cap;
    const n = await sql()`
      select count(*)::int as n from llm_calls l join messages mm on mm.id = l.message_id
      where mm.client_id = ${m.clientId} and l.created_at > now() - interval '1 day'`;
    if (Number(n[0].n) >= cap) {
      await postReview({ kind: "needs_human", messageId, client, message: m, why: "daily_cap" });
      return { messageId, outcome: "review", reason: "daily_cap" };
    }
  }

  // Model call 1.
  const voice = !!(m.raw as { voice?: boolean } | null)?.voice;
  const ex = await extract({ text: m.text, channel: m.channel, clientName: client?.name ?? null, messageId, voice, knownNames: voice ? clients.filter((c) => c.scope === "client").map((c) => c.name) : undefined });
  // Guard: a problem statement is always an ask, whatever the model said ("… is not working" → fix it).
  if ((!ex.is_request || ex.asks.length === 0) && PROBLEM.test(m.text) && m.text.trim().split(/\s+/).length >= 3) {
    ex.is_request = true;
    ex.asks = [{ ask: `Fix: ${m.text.trim()}`, quote: m.text.trim(), deadline: null, urls: [] }];
  }
  if (!ex.is_request || ex.asks.length === 0) {
    await sql()`update messages set skip_reason = 'no_ask' where id = ${messageId}`;
    // Logged as a client update; surfaces in the EOD "updates, no task" bucket.
    return { messageId, outcome: "skipped", reason: "no_ask" };
  }

  const open = await openRequests(m.clientId);
  const requestIds: string[] = [];
  // notify mode: one short line per task, all asks from one message in a single post. No buttons; Staging is the approval.
  const notify = reviewMode() === "notify";
  const feed: string[] = [];

  for (let i = 0; i < ex.asks.length; i++) {
    const a = ex.asks[i];
    // Model call 2.
    const cl = await classify({
      ask: a.ask, quote: a.quote, deadline: a.deadline, urls: a.urls,
      clientName: client?.name ?? null, scope: m.scope, channel: m.channel,
      openRequests: open.map((o, idx) => ({ index: idx, title: o.title, status: o.status })),
      messageId,
    });

    const r = route({
      requestType: cl.request_type, modelDepartment: cl.department,
      priorityHint: cl.priority_hint, priorityReason: cl.priority_reason,
      text: `${a.ask} ${a.quote}`, client,
    });

    const status = r.gated ? "needs_scope" : "pending_review";
    const ins = await sql()`
      insert into requests (message_id, client_id, scope, ask_index, summary, quote, request_type, department, priority, priority_reason, confidence, confidence_reason, draft, status)
      values (${messageId}, ${m.clientId}, ${m.scope}, ${i}, ${a.ask}, ${a.quote}, ${cl.request_type}, ${r.department},
              ${r.priority}, ${r.priorityReason}, ${cl.confidence}, ${cl.confidence_reason},
              ${JSON.stringify({ title: cl.title, description: cl.description, labels: r.labels })}::jsonb, ${status})
      returning id`;
    const requestId = ins[0].id as string;
    requestIds.push(requestId);

    // Three-way thread handling when the model says it matches an open request.
    if (cl.same_as_open !== null && open[cl.same_as_open]) {
      const target = open[cl.same_as_open];
      if (cl.same_as_kind === "nudge") {
        await sql()`update requests set status = 'merged', merged_into = ${target.id} where id = ${requestId}`;
        await sql()`update tasks set waiting_on_client_since = null where request_id = ${target.id}`;
        await postThreadFollowupComment({ taskId: target.taskId, requestId: target.id, message: m, flag: "client_waiting" });
        continue;
      }
      const kind = cl.same_as_kind === "duplicate" && dd.kind === "possible_duplicate" ? "possible_duplicate" : "followup_change";
      if (notify) {
        // Nothing new is created: the message is added as a comment on the existing card and the feed gets one line.
        // If the PM disagrees, /task in Intake makes it a separate task.
        await sql()`update requests set status = 'merged', merged_into = ${target.id}, decided_by = 'system:same_thread' where id = ${requestId}`;
        await postThreadFollowupComment({ taskId: target.taskId, requestId: target.id, message: m });
        feed.push(followupLine({ client, existingTitle: target.title, kind, message: m }));
        continue;
      }
      await postReview({ kind, requestId, client, message: m, duplicateOf: target.id });
      continue;
    }

    if (r.noCard) {
      await sql()`update requests set status = 'dismissed', decided_by = 'system:no_card' where id = ${requestId}`;
      continue;
    }

    // A real card in the Staging list. Dragging it out (or Approve, in approve mode) is the approval.
    const task = await createStagingCard({ requestId, client, route: r, draft: { title: cl.title, description: cl.description, labels: r.labels }, message: m, quote: a.quote });
    const pulpLink = task?.pulpCardId ? pulp.cardUrl(task.boardId ?? r.board ?? "", task.pulpCardId) : null;
    if (notify && pulpLink) {
      feed.push(draftLine({ client, title: cl.title, department: r.department, priority: r.priority, gated: r.gated, pulpLink, message: m }));
      continue;
    }
    // No Staging card exists (Pulp not connected) or approve mode: the card with buttons is the only way to approve.
    await postReview({ kind: "draft", requestId, taskId: task?.id ?? null, client, message: m, route: r, draft: { title: cl.title, description: cl.description, labels: r.labels }, confidence: cl.confidence, reason: cl.confidence_reason });
    if (r.priority === "P1") await postP1Ping({ requestId, client, title: cl.title, message: m, reason: r.priorityReason });
  }

  if (feed.length) await postText(feed.join("\n"), { threadKey: messageThreadKey(messageId) });
  await addReaction(m, "eyes");
  return { messageId, outcome: "review", requestIds };
}

async function openRequests(clientId: string | null): Promise<Array<{ id: string; taskId: string | null; title: string; status: string }>> {
  if (!clientId) return [];
  const rows = await sql()`
    select r.id, t.id as task_id, r.draft->>'title' as title, r.status
    from requests r left join tasks t on t.request_id = r.id
    where r.client_id = ${clientId} and r.created_at > now() - interval '14 days'
      and r.status in ('pending_review','approved','created','needs_scope')
      and (t.id is null or t.completed_at is null)
    order by r.created_at desc limit 20`;
  return rows.map((x) => ({ id: x.id as string, taskId: (x.task_id as string | null), title: x.title as string, status: x.status as string }));
}

export type { Client };
