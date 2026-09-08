import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const sql = neon(url);
const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

// Neon's HTTP driver runs one statement per call; split on ';' at line ends.
const statements = schema
  .split(/;\s*\n/)
  .map((s) => s.trim())
  .filter((s) => s.length > 0 && !s.startsWith("--"));

for (const stmt of statements) {
  await sql.query(stmt);
}
console.log(`applied ${statements.length} statements`);
