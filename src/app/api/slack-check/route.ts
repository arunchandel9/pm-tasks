import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/auth";
import { sql } from "@/lib/db";
import { web } from "@/lib/slack";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * What the hub can actually read in Slack: for every installed workspace, whether its token still works and which
 * channels the bot is a member of (the only channels whose messages Slack delivers). Plus the last event received.
 *   curl -H "Authorization: Bearer $CRON_SECRET" "https://pm-tasks.vercel.app/api/slack-check"
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return new NextResponse("unauthorized", { status: 401 });
  const rows = await sql()`select w.team_id, w.team_name, w.is_home, w.bot_user_id, c.name as client from slack_workspaces w left join clients c on c.slack_team_id = w.team_id order by w.installed_at`;
  const workspaces: Array<Record<string, unknown>> = [];
  for (const w of rows) {
    const teamId = String(w.team_id);
    const out: Record<string, unknown> = { team: w.team_name, teamId, client: w.client ?? null, home: w.is_home };
    try {
      const client = await web(teamId);
      const me = await client.auth.test();
      out.tokenOk = !!me.ok;
      out.botUser = me.user_id ?? w.bot_user_id ?? null;
      const channels: string[] = [];
      let cursor: string | undefined;
      do {
        const res = await client.users.conversations({ user: String(me.user_id ?? w.bot_user_id ?? ""), types: "public_channel,private_channel", exclude_archived: true, limit: 200, cursor });
        for (const ch of res.channels ?? []) channels.push(`${ch.is_private ? "🔒" : "#"}${ch.name ?? ch.id}`);
        cursor = res.response_metadata?.next_cursor || undefined;
      } while (cursor);
      out.channelsTheBotIsIn = channels;
      if (!channels.length) out.note = "the bot is in no channel here: /invite @Task Hub in each client channel";
    } catch (e) { out.error = (e as Error).message.slice(0, 200); }
    workspaces.push(out);
  }
  const last = await sql()`select value from settings where key = 'slack_last_event'`;
  return NextResponse.json({ ok: true, workspaces, lastEvent: last[0]?.value ?? null });
}
