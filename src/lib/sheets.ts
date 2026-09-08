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

// ---- column mapping config ----

interface SheetConfig { header_row: number; columns: Record<string, string[]>; stage_values: Record<string, string> }
let _cfg: SheetConfig | null = null;
export function sheetConfig(): SheetConfig {
  if (!_cfg) _cfg = YAML.parse(readFileSync(path.join(process.cwd(), "config", "sheet.yaml"), "utf8")) as SheetConfig;
  return _cfg;
}

const normHeader = (h: string) => h.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Map a tab's header row to our field names: field → 0-based column index. Unknown headers are ignored. */
export function mapHeaders(headers: string[], cfg: SheetConfig = sheetConfig()): Record<string, number> {
  const out: Record<string, number> = {};
  const normed = headers.map(normHeader);
  for (const [field, aliases] of Object.entries(cfg.columns)) {
    for (const a of aliases) {
      const idx = normed.indexOf(normHeader(a));
      if (idx >= 0) { out[field] = idx; break; }
    }
  }
  return out;
}

export const colLetter = (i: number) => { let s = "", n = i + 1; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };

// ---- tabs and headers ----

export async function listTabs(): Promise<string[]> {
  const res = await sheets().spreadsheets.get({ spreadsheetId: sheetId(), fields: "sheets.properties.title" });
  return (res.data.sheets ?? []).map((s) => s.properties?.title ?? "").filter(Boolean);
}

const headerCache = new Map<string, { headers: string[]; at: number }>();
export async function tabHeaders(tab: string): Promise<string[]> {
  const hit = headerCache.get(tab);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.headers;
  const row = sheetConfig().header_row;
  const res = await sheets().spreadsheets.values.get({ spreadsheetId: sheetId(), range: `'${tab}'!${row}:${row}` });
  const headers = (res.data.values?.[0] ?? []).map((v) => String(v ?? ""));
  headerCache.set(tab, { headers, at: Date.now() });
  return headers;
}

/** Find the client's tab: exact name, then case-insensitive, then a tab that starts with the client name. */
export async function findClientTab(client: Client | null): Promise<string | null> {
  const tabs = await listTabs();
  const wanted = [client?.name ?? "Internal", client?.id ?? "internal"].map((s) => s.toLowerCase());
  return tabs.find((t) => wanted.includes(t.toLowerCase()))
    ?? tabs.find((t) => wanted.some((w) => t.toLowerCase().startsWith(w)))
    ?? null;
}

// ---- config tab → clients ----

/**
 * Config tab → clients. Header row (order-insensitive, case-insensitive):
 * id | name | scope | slack_team_id | aliases | slack_channels | email_domains | whatsapp_numbers | dev_board | dev_list | dev_staging | dev_assignee | content_board | … | client_facing_ack
 */
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
    if (scope === "client" && Object.keys(boards).length === 0) errors.push(`row ${i + 1} (${cid}): no boards`);
    clients.push({
      id: cid, name: get("name") || cid, scope,
      slackChannels: list(get("slack_channels")), emailDomains: list(get("email_domains")).map((d) => d.toLowerCase()),
      whatsappNumbers: list(get("whatsapp_numbers")), boards,
      clientFacingAck: /^(true|yes|1)$/i.test(get("client_facing_ack")),
      slackTeamId: get("slack_team_id") || null,
      aliases: list(get("aliases")),
    });
  }
  return { clients, errors };
}

// ---- writing task rows into a client's own tab, under its own headers ----

export interface TaskFields {
  task_id: string; title: string; department: string; type: string; stage: string; created: string; due: string;
  last_moved: string; completed: string; source: string; source_link: string; pulp_link: string; assignee: string;
}

/** Append one row to the client's tab, placing each value under the matching header. Returns the row number. */
export async function appendTaskRow(tab: string, f: TaskFields): Promise<{ row: number; wrote: string[]; unmapped: string[] }> {
  const headers = await tabHeaders(tab);
  if (!headers.length) throw new Error(`tab "${tab}" has no header row ${sheetConfig().header_row}`);
  const map = mapHeaders(headers);
  const row: string[] = new Array(headers.length).fill("");
  const wrote: string[] = [], unmapped: string[] = [];
  for (const [field, value] of Object.entries(f)) {
    if (field === "priority" || field === "notes") continue;
    const idx = map[field];
    if (idx === undefined) { if (value) unmapped.push(field); continue; }
    row[idx] = value; wrote.push(field);
  }
  const res = await sheets().spreadsheets.values.append({
    spreadsheetId: sheetId(), range: `'${tab}'!A${sheetConfig().header_row + 1}`, valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
  const m = (res.data.updates?.updatedRange ?? "").match(/![A-Z]+(\d+)/);
  return { row: m ? Number(m[1]) : -1, wrote, unmapped };
}

/** Update only the bot-owned status cells of an existing row. */
export async function updateTaskCells(tab: string, rowNumber: number, f: Partial<Pick<TaskFields, "stage" | "last_moved" | "completed" | "pulp_link">>): Promise<void> {
  const map = mapHeaders(await tabHeaders(tab));
  const data: sheets_v4.Schema$ValueRange[] = [];
  for (const [field, value] of Object.entries(f)) {
    const idx = map[field];
    if (idx === undefined || value === undefined) continue;
    data.push({ range: `'${tab}'!${colLetter(idx)}${rowNumber}`, values: [[value]] });
  }
  if (!data.length) return;
  await sheets().spreadsheets.values.batchUpdate({ spreadsheetId: sheetId(), requestBody: { valueInputOption: "USER_ENTERED", data } });
}
