import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { env, routingForPrompt } from "../config";
import { sql } from "../db";

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) _client = new Anthropic();
  return _client;
}

// First-party per-MTok prices for the cost line in the EOD summary. Cache read 0.1×, cache write 1.25×.
const PRICES: Record<string, { in: number; out: number }> = {
  "claude-opus-5": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

function cost(model: string, u: Anthropic.Usage): number {
  const p = PRICES[model] ?? PRICES["claude-opus-5"];
  const cr = u.cache_read_input_tokens ?? 0;
  const cw = u.cache_creation_input_tokens ?? 0;
  return (u.input_tokens * p.in + cr * p.in * 0.1 + cw * p.in * 1.25 + u.output_tokens * p.out) / 1_000_000;
}

/**
 * Shared request layout (PLAN §4e):
 *   system[0] static instructions        ← cache 1h
 *   system[1] routing table + client list ← cache 1h
 *   messages[0] the per-message context, after the breakpoint
 * Nothing volatile above the breakpoint. Config is rendered in fixed key order.
 */
export async function structuredCall<T extends z.ZodType>(opts: {
  step: "extract" | "classify";
  instructions: string;
  userContent: string;
  schema: T;
  maxTokens: number;
  messageId: string | null;
}): Promise<z.infer<T>> {
  const model = env.model();
  const started = Date.now();
  const res = await client().messages.parse({
    model,
    max_tokens: opts.maxTokens,
    system: [
      { type: "text", text: opts.instructions, cache_control: { type: "ephemeral", ttl: "1h" } },
      { type: "text", text: `Request types:\n${routingForPrompt()}`, cache_control: { type: "ephemeral", ttl: "1h" } },
    ],
    messages: [{ role: "user", content: opts.userContent }],
    output_config: { format: zodOutputFormat(opts.schema), effort: "low" },
  });
  const latency = Date.now() - started;

  await sql()`
    insert into llm_calls (step, model, message_id, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, cost_usd, latency_ms)
    values (${opts.step}, ${model}, ${opts.messageId}, ${res.usage.input_tokens},
            ${res.usage.cache_read_input_tokens ?? 0}, ${res.usage.cache_creation_input_tokens ?? 0},
            ${res.usage.output_tokens}, ${cost(model, res.usage)}, ${latency})`;

  if (res.stop_reason === "refusal") throw new Error(`model refused (${opts.step})`);
  if (!res.parsed_output) throw new Error(`model output did not match schema (${opts.step})`);
  return res.parsed_output;
}
