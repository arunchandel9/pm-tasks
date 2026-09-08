import { WebClient } from "@slack/web-api";
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./config";
import { sql } from "./db";
import type { Client, Draft, Message, RouteDecision } from "./types";

// ---- one app, many workspaces: a token per team_id ----

const tokenCache = new Map<string, { token: string; at: number }>();

async function tokenFor(teamId: string | null): Promise<string> {
  if (teamId) {
    const hit = tokenCache.get(teamId);
    if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.token;
    const rows = await sql()`select bot_token from slack_workspaces where team_id = ${teamId}`;
    if (rows.length) {
      tokenCache.set(teamId, { token: rows[0].bot_token as string, at: Date.now() });
      return rows[0].bot_token as string;
    }
  }
  const fallback = process.env.SLACK_BOT_TOKEN;
  if (!fallback) throw new Error(`no Slack token for workspace ${teamId ?? "(none)"}; install the app there first`);
  return fallback;
}

/** WebClient for a workspace. Home workspace (MangoEyes) when teamId is null. */
export async function web(teamId: string | null = null): Promise<WebClient> {
  const id = teamId ?? (await homeTeamId());
  return new WebClient(await tokenFor(id));
}

let homeCache: { id: string | null; at: number } | null = null;
export async function homeTeamId(): Promise<string | null> {
  if (homeCache && Date.now() - homeCache.at < 5 * 60 * 1000) return homeCache.id;
  const rows = await sql()`select team_id from slack_workspaces where is_home order by installed_at limit 1`;
  const id = rows.length ? (rows[0].team_id as string) : null;
  homeCache = { id, at: Date.now() };
  return id;
}

export async function saveInstallation(p: { teamId: string; teamName: string | null; botToken: string; botUserId: string | null }): Promise<{ isHome: boolean }> {
  const existing = await sql()`select count(*)::int as n from slack_workspaces`;
  // The first workspace installed is the home workspace (MangoEyes). Can be changed via settings/setup.
  const isHome = Number(existing[0].n) === 0;
  await sql()`
    insert into slack_workspaces (team_id, team_name, bot_token, bot_user_id, is_home)
    values (${p.teamId}, ${p.teamName}, ${p.botToken}, ${p.botUserId}, ${isHome})
    on conflict (team_id) do update set team_name = excluded.team_name, bot_token = excluded.bot_token, bot_user_id = excluded.bot_user_id, installed_at = now()`;
  tokenCache.delete(p.teamId);
  homeCache = null;
  return { isHome };
}

// ---- staff detection by email domain (user IDs differ per workspace) ----

const STAFF_DOMAINS = () => (process.env.STAFF_EMAIL_DOMAINS || "mangoeyesagency.com").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);

export async function isStaffUser(teamId: string | null, userId: string): Promise<boolean> {
  if (!teamId) return false;
  const cached = await sql()`select is_staff, seen_at from slack_users where team_id = ${teamId} and user_id = ${userId}`;
  if (cached.length && Date.now() - new Date(cached[0].seen_at as string).getTime() < 7 * 24 * 3600 * 1000) return cached[0].is_staff as boolean;
  let email: string | null = null, isBot = false;
  try {
    const res = await (await web(teamId)).users.info({ user: userId });
    email = res.user?.profile?.email?.toLowerCase() ?? null;
    isBot = !!res.user?.is_bot;
  } catch (e) {
    console.error("users.info failed", (e as Error).message);
  }
  const isStaff = !!email && STAFF_DOMAINS().some((d) => email!.endsWith("@" + d));
  await sql()`
    insert into slack_users (team_id, user_id, email, is_staff, is_bot, seen_at) values (${teamId}, ${userId}, ${email}, ${isStaff}, ${isBot}, now())
    on conflict (team_id, user_id) do update set email = excluded.email, is_staff = excluded.is_staff, is_bot = excluded.is_bot, seen_at = now()`;
  return isStaff;
}

// ---- request verification ----

export function verifySlackSignature(rawBody: string, timestamp: string, signature: string): boolean {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 60 * 5) return false;
  const base = `v0:${timestamp}:${rawBody}`;
  const hmac = "v0=" + createHmac("sha256", secret).update(base).digest("hex");
  const a = Buffer.from(hmac), b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---- posting ----

function slackChannelAndTs(m: Message): { channel: string; ts: string } | null {
  if (m.channel !== "slack" && m.channel !== "intake") return null;
  const [channel, ts] = m.externalId.split(":");
  return channel && ts ? { channel, ts } : null;
}

/** Internal acknowledgement: a reaction on the source message in its own workspace. Never a client-facing reply. */
export async function addReaction(m: Message, name: string): Promise<void> {
  const ref = slackChannelAndTs(m);
  if (!ref) return;
  try {
    await (await web(m.teamId)).reactions.add({ channel: ref.channel, timestamp: ref.ts, name });
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

/** Review items always go to the home workspace's #pm-review. */
export async function postReview(p: ReviewPost): Promise<void> {
  const home = await web(null);
  const channel = env.reviewChannel();
  const clientName = p.client?.name ?? "Unknown client";
  const scopeTag = p.client?.scope === "internal" ? " · internal" : "";

  if (p.kind === "draft") {
    const conf = p.confidence.toFixed(2);
    const pulpLine = p.taskId ? "Card created in Staging." : "Card not created yet (Pulp not configured).";
    await home.chat.postMessage({
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
    const clientRows = await sql()`select id, name from clients where scope = 'client' order by name limit 100`;
    const options = clientRows.map((c) => ({ text: { type: "plain_text" as const, text: String(c.name).slice(0, 75) }, value: String(c.id) }));
    await home.chat.postMessage({
      channel,
      text: `${clientName}: needs a person (${p.why})`,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `*${clientName}* · needs a person · _${p.why.replace(/_/g, " ")}_\n> ${p.message.text.slice(0, 300) || "(no text)"}` } },
        { type: "context", elements: [{ type: "mrkdwn", text: sourceLine(p.message) }] },
        {
          type: "actions",
          block_id: `human:${p.messageId}`,
          elements: [
            ...(options.length ? [{ type: "static_select" as const, action_id: "pick_client", placeholder: { type: "plain_text" as const, text: "Pick the client…" }, options }] : []),
            { type: "button", style: "primary", text: { type: "plain_text", text: "Make it a task" }, action_id: "make_task", value: p.messageId },
            { type: "button", text: { type: "plain_text", text: "Not a task" }, action_id: "dismiss_message", value: p.messageId },
          ],
        },
      ],
    });
    return;
  }

  const label = p.kind === "possible_duplicate" ? "Possible duplicate" : "Change to an existing task";
  await home.chat.postMessage({
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
  await (await web(null)).chat.postMessage({
    channel: env.p1Channel(),
    text: `🔴 P1 · ${p.client?.name ?? "Unknown client"} · ${p.title}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `🔴 *P1* · *${p.client?.name ?? "Unknown client"}*\n*${p.title}*\n_${p.reason ?? ""}_` } },
      { type: "context", elements: [{ type: "mrkdwn", text: sourceLine(p.message) }] },
    ],
  });
}

/** A nudge or follow-up on an existing task: queue a card comment and mark the source message. */
export async function postThreadFollowupComment(p: { taskId: string | null; requestId: string; message: Message; flag?: "client_waiting" }): Promise<void> {
  await sql()`
    insert into queue (kind, payload) values ('card_comment', ${JSON.stringify({ taskId: p.taskId, requestId: p.requestId, text: p.message.text, permalink: p.message.permalink, flag: p.flag ?? null })}::jsonb)`;
  await addReaction(p.message, "link");
}
