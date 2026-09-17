import { NextResponse } from "next/server";
import { reprocessSoon } from "@/lib/reprocess";
import { waitUntil } from "@vercel/functions";
import { verifySlackSignature, web, slackUser, userNames, homeTeamId, downloadSlackFile } from "@/lib/slack";
import { slackToMessage, mentionedUsers, isAudioFile, type SlackMessageEvent } from "@/lib/normalize/slack";
import { slackNoise } from "@/lib/filter/noise";
import { noise, env } from "@/lib/config";
import { allClients, sql, getSetting } from "@/lib/db";
import { processMessage, storeSkipped } from "@/lib/pipeline";
import { approveRequest, dismissRequest, mergeRequest } from "@/lib/tasks";
import { resolveClientFromText, stripClientPrefix } from "@/lib/resolve";
import { transcribeAudio, startLongTranscription, estimateMinutes, hintPhrases } from "@/lib/transcribe";
import { postText, messageThreadKey } from "@/lib/review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One endpoint for Slack across every workspace the app is installed in:
 * URL verification, message events, slash command, and button clicks.
 * Slack expects a 200 within 3 seconds; the pipeline runs after the ack.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  const ts = req.headers.get("x-slack-request-timestamp") ?? "";
  const sig = req.headers.get("x-slack-signature") ?? "";
  if (!verifySlackSignature(raw, ts, sig)) return new NextResponse("bad signature", { status: 401 });

  const ctype = req.headers.get("content-type") ?? "";

  if (ctype.includes("application/x-www-form-urlencoded")) {
    const form = new URLSearchParams(raw);
    const payload = form.get("payload");
    if (payload) return handleInteraction(JSON.parse(payload));
    if (form.get("command")) return handleSlashCommand(form);
    return NextResponse.json({ ok: true });
  }

  const body = JSON.parse(raw);
  if (body.type === "url_verification") return NextResponse.json({ challenge: body.challenge });
  if (body.type !== "event_callback") return NextResponse.json({ ok: true });

  const ev = body.event as SlackMessageEvent;
  const teamId: string | null = body.team_id ?? ev.team ?? null;
  if (ev.type !== "message") { waitUntil(recordLastEvent({ team: teamId, type: ev.type, outcome: "ignored: not a message" })); return NextResponse.json({ ok: true }); }

  // Slack retries on slow responses; (channel, ts) is unique so a retry is harmless.
  waitUntil(handleMessageEvent(ev, teamId)
    .then((outcome) => recordLastEvent({ team: teamId, channel: ev.channel, user: ev.user ?? ev.bot_id ?? null, subtype: ev.subtype ?? null, text: (ev.text ?? "").slice(0, 60), outcome }))
    .catch((e) => { console.error("slack event failed", e); return recordLastEvent({ team: teamId, channel: ev.channel, user: ev.user ?? null, subtype: ev.subtype ?? null, text: (ev.text ?? "").slice(0, 60), outcome: `failed: ${(e as Error).message.slice(0, 200)}` }); }));
  return NextResponse.json({ ok: true });
}

/** The last Slack event and what became of it, kept in settings so health and hub_status can show it (nothing fails quietly). */
async function recordLastEvent(info: Record<string, unknown>) {
  try {
    await sql()`insert into settings (key, value) values ('slack_last_event', ${JSON.stringify({ at: new Date().toISOString(), ...info })}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`;
  } catch (e) { console.error("slack recordLastEvent failed", (e as Error).message); }
}

async function handleMessageEvent(ev: SlackMessageEvent, teamId: string | null) {
  const clients = await allClients();
  const home = await homeTeamId();
  const intakeId = await getSetting<string | null>("intake_channel_id", null);
  const who = ev.user ? await slackUser(teamId, ev.user) : { isStaff: false, isBot: !!ev.bot_id, name: null, email: null };
  const senderIsStaff = who.isStaff;
  const workspaceUrl = await getSetting<string | null>(`workspace_url:${teamId}`, null);
  const names = await userNames(teamId, mentionedUsers(ev.text ?? ""));

  // A voice clip from the client is read like a voice note in the DM: same engine, same vocabulary hints.
  let transcript: string | null = null, transcriptNote: string | null = null;
  const audio = (ev.files ?? []).find((f) => isAudioFile(f) && (f.url_private_download || f.url_private));
  if (audio && !senderIsStaff && !ev.bot_id) {
    const hints = hintPhrases(clients.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
    try {
      const buf = await downloadSlackFile(teamId, (audio.url_private_download ?? audio.url_private)!);
      const t = await transcribeAudio(buf, audio.mimetype ?? "", audio.name ?? "", hints);
      if ("text" in t && t.text) transcript = t.text;
      else if ("tooLong" in t) {
        // A long clip: start the long-running recognition, store the message now, and let the minute tick finish it.
        const base = slackToMessage(ev, { teamId, homeTeamId: home, clients, senderIsStaff, senderName: who.name, intakeChannelId: intakeId, workspaceUrl, userNames: names });
        const job = await startLongTranscription(buf, audio.mimetype ?? "", audio.name ?? "", undefined, hints);
        const stored = await storeSkipped(base, "transcribing");
        await sql()`insert into queue (kind, payload, next_run_at) values ('transcribe_poll', ${JSON.stringify({ messageId: stored.id, job, typed: base.text })}::jsonb, now() + interval '60 seconds')`;
        await postText(`🎙️ Voice clip from ${base.sender} in ${base.clientId ? clients.find((c) => c.id === base.clientId)?.name ?? "their Slack" : "Slack"} (about ${estimateMinutes(buf.length, audio.mimetype ?? "")} min). Transcribing; the task lines follow in a few minutes.`, { threadKey: messageThreadKey(stored.id) });
        return;
      } else transcriptNote = "error" in t ? t.error : "unknown";
    } catch (e) { transcriptNote = (e as Error).message; }
    if (transcriptNote) console.error("slack voice clip not transcribed:", transcriptNote);
  }

  const m = slackToMessage(ev, { teamId, homeTeamId: home, clients, senderIsStaff, senderName: who.name, intakeChannelId: intakeId, workspaceUrl, userNames: names, transcript });
  const isIntake = m.channel === "intake";
  if (isIntake && !m.clientId) {
    const hit = resolveClientFromText(m.text, clients);
    if (hit) { m.clientId = hit.client.id; m.scope = hit.client.scope; m.text = stripClientPrefix(m.text, hit.client); }
  }

  let threadRootIsRequest = false;
  if (m.threadRef) {
    const r = await sql()`
      select 1 from messages pm join requests r on r.message_id = pm.id
      where pm.channel in ('slack','intake') and pm.external_id = ${m.threadRef} limit 1`;
    threadRootIsRequest = r.length > 0;
  }

  const verdict = slackNoise(
    {
      subtype: ev.subtype, botId: ev.bot_id, text: m.text, senderIsStaff: m.senderIsStaff,
      isIntakeChannel: isIntake, isThreadReply: !!m.threadRef, threadRootIsRequest,
      hasFilesOnly: !!ev.files?.length && !m.text.trim(),
    },
    noise()
  );
  const result = await processMessage(m, verdict);
  console.log("processed", result);
  return `${result.outcome}${result.reason ? `: ${result.reason}` : ""} · client ${m.clientId ?? "none"} · ${senderIsStaff ? "staff" : "client"} ${m.sender}`;
}

async function handleSlashCommand(form: URLSearchParams) {
  // /task <text>  → a staff-submitted intake message. Client from the workspace, or from the client name in the text.
  const text = (form.get("text") ?? "").trim();
  const user = form.get("user_id") ?? "unknown";
  const teamId = form.get("team_id");
  // Clients can type this too, so the reply says nothing about how the hub works.
  if (!text) return NextResponse.json({ response_type: "ephemeral", text: "Task Hub" });
  const clients = await allClients();
  const client = clients.find((c) => c.slackTeamId === teamId && c.scope === "client") ?? resolveClientFromText(text, clients)?.client ?? null;
  const m = {
    channel: "task_cmd" as const, externalId: `${user}:${Date.now()}`, teamId, clientId: client?.id ?? null,
    scope: client ? client.scope : ("unknown" as const), sender: user, senderIsStaff: true, sentAt: new Date(),
    text: client ? stripClientPrefix(text, client) : text, permalink: null, threadRef: null, raw: Object.fromEntries(form.entries()),
  };
  waitUntil(processMessage(m, { skip: false, reason: null }).catch((e) => console.error("/task failed", e)));
  return NextResponse.json({ response_type: "ephemeral", text: "Task Hub: noted." });
}

async function handleInteraction(payload: { type: string; team?: { id: string }; user?: { id: string; username?: string }; actions?: Array<{ action_id: string; value?: string; block_id?: string; selected_option?: { value: string } }>; message?: { ts: string }; channel?: { id: string } }) {
  const action = payload.actions?.[0];
  const who = payload.user?.username ?? payload.user?.id ?? "unknown";
  if (!action) return NextResponse.json({ ok: true });

  const finish = async (line: string) => {
    if (payload.channel?.id && payload.message?.ts) {
      try {
        await (await web(payload.team?.id ?? null)).chat.update({ channel: payload.channel.id, ts: payload.message.ts, text: line, blocks: [{ type: "section", text: { type: "mrkdwn", text: line } }] });
      } catch (e) { console.error("chat.update failed", e); }
    }
  };

  try {
    switch (action.action_id) {
      case "approve":
        await approveRequest(action.value!, who);
        await finish(`✅ Approved by ${who} · request \`${action.value!.slice(0, 8)}\``);
        break;
      case "dismiss":
        await dismissRequest(action.value!, who);
        await finish(`🗑️ Not a task · by ${who}`);
        break;
      case "merge_into": {
        const [id, into] = action.value!.split("|");
        await mergeRequest(id, into, who);
        await finish(`🔗 Merged into \`${into.slice(0, 8)}\` by ${who}`);
        break;
      }
      case "merge":
      case "edit":
        return NextResponse.json({ response_type: "ephemeral", text: "Edit and Merge open a form in the next build. For now: Approve, or Not a task, and fix the card in Pulp." });
      case "make_task":
        await sql()`update messages set skip_reason = null where id = ${action.value!}`;
        reprocessSoon(String(action.value), waitUntil);
        await finish(`↪️ Marked as a task by ${who}; it will be processed on the next tick.`);
        break;
      case "pick_client": {
        // Dropdown on a "needs a person" card: value = messageId, selected_option = client id. Picking = processing.
        const messageId = action.value ?? (action.block_id ?? "").replace(/^human:/, "");
        const clientId = action.selected_option?.value;
        if (!messageId || !clientId) break;
        const c = (await allClients()).find((x) => x.id === clientId);
        await sql()`update messages set client_id = ${clientId}, scope = ${c?.scope ?? "client"}, skip_reason = null where id = ${messageId}`;
        await sql()`insert into queue (kind, payload) values ('process_message', ${JSON.stringify({ messageId })}::jsonb)`;
        await finish(`👤 Client set to *${c?.name ?? clientId}* by ${who}; processing on the next tick.`);
        break;
      }
      case "dismiss_message":
        await sql()`update messages set skip_reason = 'dismissed_by_human' where id = ${action.value!}`;
        await finish(`🗑️ Not a task · by ${who}`);
        break;
    }
  } catch (e) {
    console.error("interaction failed", e);
    return NextResponse.json({ response_type: "ephemeral", text: `That failed: ${(e as Error).message}` });
  }
  return NextResponse.json({ ok: true });
}
