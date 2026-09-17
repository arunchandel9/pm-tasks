import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Meeting notes, every 5 minutes, in their own function: one meeting can take a minute (a model call, feed posts),
 * and inside the minute loop that once outran the budget and silently took the mailbox and queue steps down with it.
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return new NextResponse("unauthorized", { status: 401 });
  const { meetConfigured, pollMeetings } = await import("@/lib/meet");
  if (!meetConfigured()) return NextResponse.json({ ok: true, meetings: "not configured" });
  try { return NextResponse.json({ ok: true, meetings: await pollMeetings() }); }
  catch (e) { return NextResponse.json({ ok: false, error: (e as Error).message.slice(0, 300) }, { status: 500 }); }
}
