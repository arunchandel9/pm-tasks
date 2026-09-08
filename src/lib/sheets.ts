import { google, type sheets_v4 } from "googleapis";
import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { Client } from "./types";

function auth() {
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_B64;
  if (!b64) throw new Error("GOOGLE_NOT_CONFIGURED");
  const creds = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  return new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
}

let _sheets: sheets_v4.Sheets | null = null;
function sheets(): sheets_v4.Sheets {
  if (!_sheets) _sheets = google.sheets({ version: "v4", auth: auth() });
  return _sheets;
}

export const sheetsConfigured = () => !!process.env.GOOGLE_SERVICE_ACCOUNT_B64 && !!process.env.PM_SHEET_ID;
const sheetId = () => process.env.PM_SHEET_ID!;

// ---- config ----

interface SheetConfig {
  header_row: number; date_format: string; done_divider: string[]; columns: Record<string, string[]>;
  initial_note: string; department_labels: Record<string, string>; stage_values: Record<string, string>;
}
let _cfg: SheetConfig | null = null;
export function sheetConfig(): SheetConfig {
  if (!_cfg) _cfg = YAML.parse(readFileSync(path.join(process.cwd(), "config", "sheet.yaml"), "utf8")) as SheetConfig;
  return _cfg;
}

const normHeader = (h: string) => h.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Map a tab's header row to field names: field → 0-based column index. Unknown headers are ignored. */
export function mapHeaders(headers: string[], cfg: SheetConfig = sheetConfig()): Record<string, number> {
  const out: Record<string, number> = {};
  const normed = headers.map(normHeader);
  for (const [field, aliases] of Object.entries(cfg.columns)) {
    for (const a of aliases) {
      const idx = normed.indexOf(normHeader(a));
      if (idx >= 0) { out[field] = idx; break; }
    }
  }
  // A tab whose link column has a blank header right after TASK: treat it as the pulp link.
  if (out.pulp_link === undefined && out.title !== undefined && headers[out.title + 1] !== undefined && normed[out.title + 1] === "") out.pulp_link = out.title + 1;
  return out;
}

export const colLetter = (i: number) => { let s = "", n = i + 1; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function formatDate(d: Date | null | undefined, fmt = sheetConfig().date_format): string {
  if (!d) return "";
  const dd = String(d.getDate()).padStart(2, "0"), mmm = MONTHS[d.getMonth()], yyyy = String(d.getFullYear()), mm = String(d.getMonth() + 1).padStart(2, "0");
  return fmt.replace("DD", dd).replace("MMM", mmm).replace("YYYY", yyyy).replace("MM", mm);
}

export const departmentLabel = (dep: string) => sheetConfig().department_labels[dep] ?? dep;

// ---- tabs, headers, rows ----

const tabMetaCache = new Map<string, { id: number; at: number }>();
async function tabMeta(): Promise<Array<{ title: string; id: number }>> {
  const res = await sheets().spreadsheets.get({ spreadsheetId: sheetId(), fields: "sheets.properties(title,sheetId)" });
  const list = (res.data.sheets ?? []).map((s) => ({ title: s.properties?.title ?? "", id: s.properties?.sheetId ?? 0 })).filter((t) => t.title);
  for (const t of list) tabMetaCache.set(t.title, { id: t.id, at: Date.now() });
  return list;
}
export async function listTabs(): Promise<string[]> { return (await tabMeta()).map((t) => t.title); }
async function tabNumericId(tab: string): Promise<number> {
  const hit = tabMetaCache.get(tab);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.id;
  const t = (await tabMeta()).find((x) => x.title === tab);
  if (!t) throw new Error(`tab "${tab}" not found`);
  return t.id;
}

const headerCache = new Map<string, { headers: string[]; at: number }>();
export async function tabHeaders(tab: string): Promise<string[]> {
  const hit = headerCache.get(tab);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.headers;
  const row = sheetConfig().header_row;
  const res = await sheets().spreadsheets.values.get({ spreadsheetId: sheetId(), range: `'${tab}'!${row}:${row}` });
  const headers = (res.data.values?.[0] ?? []).map((v) => String(v ?? "").trim());
  headerCache.set(tab, { headers, at: Date.now() });
  return headers;
}

/** The client's tab: explicit sheet_tab from Config, else exact/case-insensitive/prefix match on the client name. */
export async function findClientTab(client: Client | null): Promise<string | null> {
  const tabs = await listTabs();
  const key = (s: string) => s.trim().toLowerCase();
  if (client?.sheetTab) return tabs.find((t) => key(t) === key(client.sheetTab!)) ?? null;
  const wanted = [client?.name ?? "MangoEyes", client?.id ?? "internal"].map(key);
  return tabs.find((t) => wanted.includes(key(t)))
    ?? tabs.find((t) => wanted.some((w) => key(t).startsWith(w) || key(t).endsWith("- " + w)))
    ?? null;
}

/** Read the whole used area of a tab (values only). */
async function tabRows(tab: string): Promise<string[][]> {
  const res = await sheets().spreadsheets.values.get({ spreadsheetId: sheetId(), range: `'${tab}'!A1:Z2000` });
  return (res.data.values ?? []).map((r) => r.map((v) => String(v ?? "")));
}

/**
 * Where a new task row goes: the row of the DONE divider (new row is inserted above it), else one past the last
 * row with any content. Also returns the next serial number from the serial column above that point.
 */
export function placement(rows: string[][], map: Record<string, number>, cfg: SheetConfig = sheetConfig()): { insertAt: number; nextSerial: number } {
  const headerIdx = cfg.header_row - 1;
  let divider = -1;
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const firstText = rows[i].find((c) => c.trim());
    if (firstText && cfg.done_divider.includes(normHeader(firstText)) && rows[i].filter((c) => c.trim()).length <= 2) { divider = i; break; }
  }
  const lastFilled = (() => { for (let i = (divider >= 0 ? divider : rows.length) - 1; i > headerIdx; i--) if (rows[i].some((c, ci) => ci !== map.serial && c.trim())) return i; return headerIdx; })();
  let nextSerial = 1;
  if (map.serial !== undefined) {
    for (let i = headerIdx + 1; i <= lastFilled; i++) { const n = Number(rows[i]?.[map.serial]); if (Number.isFinite(n) && n >= nextSerial) nextSerial = n + 1; }
  }
  return { insertAt: divider >= 0 ? divider : lastFilled + 1, nextSerial };
}

// ---- config tab → clients ----

export async function readConfigTab(): Promise<{ clients: Client[]; errors: string[] }> {
  const tab = process.env.PM_SHEET_CONFIG_TAB || "Config";
  const res = await sheets().spreadsheets.values.get({ spreadsheetId: sheetId(), range: `'${tab}'!A1:AZ200` });
  const rows = res.data.values ?? [];
  if (rows.length < 2) return { clients: [], errors: ["Config tab has no rows"] };
  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const errors: string[] = [];
  const clients: Client[] = [];
  const list = (v: unknown) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const get = (name: string) => (col(name) >= 0 ? String(r[col(name)] ?? "").trim() : "");
    const cid = get("id");
    if (!cid) continue;
    const scope = get("scope") === "internal" ? "internal" : "client";
    const boards: Client["boards"] = {};
    for (const dep of ["dev", "content", "design", "seo", "scope", "internal"]) {
      const board = get(`${dep}_board`);
      if (!board) continue;
      boards[dep] = { board, list: get(`${dep}_list`) || "To Do", staging: get(`${dep}_staging`) || "Staging", assignee: get(`${dep}_assignee`) || undefined };
    }
    if (!get("slack_team_id") && scope === "client") errors.push(`row ${i + 1} (${cid}): no slack_team_id`);
    clients.push({
      id: cid, name: get("name") || cid, scope,
      slackChannels: list(get("slack_channels")), emailDomains: list(get("email_domains")).map((d) => d.toLowerCase()),
      whatsappNumbers: list(get("whatsapp_numbers")), boards,
      clientFacingAck: /^(true|yes|1)$/i.test(get("client_facing_ack")),
      slackTeamId: get("slack_team_id") || null,
      aliases: list(get("aliases")),
      sheetTab: get("sheet_tab") || null,
    });
  }
  return { clients, errors };
}

// ---- writing task rows ----

export interface TaskFields {
  title: string; department: string; priority: string; assignee: string; pulp_link: string; source_link: string;
  created: Date; due: Date | null;
}

/**
 * Insert one task row into the client's tab, above the DONE divider if there is one, with the next serial number,
 * dates in the sheet's format, the department label the sheet uses, Status "To Do", and the initial comment.
 * Returns the 1-based row number written.
 */
export async function insertTaskRow(tab: string, f: TaskFields): Promise<{ row: number; wrote: string[] }> {
  const cfg = sheetConfig();
  const headers = await tabHeaders(tab);
  if (!headers.length) throw new Error(`tab "${tab}" has no header row ${cfg.header_row}`);
  const map = mapHeaders(headers, cfg);
  const rows = await tabRows(tab);
  const { insertAt, nextSerial } = placement(rows, map, cfg);

  const values: Record<string, string> = {
    serial: String(nextSerial), title: f.title, pulp_link: f.pulp_link, created: formatDate(f.created, cfg.date_format),
    due: formatDate(f.due, cfg.date_format), priority: f.priority, assignee: f.assignee, stage: cfg.stage_values.created,
    department: departmentLabel(f.department), notes: cfg.initial_note, source_link: f.source_link,
  };
  const row: string[] = new Array(headers.length).fill("");
  const wrote: string[] = [];
  for (const [field, v] of Object.entries(values)) {
    const idx = map[field];
    if (idx === undefined || !v) continue;
    row[idx] = v; wrote.push(field);
  }

  const sid = await tabNumericId(tab);
  await sheets().spreadsheets.batchUpdate({
    spreadsheetId: sheetId(),
    requestBody: { requests: [{ insertDimension: { range: { sheetId: sid, dimension: "ROWS", startIndex: insertAt, endIndex: insertAt + 1 }, inheritFromBefore: insertAt > cfg.header_row } }] },
  });
  const rowNumber = insertAt + 1;
  await sheets().spreadsheets.values.update({
    spreadsheetId: sheetId(), range: `'${tab}'!A${rowNumber}:${colLetter(headers.length - 1)}${rowNumber}`, valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
  return { row: rowNumber, wrote };
}

/** Update only bot-owned status cells of an existing row: Status, Date Completed, Pulp link. Never priority, assignee or comments. */
export async function updateTaskCells(tab: string, rowNumber: number, f: { stage?: string; completed?: Date | null; pulp_link?: string }): Promise<void> {
  const cfg = sheetConfig();
  const map = mapHeaders(await tabHeaders(tab), cfg);
  const data: sheets_v4.Schema$ValueRange[] = [];
  const put = (field: string, v: string | undefined) => { const idx = map[field]; if (idx !== undefined && v !== undefined) data.push({ range: `'${tab}'!${colLetter(idx)}${rowNumber}`, values: [[v]] }); };
  put("stage", f.stage);
  put("completed", f.completed === undefined ? undefined : formatDate(f.completed, cfg.date_format));
  put("pulp_link", f.pulp_link);
  if (!data.length) return;
  await sheets().spreadsheets.values.batchUpdate({ spreadsheetId: sheetId(), requestBody: { valueInputOption: "USER_ENTERED", data } });
}
