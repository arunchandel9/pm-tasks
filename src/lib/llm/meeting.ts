import { z } from "zod";
import { structuredCall } from "./client";

/**
 * One call per meeting: sort everything said into four buckets and name the client for each item.
 * Actions then go through the normal extract/classify pipeline per client; ideas and decisions are stored.
 */
export const MeetingSchema = z.object({
  meeting_client: z.string().nullable().describe("The client this meeting was mainly about, by name from the list, or 'MangoEyes' for an internal meeting, or null if unclear"),
  summary: z.array(z.string()).describe("2–5 bullet points: what the meeting was about and what was agreed"),
  items: z.array(z.object({
    kind: z.enum(["action", "idea", "decision", "discussion"]).describe("action = someone has to do something; idea = a suggestion or future plan, not yet agreed; decision = something agreed that changes how work is done; discussion = talked about, nothing to do"),
    text: z.string().describe("One sentence, plain, in the speaker's words as far as possible"),
    client: z.string().nullable().describe("Client name from the list this item belongs to, 'MangoEyes' for the agency itself, or null if unclear"),
    owner: z.string().nullable().describe("Who is to do it, if said"),
    side: z.enum(["agency", "client"]).describe("Who does it: agency = a MangoEyes person, 'we', 'the team' (the agency does the marketing, website, content, design, ads, reporting, scheduling and sending); client = someone on the client's side (signing, granting access, sending materials or photos, confirming dates, providing people, deciding). For ideas, decisions and discussion use agency."),
    due: z.string().nullable().describe("Any timing mentioned, verbatim"),
  })),
});
export type MeetingSort = z.infer<typeof MeetingSchema>;

const INSTRUCTIONS = `You read the notes of one meeting at a digital marketing agency (MangoEyes: websites, content, design, SEO, ads, CRM automations, video for aesthetic clinics).
Sort what was said into items. Each item is exactly one of: action (someone must do something), idea (a suggestion or future plan, not agreed), decision (agreed, changes how work is done), discussion (nothing to do).
Name the client for each item from the client list. Anything the agency does for or about a client (their site, content, ads, videos, transition, offboarding, reporting) belongs to that client, even when a MangoEyes person does the work. "MangoEyes" is only for the agency's own business: hiring, pay, its own website and marketing, internal process, tools. If the meeting is about one client, default that client for actions unless an item is clearly about another. Only null when no client fits.
For every action say whose side does it. The message lists the MangoEyes team by name: those people, the organiser, and anyone called "our team" or "we" are the agency. Every other person named in the notes (the clinic's owner, doctors, managers, staff) is the client, whatever their role sounds like. When no owner is named, judge by the work: the agency builds, writes, designs, runs ads, reports, schedules and sends; the client signs, approves, grants access, shares materials, confirms dates and answers questions. Only the agency's actions become tasks; the client's are listed for the team to chase.
Do not merge separate actions. Do not invent items that are not in the notes. Keep every item to one sentence. Output only the fields.`;

export async function sortMeeting(opts: { title: string; notes: string; attendees: string[]; team?: string[]; clients: string[] }): Promise<MeetingSort> {
  const user = [
    `Meeting: ${opts.title}`,
    `Attendees: ${opts.attendees.join(", ") || "(unknown)"}`,
    `MangoEyes team (everyone else named in the notes is on the client's side): ${opts.team?.length ? opts.team.join(", ") : "anyone with a mangoeyesagency.com address"}`,
    `Clients (name; aliases): ${opts.clients.join(" | ")}`,
    "",
    "Notes:",
    opts.notes.slice(0, 16000), // long notes are cut: the summary and action list sit at the top of a Gemini doc, the transcript detail below
  ].join("\n");
  return structuredCall({ step: "meeting", instructions: INSTRUCTIONS, userContent: user, schema: MeetingSchema, maxTokens: 3000, messageId: null }); // llm_calls.message_id references messages; meetings are logged without one
}
