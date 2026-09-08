/** Regenerates src/lib/schema.ts from db/schema.sql so the SQL ships inside the bundle. Run after editing schema.sql. */
import { readFileSync, writeFileSync } from "node:fs";
const sql = readFileSync("db/schema.sql", "utf8");
const out = `// GENERATED from db/schema.sql by scripts/gen-schema.ts — do not edit by hand.\nexport const SCHEMA_SQL = ${JSON.stringify(sql)};\n`;
writeFileSync("src/lib/schema.ts", out);
console.log("wrote src/lib/schema.ts", sql.length, "chars");
