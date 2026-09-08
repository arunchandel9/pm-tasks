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
  clients: Client[];
  staffUserIds: string[];
  intakeChannelId: string | null;
  workspaceUrl: string; // e.g. https://mangoeyes.slack.com
}

export function resolveSlackClient(channel: string, clients: Client[]): { client: Client | null; scope: Scope } {
  const c = clients.find((x) => x.slackChannels.includes(channel)) ?? null;
  if (!c) return { client: null, scope: "unknown" };
  return { client: c, scope: c.scope };
}

/** A shared message into #intake carries the original as an attachment; prefer that text and link. */
function sharedContent(ev: SlackMessageEvent): { text: string; permalink: string | null } | null {
  const a = ev.attachments?.find((x) => x.from_url || x.text);
  if (!a) return null;
  return { text: (a.text || a.fallback || "").trim(), permalink: a.from_url ?? null };
}

export function slackToMessage(ev: SlackMessageEvent, ctx: SlackContext): Message {
  const isIntake = ctx.intakeChannelId !== null && ev.channel === ctx.intakeChannelId;
  const shared = isIntake ? sharedContent(ev) : null;
  const { client, scope } = resolveSlackClient(ev.channel, ctx.clients);
  const text = shared?.text || ev.text || "";
  const permalink = shared?.permalink ?? `${ctx.workspaceUrl}/archives/${ev.channel}/p${ev.ts.replace(".", "")}`;
  return {
    channel: isIntake ? "intake" : "slack",
    externalId: `${ev.channel}:${ev.ts}`,
    clientId: client?.id ?? null,
    scope: isIntake && !client ? "unknown" : scope,
    sender: ev.user ?? ev.bot_id ?? "unknown",
    senderIsStaff: !!ev.user && ctx.staffUserIds.includes(ev.user),
    sentAt: new Date(parseFloat(ev.ts) * 1000),
    text,
    permalink,
    threadRef: ev.thread_ts && ev.thread_ts !== ev.ts ? `${ev.channel}:${ev.thread_ts}` : null,
    raw: ev,
  };
}
