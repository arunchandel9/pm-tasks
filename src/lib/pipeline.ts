import { sql, allClients, channelPaused, enqueue } from "./db";
import { noise } from "./config";
import { pulp } from "./pulp";
import { dedupe, textHash } from "./dedupe";
import { extract } from "./llm/extract";
import { classify } from "./llm/classify";
import { route } from "./route";
import type { Message, Client } from "./types";
import { postThreadFollowupComment } from "./slack";
import { postReview, postText, postFeed, wordsLine, reviewMode, followupLine, feedHeadline, followupHeadline, messageThreadKey, suggestedClientOf, feedThreadKeyOf, inSharedThread, sourceLabel, senderUserOf, DEPT } from "./review";
import { postProposal } from "./proposal";
import { reminderFromMessage, senderName } from "./reminders";
import { whenLabel } from "./when";
import type { AskKindT } from "./llm/extract";
import type { Draft, RouteDecision } from "./types";

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

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

/** The sender's own words: the stored text without the "Earlier in this thread" context a mail may carry. */
export function latestPart(text: string): string {
  const i = text.indexOf("Earlier in this thread (context only, not the ask):");
  return (i >= 0 ? text.slice(0, i) : text).trim();
}

/** The Pulp link of a task's card, for feed lines that point at an existing card. */
async function cardLink(taskId: string | null | undefined): Promise<string | null> {
  if (!taskId) return null;
  const t = await sql()`select board_id, pulp_card_id from tasks where id = ${taskId}`;
  return t.length && t[0].pulp_card_id ? pulp.cardUrl(String(t[0].board_id ?? ""), String(t[0].pulp_card_id)) : null;
}

/** Store a message with a reason and nothing else (an acknowledgement, an image, a note still transcribing). */
export async function storeSkipped(m: Message, skipReason: string): Promise<{ id: string }> {
  const rows = await sql()`
    insert into messages (channel, external_id, client_id, scope, sender, sender_is_staff, sent_at, text, text_hash, permalink, thread_ref, raw, skip_reason)
    values (${m.channel}, ${m.externalId}, ${m.clientId}, ${m.scope}, ${m.sender}, ${m.senderIsStaff}, ${m.sentAt.toISOString()}, ${m.text}, ${textHash(m.text || m.externalId)}, ${m.permalink}, ${m.threadRef}, ${JSON.stringify(m.raw)}::jsonb, ${skipReason})
    on conflict (channel, external_id) do update set skip_reason = excluded.skip_reason returning id`;
  return { id: rows[0].id as string };
}

export async function processMessage(m: Message, noiseVerdict: { skip: boolean; reason: string | null }, opts: { rerun?: boolean } = {}): Promise<ProcessResult> {
  // Repeats are judged on the sender's own words, never on the earlier thread a mail carries as context.
  const hash = textHash(latestPart(m.text));

  // Store first, always. Idempotent on (channel, external_id). A re-run (client picked, "make it a task") updates the
  // stored row in place and clears its earlier requests, so the message is never without a row, even if the run dies.
  const stored = opts.rerun
    ? await sql()`
      insert into messages (channel, external_id, client_id, scope, sender, sender_is_staff, sent_at, text, text_hash, permalink, thread_ref, raw, skip_reason, sender_user)
      values (${m.channel}, ${m.externalId}, ${m.clientId}, ${m.scope}, ${m.sender}, ${m.senderIsStaff}, ${m.sentAt.toISOString()},
              ${m.text}, ${hash}, ${m.permalink}, ${m.threadRef}, ${JSON.stringify(m.raw)}::jsonb, ${noiseVerdict.skip ? noiseVerdict.reason : null}, ${senderUserOf(m)})
      on conflict (channel, external_id) do update set client_id = excluded.client_id, scope = excluded.scope, text = excluded.text, text_hash = excluded.text_hash, raw = excluded.raw, skip_reason = excluded.skip_reason, sender_user = excluded.sender_user
      returning id`
    : await sql()`
      insert into messages (channel, external_id, client_id, scope, sender, sender_is_staff, sent_at, text, text_hash, permalink, thread_ref, raw, skip_reason, sender_user)
      values (${m.channel}, ${m.externalId}, ${m.clientId}, ${m.scope}, ${m.sender}, ${m.senderIsStaff}, ${m.sentAt.toISOString()},
              ${m.text}, ${hash}, ${m.permalink}, ${m.threadRef}, ${JSON.stringify(m.raw)}::jsonb,
              ${noiseVerdict.skip ? noiseVerdict.reason : null}, ${senderUserOf(m)})
      on conflict (channel, external_id) do nothing
      returning id`;
  if (!stored.length) return { messageId: "", outcome: "skipped", reason: "already_seen" };
  const messageId = stored[0].id as string;
  if (opts.rerun) await sql()`delete from requests where message_id = ${messageId} and id not in (select request_id from tasks where request_id is not null)`;

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
    const s = suggestedClientOf(m.raw);
    const why = noiseVerdict.reason ?? (s ? `unknown client, maybe ${s.name} (heard "${s.heard}")` : "unknown_client");
    if (m.channel !== "intake") await postReview({ kind: "needs_human", messageId, client, message: m, why });
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
      // Mark the message finished, or the 10-minute watchdog would re-run it (and re-post) every time.
      await sql()`update messages set skip_reason = 'attached' where id = ${messageId}`;
      const chasing = /\b(any update|update on|status|eta|any news|when will|still waiting|following up|follow up)\b|\?\s*$/i.test(m.text);
      await postThreadFollowupComment({ taskId: root[0].task_id, requestId: root[0].request_id, message: m, flag: chasing ? "client_waiting" : undefined });
      if (m.channel === "intake" && reviewMode() === "notify") {
        const line = followupLine({ client, existingTitle: String(root[0].title ?? "the task"), kind: "followup_change", pulpLink: await cardLink(root[0].task_id as string | null) });
        await postFeed({ headline: followupHeadline({ client, message: m, kind: "followup_change" }), detail: [line, wordsLine(m.text)].filter(Boolean).join("\n"), threadKey: messageThreadKey(String(root[0].root_message_id)) });
      }
      return { messageId, outcome: "attached", requestIds: [String(root[0].request_id)] };
    }
  }

  // Dedupe before any model call.
  const dd = await dedupe(m.clientId, latestPart(m.text), hash, messageId);
  if (dd.kind === "exact_duplicate" || dd.kind === "likely_duplicate") {
    await sql()`update messages set skip_reason = ${dd.kind} where id = ${messageId}`;
    await postThreadFollowupComment({ taskId: dd.taskId, requestId: dd.requestId, message: m });
    if ((m.channel === "intake" || m.channel === "task_cmd" || m.channel === "slack" || inSharedThread(m)) && reviewMode() === "notify") {
      // The feed is the team's record: a repeat that was noted on its card gets a line too, not only the sender's thread.
      const t = await sql()`select coalesce(draft->>'title', '') as title from requests where id = ${dd.requestId}`;
      const line = followupLine({ client, existingTitle: String(t[0]?.title || "the task"), kind: "possible_duplicate", pulpLink: await cardLink(dd.taskId) });
      if (inSharedThread(m)) await postText(line, { threadKey: feedThreadKeyOf(m, messageId) });
      else await postFeed({ headline: followupHeadline({ client, message: m, kind: "possible_duplicate" }), detail: [line, wordsLine(m.text)].filter(Boolean).join("\n"), threadKey: messageThreadKey(messageId) });
    }
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
  const ex = await extract({ text: m.text, channel: m.channel, clientName: client?.name ?? null, messageId, voice, senderIsStaff: m.senderIsStaff, knownNames: voice ? clients.filter((c) => c.scope === "client").map((c) => c.name) : undefined });
  // A client message that closes the exchange ("perfect, that works now, thanks") needs no reply: the reply reminders stand down.
  if (m.channel === "slack" && !m.senderIsStaff && ex.needs_reply === false) {
    await sql()`update messages set raw = coalesce(raw, '{}'::jsonb) || '{"needsReply": false}'::jsonb where id = ${messageId}`;
  }
  // Guard: a problem statement is always an ask, whatever the model said ("… is not working" → fix it).
  const own = latestPart(m.text);
  if ((!ex.is_request || ex.asks.length === 0) && PROBLEM.test(own) && own.split(/\s+/).length >= 3) {
    ex.is_request = true;
    ex.asks = [{ kind: "task", ask: `Fix: ${own}`, quote: own, deadline: null, urgent: false, remind_at: null, owner: null, urls: [] }];
  }
  if (!ex.is_request || ex.asks.length === 0) {
    if (ex.tone === "unhappy" && !m.senderIsStaff) {
      // A displeased client with no ask is not "nothing": someone should reply. One ⚠️ line in the feed, listed in the brief until handled.
      await sql()`update messages set skip_reason = 'client_unhappy' where id = ${messageId}`;
      await postFeed({
        headline: feedHeadline({ icon: "⚠️", client, what: "client unhappy, reply needed", message: m }),
        detail: [wordsLine(m.text), ex.summary.length ? `Context: ${ex.summary.join(" ")}` : "", "No task made. A person should reply.", m.permalink ? `<${m.permalink}|Open the message>` : ""].filter(Boolean).join("\n"),
        threadKey: messageThreadKey(messageId),
      });
      return { messageId, outcome: "skipped", reason: "client_unhappy" };
    }
    await sql()`update messages set skip_reason = 'no_ask' where id = ${messageId}`;
    // Logged as a client update; surfaces in the EOD "updates, no task" bucket.
    return { messageId, outcome: "skipped", reason: "no_ask" };
  }

  const open = await openRequests(m.clientId);
  const requestIds: string[] = [];
  const feed: string[] = [];                         // thread lines: follow-ups noted on existing cards
  const proposals: Array<{ requestId: string; draft: Draft; route: RouteDecision; owner: string | null; quote: string }> = [];
  const other: string[] = [];                        // reminders, ideas, rules, notes: one line each, in the thread
  const kindsSeen = new Set<AskKindT>();
  let followKind: "possible_duplicate" | "followup_change" | null = null;
  const who = senderName(m);
  const src = sourceLabel(m).replace(" · ", ", ");

  for (let i = 0; i < ex.asks.length; i++) {
    const a = ex.asks[i];

    // Not a task: it has its own home and never a card (2026-09-22). Recorded as a request row so the record is complete.
    if (a.kind !== "task") {
      kindsSeen.add(a.kind);
      const status = { reminder: "reminder", idea: "idea", rule: "rule", note: "noted" }[a.kind];
      const ins = await sql()`
        insert into requests (message_id, client_id, scope, ask_index, summary, quote, request_type, department, priority, priority_reason, confidence, confidence_reason, draft, status, kind, decided_by, decided_at)
        values (${messageId}, ${m.clientId}, ${m.scope}, ${i}, ${a.ask}, ${a.quote}, ${a.kind}, 'general', 'P3', null, 1, 'sorted by kind',
                ${JSON.stringify({ title: a.ask, description: "", labels: [] })}::jsonb, ${status}, ${a.kind}, 'system:kind', now())
        returning id`;
      const requestId = String(ins[0].id);
      if (a.kind === "reminder") {
        const rem = await reminderFromMessage({ m, messageId, text: a.ask, remindAt: a.remind_at, requestId });
        other.push(`⏰ Reminder set for ${who} · ${whenLabel(rem.dueAt, true)} · ${a.ask} · it comes back to you in the feed then`);
      } else if (a.kind === "idea") {
        await sql()`insert into ideas (client_id, message_id, text, said_by, source, source_link, said_at, request_id) values (${m.clientId}, ${messageId}, ${a.ask}, ${who}, ${src}, ${m.permalink}, ${m.sentAt.toISOString()}, ${requestId})`;
        other.push(`💡 Idea, up for a decision on Monday: ${a.ask}`);
      } else if (a.kind === "rule") {
        if (m.clientId) await sql()`insert into client_rules (client_id, message_id, text, said_by, said_at) values (${m.clientId}, ${messageId}, ${a.ask}, ${who}, ${m.sentAt.toISOString()})`;
        other.push(`📌 Rule for ${client?.name ?? "this client"}, printed on their cards from now on: ${a.ask}`);
      } else {
        other.push(`ℹ️ Noted: ${a.ask}`);
      }
      continue;
    }

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
      text: `${a.ask} ${a.quote}`, client, urgent: a.urgent || ex.tone === "urgent", deadline: a.deadline,
    });

    const ins = await sql()`
      insert into requests (message_id, client_id, scope, ask_index, summary, quote, request_type, department, priority, priority_reason, confidence, confidence_reason, draft, status, kind)
      values (${messageId}, ${m.clientId}, ${m.scope}, ${i}, ${a.ask}, ${a.quote}, ${cl.request_type}, ${r.department},
              ${r.priority}, ${r.priorityReason}, ${cl.confidence}, ${cl.confidence_reason},
              ${JSON.stringify({ title: cl.title, description: cl.description, labels: r.labels })}::jsonb, 'proposed', 'task')
      returning id`;
    const requestId = ins[0].id as string;
    requestIds.push(requestId);

    // Belongs to an open request: noted on its card, nothing new proposed.
    if (cl.same_as_open !== null && open[cl.same_as_open]) {
      const target = open[cl.same_as_open];
      if (cl.same_as_kind === "nudge") {
        await sql()`update requests set status = 'merged', merged_into = ${target.id} where id = ${requestId}`;
        await sql()`update tasks set waiting_on_client_since = null where request_id = ${target.id}`;
        await postThreadFollowupComment({ taskId: target.taskId, requestId: target.id, message: m, flag: "client_waiting" });
        continue;
      }
      const kind = cl.same_as_kind === "duplicate" && dd.kind === "possible_duplicate" ? "possible_duplicate" : "followup_change";
      await sql()`update requests set status = 'merged', merged_into = ${target.id}, decided_by = 'system:same_thread' where id = ${requestId}`;
      await postThreadFollowupComment({ taskId: target.taskId, requestId: target.id, message: m });
      feed.push(followupLine({ client, existingTitle: target.title, kind, pulpLink: await cardLink(target.taskId) }));
      followKind ??= kind;
      continue;
    }

    // The classifier still reads it as an update or a question: a note, never a card.
    if (r.noCard) {
      await sql()`update requests set status = 'noted', kind = 'note', decided_by = 'system:no_card', decided_at = now() where id = ${requestId}`;
      requestIds.pop();
      kindsSeen.add("note");
      other.push(`ℹ️ Noted: ${cl.title}`);
      continue;
    }

    proposals.push({ requestId, draft: { title: cl.title, description: cl.description, labels: r.labels }, route: r, owner: a.owner, quote: a.quote });
  }

  const threadKey = inSharedThread(m) ? feedThreadKeyOf(m, messageId) : messageThreadKey(messageId);
  const detail = [...feed, ...other, wordsLine(m.text)].filter(Boolean).join("\n");

  if (!proposals.length) {
    // Every item found its home; nothing to build. One feed line so the message is on record, never silent.
    const first = [...kindsSeen][0];
    const reason = feed.length ? undefined : kindsSeen.size === 1 && first !== "note" ? first : kindsSeen.size > 1 ? "noted" : "no_card";
    if (!feed.length) await sql()`update messages set skip_reason = ${reason === "noted" ? "no_card" : reason ?? "no_card"} where id = ${messageId}`;
    const head = feed.length
      ? followupHeadline({ client, message: m, kind: followKind ?? "followup_change" })
      : first === "reminder" && kindsSeen.size === 1 ? feedHeadline({ icon: "⏰", client, what: `reminder set for ${who}`, message: m })
      : first === "idea" && kindsSeen.size === 1 ? feedHeadline({ icon: "💡", client, what: "idea noted for Monday", message: m })
      : first === "rule" && kindsSeen.size === 1 ? feedHeadline({ icon: "📌", client, what: "rule noted", message: m })
      : feedHeadline({ icon: "ℹ️", client, what: "noted, no task", message: m });
    if (inSharedThread(m)) { if (detail) await postText(detail, { threadKey }); }
    else await postFeed({ headline: head, detail, threadKey });
    return feed.length ? { messageId, outcome: "review", requestIds } : { messageId, outcome: "skipped", reason, requestIds };
  }

  // Tasks: one feed line for the message; the words, the other items and one proposal card per task in its thread.
  const p1 = proposals.filter((p) => p.route.priority === "P1").length;
  const depts = [...new Set(proposals.map((p) => DEPT[p.route.department] ?? p.route.department))];
  const what = proposals.length === 1 ? (p1 ? "P1 task to confirm" : "task to confirm") : `${proposals.length} tasks to confirm${p1 ? `, ${p1 === 1 ? "one" : p1} P1` : ""}`;
  if (!inSharedThread(m)) await postFeed({ headline: feedHeadline({ icon: p1 ? "🔴" : "🆕", client, what, extra: depts.length === 1 ? depts[0] : null, message: m }), detail, threadKey });
  else if (detail) await postText(detail, { threadKey });
  for (const p of proposals) {
    try { await postProposal({ requestId: p.requestId, client, message: m, messageId, draft: p.draft, route: p.route, owner: p.owner, quote: p.quote }); }
    catch (e) {
      console.error("proposal card failed, queued:", (e as Error).message);
      await enqueue("post_proposal", { requestId: p.requestId }, 60);
    }
  }
  return { messageId, outcome: "review", requestIds };
}

async function openRequests(clientId: string | null): Promise<Array<{ id: string; taskId: string | null; title: string; status: string }>> {
  if (!clientId) return [];
  const rows = await sql()`
    select r.id, t.id as task_id, r.draft->>'title' as title, r.status
    from requests r left join tasks t on t.request_id = r.id
    where r.client_id = ${clientId} and r.created_at > now() - interval '14 days'
      and r.status in ('proposed','pending_review','approved','created','needs_scope')
      and (t.id is null or t.completed_at is null)
    order by r.created_at desc limit 20`;
  return rows.map((x) => ({ id: x.id as string, taskId: (x.task_id as string | null), title: x.title as string, status: x.status as string }));
}

export type { Client };
