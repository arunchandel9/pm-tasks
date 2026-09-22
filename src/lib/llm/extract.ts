import { z } from "zod";
import { structuredCall } from "./client";

/**
 * Every ask in a message is exactly one of five things (Arun, 2026-09-22):
 *   task     someone on the MangoEyes team has to produce something (a page change, design, ad, automation, content, video, report)
 *   reminder the sender asks to be reminded or to chase something later ("remind me tomorrow", "follow up on Friday")
 *   idea     a suggestion or future plan, not agreed, nothing to do now
 *   rule     a standing instruction on how to work with this client ("ask my permission before changing durations")
 *   note     information, an update, scheduling, access or logins, a link or material shared, something the client will do, conversation
 * Only a task can become a card, and only after a person confirms it.
 */
export const AskKind = z.enum(["task", "reminder", "idea", "rule", "note"]);
export type AskKindT = z.infer<typeof AskKind>;

export const ExtractSchema = z.object({
  summary: z.array(z.string()).describe("2–5 bullet points, plain language, what the sender wants"),
  asks: z.array(
    z.object({
      kind: AskKind.describe("task: a MangoEyes person must produce something; reminder: the sender wants to be reminded or to chase later; idea: a suggestion, not agreed; rule: a standing instruction on how to work with this client; note: information, scheduling, access, a link, the client's own to-do, or conversation"),
      ask: z.string().describe("One distinct item in one sentence"),
      quote: z.string().describe("The sender's exact words that support it"),
      deadline: z.string().nullable().describe("Any date or timing mentioned for a task, verbatim, else null"),
      urgent: z.boolean().describe("true when the sender says this item is urgent in any plain way: urgent, asap, today, within 24 hours, critical, site down"),
      remind_at: z.string().nullable().describe("For a reminder: the timing the sender gave, verbatim ('tomorrow', 'Friday', 'next week'), else null"),
      owner: z.string().nullable().describe("A MangoEyes team member named to do it (e.g. '@Anuj can you…'), else null"),
      urls: z.array(z.string()).describe("URLs mentioned for this item"),
    })
  ),
  is_request: z.boolean().describe("true when at least one item is a task"),
  tone: z.enum(["neutral", "unhappy", "urgent"]).describe("unhappy: the sender is displeased, complaining or frustrated (\"too little too late\", \"this is unacceptable\"); urgent: they say it is urgent; else neutral"),
  needs_reply: z.boolean().describe("true when the sender is waiting for an answer from the agency: a question, a request, a complaint, an update they want confirmed. false when the message closes the exchange: thanks, \"done\", \"received\", \"perfect, that works now\", \"ok noted\""),
});
export type Extraction = z.infer<typeof ExtractSchema>;

const INSTRUCTIONS = `You read one message sent to a digital marketing agency (MangoEyes: websites, content, design, SEO, paid ads, CRM automations, video for clinics) by a client or a team member.
Split it into distinct items and give each one exactly one kind:
- task: a MangoEyes person has to produce something: change a page, write content, design a graphic, run or change an ad, build an automation, edit a video, prepare a report. A stated problem is a task ("the Book Now button is not working" means fix it).
- reminder: the sender asks to be reminded or to chase something later ("remind me tomorrow if he hasn't replied", "follow up with the GP on Friday").
- idea: a suggestion or future plan that is not agreed and needs no work now ("we should do a CryoPen video at some point").
- rule: a standing instruction on how to work with this client ("next time ask my permission before changing appointment durations", "always check landing pages before they go out").
- note: everything else: information, an update, a thank-you, a question in a conversation, scheduling ("move our meeting to Thursday"), access and logins granted or pending, a link or material shared ("look at this video", "photos added to Drive"), something the client will do themselves, feedback with nothing to change.
Edits to the same page or the same deliverable are ONE task, listed as bullets in its sentence, not several tasks. Never split a single piece of work by sentence.
Quote the sender's exact words for each item. Do not invent items that are not in the text.
A "Subject:" line is context only. Text after "Earlier in this thread (context only, not the ask):" is the earlier conversation: use it to understand what the latest message refers to, but never take an item from it.
When the latest message is a short reaction ("too little too late", "still not fixed"), say in summary what it reacts to, using the earlier thread.
Set tone=unhappy when the sender is displeased, even in one short line; that matters more than finding a task.
Set urgent=true on an item only when the sender says so in plain words (urgent, asap, today, within 24 hours, critical, down).
Set needs_reply=false only when nothing in the message waits for an answer (thanks, confirmation that something is done, "noted").
Be literal and brief. No advice, no extra commentary.
When the message is a voice-note transcript: words may be misheard. Keep to ONE item unless the speaker clearly lists separate things.
Never add details (colours, versions, dates, counts) that are not in the words. When unsure what was meant, keep the item general ("fix the homepage images") rather than specific.`;

export async function extract(opts: { text: string; channel: string; clientName: string | null; messageId: string | null; voice?: boolean; knownNames?: string[]; senderIsStaff?: boolean }): Promise<Extraction> {
  const user = [
    `Channel: ${opts.channel}${opts.voice ? " (voice-note transcript, may contain misheard words)" : ""}`,
    `Sender: ${opts.senderIsStaff ? "a MangoEyes team member" : "the client"}`,
    ...(opts.voice && opts.knownNames?.length ? [`Names the speaker may have said (possibly misheard): ${opts.knownNames.join(", ")}`] : []),
    `Client: ${opts.clientName ?? "unknown"}`,
    "",
    "Message:",
    opts.text,
  ].join("\n");
  const out = await structuredCall({ step: "extract", instructions: INSTRUCTIONS, userContent: user, schema: ExtractSchema, maxTokens: 4000, messageId: opts.messageId });
  // A client cannot set a reminder for the team: what they say they will chase is a note. Only a team member's "remind me" is a reminder.
  if (!opts.senderIsStaff) for (const a of out.asks) if (a.kind === "reminder") a.kind = "note";
  out.is_request = out.asks.some((a) => a.kind === "task");
  return out;
}
