import { sql, allClients } from "./db";
import { findClientTab, tabHeaders, tabRows, mapHeaders, sheetConfig, sheetsConfigured, dividerIndex } from "./sheets";
import { normList } from "./pulp";

/**
 * The PM Overview sheet is the PMs' own record: history from before the hub, and tasks they add by hand.
 * This reads every client tab and mirrors its rows into `tasks` (origin = 'sheet'), so the MCP hub and the summary
 * answer from the same record the PMs keep. Runs once at setup and every 10 minutes. Never writes to the sheet,
 * never creates Pulp cards, never posts to PM Review. Hub-made rows are recognised by their Pulp link and only pick
 * up the Assigned To a PM filled in.
 */

export interface SyncReport { tabs: Record<string, { rows: number; imported: number; updated: number; hubRows: number }>; errors: string[]; at: string }

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };

/** "08-Sep-2026", "8 Sep 2026", "08/09/2026" (DD/MM/YYYY), "2026-09-08". Returns null when unreadable. */
export function parseSheetDate(s: string | undefined): Date | null {
  const t = (s ?? "").trim();
  if (!t) return null;
  let m = t.match(/^(\d{1,2})[-\s/.]([A-Za-z]{3,4})[-\s/.,]*(\d{2,4})$/);
  if (m && MONTHS[m[2].toLowerCase()] !== undefined) return utc(Number(m[3]), MONTHS[m[2].toLowerCase()], Number(m[1]));
  m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) return utc(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return utc(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(t);
  return isNaN(d.getTime()) ? null : d;
}
function utc(y: number, mo: number, d: number): Date | null {
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, mo, d, 9, 0, 0)); // 09:00 UTC ≈ 14:30 IST, a working-hours stamp
  return isNaN(dt.getTime()) ? null : dt;
}

const cardIdFrom = (link: string) => link.match(/[?&]card=([0-9a-f-]{8,})/i)?.[1] ?? link.match(/\/card\/([0-9a-f-]{8,})/i)?.[1] ?? null;
const boardIdFrom = (link: string) => link.match(/\/board\/([0-9a-f-]{8,})/i)?.[1] ?? null;
const isDoneStatus = (s: string) => /^(done|completed?|closed|live|delivered)\b/i.test(s.trim());
const normTitle = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 80);

function departmentKey(label: string): string | null {
  const l = label.trim().toLowerCase();
  if (!l) return null;
  for (const [k, v] of Object.entries(sheetConfig().department_labels)) if (v.toLowerCase() === l) return k;
  if (/dev|web|site/.test(l)) return "dev";
  if (/content|writ|copy|blog/.test(l)) return "content";
  if (/graphic|design|creative/.test(l)) return "design";
  if (/seo/.test(l)) return "seo";
  if (/auto|crm|ghl|onboard/.test(l)) return "automation";
  if (/video|reel|edit/.test(l)) return "video";
  return "general";
}

interface Row { key: string; cardId: string | null; boardId: string | null; title: string; priority: string; assignee: string | null; due: string | null; status: string | null; dept: string | null; notes: string | null; sheetRow: number; created: string; completed: string | null }

/** Mirror one client's tab. Two sheet reads and four database statements, whatever the row count. */
export async function syncClientTab(client: { id: string; name: string; sheetTab?: string | null }, tab: string): Promise<{ rows: number; imported: number; updated: number; hubRows: number }> {
  const cfg = sheetConfig();
  const headers = await tabHeaders(tab);
  const map = mapHeaders(headers, cfg);
  if (map.title === undefined) throw new Error(`${tab}: no TASK column`);
  const rows = await tabRows(tab);
  const divider = dividerIndex(rows, map, cfg);
  const cell = (r: string[], f: string) => (map[f] !== undefined ? (r[map[f]] ?? "").trim() : "");
  const parsed: Row[] = [];
  const seenKeys = new Set<string>();
  for (let i = cfg.header_row; i < rows.length; i++) {
    const r = rows[i];
    if (i === divider) continue;
    const title = cell(r, "title");
    if (!title || normList(title) === "done") continue;
    const link = cell(r, "pulp_link");
    const cardId = link ? cardIdFrom(link) : null;
    const serial = cell(r, "serial");
    const status = cell(r, "stage");
    const belowDivider = divider >= 0 && i > divider;
    const done = belowDivider || isDoneStatus(status);
    const created = parseSheetDate(cell(r, "created"));
    const completed = parseSheetDate(cell(r, "completed")) ?? (done ? created ?? new Date() : null);
    const due = parseSheetDate(cell(r, "due"));
    const pr = cell(r, "priority");
    const priority = pr.toUpperCase().match(/P[123]/)?.[0] ?? (/(high|urgent)/i.test(pr) ? "P1" : /(medium|important)/i.test(pr) ? "P2" : "P3");
    let key = cardId ? `card:${cardId}` : `row:${tab}:${serial || "-"}:${normTitle(title)}`;
    while (seenKeys.has(key)) key += "#"; // two identical hand-typed rows: keep both
    seenKeys.add(key);
    parsed.push({
      key, cardId, boardId: link ? boardIdFrom(link) : null, title, priority, assignee: cell(r, "assignee") || null, due: due?.toISOString() ?? null,
      status: status || (done ? "Done" : null), dept: departmentKey(cell(r, "department")), notes: cell(r, "notes") || null, sheetRow: i + 1,
      created: (created ?? new Date()).toISOString(), completed: completed?.toISOString() ?? null,
    });
  }

  // Rows the hub wrote itself: recognised by Pulp card id; only learn a PM-typed assignee.
  const hub = await sql()`select id, pulp_card_id, assignee from tasks where client_id = ${client.id} and origin = 'hub' and pulp_card_id is not null`;
  const hubByCard = new Map(hub.map((h) => [String(h.pulp_card_id), h]));
  const hubAssign: Array<{ id: string; assignee: string }> = [];
  const mine = parsed.filter((p) => {
    const h = p.cardId ? hubByCard.get(p.cardId) : undefined;
    if (!h) return true;
    if (p.assignee && !h.assignee) hubAssign.push({ id: String(h.id), assignee: p.assignee });
    return false;
  });
  if (hubAssign.length) await sql()`update tasks t set assignee = v.assignee from (select unnest(${hubAssign.map((x) => x.id)}::uuid[]) as id, unnest(${hubAssign.map((x) => x.assignee)}::text[]) as assignee) v where t.id = v.id`;

  const existing = new Set((await sql()`select sheet_key from tasks where origin = 'sheet' and client_id = ${client.id}`).map((x) => String(x.sheet_key)));
  const ins = mine.filter((p) => !existing.has(p.key)), upd = mine.filter((p) => existing.has(p.key));
  const col = <K extends keyof Row>(list: Row[], k: K) => list.map((p) => p[k] as unknown as string | null);
  for (let i = 0; i < ins.length; i += 300) {
    const b = ins.slice(i, i + 300);
    await sql()`insert into tasks (request_id, client_id, pulp_card_id, board_id, title, priority, assignee, due_at, sheet_row, staging, created_at, completed_at, origin, sheet_key, sheet_tab, sheet_status, department, notes)
      select null, ${client.id}, c, bd, t, pr, a, d::timestamptz, sr, false, cr::timestamptz, co::timestamptz, 'sheet', k, ${tab}, st, dp, n
      from unnest(${col(b, "cardId")}::text[], ${col(b, "boardId")}::text[], ${col(b, "title")}::text[], ${col(b, "priority")}::text[], ${col(b, "assignee")}::text[], ${col(b, "due")}::text[],
                  ${b.map((p) => p.sheetRow)}::int[], ${col(b, "created")}::text[], ${col(b, "completed")}::text[], ${col(b, "key")}::text[], ${col(b, "status")}::text[], ${col(b, "dept")}::text[], ${col(b, "notes")}::text[])
        as v(c, bd, t, pr, a, d, sr, cr, co, k, st, dp, n)`;
  }
  for (let i = 0; i < upd.length; i += 300) {
    const b = upd.slice(i, i + 300);
    await sql()`update tasks t set title = v.t, priority = v.pr, assignee = v.a, due_at = v.d::timestamptz, sheet_status = v.st, department = v.dp, notes = v.n, sheet_row = v.sr, sheet_tab = ${tab},
        completed_at = v.co::timestamptz, pulp_card_id = coalesce(t.pulp_card_id, v.c), board_id = coalesce(t.board_id, v.bd)
      from unnest(${col(b, "key")}::text[], ${col(b, "cardId")}::text[], ${col(b, "boardId")}::text[], ${col(b, "title")}::text[], ${col(b, "priority")}::text[], ${col(b, "assignee")}::text[], ${col(b, "due")}::text[],
                  ${b.map((p) => p.sheetRow)}::int[], ${col(b, "completed")}::text[], ${col(b, "status")}::text[], ${col(b, "dept")}::text[], ${col(b, "notes")}::text[])
        as v(k, c, bd, t, pr, a, d, sr, co, st, dp, n)
      where t.sheet_key = v.k and t.origin = 'sheet'`;
  }
  return { rows: parsed.length, imported: ins.length, updated: upd.length, hubRows: parsed.length - mine.length };
}

/** All clients (or one, by id). Progress is saved per tab so a timeout still leaves a readable report. */
export async function syncSheet(onlyClientId?: string | null): Promise<SyncReport> {
  const report: SyncReport = { tabs: {}, errors: [], at: new Date().toISOString() };
  if (!sheetsConfigured()) { report.errors.push("sheets not configured"); return report; }
  const clients = (await allClients()).filter((c) => !onlyClientId || c.id === onlyClientId);
  const save = async () => { try { await sql()`insert into settings (key, value) values ('sheet_sync_last', ${JSON.stringify(report)}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`; } catch { /* ignore */ } };
  for (const client of clients) {
    let tab: string | null = null;
    try {
      tab = await findClientTab(client);
      if (!tab) continue;
      report.tabs[tab] = await syncClientTab(client, tab);
    } catch (e) { report.errors.push(`${tab ?? client.name}: ${(e as Error).message.slice(0, 160)}`); }
    await save();
  }
  return report;
}
