/**
 * The review surface: where drafts, questions, alerts, acknowledgements and the daily summary go.
 * REVIEW_SURFACE=gchat (Google Chat "PM Review" space) or slack (#pm-review in the home workspace).
 * Pipeline code calls these; it never knows which surface is behind them.
 */
import { sql } from "./db";
import type { Client, Draft, Message, RouteDecision } from "./types";
import * as slack from "./slack";
import * as gchat from "./gchat";

export type ReviewPost =
  | { kind: "draft"; requestId: string; taskId: string | null; client: Client | null; message: Message; route: RouteDecision; draft: Draft; confidence: number; reason: string }
  | { kind: "needs_human"; messageId: string; client: Client | null; message: Message; why: string }
  | { kind: "possible_duplicate"; requestId: string; client: Client | null; message: Message; duplicateOf: string }
  | { kind: "followup_change"; requestId: string; client: Client | null; message: Message; duplicateOf: string };

export const surface = (): "gchat" | "slack" => ((process.env.REVIEW_SURFACE ?? "gchat").toLowerCase() === "slack" ? "slack" : "gchat");

export function sourceLabel(m: Message): string {
  const where = { slack: "Slack", intake: "Intake", email: "Email", task_cmd: "/task", meet: "Meeting" }[m.channel] ?? m.channel;
  return `${where} · ${m.sender}`;
}

export async function postReview(p: ReviewPost): Promise<void> {
  if (surface() === "slack") return slack.postReview(p);
  if (!gchat.gchatConfigured()) { console.error("review surface gchat not configured; falling back to slack"); return slack.postReview(p); }

  const space = gchat.reviewSpace();
  const clientName = p.client?.name ?? "Unknown client";
  const scopeTag = p.client?.scope === "internal" ? " · internal" : "";

  if (p.kind === "draft") {
    const card = gchat.draftCard({
      requestId: p.requestId, clientName, scopeTag, department: p.route.department, priority: p.route.priority, gated: p.route.gated,
      confidence: p.confidence, title: p.draft.title, firstLine: p.draft.description.split("\n")[0], quote: p.message.text,
      source: sourceLabel(p.message), permalink: p.message.permalink, reason: p.reason,
      pulpLine: p.taskId ? "Card created in Staging." : "Card not created yet (Pulp not configured).",
    });
    await gchat.sendCard(space, card, `${clientName}: ${p.draft.title}`, `review-${p.requestId}`);
    return;
  }
  if (p.kind === "needs_human") {
    const rows = await sql()`select id, name from clients where scope = 'client' order by name limit 100`;
    const card = gchat.needsHumanCard({
      messageId: p.messageId, clientName, why: p.why, text: p.message.text, source: sourceLabel(p.message), permalink: p.message.permalink,
      clients: rows.map((r) => ({ id: String(r.id), name: String(r.name) })),
    });
    await gchat.sendCard(space, card, `${clientName}: needs a person (${p.why})`, `human-${p.messageId}`);
    return;
  }
  const label = p.kind === "possible_duplicate" ? "Possible duplicate" : "Change to an existing task";
  const card = gchat.duplicateCard({ requestId: p.requestId, duplicateOf: p.duplicateOf, clientName, label, text: p.message.text, source: sourceLabel(p.message), permalink: p.message.permalink });
  await gchat.sendCard(space, card, `${clientName}: ${label}`, `dup-${p.requestId}`);
}

export async function postP1Ping(p: { requestId: string; client: Client | null; title: string; message: Message; reason: string | null }): Promise<void> {
  if (surface() === "slack" || !gchat.gchatConfigured()) return slack.postP1Ping(p);
  await gchat.sendText(gchat.reviewSpace(), `🔴 *P1* · *${p.client?.name ?? "Unknown client"}*\n*${p.title}*\n_${p.reason ?? ""}_\n${sourceLabel(p.message)}${p.message.permalink ? ` · ${p.message.permalink}` : ""}`);
}

/** Plain text to the review surface (daily summary, notices). */
export async function postText(text: string): Promise<void> {
  if (surface() === "slack" || !gchat.gchatConfigured()) {
    await (await slack.web(null)).chat.postMessage({ channel: process.env.SLACK_REVIEW_CHANNEL || "#pm-review", text });
    return;
  }
  await gchat.sendText(gchat.reviewSpace(), text);
}

/**
 * Acknowledgement for anything a person put in by hand (Intake space, /task, forwarded email, voice note):
 * always one line in PM Review, whatever happened, so nobody wonders whether it was seen.
 */
export async function postAck(p: { message: Message; outcome: string; detail?: string }): Promise<void> {
  const short = p.message.text.replace(/\s+/g, " ").slice(0, 120);
  const icon = p.outcome.startsWith("draft") ? "✅" : p.outcome === "attached" ? "🔗" : p.outcome === "review" ? "❓" : p.outcome === "paused" ? "⏸️" : "ℹ️";
  const line = `${icon} Received from ${sourceLabel(p.message)}: "${short}${p.message.text.length > 120 ? "…" : ""}" → ${p.detail ?? p.outcome}`;
  await postText(line);
}
