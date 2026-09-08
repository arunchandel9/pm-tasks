import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { SCHEMA_SQL } from "../src/lib/schema";

describe("schema bundle", () => {
  it("matches db/schema.sql", () => {
    expect(SCHEMA_SQL).toBe(readFileSync("db/schema.sql", "utf8"));
  });
  it("splits into statements without stray comments", () => {
    const statements = SCHEMA_SQL.split(/;\s*\n/).map((s) => s.trim()).filter((s) => s.length > 0 && !s.startsWith("--"));
    expect(statements.length).toBeGreaterThan(15);
    for (const s of statements) expect(s.startsWith("--")).toBe(false);
  });
});
