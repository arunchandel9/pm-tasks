import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/auth";
import { postFeed } from "@/lib/review";
import { collectBrief, renderBrief } from "@/lib/brief";
import { postMondayIdeas } from "@/lib/ideas";
import { teamParts } from "@/lib/when";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 10:00 India, Monday to Friday (Vercel Cron 04:30 UTC): the day's list. One headline, the detail in its thread,
 * and nothing at all when nobody has anything to do. On Mondays the week's ideas follow as their own line.
 * ?dry=1 shows both without posting; ?ideas=1 forces the ideas post on any day.
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return new NextResponse("unauthorized", { status: 401 });
  const url = new URL(req.url);
  const data = await collectBrief();
  const brief = renderBrief(data);
  if (url.searchParams.get("dry") === "1") return new NextResponse(brief ? `${brief.headline}\n\n${brief.detail}` : "(nothing waiting: no post)", { headers: { "content-type": "text/plain; charset=utf-8" } });
  const day = new Date().toISOString().slice(0, 10);
  if (brief) await postFeed({ headline: brief.headline, detail: brief.detail, threadKey: `brief-${day}` });
  const monday = teamParts(new Date()).weekday === 1 || url.searchParams.get("ideas") === "1";
  const ideas = monday ? await postMondayIdeas() : { posted: 0, threadKey: null };
  return NextResponse.json({ ok: true, posted: !!brief, headline: brief?.headline ?? null, waiting: data.waiting.length, overdue: data.overdue.length, ideas });
}
