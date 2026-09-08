import { z } from "zod";
import { structuredCall } from "./client";

export const ExtractSchema = z.object({
  summary: z.array(z.string()).describe("2–5 bullet points, plain language, what the sender wants"),
  asks: z.array(
    z.object({
      ask: z.string().describe("One distinct request in one sentence"),
      quote: z.string().describe("The sender's exact words that support this ask"),
      deadline: z.string().nullable().describe("Any date or timing mentioned, verbatim, else null"),
      urls: z.array(z.string()).describe("URLs mentioned for this ask"),
    })
  ),
  is_request: z.boolean().describe("false if this is only an update, thanks, or question with nothing to do"),
});
export type Extraction = z.infer<typeof ExtractSchema>;

const INSTRUCTIONS = `You read one message sent to a digital marketing agency (MangoEyes) by a client or a team member.
Split it into distinct asks. One message can contain several; each gets its own entry.
Quote the sender's exact words for each ask. Do not invent asks that are not in the text.
If the message contains no actionable ask (an update, thanks, or a pure question), set is_request=false and asks=[].
Be literal and brief. No advice, no extra commentary.`;

export async function extract(opts: { text: string; channel: string; clientName: string | null; messageId: string | null }): Promise<Extraction> {
  const user = [
    `Channel: ${opts.channel}`,
    `Client: ${opts.clientName ?? "unknown"}`,
    "",
    "Message:",
    opts.text,
  ].join("\n");
  return structuredCall({ step: "extract", instructions: INSTRUCTIONS, userContent: user, schema: ExtractSchema, maxTokens: 800, messageId: opts.messageId });
}
