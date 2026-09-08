import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/auth";
import { listTabs, tabHeaders, mapHeaders, sheetsConfigured } from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Shows every tab in the PM sheet with its header row and how the hub maps those headers to fields.
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://pm-tasks.vercel.app/api/sheet-check
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return new NextResponse("unauthorized", { status: 401 });
  if (!sheetsConfigured()) return NextResponse.json({ ok: false, error: "GOOGLE_SERVICE_ACCOUNT_B64 or PM_SHEET_ID not set" }, { status: 500 });
  try {
    const tabs = await listTabs();
    const out: Record<string, unknown> = {};
    for (const t of tabs) {
      const headers = await tabHeaders(t);
      const map = mapHeaders(headers);
      out[t] = { headers, mapped: Object.fromEntries(Object.entries(map).map(([k, i]) => [k, headers[i]])), unmapped_headers: headers.filter((_, i) => !Object.values(map).includes(i) && headers[i]) };
    }
    return NextResponse.json({ ok: true, tabs: out });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
