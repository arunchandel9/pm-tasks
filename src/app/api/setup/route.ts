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
    if (k === "client") {
      // Quick client registration before the sheet exists: client=<id>|<name>|<slack_team_id>|<scope>|<alias1,alias2>
      const [id, name, teamId, scope, aliases] = v.split("|");
      if (id) {
        const al = (aliases ?? "").split(",").map((a) => a.trim()).filter(Boolean);
        await sql()`insert into clients (id, name, scope, slack_team_id, aliases) values (${id}, ${name || id}, ${scope === "internal" ? "internal" : "client"}, ${teamId || null}, ${al})
                    on conflict (id) do update set name = excluded.name, scope = excluded.scope, slack_team_id = excluded.slack_team_id, aliases = excluded.aliases, updated_at = now()`;
        seeded.push(`client:${id}`);
      }
      continue;
    }
    if (k === "mcp_key") {
      // mcp_key=<name>|<email>: mint a personal key for the MCP hub. Shown once, only here.
      const [name, email] = v.split("|");
      const { createMcpKey } = await import("@/lib/mcp-keys");
      const key = await createMcpKey(name || email, email || name);
      seeded.push(`mcp_key for ${name || email}: ${key}  →  https://pm-tasks.vercel.app/api/mcp/${key}`);
      continue;
    }
    if (k === "mcp_revoke") {
      const { revokeMcpKeys } = await import("@/lib/mcp-keys");
      seeded.push(`mcp_revoked:${await revokeMcpKeys(v)}`);
      continue;
    }
    if (k === "mcp_list") {
      const { listMcpKeys } = await import("@/lib/mcp-keys");
      seeded.push(`mcp_keys:${JSON.stringify(await listMcpKeys())}`);
      continue;
    }
    if (k === "slack_team") {
      // slack_team=<client id or name>|<T-id>: writes the workspace id into the client's Config row and the DB at once.
      const [ref, teamId] = v.split("|").map((x) => x.trim());
      const { setConfigCell } = await import("@/lib/sheets");
      const w = await setConfigCell(ref, "slack_team_id", teamId);
      if (w.ok) await sql()`update clients set slack_team_id = ${teamId}, updated_at = now() where lower(id) = ${ref.toLowerCase()} or lower(name) = ${ref.toLowerCase()}`;
      seeded.push(w.ok ? `slack_team:${ref}=${teamId}` : `slack_team failed: ${w.reason}`);
      continue;
    }
    if (k === "remove_client") {
      // Remove a client that is not in the Config tab (e.g. the setup-time test client). Messages/requests keep their rows.
      const r = await sql()`delete from clients where id = ${v} returning id`;
      seeded.push(r.length ? `removed:${v}` : `not_found:${v}`);
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
