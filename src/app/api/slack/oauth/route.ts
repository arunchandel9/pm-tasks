import { NextResponse } from "next/server";
import { WebClient } from "@slack/web-api";
import { saveInstallation, rememberWorkspaceUrl, linkWorkspaceToClient } from "@/lib/slack";
import { clientForWorkspaceName } from "@/lib/normalize/slack";
import { allClients } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Slack redirects here after "Allow". Exchanges the code for a bot token, stores it per workspace, remembers the
 * workspace URL for permalinks, and ties the workspace to the client whose name it carries. A workspace with no
 * matching client still works: its first message asks "which client?" in the feed, and the answer links it.
 */
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

  const teamId = res.team.id, teamName = res.team.name ?? null;
  const { isHome } = await saveInstallation({ teamId, teamName, botToken: res.access_token, botUserId: res.bot_user_id ?? null });
  const workspaceUrl = await rememberWorkspaceUrl(teamId);

  let linked: string | null = null, already: string | null = null;
  if (!isHome) {
    const clients = await allClients();
    const known = clients.find((c) => c.slackTeamId === teamId);
    if (known) already = known.name;
    else {
      const match = teamName ? clientForWorkspaceName(teamName, clients) : null;
      if (match && (await linkWorkspaceToClient(match, teamId))) linked = match.name;
    }
  }
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const clientLine = isHome
    ? "This is the <b>home</b> workspace (MangoEyes)."
    : already ? `Already linked to client <b>${esc(already)}</b>.`
    : linked ? `Linked to client <b>${esc(linked)}</b> (written to the Config tab).`
    : `No client name matched "${esc(teamName ?? teamId)}". Nothing to do now: the first client message from here asks "which client?" in Task Hub Feed, and picking it links this workspace for good.`;
  const html = `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;margin:40px;max-width:640px;line-height:1.5">
    <h2>Task Hub installed in <b>${esc(teamName ?? teamId)}</b></h2>
    <p>${clientLine}</p>
    <p>Workspace ID <code>${teamId}</code>${workspaceUrl ? ` · <code>${esc(workspaceUrl)}</code>` : ""}</p>
    <p><b>Next, in Slack:</b> open each client channel and type <code>/invite @Task Hub</code> (or channel details → Integrations → Add apps). The hub reads only the channels it is invited to.</p>
  </body>`;
  return new NextResponse(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
