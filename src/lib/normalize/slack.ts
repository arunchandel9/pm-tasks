import type { Client, Message, Scope } from "../types";

export interface SlackMessageEvent {
  type: "message";
  subtype?: string;
  channel: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  files?: unknown[];
  attachments?: Array<{ text?: string; fallback?: string; from_url?: string; author_name?: string }>;
  team?: string;
}

export interface SlackContext {
  teamId: string | null;         // workspace the event came from
  homeTeamId: string | null;     // MangoEyes workspace
  clients: Client[];
  senderIsStaff: boolean;
  intakeChannelId: string | null;
  workspaceUrl: string | null;   // e.g. https://clinicx.slack.com, for permalinks
}

/**
 * One workspace per client: resolve by team first, then by explicit channel list.
 * The home workspace resolves to the internal client if one is configured.
 */
export function resolveSlackClient(teamId: string | null, channel: string, clients: Client[], homeTeamId: string | null): { client: Client | null; scope: Scope } {
  const byChannel = clients.find((x) => x.slackChannels.includes(channel));
  if (byChannel) return { client: byChannel, scope: byChannel.scope };
  if (teamId) {
    const byTeam = clients.find((x) => x.slackTeamId === teamId);
    if (byTeam) return { client: byTeam, scope: byTeam.scope };
    if (teamId === homeTeamId) {
      const internal = clients.find((x) => x.scope === "internal");
      if (internal) return { client: internal, scope: "internal" };
    }
  }
  return { client: null, scope: "unknown" };
}

/** A shared message into #intake carries the original as an attachment; prefer that text and link. */
function sharedContent(ev: SlackMessageEvent): { text: string; permalink: string | null } | null {
  const a = ev.attachments?.find((x) => x.from_url || x.text);
  if (!a) return null;
  return { text: (a.text || a.fallback || "").trim(), permalink: a.from_url ?? null };
}

export function slackToMessage(ev: SlackMessageEvent, ctx: SlackContext): Message {
  const isIntake = ctx.intakeChannelId !== null && ev.channel === ctx.intakeChannelId && ctx.teamId === ctx.homeTeamId;
  const shared = isIntake ? sharedContent(ev) : null;
  const { client, scope } = isIntake
    ? { client: null as Client | null, scope: "unknown" as Scope }
    : resolveSlackClient(ctx.teamId, ev.channel, ctx.clients, ctx.homeTeamId);
  const text = shared?.text || ev.text || "";
  const permalink = shared?.permalink ?? (ctx.workspaceUrl ? `${ctx.workspaceUrl}/archives/${ev.channel}/p${ev.ts.replace(".", "")}` : null);
  return {
    channel: isIntake ? "intake" : "slack",
    externalId: `${ev.channel}:${ev.ts}`,
    teamId: ctx.teamId,
    clientId: client?.id ?? null,
    scope,
    sender: ev.user ?? ev.bot_id ?? "unknown",
    senderIsStaff: ctx.senderIsStaff,
    sentAt: new Date(parseFloat(ev.ts) * 1000),
    text,
    permalink,
    threadRef: ev.thread_ts && ev.thread_ts !== ev.ts ? `${ev.channel}:${ev.thread_ts}` : null,
    raw: ev,
  };
}
