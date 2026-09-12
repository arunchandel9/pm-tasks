import type { Client, Scope } from "./types";

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const digits = (s: string) => s.replace(/\D/g, "");
const letters = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

/**
 * Voice transcripts mishear names: "a bella", "Abella", "the eye doctors". Compare every 1–3 word window of the text
 * with each client name and alias, letters only, and accept a close match (at most one edit per five letters).
 */
export function fuzzyClientFromText(text: string, clients: Client[]): { client: Client; how: string } | null {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  let best: { client: Client; score: number } | null = null;
  for (const c of clients.filter((x) => x.scope === "client")) {
    for (const name of [c.name, ...(c.aliases ?? [])]) {
      const target = letters(name);
      if (target.length < 4) continue;
      const allowed = Math.max(1, Math.floor(target.length / 5));
      for (let i = 0; i < words.length; i++) for (let n = 1; n <= 3 && i + n <= words.length; n++) {
        const window = letters(words.slice(i, i + n).join(""));
        if (Math.abs(window.length - target.length) > allowed) continue;
        const d = editDistance(window, target);
        if (d <= allowed && (!best || d < best.score || (d === best.score && target.length > letters(best.client.name).length))) best = { client: c, score: d };
      }
    }
  }
  return best ? { client: best.client, how: "fuzzy" } : null;
}

/**
 * Find the client for a pasted or typed message (intake, /task, forwarded WhatsApp, pasted email).
 * Order: "Client:" prefix → name or alias in text → email domain in text → WhatsApp number in text.
 * Returns null when nothing matches; the caller sends it to review with a client picker.
 */
export function resolveClientFromText(text: string, clients: Client[]): { client: Client; how: string } | null {
  const t = norm(text);
  const candidates = clients.filter((c) => c.scope === "client");

  // 1. "Clinic X: ..." or "[Clinic X] ..."
  const prefix = t.match(/^\[?([^:\]\n]{2,60})[\]:]/);
  if (prefix) {
    const p = norm(prefix[1]);
    for (const c of candidates) {
      if (p === norm(c.name) || p === norm(c.id) || (c.aliases ?? []).some((a) => norm(a) === p)) return { client: c, how: "prefix" };
    }
  }

  // 2. name or alias anywhere (longest match wins, so "Clinic X London" beats "Clinic X")
  let best: { client: Client; len: number } | null = null;
  for (const c of candidates) {
    for (const name of [c.name, ...(c.aliases ?? [])]) {
      const n = norm(name);
      if (n.length >= 3 && t.includes(n) && (!best || n.length > best.len)) best = { client: c, len: n.length };
    }
  }
  if (best) return { client: best.client, how: "name" };

  // 3. an email address whose domain belongs to a client
  for (const m of t.matchAll(/[\w.+-]+@([\w-]+\.[\w.-]+)/g)) {
    const domain = m[1].replace(/[>.,;)]+$/, "");
    const c = candidates.find((x) => x.emailDomains.some((d) => domain === d || domain.endsWith("." + d)));
    if (c) return { client: c, how: "email_domain" };
  }

  // 4. a phone number that matches a WhatsApp number (compare last 9 digits)
  for (const m of t.matchAll(/\+?\d[\d\s().-]{7,}\d/g)) {
    const d = digits(m[0]);
    if (d.length < 9) continue;
    const c = candidates.find((x) => x.whatsappNumbers.some((n) => digits(n).endsWith(d.slice(-9))));
    if (c) return { client: c, how: "whatsapp_number" };
  }

  return null;
}

/** Strip a leading "Client:" prefix so the model doesn't treat the label as part of the ask. */
export function stripClientPrefix(text: string, client: Client): string {
  const names = [client.name, client.id, ...(client.aliases ?? [])].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return text.replace(new RegExp(`^\\s*\\[?(?:${names.join("|")})\\]?\\s*:\\s*`, "i"), "");
}

export function scopeFor(client: Client | null): Scope {
  return client ? client.scope : "unknown";
}
