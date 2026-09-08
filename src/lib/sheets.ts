import { google, type sheets_v4 } from "googleapis";
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

/**
 * Config tab → clients. Expected header row (order-insensitive, case-insensitive):
 * id | name | scope | slack_channels | email_domains | whatsapp_numbers | dev_board | dev_list | dev_staging | dev_assignee | content_board | ... | client_facing_ack
 * Lists are comma-separated. Departments: dev, content, design, seo, scope, internal.
 */
export async function readConfigTab(): Promise<{ clients: Client[]; errors: string[] }> {
  const id = process.env.PM_SHEET_ID!;
  const tab = process.env.PM_SHEET_CONFIG_TAB || "Config";
  const res = await sheets().spreadsheets.values.get({ spreadsheetId: id, range: `${tab}!A1:AZ200` });
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
    });
  }
  return { clients, errors };
}

/** Bot-owned columns only. Human-owned columns (Priority, Owner, PM notes, Client ETA) are never written. */
export interface SheetRow {
  taskId: string; client: string; department: string; type: string; title: string; pulpLink: string;
  source: string; sourceLink: string; created: string; stage: string; lastMoved: string; completed: string;
}

export async function appendTaskRow(tab: string, row: SheetRow): Promise<number> {
  const id = process.env.PM_SHEET_ID!;
  const values = [[row.taskId, row.client, row.department, row.type, row.title, row.pulpLink, row.source, row.sourceLink, row.created, row.stage, row.lastMoved, row.completed]];
  const res = await sheets().spreadsheets.values.append({
    spreadsheetId: id, range: `${tab}!A:L`, valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });
  const updated = res.data.updates?.updatedRange ?? "";
  const m = updated.match(/!A(\d+)/);
  return m ? Number(m[1]) : -1;
}

export async function updateStageCells(tab: string, rowNumber: number, stage: string, lastMoved: string, completed: string): Promise<void> {
  const id = process.env.PM_SHEET_ID!;
  await sheets().spreadsheets.values.update({
    spreadsheetId: id, range: `${tab}!J${rowNumber}:L${rowNumber}`, valueInputOption: "USER_ENTERED",
    requestBody: { values: [[stage, lastMoved, completed]] },
  });
}
