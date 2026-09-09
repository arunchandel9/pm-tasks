import { z } from "zod";
import { structuredCall } from "./client";

export const ClassifySchema = z.object({
  request_type: z.string().describe("One of the request type keys given in the system prompt"),
  department: z.enum(["dev", "content", "design", "seo", "automation", "video", "general", "internal"]),
  priority_hint: z.enum(["P1", "P2", "P3"]).describe("P1 only for revenue-affecting breakage; P3 default"),
  priority_reason: z.string().nullable(),
  confidence: z.number().min(0).max(1).describe("How sure you are of request_type and department"),
  confidence_reason: z.string().describe("One sentence"),
  same_as_open: z.number().nullable().describe("Index into the open-requests list if this is the same ask, else null"),
  same_as_kind: z.enum(["duplicate", "nudge", "change"]).nullable().describe("If same_as_open is set: duplicate = repeat; nudge = 'any update?'; change = alters the existing ask"),
  title: z.string().describe("Board card title, under 80 characters, starts with a verb"),
  description: z.string().describe("2–6 lines for the person doing the work. Include the quote and any URLs/deadline."),
  labels: z.array(z.string()),
});
export type Classification = z.infer<typeof ClassifySchema>;

const INSTRUCTIONS = `You classify one ask from a client (or team member) of a digital marketing agency (MangoEyes: websites, content, design, SEO, paid ads, CRM automations and onboarding, video production for clinics).
Pick exactly one request_type from the list in this prompt and the matching department.
Confidence is about request_type and department only. Be honest: 0.9+ means a PM would not change it; below 0.7 means a person should look.
If the open-requests list contains the same ask, set same_as_open to its index and say whether this is a duplicate, a nudge ("any update?"), or a change to it.
Draft a card: short verb-first title, a description a developer/writer/designer can act on, and labels.
Never address the client. Never promise anything. Output only the fields.`;

export async function classify(opts: {
  ask: string;
  quote: string;
  deadline: string | null;
  urls: string[];
  clientName: string | null;
  scope: string;
  channel: string;
  openRequests: Array<{ index: number; title: string; status: string }>;
  messageId: string | null;
}): Promise<Classification> {
  const open = opts.openRequests.length
    ? opts.openRequests.map((o) => `${o.index}. [${o.status}] ${o.title}`).join("\n")
    : "(none)";
  const user = [
    `Client: ${opts.clientName ?? "unknown"}  Scope: ${opts.scope}  Channel: ${opts.channel}`,
    `Ask: ${opts.ask}`,
    `Quote: "${opts.quote}"`,
    `Deadline mentioned: ${opts.deadline ?? "none"}`,
    `URLs: ${opts.urls.length ? opts.urls.join(", ") : "none"}`,
    "",
    "Open requests for this client (last 14 days):",
    open,
  ].join("\n");
  return structuredCall({ step: "classify", instructions: INSTRUCTIONS, userContent: user, schema: ClassifySchema, maxTokens: 1000, messageId: opts.messageId });
}
