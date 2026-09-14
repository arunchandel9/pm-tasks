import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The Drop space, read three times a minute (Vercel Cron fires once a minute; this call reads at 0 s, 20 s and 40 s),
 * so a message shared from the phone is answered within about 20 seconds instead of up to a minute.
 * Kept apart from /api/tick so the wait never delays the queue, the mailbox or the Pulp poll.
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return new NextResponse("unauthorized", { status: 401 });
  const { inboxConfigured, pollInbox } = await import("@/lib/chat-inbox");
  if (!inboxConfigured()) return NextResponse.json({ ok: true, inbox: "not configured" });
  const rounds: unknown[] = [];
  const started = Date.now();
  for (let i = 0; i < 3; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, Math.max(0, started + i * 20_000 - Date.now())));
    try { rounds.push(await pollInbox()); } catch (e) { rounds.push({ error: (e as Error).message }); }
  }
  return NextResponse.json({ ok: true, rounds });
}
