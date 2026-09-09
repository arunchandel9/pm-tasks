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

export async function syncSheet(): Promise<SyncReport> {
  const report: SyncReport = { tabs: {}, errors: [], at: new Date().toISOString() };
  if (!sheetsConfigured()) { report.errors.push("sheets not configured"); return report; }
  const cfg = sheetConfig();
  const clients = await allClients();
  for (const client of clients) {
    let tab: string | null = null;
    try {
      tab = await findClientTab(client);
      if (!tab) continue;
      const headers = await tabHeaders(tab);
      const map = mapHeaders(headers, cfg);
      if (map.title === undefined) { report.errors.push(`${tab}: no TASK column`); continue; }
      const rows = await tabRows(tab);
      const divider = dividerIndex(rows, map, cfg);
      const stat = { rows: 0, imported: 0, updated: 0, hubRows: 0 };
      const cell = (r: string[], f: string) => (map[f] !== undefined ? (r[map[f]] ?? "").trim() : "");
      for (let i = cfg.header_row; i < rows.length; i++) {
        const r = rows[i];
        if (i === divider) continue;
        const title = cell(r, "title");
        if (!title || normList(title) === "done") continue;
        stat.rows++;
        const link = cell(r, "pulp_link");
        const cardId = link ? cardIdFrom(link) : null;
        const serial = cell(r, "serial");
        const status = cell(r, "stage");
        const belowDivider = divider >= 0 && i > divider;
        const done = belowDivider || isDoneStatus(status);
        const created = parseSheetDate(cell(r, "created")) ?? null;
        const completed = parseSheetDate(cell(r, "completed")) ?? (done ? created : null);
        const due = parseSheetDate(cell(r, "due"));
        const priority = (cell(r, "priority").toUpperCase().match(/P[123]/)?.[0]) ?? (/(high|urgent)/i.test(cell(r, "priority")) ? "P1" : /(medium|important)/i.test(cell(r, "priority")) ? "P2" : "P3");
        const assignee = cell(r, "assignee") || null;
        const notes = cell(r, "notes") || null;
        const dept = departmentKey(cell(r, "department"));
        const key = cardId ? `card:${cardId}` : `row:${tab}:${serial || "-"}:${normTitle(title)}`;

        // A row the hub wrote itself: only learn the assignee a PM typed in.
        if (cardId) {
          const hub = await sql()`select id, assignee from tasks where pulp_card_id = ${cardId} and origin = 'hub'`;
          if (hub.length) {
            stat.hubRows++;
            if (assignee && !hub[0].assignee) await sql()`update tasks set assignee = ${assignee} where id = ${hub[0].id}`;
            continue;
          }
        }
        const existing = await sql()`select id from tasks where sheet_key = ${key}`;
        if (existing.length) {
          await sql()`update tasks set title = ${title}, priority = ${priority}, assignee = ${assignee}, due_at = ${due?.toISOString() ?? null},
            sheet_status = ${status || (done ? "Done" : null)}, department = ${dept}, notes = ${notes}, sheet_row = ${i + 1}, sheet_tab = ${tab},
            completed_at = ${completed?.toISOString() ?? null}, pulp_card_id = coalesce(pulp_card_id, ${cardId}), board_id = coalesce(board_id, ${link ? boardIdFrom(link) : null})
            where id = ${existing[0].id}`;
          stat.updated++;
        } else {
          await sql()`insert into tasks (request_id, client_id, pulp_card_id, board_id, title, priority, assignee, due_at, sheet_row, staging, created_at, completed_at, origin, sheet_key, sheet_tab, sheet_status, department, notes)
            values (null, ${client.id}, ${cardId}, ${link ? boardIdFrom(link) : null}, ${title}, ${priority}, ${assignee}, ${due?.toISOString() ?? null}, ${i + 1}, false,
                    ${(created ?? new Date()).toISOString()}, ${completed?.toISOString() ?? null}, 'sheet', ${key}, ${tab}, ${status || (done ? "Done" : null)}, ${dept}, ${notes})`;
          stat.imported++;
        }
      }
      report.tabs[tab] = stat;
    } catch (e) { report.errors.push(`${tab ?? client.name}: ${(e as Error).message.slice(0, 160)}`); }
  }
  try {
    await sql()`insert into settings (key, value) values ('sheet_sync_last', ${JSON.stringify(report)}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`;
  } catch { /* ignore */ }
  return report;
}
