import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/auth";
import { syncSheet } from "@/lib/sheet-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Mirror every client tab of the PM Overview sheet into the hub now (also runs every 10 minutes from the tick). */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return new NextResponse("unauthorized", { status: 401 });
  const r = await syncSheet();
  const totals = Object.values(r.tabs).reduce((a, t) => ({ rows: a.rows + t.rows, imported: a.imported + t.imported, updated: a.updated + t.updated, hubRows: a.hubRows + t.hubRows }), { rows: 0, imported: 0, updated: 0, hubRows: 0 });
  return NextResponse.json({ ok: r.errors.length === 0, totals, ...r });
}
