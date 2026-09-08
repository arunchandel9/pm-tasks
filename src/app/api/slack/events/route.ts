import { NextResponse } from "next/server";
import { verifySlackSignature, web, isStaffUser, homeTeamId } from "@/lib/slack";
import { slackToMessage, type SlackMessageEvent } from "@/lib/normalize/slack";
import { slackNoise } from "@/lib/filter/noise";
import { noise, env } from "@/lib/config";
import { allClients, sql, getSetting } from "@/lib/db";
import { processMessage } from "@/lib/pipeline";
import { approveRequest, dismissRequest, mergeRequest } from "@/lib/tasks";

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
  if (ev.type !== "message") return NextResponse.json({ ok: true });
  const teamId: string | null = body.team_id ?? ev.team ?? null;

  // Slack retries on slow responses; (channel, ts) is unique so a retry is harmless.
  void handleMessageEvent(ev, teamId).catch((e) => console.error("slack event failed", e));
  return NextResponse.json({ ok: true });
}

async function handleMessageEvent(ev: SlackMessageEvent, teamId: string | null) {
  const clients = await allClients();
  const home = await homeTeamId();
  const intakeId = await getSetting<string | null>("intake_channel_id", null);
  const senderIsStaff = ev.user ? await isStaffUser(teamId, ev.user) : false;
  const workspaceUrl = await getSetting<string | null>(`workspace_url:${teamId}`, null);

  const m = slackToMessage(ev, { teamId, homeTeamId: home, clients, senderIsStaff, intakeChannelId: intakeId, workspaceUrl });
  const isIntake = m.channel === "intake";

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
      hasFilesOnly: !!ev.files?.length && !(ev.text ?? "").trim(),
    },
    noise()
  );
  const result = await processMessage(m, verdict);
  console.log("processed", result);
}

async function handleSlashCommand(form: URLSearchParams) {
  // /task <text>  → a staff-submitted intake message. Client from the workspace, or from the client name in the text.
  const text = (form.get("text") ?? "").trim();
  const user = form.get("user_id") ?? "unknown";
  const teamId = form.get("team_id");
  if (!text) return NextResponse.json({ response_type: "ephemeral", text: "Usage: /task <what the client asked for>. Add the client name if this isn't their workspace." });
  const clients = await allClients();
  const client = clients.find((c) => c.slackTeamId === teamId) ?? clients.find((c) => text.toLowerCase().includes(c.name.toLowerCase())) ?? null;
  const m = {
    channel: "task_cmd" as const, externalId: `${user}:${Date.now()}`, teamId, clientId: client?.id ?? null,
    scope: client ? client.scope : ("unknown" as const), sender: user, senderIsStaff: true, sentAt: new Date(),
    text, permalink: null, threadRef: null, raw: Object.fromEntries(form.entries()),
  };
  void processMessage(m, { skip: false, reason: null }).catch((e) => console.error("/task failed", e));
  return NextResponse.json({ response_type: "ephemeral", text: client ? `Got it for ${client.name}. It will appear in ${env.reviewChannel()}.` : `Got it. I couldn't tell the client, so it will appear in ${env.reviewChannel()} for you to pick.` });
}

async function handleInteraction(payload: { type: string; team?: { id: string }; user?: { id: string; username?: string }; actions?: Array<{ action_id: string; value?: string }>; message?: { ts: string }; channel?: { id: string } }) {
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
        await sql()`insert into queue (kind, payload) values ('process_message', ${JSON.stringify({ messageId: action.value })}::jsonb)`;
        await finish(`↪️ Marked as a task by ${who}; it will be processed on the next tick.`);
        break;
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
