import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { verifyChatRequest, intakeSpace, reviewSpace, taskDialog, dialogOk, updateCardResponse, downloadAttachment } from "@/lib/gchat";
import { allClients, sql } from "@/lib/db";
import { processMessage } from "@/lib/pipeline";
import { approveRequest, dismissRequest, mergeRequest } from "@/lib/tasks";
import { resolveClientFromText, stripClientPrefix } from "@/lib/resolve";
import { postAck, postReview } from "@/lib/review";
import { transcribeAudio, isAudio } from "@/lib/transcribe";
import type { Message } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Google Chat interaction events: messages in the Intake space, /task dialog, card button clicks. */
export async function POST(req: Request) {
  if (!(await verifyChatRequest(req.headers.get("authorization")))) return new NextResponse("unauthorized", { status: 401 });
  const ev = await req.json();
  const type: string = ev.type ?? "";

  if (type === "ADDED_TO_SPACE") {
    const space = ev.space?.name ?? "";
    const role = space === reviewSpace() ? "PM Review: drafts, questions, alerts and the daily summary land here." : space === intakeSpace() ? "Intake: paste a WhatsApp or any message here, drop a voice note, or type /task for the form. Start with the client name and a colon when you can." : "Add me to the PM Review and Intake spaces.";
    return NextResponse.json({ text: `Task Hub is here. ${role}` });
  }

  if (type === "MESSAGE") {
    const msg = ev.message ?? {};
    // /task → open the form
    if (msg.slashCommand?.commandId !== undefined || /^\/task\b/.test(msg.text ?? "")) {
      const clients = (await allClients()).filter((c) => c.scope === "client").map((c) => ({ id: c.id, name: c.name }));
      return NextResponse.json(taskDialog(clients));
    }
    if (ev.isDialogEvent && ev.dialogEventType === "SUBMIT") return handleDialogSubmit(ev);
    if ((ev.space?.name ?? msg.space?.name) !== intakeSpace()) return NextResponse.json({});
    waitUntil(handleIntakeMessage(ev).catch((e) => console.error("gchat intake failed", e)));
    return NextResponse.json({});
  }

  if (type === "CARD_CLICKED") return handleCardClick(ev);
  if (ev.isDialogEvent && ev.dialogEventType === "SUBMIT") return handleDialogSubmit(ev);
  return NextResponse.json({});
}

function permalinkFor(messageName: string): string | null {
  const m = messageName.match(/^spaces\/([^/]+)\/messages\/(.+)$/);
  return m ? `https://chat.google.com/room/${m[1]}/${m[2]}` : null;
}

async function handleIntakeMessage(ev: { message: { name: string; text?: string; argumentText?: string; sender?: { email?: string; displayName?: string }; createTime?: string; attachment?: Array<{ name?: string; contentName?: string; contentType?: string; attachmentDataRef?: { resourceName?: string } }> } }) {
  const msg = ev.message;
  const clients = await allClients();
  let text = (msg.argumentText ?? msg.text ?? "").trim();
  const sender = msg.sender?.email ?? msg.sender?.displayName ?? "unknown";
  let transcriptNote = "";

  // Voice notes and other audio: transcribe, then treat the transcript as the message.
  for (const a of msg.attachment ?? []) {
    if (!a.attachmentDataRef?.resourceName || !isAudio(a.contentType ?? "", a.contentName ?? "")) continue;
    try {
      const buf = await downloadAttachment(a.attachmentDataRef.resourceName);
      const t = await transcribeAudio(buf, a.contentType ?? "", a.contentName ?? "");
      if ("text" in t && t.text) { text = [text, t.text].filter(Boolean).join("\n"); transcriptNote = " (voice note transcribed)"; }
      else if ("tooLong" in t) transcriptNote = " (voice note over a minute: please type the ask)";
      else transcriptNote = ` (voice note could not be transcribed: ${"error" in t ? t.error : "unknown"})`;
    } catch (e) { transcriptNote = ` (voice note download failed: ${(e as Error).message})`; }
  }

  const hit = resolveClientFromText(text, clients);
  const m: Message = {
    channel: "intake", externalId: msg.name, teamId: null, clientId: hit?.client.id ?? null, scope: hit ? hit.client.scope : "unknown",
    sender, senderIsStaff: true, sentAt: msg.createTime ? new Date(msg.createTime) : new Date(),
    text: hit ? stripClientPrefix(text, hit.client) : text, permalink: permalinkFor(msg.name), threadRef: null, raw: ev,
  };
  if (!m.text.trim() && !msg.attachment?.length) return;
  if (!m.text.trim()) {
    await postReview({ kind: "needs_human", messageId: (await storeOnly(m)).id, client: null, message: m, why: `attachment_only${transcriptNote}` });
    return;
  }
  const result = await processMessage(m, { skip: false, reason: null });
  const detail = result.outcome === "review" && result.requestIds?.length ? `${result.requestIds.length} draft${result.requestIds.length > 1 ? "s" : ""} for ${hit?.client.name ?? "unknown client"} below${transcriptNote}`
    : result.outcome === "review" ? `needs a decision below${transcriptNote}`
    : result.outcome === "attached" ? `attached to an existing task${transcriptNote}`
    : result.outcome === "skipped" ? `no task found (${result.reason ?? "update only"})${transcriptNote}`
    : `${result.outcome}${transcriptNote}`;
  await postAck({ message: m, outcome: result.outcome, detail });
}

async function storeOnly(m: Message): Promise<{ id: string }> {
  const { textHash } = await import("@/lib/dedupe");
  const rows = await sql()`
    insert into messages (channel, external_id, client_id, scope, sender, sender_is_staff, sent_at, text, text_hash, permalink, thread_ref, raw, skip_reason)
    values (${m.channel}, ${m.externalId}, ${m.clientId}, ${m.scope}, ${m.sender}, ${m.senderIsStaff}, ${m.sentAt.toISOString()}, ${m.text}, ${textHash(m.text || m.externalId)}, ${m.permalink}, ${m.threadRef}, ${JSON.stringify(m.raw)}::jsonb, 'attachment_only')
    on conflict (channel, external_id) do update set skip_reason = excluded.skip_reason returning id`;
  return { id: rows[0].id as string };
}

async function handleDialogSubmit(ev: { common?: { formInputs?: Record<string, { stringInputs?: { value?: string[] } }> }; user?: { email?: string; displayName?: string } }) {
  const f = ev.common?.formInputs ?? {};
  const get = (k: string) => f[k]?.stringInputs?.value?.[0]?.trim() ?? "";
  const clientId = get("client"), request = get("request"), notes = get("notes"), priority = get("priority") || "P3", source = get("source");
  if (!request) return NextResponse.json(dialogOk("Please write what was asked."));
  const clients = await allClients();
  const client = clients.find((c) => c.id === clientId) ?? null;
  const body = [request, notes ? `\nNotes from ${ev.user?.displayName ?? "team"}: ${notes}` : "", source ? `\nCame via: ${source}` : "", priority === "P1" ? "\nMarked urgent (P1) by the team." : priority === "P2" ? "\nMarked important by the team." : ""].join("");
  const m: Message = {
    channel: "task_cmd", externalId: `gchat:${ev.user?.email ?? "u"}:${Date.now()}`, teamId: null, clientId: client?.id ?? null, scope: client ? client.scope : "unknown",
    sender: ev.user?.email ?? "unknown", senderIsStaff: true, sentAt: new Date(), text: body, permalink: null, threadRef: null, raw: ev,
  };
  waitUntil((async () => {
    const r = await processMessage(m, { skip: false, reason: null });
    await postAck({ message: m, outcome: r.outcome, detail: r.requestIds?.length ? `${r.requestIds.length} draft${r.requestIds.length > 1 ? "s" : ""} for ${client?.name ?? "unknown client"} below` : r.reason ?? r.outcome });
  })().catch((e) => console.error("dialog submit failed", e)));
  return NextResponse.json(dialogOk(`Added for ${client?.name ?? "unknown client"}. Watch PM Review.`));
}

async function handleCardClick(ev: { common?: { invokedFunction?: string; parameters?: Record<string, string>; formInputs?: Record<string, { stringInputs?: { value?: string[] } }> }; action?: { actionMethodName?: string; parameters?: Array<{ key: string; value: string }> }; user?: { email?: string; displayName?: string } }) {
  const fn = ev.common?.invokedFunction ?? ev.action?.actionMethodName ?? "";
  const params: Record<string, string> = { ...(ev.common?.parameters ?? {}) };
  for (const p of ev.action?.parameters ?? []) params[p.key] = p.value;
  const who = ev.user?.displayName ?? ev.user?.email ?? "unknown";
  try {
    switch (fn) {
      case "approve":
        await approveRequest(params.requestId, who);
        return NextResponse.json(updateCardResponse(`✅ Approved by ${who} · request ${params.requestId.slice(0, 8)}`));
      case "dismiss":
        await dismissRequest(params.requestId, who);
        return NextResponse.json(updateCardResponse(`🗑️ Not a task · by ${who}`));
      case "merge_into":
        await mergeRequest(params.requestId, params.into, who);
        return NextResponse.json(updateCardResponse(`🔗 Merged into ${params.into.slice(0, 8)} by ${who}`));
      case "edit":
      case "merge":
        return NextResponse.json({ text: "Edit and Merge open a form in the next build. For now: Approve, or Not a task, and fix the card in Pulp." });
      case "make_task":
        await sql()`update messages set skip_reason = null where id = ${params.messageId}`;
        await sql()`insert into queue (kind, payload) values ('process_message', ${JSON.stringify({ messageId: params.messageId })}::jsonb)`;
        return NextResponse.json(updateCardResponse(`↪️ Marked as a task by ${who}; processing on the next tick.`));
      case "pick_client": {
        const clientId = ev.common?.formInputs?.client?.stringInputs?.value?.[0];
        if (!clientId) return NextResponse.json({});
        const c = (await allClients()).find((x) => x.id === clientId);
        await sql()`update messages set client_id = ${clientId}, scope = ${c?.scope ?? "client"}, skip_reason = null where id = ${params.messageId}`;
        await sql()`insert into queue (kind, payload) values ('process_message', ${JSON.stringify({ messageId: params.messageId })}::jsonb)`;
        return NextResponse.json(updateCardResponse(`👤 Client set to ${c?.name ?? clientId} by ${who}; processing on the next tick.`));
      }
      case "dismiss_message":
        await sql()`update messages set skip_reason = 'dismissed_by_human' where id = ${params.messageId}`;
        return NextResponse.json(updateCardResponse(`🗑️ Not a task · by ${who}`));
      default:
        return NextResponse.json({});
    }
  } catch (e) {
    console.error("card click failed", e);
    return NextResponse.json({ text: `That failed: ${(e as Error).message}` });
  }
}
