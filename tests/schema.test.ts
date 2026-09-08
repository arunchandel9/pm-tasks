import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { SCHEMA_SQL } from "../src/lib/schema";
import { splitSchema } from "../src/lib/schema-split";

describe("schema bundle", () => {
  it("matches db/schema.sql", () => {
    expect(SCHEMA_SQL).toBe(readFileSync("db/schema.sql", "utf8"));
  });
  it("splits into statements without stray comments", () => {
    const statements = splitSchema(SCHEMA_SQL);
    expect(statements.length).toBeGreaterThan(15);
    for (const s of statements) expect(s.startsWith("--")).toBe(false);
    const tables = statements.filter((s) => /^create table/i.test(s)).length;
    expect(tables).toBe(10);
  });
});
