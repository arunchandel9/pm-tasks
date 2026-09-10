import { sql } from "./db";
import { pulp, isDoneList, normList } from "./pulp";
import { sheetsConfigured, sheetConfig, tabHeaders, tabRows, mapHeaders, updateTaskCells, moveRowBelowDivider } from "./sheets";

/**
 * Cards people create by hand in Pulp and link in the PM sheet themselves.
 * The sheet mirror (sheet-sync) already stores the card id of every open row that has a Pulp link. This checks those
 * cards in rotation (a bounded number per minute, oldest check first) and, when a card has moved to another list since
 * the hub last saw it, writes the new Status into the row; Done also fills Date Completed and moves the row below the
 * DONE divider. The first look at a card only records where it is (no write), so a PM's hand-typed status is never
 * overwritten unless the card actually moves. A card already in Done on first look is the one exception: the row is
 * closed, because that is exactly the case people forget.
 */

export type SheetCardAction = "baseline" | "skip" | "write";

/** Pure decision: what to do with one sheet-linked card. */
export function sheetCardAction(p: { lastListId: string | null; cardListId: string; done: boolean; sheetStatus: string | null; wanted: string }): SheetCardAction {
  if (p.lastListId === null) return p.done && normList(p.sheetStatus ?? "") !== normList(p.wanted) ? "write" : "baseline";
  if (p.cardListId === p.lastListId) return "skip";
  return normList(p.sheetStatus ?? "") === normList(p.wanted) ? "baseline" : "write";
}

const cardIdIn = (link: string) => link.match(/[?&]card=([0-9a-f-]{8,})/i)?.[1] ?? link.match(/\/card\/([0-9a-f-]{8,})/i)?.[1] ?? null;

/** Row number (1-based) whose Pulp link carries this card id, or null. One sheet read. */
export async function locateRowByCardId(tab: string, cardId: string): Promise<number | null> {
  const cfg = sheetConfig();
  const map = mapHeaders(await tabHeaders(tab), cfg);
  if (map.pulp_link === undefined) return null;
  const rows = await tabRows(tab);
  const want = cardId.toLowerCase();
  for (let i = cfg.header_row; i < rows.length; i++) {
    const id = cardIdIn((rows[i][map.pulp_link] ?? "").trim());
    if (id && id.toLowerCase() === want) return i + 1;
  }
  return null;
}

export interface SheetCardsReport { checked: number; baselined: number; written: number; closed: number; errors: string[] }

export async function pollSheetCards(limit = 40): Promise<SheetCardsReport> {
  const report: SheetCardsReport = { checked: 0, baselined: 0, written: 0, closed: 0, errors: [] };
  if (!pulp.configured() || !sheetsConfigured()) return report;
  const rows = await sql()`
    select id, pulp_card_id, board_id, list_id, title, sheet_tab, sheet_row, sheet_status
    from tasks where origin = 'sheet' and pulp_card_id is not null and sheet_tab is not null and completed_at is null
    order by pulp_checked_at asc nulls first, created_at desc limit ${limit}`;
  for (const t of rows) {
    await sql()`update tasks set pulp_checked_at = now() where id = ${t.id}`;
    let card: Awaited<ReturnType<typeof pulp.getCard>>;
    try { card = await pulp.getCard(String(t.pulp_card_id)); report.checked++; }
    catch (e) {
      const msg = (e as Error).message;
      if (!/→ 404/.test(msg)) report.errors.push(`${String(t.title).slice(0, 40)}: ${msg.slice(0, 120)}`);
      continue; // 404: archived or deleted in Pulp; the row stays as the PM left it
    }
    const listName = card.listName ?? (await pulp.listsOnBoard(card.boardId)).find((l) => l.id === card.listId)?.name ?? card.listId;
    const done = isDoneList(listName);
    const wanted = done ? sheetConfig().stage_values.done : listName;
    const action = sheetCardAction({ lastListId: (t.list_id as string | null) ?? null, cardListId: card.listId, done, sheetStatus: (t.sheet_status as string | null) ?? null, wanted });
    if (action === "skip") continue;
    if (action === "baseline") {
      await sql()`update tasks set list_id = ${card.listId}, board_id = coalesce(board_id, ${card.boardId}) where id = ${t.id}`;
      report.baselined++;
      continue;
    }
    try {
      const tab = String(t.sheet_tab);
      const row = (await locateRowByCardId(tab, String(t.pulp_card_id))) ?? (t.sheet_row ? Number(t.sheet_row) : null);
      if (!row) { report.errors.push(`row not found for ${String(t.title).slice(0, 40)} in ${tab}`); continue; }
      await updateTaskCells(tab, row, { stage: wanted, completed: done ? new Date() : undefined });
      const finalRow = done ? await moveRowBelowDivider(tab, row) : row;
      await sql()`update tasks set list_id = ${card.listId}, board_id = coalesce(board_id, ${card.boardId}), sheet_status = ${wanted}, sheet_row = ${finalRow},
                  completed_at = ${done ? new Date().toISOString() : null}, last_moved_at = now() where id = ${t.id}`;
      await sql()`insert into status_events (task_id, from_list, to_list, source) values (${t.id}, ${(t.list_id as string | null) ?? "unknown"}, ${card.listId}, 'poll')`;
      report.written++;
      if (done) report.closed++;
    } catch (e) { report.errors.push(`sheet ${String(t.title).slice(0, 40)}: ${(e as Error).message.slice(0, 160)}`); }
  }
  try {
    await sql()`insert into settings (key, value) values ('sheet_cards_last', ${JSON.stringify({ at: new Date().toISOString(), ...report })}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`;
  } catch { /* ignore */ }
  return report;
}
