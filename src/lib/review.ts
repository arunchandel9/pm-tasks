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

/**
 * notify (default): the Staging list in Pulp is the approval step. PM Review gets one short line per task, no buttons.
 * approve: every draft is a card with Approve / Not a task buttons (used automatically while Pulp is not connected,
 * because then there is no Staging list to approve from).
 */
export const reviewMode = (): "notify" | "approve" => ((process.env.REVIEW_MODE ?? "notify").toLowerCase() === "approve" ? "approve" : "notify");

export function sourceLabel(m: Message): string {
  const where = { slack: "Slack", intake: "Intake", email: "Email", task_cmd: "/task", meet: "Meeting" }[m.channel] ?? m.channel;
  return `${where} · ${m.sender}`;
}

const DEPT: Record<string, string> = { dev: "Dev", content: "Content", design: "Graphics", seo: "SEO", automation: "Automation", video: "Video", general: "PM", internal: "PM" };
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

/**
 * One feed line: `🆕 *HOH* · Fix Book Now button on mobile · Dev · P2 · Staging card · Slack, Dr Mehta`. P1 lines start with 🔴.
 * Gated asks (new page, new feature) say `Needs scope card` instead: the card waits in the Needs scope list until a person scopes it.
 */
export function draftLine(p: { client: Client | null; title: string; department: string; priority: string; gated: boolean; pulpLink: string | null; message: Message }): string {
  const icon = p.priority === "P1" ? "🔴 *P1*" : "🆕";
  const name = `*${p.client?.name ?? "Unknown client"}*${p.client?.scope === "internal" ? " (internal)" : ""}`;
  const hold = p.gated ? "Needs scope card" : "Staging card";
  const where = p.pulpLink ? `<${p.pulpLink}|${hold}>` : p.gated ? "needs scope, card pending" : "card pending";
  const parts = [`${icon} ${name}`, clip(p.title, 90), DEPT[p.department] ?? p.department, p.priority === "P1" ? null : p.priority, where, sourceLabel(p.message).replace(" · ", ", ")];
  return parts.filter(Boolean).join(" · ");
}

/** One feed line for a message that belongs to an existing task: noted on that card, nothing new created. */
export function followupLine(p: { client: Client | null; existingTitle: string; kind: "possible_duplicate" | "followup_change"; message: Message }): string {
  const what = p.kind === "possible_duplicate" ? "same as" : "update to";
  return `🔁 *${p.client?.name ?? "Unknown client"}* · "${clip(p.message.text.replace(/\s+/g, " "), 80)}" · ${what} *${clip(p.existingTitle, 60)}* · noted on its card`;
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
    const sent = await gchat.sendCard(space, card, `${clientName}: ${p.draft.title}`, `review-${p.requestId}`);
    await rememberThread(sent.thread, { kind: "request", requestId: p.requestId });
    return;
  }
  if (p.kind === "needs_human") {
    const rows = await sql()`select id, name from clients where scope = 'client' order by name limit 100`;
    const card = gchat.needsHumanCard({
      messageId: p.messageId, clientName, why: p.why, text: p.message.text, source: sourceLabel(p.message), permalink: p.message.permalink,
      clients: rows.map((r) => ({ id: String(r.id), name: String(r.name) })),
    });
    const sent = await gchat.sendCard(space, card, `${clientName}: needs a person (${p.why})`, `human-${p.messageId}`);
    await rememberThread(sent.thread, { kind: "needs_human", messageId: p.messageId });
    if (sent.name) await sql()`insert into settings (key, value) values (${"gchat_card_for:" + p.messageId}, ${JSON.stringify(sent.name)}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`;
    return;
  }
  const label = p.kind === "possible_duplicate" ? "Possible duplicate" : "Change to an existing task";
  const card = gchat.duplicateCard({ requestId: p.requestId, duplicateOf: p.duplicateOf, clientName, label, text: p.message.text, source: sourceLabel(p.message), permalink: p.message.permalink });
  const sent = await gchat.sendCard(space, card, `${clientName}: ${label}`, `dup-${p.requestId}`);
  await rememberThread(sent.thread, { kind: "request", requestId: p.requestId, duplicateOf: p.duplicateOf });
}

/** What a PM Review card thread is about, so a typed reply in that thread can answer it. */
export type ThreadTopic = { kind: "needs_human"; messageId: string } | { kind: "request"; requestId: string; duplicateOf?: string };
async function rememberThread(thread: string | null, topic: ThreadTopic): Promise<void> {
  if (!thread) return;
  await sql()`insert into settings (key, value) values (${"gchat_thread:" + thread}, ${JSON.stringify(topic)}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`;
}
/** Replace the "needs a person" card with a one-line outcome once someone answered it (from anywhere). */
export async function closeNeedsHumanCard(messageId: string, text: string): Promise<void> {
  const r = await sql()`select value from settings where key = ${"gchat_card_for:" + messageId}`;
  if (!r.length || surface() !== "gchat") return;
  try { await gchat.updateMessageText(String(r[0].value), text); } catch (e) { console.error("card update failed", (e as Error).message); }
}
export async function threadTopic(thread: string | null | undefined): Promise<ThreadTopic | null> {
  if (!thread) return null;
  const r = await sql()`select value from settings where key = ${"gchat_thread:" + thread}`;
  return r.length ? (r[0].value as ThreadTopic) : null;
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
/** Plain-English version of the pipeline's outcome/reason codes, for the acknowledgement line. */
export function humanOutcome(outcome: string, reason?: string | null): string {
  const r = reason ?? "";
  const known: Record<string, string> = {
    no_ask: "no task in it: nothing was asked. If it is a task, say what should be done, e.g. \"update the price list\".",
    already_seen: "already received earlier, nothing new created.",
    daily_cap: "today's limit for this client reached; a person should look.",
    unknown_client: "could not tell which client; pick one on the card below.",
    duplicate: "same as an existing task; noted on its card.",
    nudge: "a chase on an existing task; noted on its card.",
    change: "an update to an existing task; noted on its card.",
    acknowledgement: "just a thank-you or OK, nothing to do.",
    noise: "not a request, nothing to do.",
  };
  if (known[r]) return known[r];
  if (outcome === "attached") return "added to an existing task's card.";
  if (outcome === "paused") return "intake is paused; it is queued and will be processed when resumed.";
  if (outcome === "skipped") return `nothing to do${r ? ` (${r.replace(/_/g, " ")})` : ""}.`;
  if (outcome === "review") return r ? `needs a person: ${r.replace(/_/g, " ")}.` : "needs a person; see the card below.";
  return r ? r.replace(/_/g, " ") : outcome;
}

export async function postAck(p: { message: Message; outcome: string; detail?: string }): Promise<void> {
  const short = p.message.text.replace(/\s+/g, " ").slice(0, 120);
  const icon = p.outcome.startsWith("draft") ? "✅" : p.outcome === "attached" ? "🔗" : p.outcome === "review" ? "❓" : p.outcome === "paused" ? "⏸️" : "ℹ️";
  const line = `${icon} From ${sourceLabel(p.message).replace(" · ", ", ")}: "${short}${p.message.text.length > 120 ? "…" : ""}" → ${p.detail ?? humanOutcome(p.outcome)}`;
  await postText(line);
}
