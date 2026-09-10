import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

describe("feature register", () => {
  const doc = readFileSync("docs/FEATURES.md", "utf8");
  it("names every endpoint", () => {
    const routes = walk("src/app/api").filter((p) => p.endsWith("route.ts")).map((p) => "/" + p.replace(/^src\/app\//, "").replace(/\/route\.ts$/, ""));
    const missing = routes.filter((r) => !doc.includes("`" + r + "`"));
    expect(missing, `add these endpoints to docs/FEATURES.md section 9: ${missing.join(", ")}`).toEqual([]);
  });
  it("names every module", () => {
    const mods = walk("src/lib").filter((p) => p.endsWith(".ts"));
    const missing = mods.filter((m) => !doc.includes("`" + m + "`"));
    expect(missing, `add these modules to docs/FEATURES.md section 10: ${missing.join(", ")}`).toEqual([]);
  });
});
