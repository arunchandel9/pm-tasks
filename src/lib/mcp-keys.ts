import { createHash, randomBytes } from "node:crypto";
import { sql } from "./db";

/**
 * One key per person for the MCP hub. The key is shown once at creation; only its hash is stored
 * (settings `mcp_key:<sha256>` → { name, email, createdAt }). Revoking deletes the row.
 */
export interface McpKeyOwner { name: string; email: string; createdAt: string }

const hash = (key: string) => createHash("sha256").update(key.trim()).digest("hex");

export async function createMcpKey(name: string, email: string): Promise<string> {
  const key = `mh_${randomBytes(24).toString("hex")}`;
  const owner: McpKeyOwner = { name: name.trim(), email: email.trim().toLowerCase(), createdAt: new Date().toISOString() };
  await sql()`insert into settings (key, value) values (${"mcp_key:" + hash(key)}, ${JSON.stringify(owner)}::jsonb)`;
  return key;
}

export async function verifyMcpKey(key: string | null | undefined): Promise<McpKeyOwner | null> {
  if (!key || !/^mh_[0-9a-f]{48}$/.test(key.trim())) return null;
  const r = await sql()`select value from settings where key = ${"mcp_key:" + hash(key)}`;
  return r.length ? (r[0].value as McpKeyOwner) : null;
}

export async function listMcpKeys(): Promise<McpKeyOwner[]> {
  const r = await sql()`select value from settings where key like 'mcp_key:%' order by updated_at`;
  return r.map((x) => x.value as McpKeyOwner);
}

export async function revokeMcpKeys(nameOrEmail: string): Promise<number> {
  const n = nameOrEmail.trim().toLowerCase();
  const r = await sql()`delete from settings where key like 'mcp_key:%' and (lower(value->>'name') = ${n} or lower(value->>'email') = ${n}) returning key`;
  return r.length;
}
