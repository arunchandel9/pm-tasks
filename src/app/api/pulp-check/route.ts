import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/auth";
import { pulp } from "@/lib/pulp";
import { boards } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Proves the Pulp connection end to end: who the key is, every board it can see with its lists,
 * and how each department in boards.yaml resolves (board id, Staging and target list present or not).
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://pm-tasks.vercel.app/api/pulp-check
 * Add ?create=1 to create any missing Staging / target lists.
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return new NextResponse("unauthorized", { status: 401 });
  if (!pulp.configured()) return NextResponse.json({ ok: false, error: "PULP_TOKEN not set" }, { status: 500 });
  const create = new URL(req.url).searchParams.get("create") === "1";
  const out: Record<string, unknown> = { base: pulp.baseUrl() };
  try {
    out.me = await pulp.me();
    const all = await pulp.boards(true);
    const boardsOut: Record<string, unknown> = {};
    for (const b of all) boardsOut[b.name] = { id: b.id, lists: (await pulp.listsOnBoard(b.id, true)).map((l) => l.name) };
    out.boards = boardsOut;

    const deps: Record<string, unknown> = {};
    for (const [dep, cfg] of Object.entries(boards().departments)) {
      if (!cfg.board) { deps[dep] = { configured: false }; continue; }
      const id = await pulp.resolveBoardId(cfg.board);
      if (!id) { deps[dep] = { ref: cfg.board, resolved: null, problem: "board not found; check boards.yaml or the key's board membership" }; continue; }
      const wanted = [cfg.staging ?? (dep === "scope" ? null : "Staging"), cfg.list].filter((x): x is string => !!x);
      const lists: Record<string, string> = {};
      for (const name of wanted) {
        let lid = await pulp.findListId(id, name);
        if (!lid && create) lid = await pulp.ensureList(id, name);
        lists[name] = lid ? "ok" : "missing";
      }
      deps[dep] = { ref: cfg.board, resolved: id, name: all.find((b) => b.id === id)?.name, lists, sampleCardUrl: pulp.cardUrl(id, "<card-id>") };
    }
    out.departments = deps;
    return NextResponse.json({ ok: true, ...out });
  } catch (e) {
    return NextResponse.json({ ok: false, ...out, error: (e as Error).message }, { status: 500 });
  }
}
