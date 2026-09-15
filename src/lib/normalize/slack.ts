import type { Client, Message, Scope } from "../types";

export interface SlackFile { id?: string; name?: string; mimetype?: string; filetype?: string; url_private_download?: string; url_private?: string; size?: number }

export interface SlackMessageEvent {
  type: "message";
  subtype?: string;
  channel: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  files?: SlackFile[];
  attachments?: Array<{ text?: string; fallback?: string; from_url?: string; author_name?: string }>;
  team?: string;
}

export interface SlackContext {
  teamId: string | null;         // workspace the event came from
  homeTeamId: string | null;     // MangoEyes workspace
  clients: Client[];
  senderIsStaff: boolean;
  senderName?: string | null;    // the person's real name, so the feed and the card never show a raw user id
  intakeChannelId: string | null;
  workspaceUrl: string | null;   // e.g. https://clinicx.slack.com, for permalinks
  userNames?: Record<string, string>; // user id → name, for the <@U…> mentions in the text
  transcript?: string | null;    // a voice clip's words, already transcribed
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

/** The workspace a client's Slack is, judged by its name: "Abela Clinic" ~ client Abela; whole words, case-free. */
export function clientForWorkspaceName(teamName: string, clients: Client[]): Client | null {
  const words = teamName.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (!words) return null;
  const has = (needle: string) => { const n = needle.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim(); return !!n && (` ${words} `).includes(` ${n} `); };
  return clients.find((c) => c.scope === "client" && (has(c.name) || has(c.id) || (c.aliases ?? []).some((a) => a.length >= 3 && has(a)))) ?? null;
}

/** User ids mentioned in a Slack message: "<@U123>" and "<@U123|name>". */
export function mentionedUsers(text: string): string[] {
  return Array.from(new Set(Array.from(text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g), (m) => m[1])));
}

/**
 * Slack's mrkdwn markup, turned into the words a person wrote: mentions become @Name, channel refs #name, links
 * their label (or the URL), "@here" stays, entities are decoded. What the model and the card see.
 */
export function cleanSlackText(text: string, names: Record<string, string> = {}): string {
  return text
    .replace(/<@([A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id: string, label?: string) => `@${names[id] ?? label ?? id}`)
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<!subteam\^[A-Z0-9]+(?:\|@?([^>]*))?>/g, (_m, l?: string) => `@${l ?? "group"}`)
    .replace(/<(mailto:)?([^|>\s]+)\|([^>]+)>/g, (_m, _p, target: string, label: string) => (/^https?:\/\//.test(target) && label.trim() !== target ? `${label} (${target})` : label))
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .trim();
}

export const isAudioFile = (f: SlackFile): boolean => /^audio\//i.test(f.mimetype ?? "") || /^(m4a|mp3|ogg|oga|opus|wav|webm|aac|flac)$/i.test(f.filetype ?? "") || /\.(m4a|mp3|ogg|oga|opus|wav|webm|aac|flac)$/i.test(f.name ?? "");

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
  const typed = cleanSlackText(shared?.text || ev.text || "", ctx.userNames ?? {});
  const text = [typed, ctx.transcript?.trim() ?? ""].filter(Boolean).join("\n");
  const permalink = shared?.permalink ?? (ctx.workspaceUrl ? `${ctx.workspaceUrl}/archives/${ev.channel}/p${ev.ts.replace(".", "")}` : null);
  const mentions = mentionedUsers(ev.text ?? "").map((id) => ctx.userNames?.[id] ?? id);
  return {
    channel: isIntake ? "intake" : "slack",
    externalId: `${ev.channel}:${ev.ts}`,
    teamId: ctx.teamId,
    clientId: client?.id ?? null,
    scope,
    sender: ctx.senderName?.trim() || ev.user || ev.bot_id || "unknown",
    senderIsStaff: ctx.senderIsStaff,
    sentAt: new Date(parseFloat(ev.ts) * 1000),
    text,
    permalink,
    threadRef: ev.thread_ts && ev.thread_ts !== ev.ts ? `${ev.channel}:${ev.thread_ts}` : null,
    raw: { ...ev, teamId: ctx.teamId, senderId: ev.user ?? null, mentions, ...(ctx.transcript ? { voice: true, transcript: ctx.transcript } : {}) },
  };
}
