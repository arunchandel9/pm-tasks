import { NextResponse } from "next/server";
import { WebClient } from "@slack/web-api";
import { saveInstallation } from "@/lib/slack";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Slack redirects here after "Allow". Exchanges the code for a bot token and stores it per workspace. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (error) return new NextResponse(`Slack said: ${error}`, { status: 400 });
  if (!code) return new NextResponse("missing code", { status: 400 });

  const clientId = process.env.SLACK_CLIENT_ID, clientSecret = process.env.SLACK_CLIENT_SECRET;
  if (!clientId || !clientSecret) return new NextResponse("SLACK_CLIENT_ID / SLACK_CLIENT_SECRET not set", { status: 500 });

  const origin = url.origin.replace("http://", "https://");
  const res = await new WebClient().oauth.v2.access({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: `${origin}/api/slack/oauth` });
  if (!res.ok || !res.access_token || !res.team?.id) return new NextResponse(`OAuth failed: ${res.error ?? "unknown"}`, { status: 400 });

  const { isHome } = await saveInstallation({ teamId: res.team.id, teamName: res.team.name ?? null, botToken: res.access_token, botUserId: res.bot_user_id ?? null });

  const html = `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;margin:40px">
    <h2>Task Hub installed in <b>${res.team.name ?? res.team.id}</b></h2>
    <p>Workspace ID: <code>${res.team.id}</code>${isHome ? " · this is the <b>home</b> workspace (#pm-review and #intake live here)" : ""}</p>
    <p>Next: in Slack, type <code>/invite @Task Hub</code> in each channel the hub should read. Put the workspace ID in the Config tab's <code>slack_team_id</code> column for this client.</p>
  </body>`;
  return new NextResponse(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
