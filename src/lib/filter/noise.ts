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

/** "yes", "yeah, that's right", "correct 👍": a confirmation of the hub's suggestion (which client a voice note was for). */
export function isAffirmative(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();
  return /^(yes|yeah|yep|yup|ya|haan|correct|right|exactly|sure|ok|okay)( (yes|yeah|yep|correct|right|please|that'?s (right|it|correct|the one)|it is|please do|go ahead))*$/.test(t) || /^that'?s (right|it|correct|the one)$/.test(t);
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
  /** The intake address is in the To line: a person wrote to the hub on purpose (typed ask, shared voice note). */
  toIntake?: boolean;
  headers: Record<string, string>;
  text: string;
}

export function emailNoise(m: EmailNoiseInput, cfg: NoiseConfig): NoiseVerdict {
  const from = m.from.toLowerCase();
  const allow = cfg.email_allow_senders.some((s) => from.includes(s.toLowerCase()));
  if (!allow) {
    // Staff mail is "outgoing" (a reply to a client that copies the hub) only when it is neither a forward nor addressed to the hub.
    if (m.fromIsStaff && !m.isForward && !m.toIntake) return { skip: true, reason: "staff_outgoing" };
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
/**
 * Cut everything from the first sign of an earlier email: "On … wrote:", Gmail/Outlook separators, an Outlook header
 * block ("From:" / "*From:*" / "De:" then Sent/Date/To/Subject), or the Google Groups footer. Lines quoted with ">" go too.
 * Only what the sender wrote themselves survives: the hub must never read our own earlier mail as the client's ask.
 */
export function stripQuotedHistory(text: string): string {
  return splitQuotedHistory(text).latest;
}

/**
 * The sender's own words (`latest`) and the earlier thread they replied to (`history`, quote marks removed, capped).
 * History is context for understanding the latest message; asks are never taken from it.
 */
export function splitQuotedHistory(text: string, historyCap = 1500): { latest: string; history: string } {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  const headerLine = (l: string) => /^[*_\s]*(From|Sent|Date|To|Cc|Subject|De|Envoy[ée]|Para|Asunto)[*_\s]*:/i.test(l);
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (/^On .{5,160} wrote:\s*$/.test(l) || /^Le .{5,160} a écrit\s*:$/.test(l)) { cut = i; break; }
    if (/^-{2,}\s*(Original|Forwarded) message\s*-{2,}$/i.test(l)) { cut = i; break; }
    if (/^You received this message because you are subscribed to/i.test(l)) { cut = i; break; }
    // An Outlook-style quoted header: a From line followed within four lines by another header line.
    if (/^[*_\s]*From[*_\s]*:/i.test(l) && out.some((x) => x.trim()) && lines.slice(i + 1, i + 5).some((x) => headerLine(x.trim()))) { cut = i; break; }
    // A long rule (____ or ----) right before such a block is part of it.
    if (/^[_-]{5,}$/.test(l) && lines.slice(i + 1, i + 4).some((x) => /^[*_\s]*From[*_\s]*:/i.test(x.trim()))) { cut = i; break; }
    if (/^>/.test(l)) { cut = Math.min(cut, i); continue; }
    out.push(lines[i]);
  }
  const history = lines.slice(cut)
    .map((x) => x.replace(/^(\s*>)+\s?/, "").trimEnd())
    .filter((x) => !/^You received this message because|^To unsubscribe from this group|^To view this discussion|^[_-]{5,}$/i.test(x.trim()))
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { latest: out.join("\n"), history: history.length > historyCap ? history.slice(0, historyCap).trimEnd() + "…" : history };
}
