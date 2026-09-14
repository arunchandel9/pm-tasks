import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { verifyChatRequest, intakeSpace, reviewSpace, taskDialogBody, sendText, inboxSpaceName, rememberInboxSpace } from "@/lib/gchat";
import { normaliseChatEvent, replyText, replyUpdateMessage, replyDialog, replyDialogOk, replyDialogError, type NormalisedEvent } from "@/lib/gchat-events";
import { allClients, sql } from "@/lib/db";
import { processMessage } from "@/lib/pipeline";
import { approveRequest, dismissRequest, mergeRequest } from "@/lib/tasks";
import { resolveClientFromText } from "@/lib/resolve";
import { postAck, humanOutcome, threadTopic, closeNeedsHumanCard, type ThreadTopic } from "@/lib/review";
import { handleIntakeMessage } from "@/lib/chat-intake";
import type { Message } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Google Chat interaction events, classic or add-on format: Intake messages, /task dialog, card buttons. */
export async function POST(req: Request) {
  const v = await verifyChatRequest(req.headers.get("authorization"), req.url);
  if (!v.ok) {
    console.error("gchat rejected:", v.reason);
    waitUntil(recordLastEvent({ ok: false, reason: v.reason }));
    return new NextResponse("unauthorized", { status: 401 });
  }
  const raw = await req.json();
  const ev = normaliseChatEvent(raw, new URL(req.url).searchParams.get("fn"));
  const f = ev.format;
  const record = (extra: Record<string, unknown>) => waitUntil(recordLastEvent({ ok: true, caller: v.caller, format: f, kind: ev.kind, space: ev.space, intakeSpace: intakeSpace(), invokedFunction: ev.invokedFunction, formKeys: Object.keys(ev.formInputs), text: (ev.message?.argumentText ?? ev.message?.text ?? "").slice(0, 80), ...extra }));
  const res = await handle(ev, raw, record);
  return res;
}

async function handle(ev: NormalisedEvent, raw: unknown, record: (extra: Record<string, unknown>) => void) {
  const f = ev.format;
  const reply = (label: string, body: unknown) => { record({ replied: label }); return NextResponse.json(body); };

  if (ev.kind === "added") {
    const isInbox = !ev.isDm && !!ev.spaceName && ev.spaceName.trim().toLowerCase() === inboxSpaceName().toLowerCase();
    if (isInbox) await rememberInboxSpace(ev.space);
    const role = ev.space === reviewSpace() ? "This is the feed: one line per task, questions, alerts and the daily summary land here."
      : ev.isDm ? "Send or forward anything here. Start with the client name when you can."
      : isInbox ? "Share anything here from your phone: text, forwards, voice notes. No need to mention me; I read this space every minute and answer in the message's thread when I need something."
      : ev.space === intakeSpace() ? "In a space I only receive messages that mention me (@Task Hub). For forwarding, open a direct message with me instead."
      : "Open a direct message with me to send requests. Add me to the feed space to post the daily summary.";
    return reply("welcome", replyText(f, ev.isDm ? role : `Task Hub is here. ${role}`));
  }

  // Clicks first: a button click event also carries the original message (e.g. "/task"), which must not reopen the form.
  if (ev.kind === "dialog_submit") { const r = await handleDialogSubmit(ev); record({ replied: "dialog_submit" }); return r; }
  if (ev.kind === "click") { const r = await handleCardClick(ev); record({ replied: `click:${ev.invokedFunction}` }); return r; }

  if (ev.kind === "command" || (ev.kind === "message" && /^\/task\b/.test(ev.message?.text ?? ""))) {
    const clients = (await allClients()).filter((c) => c.scope === "client").map((c) => ({ id: c.id, name: c.name }));
    return reply("dialog_open", replyDialog(f, taskDialogBody(clients)));
  }

  if (ev.kind === "message" && ev.message) {
    if (ev.space === reviewSpace()) {
      // A typed reply (with @Task Hub) inside a card's thread answers that card: client name, "not a task", "make it a task", "approve".
      const topic = await threadTopic(ev.message.thread?.name);
      if (!topic) return reply("review_no_topic", replyText(f, "Reply inside the thread of the card you mean, with the client name, \"not a task\", \"make it a task\" or \"approve\"."));
      const answer = await answerThread(topic, (ev.message.argumentText ?? ev.message.text ?? "").replace(/^@?Task Hub\s*/i, "").trim(), ev.user.displayName ?? ev.user.email ?? "unknown");
      await sendText(reviewSpace(), answer, ev.message.thread?.name); // answer inside the same thread
      return reply("review_thread_reply", {});
    }
    if (ev.space === (await inboxSpaceCached())) return reply("inbox_polled", {}); // the minute poll reads this space; a mention must not double it
    if (ev.space !== intakeSpace() && !ev.isDm) return reply("ignored_other_space", {});
    waitUntil(handleIntakeMessage(ev.message, raw, ev.space).catch((e) => console.error("gchat intake failed", e)));
    return reply("empty_ack", {});
  }
  return reply("empty_other", {});
}

/** Interpret a typed reply in a PM Review card thread. Returns the one-line answer to post back in the thread. */
async function answerThread(topic: ThreadTopic, text: string, who: string): Promise<string> {
  const t = text.toLowerCase();
  const no = /\b(not a task|no task|ignore|skip|dismiss|drop it|nothing)\b/.test(t);
  const yes = /\b(make it a task|make a task|create|approve|yes|go ahead|ok(ay)?|separate task)\b/.test(t);
  if (topic.kind === "needs_human") {
    if (no) { await sql()`update messages set skip_reason = 'dismissed_by_human' where id = ${topic.messageId}`; return `🗑️ Not a task · by ${who}`; }
    const hit = resolveClientFromText(text, await allClients());
    if (hit) {
      await sql()`update messages set client_id = ${hit.client.id}, scope = ${hit.client.scope}, skip_reason = null where id = ${topic.messageId}`;
      await sql()`insert into queue (kind, payload) values ('process_message', ${JSON.stringify({ messageId: topic.messageId })}::jsonb)`;
      await closeNeedsHumanCard(topic.messageId, `👤 Client set to ${hit.client.name} by ${who}; processing.`);
      return `👤 Client set to ${hit.client.name} by ${who}; processing.`;
    }
    if (yes) {
      await sql()`update messages set skip_reason = null where id = ${topic.messageId}`;
      await sql()`insert into queue (kind, payload) values ('process_message', ${JSON.stringify({ messageId: topic.messageId })}::jsonb)`;
      return `↪️ Marked as a task by ${who}; processing on the next tick.`;
    }
    return "I did not catch that. Say the client name, \"not a task\", or \"make it a task\".";
  }
  if (no) { await dismissRequest(topic.requestId, who); return `🗑️ Not a task · by ${who}`; }
  if (/\b(merge|same)\b/.test(t) && topic.duplicateOf) { await mergeRequest(topic.requestId, topic.duplicateOf, who); return `🔗 Merged into the existing task by ${who}`; }
  if (yes) { await approveRequest(topic.requestId, who); return `✅ Approved by ${who}`; }
  return "I did not catch that. Say \"approve\", \"not a task\"" + (topic.duplicateOf ? " or \"merge\"." : ".");
}

let _inbox: { at: number; space: string } | null = null;
async function inboxSpaceCached(): Promise<string> {
  if (_inbox && Date.now() - _inbox.at < 60_000) return _inbox.space;
  const { inboxSpace } = await import("@/lib/chat-inbox");
  _inbox = { at: Date.now(), space: (await inboxSpace()) ?? "" };
  return _inbox.space;
}

/** GET is a reachability check: proves the route is deployed without any Chat involvement. */
export async function GET() {
  return NextResponse.json({ ok: true, route: "/api/gchat", expects: "POST from Google Chat with a Google-signed bearer token" });
}

/** The last Chat event, kept in settings so /api/health can show it without Vercel logs. */
async function recordLastEvent(info: Record<string, unknown>) {
  try {
    await sql()`insert into settings (key, value) values ('gchat_last_event', ${JSON.stringify({ at: new Date().toISOString(), ...info })}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`;
  } catch (e) { console.error("recordLastEvent failed", (e as Error).message); }
}


async function handleDialogSubmit(ev: NormalisedEvent) {
  const get = (k: string) => ev.formInputs[k]?.stringInputs?.value?.[0]?.trim() ?? "";
  const clientId = get("client"), request = get("request"), notes = get("notes"), priority = get("priority") || "P3", source = get("source");
  if (!request) return NextResponse.json(replyDialogError(ev.format, "Please write what was asked."));
  const clients = await allClients();
  const client = clients.find((c) => c.id === clientId) ?? null;
  const body = [request, notes ? `\nNotes from ${ev.user.displayName ?? "team"}: ${notes}` : "", source ? `\nCame via: ${source}` : "", priority === "P1" ? "\nMarked urgent (P1) by the team." : priority === "P2" ? "\nMarked important by the team." : ""].join("");
  const m: Message = {
    channel: "task_cmd", externalId: `gchat:${ev.user.email ?? "u"}:${Date.now()}`, teamId: null, clientId: client?.id ?? null, scope: client ? client.scope : "unknown",
    sender: ev.user.displayName ?? ev.user.email ?? "unknown", senderIsStaff: true, sentAt: new Date(), text: body, permalink: null, threadRef: null, raw: { form: ev.formInputs },
  };
  waitUntil((async () => {
    const r = await processMessage(m, { skip: false, reason: null });
    const n = r.requestIds?.length ?? 0;
    if (r.outcome === "review" && n) return; // the feed lines are the acknowledgement
    await postAck({ message: m, outcome: r.outcome, detail: humanOutcome(r.outcome, r.reason) });
  })().catch((e) => console.error("dialog submit failed", e)));
  return NextResponse.json(replyDialogOk(ev.format, `Added for ${client?.name ?? "unknown client"}. Watch PM Review.`));
}

async function handleCardClick(ev: NormalisedEvent) {
  const fn = ev.invokedFunction, p = ev.parameters, who = ev.user.displayName ?? ev.user.email ?? "unknown";
  const done = (text: string) => NextResponse.json(replyUpdateMessage(ev.format, text));
  try {
    switch (fn) {
      case "approve":
        await approveRequest(p.requestId, who);
        return done(`✅ Approved by ${who} · request ${p.requestId.slice(0, 8)}`);
      case "dismiss":
        await dismissRequest(p.requestId, who);
        return done(`🗑️ Not a task · by ${who}`);
      case "merge_into":
        await mergeRequest(p.requestId, p.into, who);
        return done(`🔗 Merged into ${p.into.slice(0, 8)} by ${who}`);
      case "edit":
      case "merge":
        return NextResponse.json(replyText(ev.format, "Edit and Merge open a form in the next build. For now: Approve, or Not a task, and fix the card in Pulp."));
      case "make_task":
        await sql()`update messages set skip_reason = null where id = ${p.messageId}`;
        await sql()`insert into queue (kind, payload) values ('process_message', ${JSON.stringify({ messageId: p.messageId })}::jsonb)`;
        return done(`↪️ Marked as a task by ${who}; processing on the next tick.`);
      case "pick_client": {
        const clientId = ev.formInputs.client?.stringInputs?.value?.[0];
        if (!clientId) return NextResponse.json({});
        const c = (await allClients()).find((x) => x.id === clientId);
        await sql()`update messages set client_id = ${clientId}, scope = ${c?.scope ?? "client"}, skip_reason = null where id = ${p.messageId}`;
        await sql()`insert into queue (kind, payload) values ('process_message', ${JSON.stringify({ messageId: p.messageId })}::jsonb)`;
        return done(`👤 Client set to ${c?.name ?? clientId} by ${who}; processing.`);
      }
      case "dismiss_message":
        await sql()`update messages set skip_reason = 'dismissed_by_human' where id = ${p.messageId}`;
        return done(`🗑️ Not a task · by ${who}`);
      default:
        return NextResponse.json({});
    }
  } catch (e) {
    console.error("card click failed", e);
    return NextResponse.json(replyText(ev.format, `That failed: ${(e as Error).message}`));
  }
}
