import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/auth";
import { postText } from "@/lib/review";
import { dailySummaryText } from "@/lib/hub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Once a day (Vercel Cron, weekdays 17:30 UTC). Same text the MCP `daily_summary` tool returns. Add ?dry=1 to see it without posting. */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return new NextResponse("unauthorized", { status: 401 });
  const text = await dailySummaryText(1);
  if (new URL(req.url).searchParams.get("dry") === "1") return new NextResponse(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
  await postText("```\n" + text + "\n```");
  return NextResponse.json({ ok: true, lines: text.split("\n").length });
}
