import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import type { Client } from "./types";

let _sql: NeonQueryFunction<false, false> | null = null;

/** Accepts DATABASE_URL or any prefixed variant Vercel's Neon integration writes (e.g. storage_DATABASE_URL). */
export function databaseUrl(): string | null {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const [k, v] of Object.entries(process.env)) {
    if (k.endsWith("_DATABASE_URL") && !k.endsWith("_UNPOOLED") && v) return v;
  }
  if (process.env.POSTGRES_URL) return process.env.POSTGRES_URL;
  return null;
}

export function sql(): NeonQueryFunction<false, false> {
  if (!_sql) {
    const url = databaseUrl();
    if (!url) throw new Error("DATABASE_URL is not set");
    _sql = neon(url);
  }
  return _sql;
}

// ---- settings (kill switches, gate state) ----

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const rows = await sql()`select value from settings where key = ${key}`;
  return rows.length ? (rows[0].value as T) : fallback;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await sql()`
    insert into settings (key, value) values (${key}, ${JSON.stringify(value)}::jsonb)
    on conflict (key) do update set value = excluded.value, updated_at = now()`;
}

export async function channelPaused(channel: string): Promise<boolean> {
  if ((process.env.INTAKE_PAUSED || "false").toLowerCase() === "true") return true;
  if (await getSetting<boolean>("intake_paused", false)) return true;
  return getSetting<boolean>(`channel_paused:${channel}`, false);
}

// ---- clients ----

type ClientRow = {
  id: string; name: string; scope: "client" | "internal";
  slack_channels: string[]; email_domains: string[]; whatsapp_numbers: string[];
  boards: Record<string, { board: string; list: string; staging?: string; assignee?: string }>;
  client_facing_ack: boolean;
  slack_team_id: string | null;
  aliases: string[] | null;
  sheet_tab: string | null;
};

function toClient(r: ClientRow): Client {
  return {
    id: r.id, name: r.name, scope: r.scope,
    slackChannels: r.slack_channels ?? [], emailDomains: r.email_domains ?? [],
    whatsappNumbers: r.whatsapp_numbers ?? [], boards: r.boards ?? {},
    clientFacingAck: r.client_facing_ack,
    slackTeamId: r.slack_team_id,
    aliases: r.aliases ?? [],
    sheetTab: r.sheet_tab,
  };
}

export async function allClients(): Promise<Client[]> {
  const rows = (await sql()`select * from clients order by name`) as ClientRow[];
  return rows.map(toClient);
}

export async function upsertClient(c: Client): Promise<void> {
  await sql()`
    insert into clients (id, name, scope, slack_channels, email_domains, whatsapp_numbers, boards, client_facing_ack, slack_team_id, aliases, sheet_tab)
    values (${c.id}, ${c.name}, ${c.scope}, ${c.slackChannels}, ${c.emailDomains}, ${c.whatsappNumbers},
            ${JSON.stringify(c.boards)}::jsonb, ${c.clientFacingAck}, ${c.slackTeamId ?? null}, ${c.aliases ?? []}, ${c.sheetTab ?? null})
    on conflict (id) do update set
      name = excluded.name, scope = excluded.scope, slack_channels = excluded.slack_channels,
      email_domains = excluded.email_domains, whatsapp_numbers = excluded.whatsapp_numbers,
      boards = excluded.boards, client_facing_ack = excluded.client_facing_ack,
      slack_team_id = excluded.slack_team_id, aliases = excluded.aliases, sheet_tab = excluded.sheet_tab, updated_at = now()`;
}

// ---- queue ----

export async function enqueue(kind: string, payload: unknown, delaySeconds = 0): Promise<void> {
  await sql()`
    insert into queue (kind, payload, next_run_at)
    values (${kind}, ${JSON.stringify(payload)}::jsonb, now() + (${delaySeconds} || ' seconds')::interval)`;
}
