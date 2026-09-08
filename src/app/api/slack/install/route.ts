import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SCOPES = [
  "channels:history", "channels:read", "groups:history", "groups:read",
  "chat:write", "reactions:write", "reactions:read", "users:read", "users:read.email", "commands", "team:read",
];

/** "Add to Slack": open this URL while signed in to the workspace you want to install into. */
export async function GET(req: Request) {
  const clientId = process.env.SLACK_CLIENT_ID;
  if (!clientId) return new NextResponse("SLACK_CLIENT_ID is not set", { status: 500 });
  const origin = new URL(req.url).origin.replace("http://", "https://");
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", SCOPES.join(","));
  url.searchParams.set("redirect_uri", `${origin}/api/slack/oauth`);
  return NextResponse.redirect(url.toString());
}
