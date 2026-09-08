import { createHash } from "node:crypto";
import { sql } from "./db";
import { noise } from "./config";

export function textHash(text: string): string {
  const norm = text.toLowerCase().replace(/\s+/g, " ").replace(/[^\p{L}\p{N} ]/gu, "").trim();
  return createHash("sha256").update(norm).digest("hex");
}

export type DedupeOutcome =
  | { kind: "new" }
  | { kind: "exact_duplicate"; requestId: string; taskId: string | null }
  | { kind: "likely_duplicate"; requestId: string; taskId: string | null; similarity: number }
  | { kind: "possible_duplicate"; requestId: string; taskId: string | null; similarity: number };

/**
 * Same client, same hash → exact. Same client, pg_trgm similarity above merge_at → likely.
 * Between review_at and merge_at → possible (goes to review). Below → new.
 */
export async function dedupe(clientId: string | null, text: string, hash: string): Promise<DedupeOutcome> {
  if (!clientId) return { kind: "new" };
  const cfg = noise();
  const days = cfg.duplicate_window_days;

  const exact = await sql()`
    select r.id as request_id, t.id as task_id
    from messages m
    join requests r on r.message_id = m.id
    left join tasks t on t.request_id = r.id
    where m.client_id = ${clientId} and m.text_hash = ${hash}
      and m.sent_at > now() - (${days} || ' days')::interval
      and r.status not in ('dismissed')
    order by m.sent_at desc limit 1`;
  if (exact.length) return { kind: "exact_duplicate", requestId: exact[0].request_id, taskId: exact[0].task_id };

  const sim = await sql()`
    select r.id as request_id, t.id as task_id, similarity(m.text, ${text}) as s
    from messages m
    join requests r on r.message_id = m.id
    left join tasks t on t.request_id = r.id
    where m.client_id = ${clientId}
      and m.sent_at > now() - (${days} || ' days')::interval
      and r.status not in ('dismissed')
      and (t.id is null or t.completed_at is null)
      and similarity(m.text, ${text}) >= ${cfg.similarity.review_at}
    order by s desc limit 1`;
  if (!sim.length) return { kind: "new" };
  const s = Number(sim[0].s);
  const base = { requestId: sim[0].request_id as string, taskId: (sim[0].task_id as string | null), similarity: s };
  return s >= cfg.similarity.merge_at ? { kind: "likely_duplicate", ...base } : { kind: "possible_duplicate", ...base };
}
