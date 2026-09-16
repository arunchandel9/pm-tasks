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
  if (m.channel === "task_cmd" && /via Claude/i.test(m.sender)) return m.sender; // "Anuj via Claude-Arun": the person, then the account
  const where = { slack: "Slack", intake: "Task Hub", email: "Email", task_cmd: "Claude", meet: "Meeting" }[m.channel] ?? m.channel;
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

/** One feed line for a message that belongs to an existing task: noted on that card, nothing new created. The words go in the thread. */
export function followupLine(p: { client: Client | null; existingTitle: string; kind: "possible_duplicate" | "followup_change"; message: Message; pulpLink?: string | null }): string {
  const what = p.kind === "possible_duplicate" ? "same as" : "update to";
  const card = p.pulpLink ? `<${p.pulpLink}|card>` : "card";
  return `🔁 *${p.client?.name ?? "Unknown client"}* · ${what} *${clip(p.existingTitle, 60)}* · noted on its ${card} · ${sourceLabel(p.message).replace(" · ", ", ")}`;
}

/** The sender's own words, for the thread under a feed line. */
export function wordsLine(text: string): string {
  const i = text.indexOf("Earlier in this thread (context only, not the ask):");
  const own = (i >= 0 ? text.slice(0, i) : text).replace(/^Subject:[^\n]*\n+/i, "").replace(/\s+/g, " ").trim();
  return own ? `"${clip(own, 400)}"` : "";
}

/** A message can ask to be reported inside another feed thread (a meeting's), instead of its own. */
export const feedThreadKeyOf = (m: { raw: unknown }, messageId: string): string => ((m.raw as { feedThreadKey?: string } | null)?.feedThreadKey ?? messageThreadKey(messageId));
export const inSharedThread = (m: { raw: unknown }): boolean => !!(m.raw as { feedThreadKey?: string } | null)?.feedThreadKey;

/** Post a headline and return its message name so it can be edited once the counts are known. */
export async function postHeadline(text: string, threadKey: string): Promise<string | null> {
  if (surface() === "slack" || !gchat.gchatConfigured()) { await postText(text, { threadKey }); return null; }
  return gchat.sendText(gchat.reviewSpace(), text, undefined, threadKey);
}
export async function editHeadline(name: string | null, text: string): Promise<void> {
  if (!name) return;
  try { await gchat.updateMessageText(name, text); } catch (e) { console.error("headline edit failed", (e as Error).message); }
}
/** The boxed note under a headline, on its own (postFeed posts both). */
export async function postDetail(detail: string, threadKey: string): Promise<void> {
  if (!detail.trim()) return;
  if (surface() === "slack" || !gchat.gchatConfigured()) { await postText(detail, { threadKey }); return; }
  for (const [i, part] of splitDetail(detail).entries()) {
    const card = { sections: [{ widgets: [{ textParagraph: { text: toCardHtml(part) } }] }] };
    await gchat.sendCard(gchat.reviewSpace(), card, "", `detail-${threadKey}-${Date.now()}-${i}`, threadKey);
  }
}

/**
 * The feed rule: one line at the top level per message, everything else inside that line's thread.
 * The headline is the ledger entry; the detail (the words, per-card links, a card with buttons) opens on demand.
 */
export async function postFeed(p: { headline: string; detail?: string | null; threadKey: string }): Promise<void> {
  await postText(p.headline, { threadKey: p.threadKey });
  if (!p.detail?.trim()) return;
  if (surface() === "slack" || !gchat.gchatConfigured()) { await postText(p.detail, { threadKey: p.threadKey }); return; }
  // The detail is a boxed card, so even where Chat shows replies inline it reads as the note under the headline, never as a second headline.
  await postDetail(p.detail, p.threadKey);
}

/** Chat caps a card paragraph at about 4,000 characters: a long note is split at section or line breaks into several boxes. */
export function splitDetail(detail: string, max = 3500): string[] {
  if (detail.length <= max) return [detail];
  const out: string[] = [];
  let cur = "";
  for (const para of detail.split("\n\n")) {
    const piece = para.length > max ? para.split("\n") : [para];
    for (const line of piece) {
      const sep = cur ? (piece.length > 1 ? "\n" : "\n\n") : "";
      if (cur && cur.length + sep.length + line.length > max) { out.push(cur); cur = line; }
      else cur += sep + line;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Chat text markup (*bold*, _italic_, <url|label>) to the HTML subset cards accept. */
export function toCardHtml(text: string): string {
  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const links: string[] = [];
  let t = text.replace(/<(https?:[^|>\s]+)(?:\|([^>]+))?>/g, (_m, u: string, l?: string) => { links.push(`<a href="${esc(u)}">${esc(l ?? u)}</a>`); return `\u0000${links.length - 1}\u0000`; });
  t = esc(t).replace(/\*([^*\n]+)\*/g, "<b>$1</b>").replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, "$1<i>$2</i>").replace(/\n/g, "<br>");
  return t.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => links[Number(i)]);
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
    // One headline line in the feed; the words and the card with the dropdown sit in its thread.
    const head = p.why.startsWith("unknown") ? `❓ *Which client?* · ${sourceLabel(p.message).replace(" · ", ", ")} · ${clip(wordsLine(p.message.text), 70)}` : `❓ *Needs a person* · ${p.why.replace(/_/g, " ")} · ${sourceLabel(p.message).replace(" · ", ", ")}`;
    const tk = feedThreadKeyOf(p.message, p.messageId);
    const headName = await gchat.sendText(space, head, undefined, tk);
    const sent = await gchat.sendCard(space, card, "Pick the client below, or reply here with the name.", `human-${p.messageId}`, tk);
    await rememberThread(sent.thread, { kind: "needs_human", messageId: p.messageId });
    await sql()`insert into settings (key, value) values (${"gchat_card_for:" + p.messageId}, ${JSON.stringify({ card: sent.name, head: headName })}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`;
    return;
  }
  const label = p.kind === "possible_duplicate" ? "Possible duplicate" : "Change to an existing task";
  const card = gchat.duplicateCard({ requestId: p.requestId, duplicateOf: p.duplicateOf, clientName, label, text: p.message.text, source: sourceLabel(p.message), permalink: p.message.permalink });
  const sent = await gchat.sendCard(space, card, `${clientName}: ${label}`, `dup-${p.requestId}`);
  await rememberThread(sent.thread, { kind: "request", requestId: p.requestId, duplicateOf: p.duplicateOf });
}

/** What a PM Review card thread is about, so a typed reply in that thread can answer it. */
export type ThreadTopic = { kind: "needs_human"; messageId: string } | { kind: "request"; requestId: string; duplicateOf?: string } | { kind: "nudge"; messageId: string; channelId: string };
export async function rememberThread(thread: string | null, topic: ThreadTopic): Promise<void> {
  if (!thread) return;
  await sql()`insert into settings (key, value) values (${"gchat_thread:" + thread}, ${JSON.stringify(topic)}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`;
}
/** Replace the "needs a person" card with a one-line outcome once someone answered it (from anywhere). */
export async function closeNeedsHumanCard(messageId: string, text: string): Promise<void> {
  const r = await sql()`select value from settings where key = ${"gchat_card_for:" + messageId}`;
  if (!r.length || surface() !== "gchat") return;
  // Older rows hold the card's name as a string; newer ones hold { card, head } so the headline changes too.
  const v = r[0].value as string | { card?: string | null; head?: string | null };
  const names = typeof v === "string" ? [v] : [v.head, v.card].filter((x): x is string => !!x);
  for (const name of names) {
    try { await gchat.updateMessageText(name, text); } catch (e) { console.error("card update failed", (e as Error).message); }
  }
}
export async function threadTopic(thread: string | null | undefined): Promise<ThreadTopic | null> {
  if (!thread) return null;
  const r = await sql()`select value from settings where key = ${"gchat_thread:" + thread}`;
  return r.length ? (r[0].value as ThreadTopic) : null;
}

export async function postP1Ping(p: { requestId: string; client: Client | null; title: string; message: Message; reason: string | null }): Promise<void> {
  if (surface() === "slack" || !gchat.gchatConfigured()) return slack.postP1Ping(p);
  await gchat.sendText(gchat.reviewSpace(), `🔴 *P1* · *${p.client?.name ?? "Unknown client"}* · ${clip(p.title, 80)} · ${p.reason ?? ""} · ${sourceLabel(p.message).replace(" · ", ", ")}`);
}

/** Plain text to the review surface (daily summary, notices). */
/** Everything about one source message goes in one feed thread: key `msg-<messageId>`. */
export const messageThreadKey = (messageId: string) => `msg-${messageId}`;

export async function postText(text: string, opts: { threadKey?: string } = {}): Promise<void> {
  if (surface() === "slack" || !gchat.gchatConfigured()) {
    await (await slack.web(null)).chat.postMessage({ channel: process.env.SLACK_REVIEW_CHANNEL || "#pm-review", text });
    return;
  }
  await gchat.sendText(gchat.reviewSpace(), text, undefined, opts.threadKey);
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
    client_unhappy: "no task, but the client sounds unhappy; a person should reply.",
    no_card: "read as an update, question or idea, not a task; nothing created. If it should be a task, say what should be done, with the client name.",
  };
  if (known[r]) return known[r];
  if (outcome === "attached") return "added to an existing task's card.";
  if (outcome === "paused") return "intake is paused; it is queued and will be processed when resumed.";
  if (outcome === "skipped") return `nothing to do${r ? ` (${r.replace(/_/g, " ")})` : ""}.`;
  if (outcome === "review") return r ? `needs a person: ${r.replace(/_/g, " ")}.` : "needs a person; see the card below.";
  return r ? r.replace(/_/g, " ") : outcome;
}

/** A client name a voice note may have contained, misheard: stored on the message as a suggestion, never used as a decision. */
export type SuggestedClient = { id: string; name: string; heard: string };
export const suggestedClientOf = (raw: unknown): SuggestedClient | null => ((raw as { suggestedClient?: SuggestedClient } | null)?.suggestedClient ?? null);

/** The DM question when no client is certain: quote what was heard, offer the suggestion if any, ask for the name. */
export function askWhichClient(p: { text: string; raw: unknown }): string {
  const voice = !!(p.raw as { voice?: boolean } | null)?.voice;
  const s = suggestedClientOf(p.raw);
  const heard = voice ? `Heard: "${p.text.replace(/\s+/g, " ").slice(0, 200)}${p.text.length > 200 ? "…" : ""}"\n` : "";
  const ask = s ? `Which client is this for? I heard "${s.heard}", is it ${s.name}? Reply "yes", or the client name.` : "Which client is this for? Reply here with the name.";
  return heard + ask;
}

export async function postAck(p: { message: Message; outcome: string; detail?: string; messageId?: string | null }): Promise<void> {
  const short = p.message.text.replace(/\s+/g, " ").slice(0, 120);
  const icon = p.outcome.startsWith("draft") ? "✅" : p.outcome === "attached" ? "🔗" : p.outcome === "review" ? "❓" : p.outcome === "paused" ? "⏸️" : "ℹ️";
  const line = `${icon} From ${sourceLabel(p.message).replace(" · ", ", ")}: "${short}${p.message.text.length > 120 ? "…" : ""}" → ${p.detail ?? humanOutcome(p.outcome)}`;
  await postText(line, p.messageId ? { threadKey: messageThreadKey(p.messageId) } : {});
}
