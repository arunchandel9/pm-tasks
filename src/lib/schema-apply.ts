import { createHash } from "node:crypto";
import { sql } from "./db";
import { SCHEMA_SQL } from "./schema";
import { splitSchema } from "./schema-split";

/**
 * The schema applies itself: the first minute loop after a deploy whose schema differs from the one last applied runs
 * db/schema.sql (every statement is idempotent) and remembers its hash. Before 2026-09-22 a new table needed a
 * `/api/setup` call by hand; a deploy that added tables and forgot the call failed quietly.
 */
export const schemaHash = () => createHash("sha256").update(SCHEMA_SQL).digest("hex").slice(0, 16);

export async function ensureSchema(): Promise<{ applied: boolean; statements?: number; hash: string }> {
  const hash = schemaHash();
  let current: string | null = null;
  try { const r = await sql()`select value from settings where key = 'schema_hash'`; current = r.length ? String(r[0].value) : null; }
  catch { current = null; } // the settings table itself may not exist yet
  if (current === hash) return { applied: false, hash };
  const statements = splitSchema(SCHEMA_SQL);
  for (const s of statements) await sql().query(s);
  await sql()`insert into settings (key, value) values ('schema_hash', ${JSON.stringify(hash)}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`;
  return { applied: true, statements: statements.length, hash };
}
