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
    const last = await sql()`select key, value from settings where key in ('gchat_last_event', 'slack_last_event', 'pulp_poll_last', 'gmail_poll_last', 'sheet_sync_last', 'meet_poll_last', 'sheet_cards_last', 'voice_last', 'tick_last', 'chat_inbox_last', 'board_mirror_last')`;
    out.chatInboxLast = last.find((x) => x.key === "chat_inbox_last")?.value ?? null;
    const tickLast = last.find((x) => x.key === "tick_last")?.value as string | undefined;
    out.tickLast = tickLast ?? null;
    out.tickAgeSeconds = tickLast ? Math.round((Date.now() - new Date(tickLast).getTime()) / 1000) : null;
    // Every reader has a heartbeat; one that stops is a failure whatever the minute loop says (the Meet reader once
    // stood still for a day while everything else looked fine). Ages in seconds, with the limit each may reach.
    const ageOf = (key: string) => { const v = last.find((x) => x.key === key)?.value as { at?: string } | string | undefined; const at = typeof v === "string" ? v : v?.at; return at ? Math.round((Date.now() - new Date(at).getTime()) / 1000) : null; };
    const stale: string[] = [];
    const limits: Array<[string, number, string]> = [["gmail_poll_last", 300, "mailbox"], ["chat_inbox_last", 300, "Task Hub Drop"], ["meet_poll_last", 1200, "Meet notes"], ["pulp_poll_last", 300, "Pulp"], ["sheet_cards_last", 300, "sheet cards"], ["board_mirror_last", 1200, "board mirror"]];
    for (const [key, limit, name] of limits) { const age = ageOf(key); if (age === null || age > limit) stale.push(`${name}: ${age === null ? "never ran" : `${Math.round(age / 60)} min ago`}`); }
    out.stale = stale;
    out.ok = !!tickLast && (out.tickAgeSeconds as number) < 300 && stale.length === 0;
    out.gchatLastEvent = last.find((x) => x.key === "gchat_last_event")?.value ?? null;
    out.pulpPollLast = last.find((x) => x.key === "pulp_poll_last")?.value ?? null;
    out.gmailPollLast = last.find((x) => x.key === "gmail_poll_last")?.value ?? null;
    out.sheetSyncLast = last.find((x) => x.key === "sheet_sync_last")?.value ?? null;
    out.meetPollLast = last.find((x) => x.key === "meet_poll_last")?.value ?? null;
    out.sheetCardsLast = last.find((x) => x.key === "sheet_cards_last")?.value ?? null;
    out.boardMirrorLast = last.find((x) => x.key === "board_mirror_last")?.value ?? null;
    out.voiceLast = last.find((x) => x.key === "voice_last")?.value ?? null;
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
  return NextResponse.json(out, { status: out.ok === false ? 503 : 200 });
}
