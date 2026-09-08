import type { NoiseConfig } from "../types";

export interface NoiseVerdict {
  skip: boolean;
  reason: string | null;
}

const EMOJI_OR_PUNCT = /^[\s\p{P}\p{S}\p{Emoji_Presentation}\p{Extended_Pictographic}]*$/u;

/**
 * True when the text is only an acknowledgement ("thanks!", "ok 👍", "thank you so much 🙏").
 * Rule: after stripping emoji and punctuation, every word is in the ack vocabulary and there are
 * at most 6 words. A real ask always contains a word outside that vocabulary.
 */
export function isAcknowledgement(text: string, cfg: NoiseConfig): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return true;
  if (EMOJI_OR_PUNCT.test(t)) return true;
  const words = t.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 6) return false;
  const vocab = new Set<string>(cfg.ack_words.map((w) => w.toLowerCase()));
  for (const a of cfg.acknowledgements) for (const w of a.toLowerCase().split(/\s+/)) vocab.add(w);
  return words.every((w) => vocab.has(w));
}

export interface SlackNoiseInput {
  subtype?: string;
  botId?: string;
  text: string;
  senderIsStaff: boolean;
  isIntakeChannel: boolean;
  isThreadReply: boolean;
  threadRootIsRequest: boolean;
  hasFilesOnly: boolean;
}

/** Slack rules from PLAN §4d. Runs before any model call. */
export function slackNoise(m: SlackNoiseInput, cfg: NoiseConfig): NoiseVerdict {
  if (m.botId) return { skip: true, reason: "bot_message" };
  if (m.subtype && cfg.slack_skip_subtypes.includes(m.subtype)) return { skip: true, reason: `subtype:${m.subtype}` };
  if (m.senderIsStaff && !m.isIntakeChannel) return { skip: true, reason: "staff_outside_intake" };
  if (m.hasFilesOnly) return { skip: false, reason: "attachment_only" }; // goes to review, no model call
  const text = m.text.trim();
  if (text.length < cfg.min_chars) return { skip: true, reason: "too_short" };
  if (isAcknowledgement(text, cfg)) return { skip: true, reason: "acknowledgement" };
  if (m.isThreadReply && m.threadRootIsRequest && text.length < cfg.thread_reply_followup_min_chars) {
    return { skip: false, reason: "thread_followup" }; // attaches to the existing request, no model call
  }
  return { skip: false, reason: null };
}

export interface EmailNoiseInput {
  from: string;
  fromIsStaff: boolean;
  isForward: boolean;
  headers: Record<string, string>;
  text: string;
}

export function emailNoise(m: EmailNoiseInput, cfg: NoiseConfig): NoiseVerdict {
  const from = m.from.toLowerCase();
  const allow = cfg.email_allow_senders.some((s) => from.includes(s.toLowerCase()));
  if (!allow) {
    if (m.fromIsStaff && !m.isForward) return { skip: true, reason: "staff_outgoing" };
    if (cfg.email_skip_senders.some((s) => from.includes(s.toLowerCase()))) return { skip: true, reason: "automated_sender" };
    const h = Object.fromEntries(Object.entries(m.headers).map(([k, v]) => [k.toLowerCase(), v.toLowerCase()]));
    if (h["auto-submitted"] && h["auto-submitted"] !== "no") return { skip: true, reason: "auto_submitted" };
    if (h["precedence"] === "bulk" || h["precedence"] === "list") return { skip: true, reason: "bulk_precedence" };
    if (h["list-unsubscribe"]) return { skip: true, reason: "newsletter" };
  }
  const text = stripQuotedHistory(m.text).trim();
  if (text.length < cfg.min_chars) return { skip: true, reason: "too_short" };
  if (isAcknowledgement(text, cfg)) return { skip: true, reason: "acknowledgement" };
  return { skip: false, reason: null };
}

/** Keep only the newest part of a reply/forward chain. Cuts 60–90% of tokens on long threads. */
export function stripQuotedHistory(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const l = line.trim();
    if (/^On .{5,120} wrote:$/.test(l)) break;
    if (/^-{2,}\s*(Original|Forwarded) message\s*-{2,}$/i.test(l)) break;
    if (/^From:\s.+/.test(l) && out.length > 0) break;
    if (/^>{1}/.test(l)) continue;
    out.push(line);
  }
  return out.join("\n");
}
