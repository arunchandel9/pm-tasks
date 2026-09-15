import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/auth";
import { drive, findNoteDocs, meetConfigured, pollMeetings, rereadNoteDoc, forgetMeetingCards } from "@/lib/meet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * What the hub can see in Drive: folders shared with it (by owner), and notes docs from the last 14 days at any depth. Add ?run=1 to read
 * any new docs now instead of waiting for the 5-minute tick; ?reread=<doc id> forgets one meeting and reads its doc again.
 *   curl -H "Authorization: Bearer $CRON_SECRET" "https://pm-tasks.vercel.app/api/meet-check?run=1"
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return new NextResponse("unauthorized", { status: 401 });
  if (!meetConfigured()) return NextResponse.json({ ok: false, error: "GOOGLE_SERVICE_ACCOUNT_B64 not set" }, { status: 500 });
  try {
    const folders = await drive().files.list({ q: "sharedWithMe and mimeType = 'application/vnd.google-apps.folder' and trashed = false", fields: "files(id,name,owners(emailAddress))", pageSize: 100 });
    const docs = await findNoteDocs(14);
    const out: Record<string, unknown> = {
      ok: true,
      foldersSharedWithHub: (folders.data.files ?? []).map((f) => ({ name: f.name, owner: f.owners?.[0]?.emailAddress ?? null })),
      organisersCovered: [...new Set((folders.data.files ?? []).map((f) => f.owners?.[0]?.emailAddress).filter(Boolean))],
      notesDocsLast14Days: docs.map((d) => ({ name: d.name, modified: d.modifiedTime, owner: d.owner, folder: d.folder })),
    };
    const params = new URL(req.url).searchParams;
    // ?since=now (or an ISO time): only notes docs changed after this moment are read on their own. Use it when a
    // newly shared folder carries older meetings that should stay unread; ?reread=<doc> still reads any one doc.
    const since = params.get("since");
    if (since) {
      const at = since === "now" ? new Date() : new Date(since);
      if (isNaN(at.getTime())) return NextResponse.json({ ok: false, error: "since must be 'now' or an ISO time" }, { status: 400 });
      const { sql } = await import("@/lib/db");
      await sql()`insert into settings (key, value) values ('meet_since', ${JSON.stringify(at.toISOString())}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`;
      out.since = at.toISOString();
    }
    const docId = (v: string) => v.replace(/^.*\/d\/([^/]+).*$/, "$1");
    const forget = params.get("forget_cards");
    if (forget) out.forget_cards = await forgetMeetingCards(docId(forget));
    const reread = params.get("reread");
    if (reread) out.reread = await rereadNoteDoc(docId(reread));
    if (params.get("run") === "1") out.run = await pollMeetings();
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message.slice(0, 300) }, { status: 500 });
  }
}
