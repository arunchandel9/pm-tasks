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
  } catch (e) {
    out.db = { ok: false, error: (e as Error).message };
  }
  return NextResponse.json(out);
}
