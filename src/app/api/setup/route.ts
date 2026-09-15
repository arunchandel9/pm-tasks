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
    if (k === "label_hub_cards") {
      // label_hub_cards=<label>: put a label on every card the hub created (every hub card so far is a soak test), so the
      // cards can be selected by label in Pulp and deleted in one go. Also lists the sheet rows the hub wrote, bottom-up
      // per tab, so they can be deleted by hand without the row numbers shifting under you.
      const { pulp } = await import("@/lib/pulp");
      const name = v.trim() || "Hub test";
      const cards = await sql()`select t.id, t.title, t.board_id, t.pulp_card_id, t.sheet_row, tab.value as tab from tasks t
        left join settings tab on tab.key = 'sheet_tab:' || t.id::text where t.origin = 'hub' and t.pulp_card_id is not null order by t.created_at`;
      let labelled = 0, gone = 0; const errors: string[] = [];
      for (const c of cards) {
        try {
          const card = await pulp.getCard(String(c.pulp_card_id));
          await pulp.addLabel(card.boardId, card.id, name);
          labelled++;
        } catch (e) {
          const msg = (e as Error).message;
          if (/→ 404/.test(msg)) gone++; else errors.push(`${String(c.title).slice(0, 40)}: ${msg.slice(0, 100)}`);
        }
      }
      const rows = cards.filter((c) => c.tab && c.sheet_row).map((c) => ({ tab: String(c.tab), row: Number(c.sheet_row), title: String(c.title).slice(0, 60) }))
        .sort((a, b) => a.tab.localeCompare(b.tab) || b.row - a.row);
      seeded.push(`label_hub_cards "${name}": ${labelled} labelled, ${gone} already gone, ${errors.length} errors${errors.length ? " (" + errors.join("; ") + ")" : ""}`);
      seeded.push(`sheet rows written by the hub (delete bottom-up): ${JSON.stringify(rows)}`);
      continue;
    }
    if (k === "purge_hub_tests") {
      // purge_hub_tests=before:<ISO time>: forget everything the hub made before that moment (messages, requests, tasks,
      // status history, meetings), so the record starts clean at go-live. Sheet-mirrored history is never touched.
      // Run only after the test cards are deleted in Pulp and the test rows removed from the sheet.
      const before = v.replace(/^before:/, "").trim();
      if (!before || isNaN(new Date(before).getTime())) { seeded.push("purge_hub_tests: give before:<ISO time>, e.g. before:2026-09-16T00:00:00Z"); continue; }
      const t = await sql()`select id from tasks where origin = 'hub' and created_at < ${before}::timestamptz`;
      const ids = t.map((r) => String(r.id));
      await sql()`delete from status_events where task_id = any(${ids}::uuid[])`;
      await sql()`delete from settings where key like 'sheet_stage:%' or key like 'sheet_tab:%' or key like 'gchat_card_for:%' or key like 'gchat_thread:%' or key like 'reply_nudged:%' or key like 'reply_acked:%' or key like 'client_hint:%'`;
      await sql()`delete from tasks where id = any(${ids}::uuid[])`;
      const m = await sql()`select id from messages where channel in ('intake','email','slack','task_cmd','meet') and created_at < ${before}::timestamptz`;
      const mids = m.map((r) => String(r.id));
      const mi = await sql()`delete from meeting_items where meeting_id in (select id from meetings where created_at < ${before}::timestamptz) returning id`;
      const me = await sql()`delete from meetings where created_at < ${before}::timestamptz returning id`;
      await sql()`update llm_calls set message_id = null where message_id = any(${mids}::uuid[])`; // the cost log stays
      await sql()`update requests set merged_into = null where merged_into in (select id from requests where message_id = any(${mids}::uuid[]))`;
      await sql()`delete from requests where message_id = any(${mids}::uuid[])`;
      await sql()`delete from queue where done_at is null and (payload->>'messageId') = any(${mids})`;
      await sql()`delete from messages where id = any(${mids}::uuid[])`;
      seeded.push(`purge_hub_tests before ${before}: ${ids.length} tasks, ${mids.length} messages and their requests, ${me.length} meetings (${mi.length} items) removed; sheet history kept`);
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
