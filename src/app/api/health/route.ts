import { NextResponse } from "next/server";
import { sql, databaseUrl } from "@/lib/db";
import { pulp } from "@/lib/pulp";
import { sheetsConfigured } from "@/lib/sheets";
import { env } from "@/lib/config";
import { gchatConfigured } from "@/lib/gchat";
import { gmailConfigured } from "@/lib/gmail";
import { surface, reviewMode } from "@/lib/review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const out: Record<string, unknown> = { model: env.model(), reviewSurface: surface(), reviewMode: reviewMode(), gchat: gchatConfigured(), gmail: gmailConfigured(), gmailMailbox: process.env.GMAIL_MAILBOX ?? null, pulp: pulp.configured(), sheets: sheetsConfigured(), slackAppConfigured: !!process.env.SLACK_SIGNING_SECRET && !!process.env.SLACK_CLIENT_ID && !!process.env.SLACK_CLIENT_SECRET, intakePaused: env.intakePaused(), cronSecretSet: !!process.env.CRON_SECRET, cronSecretHint: process.env.CRON_SECRET ? `${process.env.CRON_SECRET.trim().slice(0,4)}…(${process.env.CRON_SECRET.trim().length})` : null, dbUrlSet: !!databaseUrl(), anthropicKeySet: !!process.env.ANTHROPIC_API_KEY };
  try {
    const r = await sql()`select (select count(*) from clients)::int as clients, (select count(*) from slack_workspaces)::int as workspaces, (select team_name from slack_workspaces where is_home limit 1) as home`;
    out.db = { ok: true, clients: r[0].clients, slackWorkspaces: r[0].workspaces, homeWorkspace: r[0].home };
    const last = await sql()`select key, value from settings where key in ('gchat_last_event', 'pulp_poll_last', 'gmail_poll_last', 'sheet_sync_last')`;
    out.gchatLastEvent = last.find((x) => x.key === "gchat_last_event")?.value ?? null;
    out.pulpPollLast = last.find((x) => x.key === "pulp_poll_last")?.value ?? null;
    out.gmailPollLast = last.find((x) => x.key === "gmail_poll_last")?.value ?? null;
    out.sheetSyncLast = last.find((x) => x.key === "sheet_sync_last")?.value ?? null;
    const recent = await sql()`select channel, sender, left(text, 80) as text, skip_reason, created_at from messages order by created_at desc limit 3`;
    out.recentMessages = recent;
    const errs = await sql()`select kind, attempts, left(last_error, 160) as last_error from queue where done_at is null and last_error is not null order by next_run_at limit 3`;
    out.queueErrors = errs;
    out.recentRequests = await sql()`select r.status, r.department, r.priority, r.draft->>'title' as title, c.name as client, t.pulp_card_id, t.list_id, r.created_at
      from requests r left join clients c on c.id = r.client_id left join tasks t on t.request_id = r.id order by r.created_at desc limit 5`;
    out.recentLlmCalls = await sql()`select step, model, input_tokens, cache_read_tokens, output_tokens, cost_usd, latency_ms, created_at from llm_calls order by created_at desc limit 4`;
  } catch (e) {
    out.db = { ok: false, error: (e as Error).message };
  }
  return NextResponse.json(out);
}
