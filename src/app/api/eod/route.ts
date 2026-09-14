import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/auth";
import { postText } from "@/lib/review";
import { collectBrief, renderBrief } from "@/lib/brief";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Once a day (Vercel Cron, weekdays 17:30 UTC = 23:00 India): the daily brief. One headline line in the feed, the
 * detail as a reply in its own thread. Add ?dry=1 to see both without posting.
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return new NextResponse("unauthorized", { status: 401 });
  const data = await collectBrief();
  const { headline, detail } = renderBrief(data);
  if (new URL(req.url).searchParams.get("dry") === "1") return new NextResponse(`${headline}\n\n${detail ?? "(no detail)"}`, { headers: { "content-type": "text/plain; charset=utf-8" } });
  const threadKey = `brief-${new Date().toISOString().slice(0, 10)}`;
  await postText(headline, { threadKey });
  if (detail) await postText(detail, { threadKey });
  return NextResponse.json({ ok: true, headline, detailLines: detail ? detail.split("\n").length : 0 });
}
