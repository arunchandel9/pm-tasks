import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL || Object.entries(process.env).find(([k, v]) => k.endsWith("_DATABASE_URL") && !k.endsWith("_UNPOOLED") && v)?.[1];
if (!url) throw new Error("DATABASE_URL is not set");

const sql = neon(url);
const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

// Neon's HTTP driver runs one statement per call; split on ';' at line ends.
const statements = schema.split(/\r?\n/).filter((l) => !l.trim().startsWith("--")).join("\n").split(";").map((s) => s.trim()).filter((s) => s.length > 0);

for (const stmt of statements) {
  await sql.query(stmt);
}
console.log(`applied ${statements.length} statements`);
