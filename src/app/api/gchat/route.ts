import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { verifyChatRequest, intakeSpace, reviewSpace, taskDialogBody, downloadAttachment, sendText } from "@/lib/gchat";
import { normaliseChatEvent, replyText, replyUpdateMessage, replyDialog, replyDialogOk, replyDialogError, type NormalisedEvent, type ChatMessage } from "@/lib/gchat-events";
import { allClients, sql } from "@/lib/db";
import { processMessage } from "@/lib/pipeline";
import { approveRequest, dismissRequest, mergeRequest } from "@/lib/tasks";
import { resolveClientFromText, stripClientPrefix } from "@/lib/resolve";
import { postAck, postReview, postText, humanOutcome, threadTopic, closeNeedsHumanCard, type ThreadTopic } from "@/lib/review";
import { transcribeAudio, isAudio, startLongTranscription, estimateMinutes } from "@/lib/transcribe";
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
    const role = ev.space === reviewSpace() ? "This is the feed: one line per task, questions, alerts and the daily summary land here."
      : ev.isDm ? "Send or forward anything here: a WhatsApp message, a voice note, a screenshot, a note to yourself. No mention needed. Start with the client name and a colon when you can, or type /task for the form."
      : ev.space === intakeSpace() ? "In a space I only receive messages that mention me (@Task Hub). For forwarding, open a direct message with me instead."
      : "Open a direct message with me to send requests. Add me to the feed space to post the daily summary.";
    return reply("welcome", replyText(f, `Task Hub is here. ${role}`));
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

function permalinkFor(messageName: string): string | null {
  const m = messageName.match(/^spaces\/([^/]+)\/messages\/(.+)$/);
  return m ? `https://chat.google.com/room/${m[1]}/${m[2]}` : null;
}

async function handleIntakeMessage(msg: ChatMessage, raw: unknown, space: string) {
  const clients = await allClients();
  let text = (msg.argumentText ?? msg.text ?? "").replace(/^@?Task Hub\s*/i, "").trim();
  const sender = msg.sender?.displayName ?? msg.sender?.email ?? "unknown";
  let transcriptNote = "";
  const say = (t: string) => sendText(space, t, msg.thread?.name).catch((e) => console.error("say failed", (e as Error).message));

  // A message that is only a client name ("HOH", "this is for PSS"): it names the client for a forwarded message,
  // sent just before (same thread, or the last 30 minutes in a direct chat) or about to be sent (kept for 15 minutes).
  const nameHit = resolveClientFromText(text, clients);
  if (nameHit && text.split(/\s+/).length <= 5 && !msg.attachment?.length) {
    const pending = await sql()`
      select id from messages where channel = 'intake' and client_id is null and skip_reason in ('unknown_client', 'attachment_only')
        and (${msg.thread?.name ?? null}::text is not null and thread_ref = ${msg.thread?.name ?? null} or (${msg.thread?.name ?? null}::text is null and sender = ${sender} and created_at > now() - interval '30 minutes'))
      order by created_at desc limit 1`;
    if (pending.length) {
      const id = String(pending[0].id);
      await sql()`update messages set client_id = ${nameHit.client.id}, scope = ${nameHit.client.scope}, skip_reason = null where id = ${id}`;
      await sql()`insert into queue (kind, payload) values ('process_message', ${JSON.stringify({ messageId: id })}::jsonb)`;
      await closeNeedsHumanCard(id, `👤 Client set to ${nameHit.client.name} by ${sender}; processing.`);
      await say(`Got it: ${nameHit.client.name}. Processing the message above.`);
      return;
    }
    await sql()`insert into settings (key, value) values (${"client_hint:" + sender}, ${JSON.stringify({ clientId: nameHit.client.id, at: Date.now() })}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`;
    await say(`Noted: ${nameHit.client.name}. Forward the message now and I will file it under that client.`);
    return;
  }

  for (const a of msg.attachment ?? []) {
    if (!a.attachmentDataRef?.resourceName || !isAudio(a.contentType ?? "", a.contentName ?? "")) continue;
    try {
      const buf = await downloadAttachment(a.attachmentDataRef.resourceName);
      const t = await transcribeAudio(buf, a.contentType ?? "", a.contentName ?? "");
      if ("text" in t && t.text) { text = [text, t.text].filter(Boolean).join("\n"); transcriptNote = " (voice note transcribed)"; }
      else if ("tooLong" in t) {
        // Long note: upload, start the long-running recognition, and let the minute tick finish the job.
        const mins = estimateMinutes(buf.length, a.contentType ?? "");
        try {
          const job = await startLongTranscription(buf, a.contentType ?? "", a.contentName ?? "");
          const stored = await storeOnly({ ...baseMessage(msg, raw, sender, text, clients), text }, "transcribing");
          await sql()`insert into queue (kind, payload, next_run_at) values ('transcribe_poll', ${JSON.stringify({ messageId: stored.id, job, typed: text })}::jsonb, now() + interval '60 seconds')`;
          await postText(`🎙️ Voice note from ${sender} received (about ${mins} min). Transcribing; the task lines will follow in a few minutes.`);
          return;
        } catch (e) { transcriptNote = ` (long voice note could not be started: ${(e as Error).message.slice(0, 160)})`; }
      }
      else transcriptNote = ` (voice note could not be transcribed: ${"error" in t ? t.error : "unknown"})`;
    } catch (e) { transcriptNote = ` (voice note download failed: ${(e as Error).message})`; }
  }

  let m = baseMessage(msg, raw, sender, text, clients);
  if (!m.clientId) {
    // No client in the text: use the name the same person gave in the last 15 minutes, if any.
    const h = await sql()`select value from settings where key = ${"client_hint:" + sender}`;
    const hint = h.length ? (h[0].value as { clientId: string; at: number }) : null;
    const c = hint && Date.now() - hint.at < 15 * 60 * 1000 ? clients.find((x) => x.id === hint.clientId) : null;
    if (c) { m = { ...m, clientId: c.id, scope: c.scope }; await sql()`delete from settings where key = ${"client_hint:" + sender}`; }
  }
  const hit = m.clientId ? { client: clients.find((x) => x.id === m.clientId)! } : null;
  if (!m.text.trim() && !msg.attachment?.length) return;
  if (!m.text.trim()) {
    await postReview({ kind: "needs_human", messageId: (await storeOnly(m, "attachment_only")).id, client: null, message: m, why: `attachment_only${transcriptNote}` });
    return;
  }
  const result = await processMessage(m, { skip: false, reason: null });
  const n = result.requestIds?.length ?? 0;
  if (result.outcome === "review" && result.reason === "unknown_client") await say("Which client is this for? Reply here with the name.");
  // When tasks were created, the feed lines are the acknowledgement; a second line would only add noise.
  if (result.outcome === "review" && n && !transcriptNote) return;
  const detail = result.outcome === "review" && n ? `${n} task${n > 1 ? "s" : ""} for ${hit?.client.name ?? "unknown client"} above${transcriptNote}`
    : `${humanOutcome(result.outcome, result.reason)}${transcriptNote}`;
  await postAck({ message: m, outcome: result.outcome, detail });
}

/** The Message record for an Intake/DM post, with the client resolved from the text. */
function baseMessage(msg: ChatMessage, raw: unknown, sender: string, text: string, clients: Awaited<ReturnType<typeof allClients>>): Message {
  const hit = resolveClientFromText(text, clients);
  return {
    channel: "intake", externalId: msg.name, teamId: null, clientId: hit?.client.id ?? null, scope: hit ? hit.client.scope : "unknown",
    sender, senderIsStaff: true, sentAt: msg.createTime ? new Date(msg.createTime) : new Date(),
    text: hit ? stripClientPrefix(text, hit.client) : text, permalink: permalinkFor(msg.name), threadRef: msg.thread?.name ?? null, raw,
  };
}

async function storeOnly(m: Message, skipReason: string): Promise<{ id: string }> {
  const { textHash } = await import("@/lib/dedupe");
  const rows = await sql()`
    insert into messages (channel, external_id, client_id, scope, sender, sender_is_staff, sent_at, text, text_hash, permalink, thread_ref, raw, skip_reason)
    values (${m.channel}, ${m.externalId}, ${m.clientId}, ${m.scope}, ${m.sender}, ${m.senderIsStaff}, ${m.sentAt.toISOString()}, ${m.text}, ${textHash(m.text || m.externalId)}, ${m.permalink}, ${m.threadRef}, ${JSON.stringify(m.raw)}::jsonb, ${skipReason})
    on conflict (channel, external_id) do update set skip_reason = excluded.skip_reason returning id`;
  return { id: rows[0].id as string };
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
