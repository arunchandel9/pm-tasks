import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/auth";
import { sql } from "@/lib/db";
import { SCHEMA_SQL } from "@/lib/schema";
import { splitSchema } from "@/lib/schema-split";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One-time (idempotent) database setup from the deployed app, so no local DB access is needed:
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/setup
 * Applies db/schema.sql and seeds settings passed as query params, e.g. ?intake_channel_id=C0..&home_team_id=T0..&workspace_url:T0..=https://x.slack.com
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return new NextResponse("unauthorized", { status: 401 });

  const statements = splitSchema(SCHEMA_SQL);
  let applied = 0;
  try {
    for (const stmt of statements) {
      await sql().query(stmt);
      applied++;
    }
  } catch (e) {
    return NextResponse.json({ ok: false, applied, failed_statement: statements[applied]?.slice(0, 120), error: (e as Error).message }, { status: 500 });
  }

  const url = new URL(req.url);
  const seeded: string[] = [];
  for (const [k, v] of url.searchParams.entries()) {
    if (k === "home_team_id") {
      await sql()`update slack_workspaces set is_home = (team_id = ${v})`;
      seeded.push(k);
      continue;
    }
    if (k !== "intake_channel_id" && !k.startsWith("workspace_url:")) continue;
    await sql()`insert into settings (key, value) values (${k}, ${JSON.stringify(v)}::jsonb)
                on conflict (key) do update set value = excluded.value, updated_at = now()`;
    seeded.push(k);
  }

  const counts = await sql()`select (select count(*) from clients)::int as clients, (select count(*) from messages)::int as messages, (select count(*) from slack_workspaces)::int as workspaces`;
  return NextResponse.json({ ok: true, applied, seeded, ...counts[0] });
}
