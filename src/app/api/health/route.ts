import { NextResponse } from "next/server";
import { sql, databaseUrl } from "@/lib/db";
import { pulp } from "@/lib/pulp";
import { sheetsConfigured } from "@/lib/sheets";
import { env } from "@/lib/config";
import { gchatConfigured } from "@/lib/gchat";
import { surface, reviewMode } from "@/lib/review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const out: Record<string, unknown> = { model: env.model(), reviewSurface: surface(), reviewMode: reviewMode(), gchat: gchatConfigured(), pulp: pulp.configured(), sheets: sheetsConfigured(), slackAppConfigured: !!process.env.SLACK_SIGNING_SECRET && !!process.env.SLACK_CLIENT_ID && !!process.env.SLACK_CLIENT_SECRET, intakePaused: env.intakePaused(), cronSecretSet: !!process.env.CRON_SECRET, cronSecretHint: process.env.CRON_SECRET ? `${process.env.CRON_SECRET.trim().slice(0,4)}…(${process.env.CRON_SECRET.trim().length})` : null, dbUrlSet: !!databaseUrl(), anthropicKeySet: !!process.env.ANTHROPIC_API_KEY };
  try {
    const r = await sql()`select (select count(*) from clients)::int as clients, (select count(*) from slack_workspaces)::int as workspaces, (select team_name from slack_workspaces where is_home limit 1) as home`;
    out.db = { ok: true, clients: r[0].clients, slackWorkspaces: r[0].workspaces, homeWorkspace: r[0].home };
    const last = await sql()`select key, value from settings where key in ('gchat_last_event')`;
    out.gchatLastEvent = last.find((x) => x.key === "gchat_last_event")?.value ?? null;
    const recent = await sql()`select channel, sender, left(text, 80) as text, skip_reason, created_at from messages order by created_at desc limit 3`;
    out.recentMessages = recent;
    const errs = await sql()`select kind, attempts, left(last_error, 160) as last_error from queue where done_at is null and last_error is not null order by next_run_at limit 3`;
    out.queueErrors = errs;
  } catch (e) {
    out.db = { ok: false, error: (e as Error).message };
  }
  return NextResponse.json(out);
}
