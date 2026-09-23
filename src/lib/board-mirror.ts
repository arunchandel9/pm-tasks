import { sql, allClients } from "./db";
import { pulp, isDoneList, normList, type BoardCard } from "./pulp";
import { boards as boardsConfig } from "./config";
import { resolveClientFromText } from "./resolve";
import type { Client } from "./types";

/**
 * Every card on the department boards is known to the hub, sheet row or not (decision 2026-09-23: a PM asked Claude
 * about the HBOT videos on the Video Sprint board and the hub knew nothing, because it mirrors the sheet, not the
 * boards). Every five minutes each board is read in one call and the cards nobody else tracks (not made by the hub,
 * not linked in the sheet) are kept as tasks with origin 'board': title, list, labels, assignee, due date, and the
 * client when a label or the title says it. Reads only: nothing is written to Pulp or the sheet, and the hub's own
 * cards and the sheet-linked cards keep their own polls. A card that leaves the board is marked archived.
 */

export const MIRROR_EVERY_MIN = 5;
export const ARCHIVED_NOTE = "Archived or deleted in Pulp";
/** Pulp's board read is capped at 1000 cards; past that a missing card may only be beyond the cap, so nothing is archived. */
export const BOARD_READ_CAP = 1000;

export interface KnownCard { id: string; pulp_card_id: string; list_id: string | null; origin: string; title: string; completed_at: string | null; notes: string | null; labels?: string[] | null }
export interface MirrorPlan { insert: BoardCard[]; update: Array<{ id: string; card: BoardCard; moved: boolean; fromList: string | null }>; archive: string[] }

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** The client from a label ("HOH", "House Of Health") first, else from the title ("HOH - HBOT week 3"). */
export function clientFromCard(card: { title: string; labels: string[] }, clients: Client[]): string | null {
  const candidates = clients.filter((c) => c.scope === "client");
  for (const label of card.labels) {
    const l = norm(label);
    if (l.length < 2) continue;
    const hit = candidates.find((c) => l === norm(c.name) || l === norm(c.id) || (c.aliases ?? []).some((a) => norm(a) === l));
    if (hit) return hit.id;
  }
  return resolveClientFromText(card.title, clients)?.client.id ?? null;
}

/** "P1", "P1 Task", "p2 - important" all count; anything else is P3. */
export function priorityFromLabels(labels: string[]): "P1" | "P2" | "P3" {
  const set = new Set(labels.map((l) => l.trim().toUpperCase().match(/^P([123])\b/)?.[1] ?? ""));
  return set.has("1") ? "P1" : set.has("2") ? "P2" : "P3";
}

/** Pure diff of one board's cards against what the hub knows. Cards tracked by another origin are left to their own polls. */
export function planMirror(known: KnownCard[], cards: BoardCard[], capped = false): MirrorPlan {
  const byCard = new Map(known.map((k) => [k.pulp_card_id, k]));
  const plan: MirrorPlan = { insert: [], update: [], archive: [] };
  const seen = new Set<string>();
  for (const card of cards) {
    seen.add(card.id);
    const k = byCard.get(card.id);
    if (!k) { plan.insert.push(card); continue; }
    if (k.origin !== "board") continue;
    const moved = k.list_id !== card.listId;
    const changed = moved || k.title !== card.title || k.notes === ARCHIVED_NOTE || JSON.stringify(k.labels ?? []) !== JSON.stringify(card.labels);
    if (changed) plan.update.push({ id: k.id, card, moved, fromList: k.list_id });
  }
  if (!capped) for (const k of known) if (k.origin === "board" && !seen.has(k.pulp_card_id) && k.notes !== ARCHIVED_NOTE) plan.archive.push(k.id);
  return plan;
}

export interface MirrorReport { at: string; boards: Array<{ board: string; name: string; department: string; cards: number; capped: boolean; new: number; updated: number; archived: number }>; errors: string[]; sample: unknown; seconds: number }

/** The boards in boards.yaml, one entry per distinct board with the first department that names it. */
async function mirroredBoards(): Promise<Array<{ id: string; department: string }>> {
  const out: Array<{ id: string; department: string }> = [];
  for (const [dep, d] of Object.entries(boardsConfig().departments)) {
    if (dep === "scope") continue;
    const id = await pulp.resolveBoardId(d.board);
    if (id && !out.some((b) => b.id === id)) out.push({ id, department: dep });
  }
  return out;
}

export async function shouldMirror(now = new Date()): Promise<boolean> {
  const r = await sql()`select value->>'at' as at from settings where key = 'board_mirror_last'`;
  const at = r.length && r[0].at ? new Date(String(r[0].at)).getTime() : 0;
  return now.getTime() - at >= MIRROR_EVERY_MIN * 60_000 - 5_000;
}

export async function mirrorBoards(outOfTime: () => boolean = () => false): Promise<MirrorReport> {
  const started = Date.now();
  const report: MirrorReport = { at: new Date().toISOString(), boards: [], errors: [], sample: null, seconds: 0 };
  if (!pulp.configured()) return report;
  // Marked as started before any read: a run cut short by the function's time limit must not repeat every minute.
  // (First live run, 2026-09-23: one insert per card, hundreds of cards, ran past the minute and starved the tick.)
  try {
    await sql()`insert into settings (key, value) values ('board_mirror_last', ${JSON.stringify({ ...report, phase: "started" })}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`;
  } catch { /* ignore */ }
  const clients = await allClients();
  const names = new Map((await pulp.boards()).map((b) => [b.id, b.name]));
  for (const b of await mirroredBoards()) {
    if (outOfTime()) { report.errors.push(`stopped before ${names.get(b.id) ?? b.id}: out of time`); break; }
    try {
      const { cards, sample } = await pulp.boardCards(b.id);
      if (!report.sample) report.sample = sample;
      const capped = cards.length >= BOARD_READ_CAP;
      const lists = new Map((await pulp.listsOnBoard(b.id)).map((l) => [l.id, l.name]));
      const ids = cards.map((c) => c.id);
      const known = (await sql()`select id, pulp_card_id, list_id, origin, title, completed_at, notes, labels from tasks
        where pulp_card_id = any(${ids}::text[]) or (origin = 'board' and board_id = ${b.id})`) as unknown as KnownCard[];
      const plan = planMirror(known, cards, capped);
      const fields = (card: BoardCard) => {
        const listName = lists.get(card.listId) ?? "";
        return {
          clientId: clientFromCard(card, clients), listName, staging: normList(listName) === "staging", done: isDoneList(listName),
          priority: priorityFromLabels(card.labels), assignee: card.members[0] ?? null,
        };
      };
      // One statement per 300 cards: the first read of a board brings hundreds, and a round trip per card ran past the minute.
      const now = new Date().toISOString();
      for (let i = 0; i < plan.insert.length; i += 300) {
        const batch = plan.insert.slice(i, i + 300).map((card) => ({ card, f: fields(card) }));
        const col = (fn: (x: { card: BoardCard; f: ReturnType<typeof fields> }) => string | null) => batch.map(fn);
        await sql()`insert into tasks (request_id, client_id, pulp_card_id, board_id, list_id, title, priority, assignee, due_at, staging, created_at, completed_at, origin, sheet_key, department, labels, last_moved_at)
          select null, cl, c, ${b.id}, l, t, pr, a, d::timestamptz, s, cr::timestamptz, co::timestamptz, 'board', 'board:' || c, ${b.department}, string_to_array(lb, E'\\u0001'), lm::timestamptz
          from unnest(${col((x) => x.f.clientId)}::text[], ${col((x) => x.card.id)}::text[], ${col((x) => x.card.listId)}::text[], ${col((x) => x.card.title)}::text[], ${col((x) => x.f.priority)}::text[],
                      ${col((x) => x.f.assignee)}::text[], ${col((x) => x.card.dueAt)}::text[], ${batch.map((x) => x.f.staging)}::boolean[], ${col((x) => x.card.createdAt ?? now)}::text[], ${col((x) => x.f.done ? now : null)}::text[],
                      ${col((x) => x.card.labels.join("\u0001"))}::text[], ${col((x) => x.card.updatedAt ?? null)}::text[])
            as v(cl, c, l, t, pr, a, d, s, cr, co, lb, lm)
          on conflict (sheet_key) where sheet_key is not null do update set list_id = excluded.list_id, title = excluded.title, labels = excluded.labels`;
      }
      for (const u of plan.update) {
        const f = fields(u.card);
        await sql()`update tasks set list_id = ${u.card.listId}, board_id = ${b.id}, title = ${u.card.title}, labels = ${u.card.labels}::text[], priority = ${f.priority}, assignee = coalesce(${f.assignee}, assignee), due_at = ${u.card.dueAt},
          staging = ${f.staging}, client_id = coalesce(client_id, ${f.clientId}), department = coalesce(department, ${b.department}), notes = case when notes = ${ARCHIVED_NOTE} then null else notes end,
          completed_at = ${f.done ? new Date().toISOString() : null}, last_moved_at = case when ${u.moved} then now() else last_moved_at end where id = ${u.id}`;
        if (u.moved) await sql()`insert into status_events (task_id, from_list, to_list, source) values (${u.id}, ${u.fromList ?? "unknown"}, ${u.card.listId}, 'poll')`;
      }
      if (plan.archive.length) await sql()`update tasks set completed_at = coalesce(completed_at, now()), notes = ${ARCHIVED_NOTE} where id = any(${plan.archive}::uuid[])`;
      report.boards.push({ board: b.id, name: names.get(b.id) ?? b.id, department: b.department, cards: cards.length, capped, new: plan.insert.length, updated: plan.update.length, archived: plan.archive.length });
    } catch (e) { report.errors.push(`${names.get(b.id) ?? b.id}: ${(e as Error).message.slice(0, 160)}`); }
  }
  // A mirrored card that later gets a sheet row (the PM pastes its link) or turns out to be a hub card is tracked there from then on.
  try {
    const dup = await sql()`select t.id from tasks t where t.origin = 'board' and exists (select 1 from tasks o where o.pulp_card_id = t.pulp_card_id and o.origin <> 'board')`;
    if (dup.length) {
      const ids = dup.map((d) => String(d.id));
      await sql()`delete from status_events where task_id = any(${ids}::uuid[])`;
      await sql()`delete from tasks where id = any(${ids}::uuid[])`;
    }
  } catch (e) { report.errors.push(`dedupe: ${(e as Error).message.slice(0, 160)}`); }
  report.seconds = Math.round((Date.now() - started) / 100) / 10;
  try {
    await sql()`insert into settings (key, value) values ('board_mirror_last', ${JSON.stringify(report)}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`;
  } catch { /* ignore */ }
  return report;
}
