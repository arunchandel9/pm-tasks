import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { NoiseConfig, RoutingConfig } from "./types";

// Statically scoped to ./config so the bundler can trace the files (see next.config.ts).
const configDir = path.join(process.cwd(), "config");

function loadYaml<T>(file: string): T {
  return YAML.parse(readFileSync(path.join(configDir, file), "utf8")) as T;
}

interface BoardsConfig { base_url: string; card_url?: string; departments: Record<string, { board: string; list: string; staging?: string; assignee?: string }> }
let boardsCache: BoardsConfig | null = null;
export function boards(): BoardsConfig {
  if (!boardsCache) boardsCache = loadYaml<BoardsConfig>("boards.yaml");
  return boardsCache;
}

let routingCache: RoutingConfig | null = null;
let noiseCache: NoiseConfig | null = null;

export function routing(): RoutingConfig {
  if (!routingCache) routingCache = loadYaml<RoutingConfig>("routing.yaml");
  return routingCache;
}

export function noise(): NoiseConfig {
  if (!noiseCache) noiseCache = loadYaml<NoiseConfig>("noise.yaml");
  return noiseCache;
}

/**
 * Rendered once, in a fixed key order, so the cached prompt prefix never drifts.
 * This string goes into the system block with a 1-hour cache.
 */
export function routingForPrompt(): string {
  const r = routing();
  const lines: string[] = [];
  for (const key of Object.keys(r.request_types).sort()) {
    const t = r.request_types[key];
    const flags = [
      t.gated ? "gated" : null,
      t.no_card ? "no_card" : null,
      t.backlog ? `backlog:${t.backlog}` : null,
    ].filter(Boolean);
    lines.push(`- ${key}: department=${t.department}${flags.length ? " " + flags.join(" ") : ""}`);
  }
  return lines.join("\n");
}

export const env = {
  model: () => process.env.LLM_MODEL || "claude-sonnet-5",
  reviewChannel: () => process.env.SLACK_REVIEW_CHANNEL || "#pm-review",
  intakeChannel: () => process.env.SLACK_INTAKE_CHANNEL || "#intake",
  p1Channel: () => process.env.SLACK_P1_CHANNEL || process.env.SLACK_REVIEW_CHANNEL || "#pm-review",
  intakePaused: () => (process.env.INTAKE_PAUSED || "false").toLowerCase() === "true",
};
