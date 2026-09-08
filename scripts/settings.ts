/**
 * Set or read a settings row.
 *   npx tsx scripts/settings.ts intake_channel_id '"C0123456789"'
 *   npx tsx scripts/settings.ts staff_slack_user_ids '["U1","U2"]'
 *   npx tsx scripts/settings.ts intake_paused true
 *   npx tsx scripts/settings.ts                      # list all
 */
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL || Object.entries(process.env).find(([k, v]) => k.endsWith("_DATABASE_URL") && !k.endsWith("_UNPOOLED") && v)?.[1];
if (!url) throw new Error("DATABASE_URL is not set");
const sql = neon(url);
const [key, raw] = process.argv.slice(2);

if (!key) {
  const rows = await sql`select key, value, updated_at from settings order by key`;
  for (const r of rows) console.log(r.key, JSON.stringify(r.value), r.updated_at);
} else if (raw === undefined) {
  const rows = await sql`select value from settings where key = ${key}`;
  console.log(rows.length ? JSON.stringify(rows[0].value) : "(unset)");
} else {
  const value = JSON.parse(raw);
  await sql`insert into settings (key, value) values (${key}, ${JSON.stringify(value)}::jsonb)
            on conflict (key) do update set value = excluded.value, updated_at = now()`;
  console.log("set", key, "=", JSON.stringify(value));
}
