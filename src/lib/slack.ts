import { WebClient } from "@slack/web-api";
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./config";
import { sql } from "./db";
import type { Client, Draft, Message, RouteDecision } from "./types";

let _web: WebClient | null = null;
export function web(): WebClient {
  if (!_web) _web = new WebClient(process.env.SLACK_BOT_TOKEN);
  return _web;
}

export function verifySlackSignature(rawBody: string, timestamp: string, signature: string): boolean {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 60 * 5) return false;
  const base = `v0:${timestamp}:${rawBody}`;
  const hmac = "v0=" + createHmac("sha256", secret).update(base).digest("hex");
  const a = Buffer.from(hmac), b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

function slackChannelAndTs(m: Message): { channel: string; ts: string } | null {
  if (m.channel !== "slack" && m.channel !== "intake") return null;
  const [channel, ts] = m.externalId.split(":");
  return channel && ts ? { channel, ts } : null;
}

/** Internal acknowledgement: a reaction on the source message. Never a client-facing reply. */
export async function addReaction(m: Message, name: string): Promise<void> {
  const ref = slackChannelAndTs(m);
  if (!ref) return;
  try {
    await web().reactions.add({ channel: ref.channel, timestamp: ref.ts, name });
  } catch {
    /* already reacted or no permission: not worth failing the pipeline */
  }
}

type ReviewPost =
  | { kind: "draft"; requestId: string; taskId: string | null; client: Client | null; message: Message; route: RouteDecision; draft: Draft; confidence: number; reason: string }
  | { kind: "needs_human"; messageId: string; client: Client | null; message: Message; why: string }
  | { kind: "possible_duplicate"; requestId: string; client: Client | null; message: Message; duplicateOf: string }
  | { kind: "followup_change"; requestId: string; client: Client | null; message: Message; duplicateOf: string };

function sourceLine(m: Message): string {
  const where = m.channel === "slack" ? "Slack" : m.channel === "intake" ? "#intake" : m.channel;
  return m.permalink ? `From ${where} · ${m.sender} · <${m.permalink}|open message>` : `From ${where} · ${m.sender}`;
}

export async function postReview(p: ReviewPost): Promise<void> {
  const channel = env.reviewChannel();
  const clientName = p.client?.name ?? "Unknown client";
  const scopeTag = p.client?.scope === "internal" ? " · internal" : "";

  if (p.kind === "draft") {
    const conf = p.confidence.toFixed(2);
    const pulpLine = p.taskId ? "Card created in Staging." : "Card not created yet (Pulp not configured).";
    await web().chat.postMessage({
      channel,
      text: `${clientName}: ${p.draft.title}`,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `*${clientName}*${scopeTag} · ${p.route.department} · ${p.route.priority}${p.route.gated ? " · *Needs scope*" : ""} · confidence ${conf}\n*${p.draft.title}*\n> ${p.draft.description.split("\n")[0]}` } },
        { type: "context", elements: [{ type: "mrkdwn", text: `${sourceLine(p.message)}\n_${p.reason}_ · ${pulpLine}` }] },
        {
          type: "actions",
          block_id: `review:${p.requestId}`,
          elements: [
            { type: "button", style: "primary", text: { type: "plain_text", text: "Approve" }, action_id: "approve", value: p.requestId },
            { type: "button", text: { type: "plain_text", text: "Edit" }, action_id: "edit", value: p.requestId },
            { type: "button", text: { type: "plain_text", text: "Merge into…" }, action_id: "merge", value: p.requestId },
            { type: "button", style: "danger", text: { type: "plain_text", text: "Not a task" }, action_id: "dismiss", value: p.requestId },
          ],
        },
      ],
    });
    return;
  }

  if (p.kind === "needs_human") {
    await web().chat.postMessage({
      channel,
      text: `${clientName}: needs a person (${p.why})`,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `*${clientName}* · needs a person · _${p.why.replace(/_/g, " ")}_\n> ${p.message.text.slice(0, 300) || "(no text)"}` } },
        { type: "context", elements: [{ type: "mrkdwn", text: sourceLine(p.message) }] },
        {
          type: "actions",
          block_id: `human:${p.messageId}`,
          elements: [
            { type: "button", style: "primary", text: { type: "plain_text", text: "Make it a task" }, action_id: "make_task", value: p.messageId },
            { type: "button", text: { type: "plain_text", text: "Not a task" }, action_id: "dismiss_message", value: p.messageId },
          ],
        },
      ],
    });
    return;
  }

  const label = p.kind === "possible_duplicate" ? "Possible duplicate" : "Change to an existing task";
  await web().chat.postMessage({
    channel,
    text: `${clientName}: ${label}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${clientName}* · ${label} of request \`${p.duplicateOf.slice(0, 8)}\`\n> ${p.message.text.slice(0, 300)}` } },
      { type: "context", elements: [{ type: "mrkdwn", text: sourceLine(p.message) }] },
      {
        type: "actions",
        block_id: `dup:${p.requestId}`,
        elements: [
          { type: "button", style: "primary", text: { type: "plain_text", text: "Merge into it" }, action_id: "merge_into", value: `${p.requestId}|${p.duplicateOf}` },
          { type: "button", text: { type: "plain_text", text: "Separate task" }, action_id: "approve", value: p.requestId },
          { type: "button", text: { type: "plain_text", text: "Not a task" }, action_id: "dismiss", value: p.requestId },
        ],
      },
    ],
  });
}

export async function postP1Ping(p: { requestId: string; client: Client | null; title: string; message: Message; reason: string | null }): Promise<void> {
  await web().chat.postMessage({
    channel: env.p1Channel(),
    text: `🔴 P1 · ${p.client?.name ?? "Unknown client"} · ${p.title}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `🔴 *P1* · *${p.client?.name ?? "Unknown client"}*\n*${p.title}*\n_${p.reason ?? ""}_` } },
      { type: "context", elements: [{ type: "mrkdwn", text: sourceLine(p.message) }] },
    ],
  });
}

/** A nudge or follow-up on an existing task: comment on the card (via tasks table) and note in review thread. */
export async function postThreadFollowupComment(p: { taskId: string | null; requestId: string; message: Message; flag?: "client_waiting" }): Promise<void> {
  await sql()`
    insert into queue (kind, payload) values ('card_comment', ${JSON.stringify({ taskId: p.taskId, requestId: p.requestId, text: p.message.text, permalink: p.message.permalink, flag: p.flag ?? null })}::jsonb)`;
  await addReaction(p.message, "link");
}
