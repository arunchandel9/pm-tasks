import { sql, enqueue } from "./db";
import { pulp } from "./pulp";
import { boards as boardsConfig } from "./config";
import { insertTaskRow, sheetsConfigured, findClientTab } from "./sheets";
import { ruleFor } from "./route";
import type { Client, Draft, Message, RouteDecision } from "./types";

export interface TaskRow { id: string; pulpCardId: string | null; boardId: string | null }

/** Every card the hub creates carries this label, so hub cards can be told from hand-made ones on any board. Created on a board if missing. */
export const HUB_LABEL = "Task Hub";

/**
 * The department a board belongs to, from boards.yaml: the first department (in file order, `scope` aside) whose board
 * resolves to this id. `general` comes before `internal`, so the PMs board reads as general.
 */
export function pickDepartment(boardId: string, entries: Array<[dep: string, boardId: string | null]>): string | null {
  const want = boardId.toLowerCase();
  for (const [dep, id] of entries) if (dep !== "scope" && id && id.toLowerCase() === want) return dep;
  return null;
}

let boardMapCache: { at: number; entries: Array<[string, string | null]> } | null = null;
/** boards.yaml departments with their board ids resolved in Pulp; cached five minutes (boards are renamed weekly, not moved). */
async function boardMap(): Promise<Array<[string, string | null]>> {
  if (boardMapCache && Date.now() - boardMapCache.at < 300_000) return boardMapCache.entries;
  const entries: Array<[string, string | null]> = [];
  for (const [dep, d] of Object.entries(boardsConfig().departments)) {
    let id: string | null = null;
    try { id = pulp.configured() ? await pulp.resolveBoardId(d.board) : null; } catch { id = null; }
    entries.push([dep, id]);
  }
  boardMapCache = { at: Date.now(), entries };
  return entries;
}

export async function departmentForBoard(boardId: string | null | undefined): Promise<string | null> {
  return boardId ? pickDepartment(boardId, await boardMap()) : null;
}

/**
 * A board whose cards get no sheet row from the hub (`sheet: manual` in boards.yaml: the PMs board). The PM adds the
 * row by hand when wanted; from then on Status follows the card. Moving the card to any other board writes the row.
 */
export async function sheetIsManual(boardId: string | null | undefined): Promise<boolean> {
  if (!boardId) return false;
  const manual = new Set(Object.entries(boardsConfig().departments).filter(([, d]) => d.sheet === "manual").map(([dep]) => dep));
  if (!manual.size) return false;
  const want = boardId.toLowerCase();
  return (await boardMap()).some(([dep, id]) => manual.has(dep) && !!id && id.toLowerCase() === want);
}

/**
 * What one observed card move means. `approve`: the request was waiting in Staging and the drag decides it.
 * `writeRow`: the card has no sheet row yet and now sits on a board whose rows the hub writes.
 */
export function moveOutcome(p: { wasStaging: boolean; hasRow: boolean; manualBoard: boolean }): { approve: boolean; writeRow: boolean } {
  return { approve: p.wasStaging, writeRow: !p.manualBoard && !p.hasRow };
}

/**
 * Where a new card waits for a person: "Staging" for ordinary asks, "Needs scope" for gated types (new page, new feature).
 * Both are hold lists: dragging the card out of either is the approval.
 */
export function holdListName(route: { gated: boolean; list: string | null; staging: string | null }): string {
  return route.gated ? route.list ?? "Needs scope" : route.staging ?? "Staging";
}

/** "Slack, Dr Mehta" / "Task Hub, Priya" (DM with the app) / "/task, Priya" — the origin stamped into the sheet's Comments cell. */
export function sourceText(channel: string, sender: string): string {
  if (channel === "task_cmd" && /via Claude/i.test(sender)) return sender; // "Anuj via Claude-Arun"
  const where = { slack: "Slack", intake: "Task Hub", email: "Email", task_cmd: "Claude", meet: "Meeting" }[channel] ?? channel;
  return sender ? `${where}, ${sender}` : where;
}

/**
 * Shadow mode: a real card in the Staging list of the right board, plus the tasks row.
 * Approval (Slack button or drag out of Staging) moves it to the target list.
 * If Pulp is not configured yet, the tasks row is still created so nothing is lost.
 */
export async function createStagingCard(p: { requestId: string; client: Client | null; route: RouteDecision; draft: Draft; message: Message; quote: string }): Promise<TaskRow | null> {
  const description = [
    p.draft.description,
    "",
    `Original (${p.message.channel}, ${p.message.sender}):`,
    `> ${p.quote}`,
    p.message.permalink ? `Source: ${p.message.permalink}` : "",
    `Request: ${p.requestId}`,
  ].filter((l) => l !== "").join("\n");

  let pulpCardId: string | null = null;
  let listId: string | null = null;
  let boardId: string | null = p.route.board;
  if (pulp.configured() && p.route.board) {
    try {
      boardId = await pulp.resolveBoardId(p.route.board);
      if (!boardId) throw new Error(`board "${p.route.board}" not found in Pulp (is the API key's user a member?)`);
      listId = await pulp.ensureList(boardId, holdListName(p.route));
      const card = await pulp.createCard({
        // Department sprint boards hold every client's cards; the client label is how the team tells them apart.
        boardId, listId, title: p.draft.title, description, labels: [HUB_LABEL, ...(p.client?.name ? [p.client.name] : []), ...p.draft.labels],
        assignee: p.route.assignee, dueAt: p.route.dueAt,
      });
      pulpCardId = card.id;
    } catch (e) {
      await enqueue("create_card", { requestId: p.requestId }, 120);
      console.error("pulp create failed, queued:", (e as Error).message);
    }
  }

  const ins = await sql()`
    insert into tasks (request_id, client_id, pulp_card_id, board_id, list_id, title, priority, assignee, due_at, staging)
    values (${p.requestId}, ${p.client?.id ?? null}, ${pulpCardId}, ${boardId}, ${listId}, ${p.draft.title}, ${p.route.priority},
            ${p.route.assignee}, ${p.route.dueAt?.toISOString() ?? null}, true)
    returning id`;
  return { id: ins[0].id as string, pulpCardId, boardId };
}

/** A client's standing rules, newest first, printed on their cards. */
export async function rulesFor(clientId: string): Promise<string[]> {
  const rows = await sql()`select text from client_rules where client_id = ${clientId} order by said_at desc limit 8`;
  return rows.map((r) => String(r.text));
}

/** The card's description as the team reads it in Pulp: the draft, the original words, the source, the client's rules. */
export function cardDescription(p: { draft: Draft; quote: string; channel: string; sender: string; permalink: string | null; requestId: string; rules: string[] }): string {
  return [
    p.draft.description,
    "",
    `Original (${p.channel}, ${p.sender}):`,
    `> ${p.quote}`,
    p.permalink ? `Source: ${p.permalink}` : "",
    p.rules.length ? `\nClient rules:\n${p.rules.map((r) => `- ${r}`).join("\n")}` : "",
    `Request: ${p.requestId}`,
  ].filter((l) => l !== "").join("\n");
}

/**
 * Create card was tapped on a proposal (2026-09-22): the card goes straight to the department's To Do, assigned, with
 * the due date, and the sheet row is written at the same moment. No Staging, no drag.
 */
export async function createFromProposal(p: { requestId: string; department: string; assignee: string | null; priority: string; dueAt: Date | null; who: string }): Promise<{ taskId: string; cardId: string | null; link: string }> {
  const rows = await sql()`
    select r.id, r.client_id, r.quote, r.draft, c.name as client_name, c.boards, m.channel, m.sender, m.permalink
    from requests r left join clients c on c.id = r.client_id join messages m on m.id = r.message_id where r.id = ${p.requestId}`;
  if (!rows.length) throw new Error("request not found");
  const x = rows[0];
  const draft = (x.draft ?? {}) as Draft;
  const own = (x.boards ?? {}) as Record<string, { board?: string; list?: string; staging?: string }>;
  const def = boardsConfig().departments[p.department];
  const boardRef = own[p.department]?.board || def?.board;
  if (!boardRef) throw new Error(`no board for department "${p.department}"`);
  const listName = own[p.department]?.list || def?.list || "To Do";
  const rules = x.client_id ? await rulesFor(String(x.client_id)) : [];
  const description = cardDescription({ draft, quote: String(x.quote ?? ""), channel: String(x.channel), sender: String(x.sender ?? ""), permalink: (x.permalink as string | null) ?? null, requestId: p.requestId, rules });
  const labels = [HUB_LABEL, ...(x.client_name ? [String(x.client_name)] : []), ...(draft.labels ?? []).filter((l) => !/^P[123]$/.test(l)), p.priority];

  let cardId: string | null = null, boardId: string | null = null, listId: string | null = null;
  if (pulp.configured()) {
    boardId = await pulp.resolveBoardId(boardRef);
    if (!boardId) throw new Error(`board "${boardRef}" not found in Pulp`);
    listId = await pulp.ensureList(boardId, listName);
    const card = await pulp.createCard({ boardId, listId, title: draft.title, description, labels, assignee: p.assignee, dueAt: p.dueAt });
    cardId = card.id;
  }
  const ins = await sql()`
    insert into tasks (request_id, client_id, pulp_card_id, board_id, list_id, title, priority, assignee, due_at, staging, department, last_moved_at)
    values (${p.requestId}, ${x.client_id ?? null}, ${cardId}, ${boardId}, ${listId}, ${draft.title}, ${p.priority}, ${p.assignee}, ${p.dueAt?.toISOString() ?? null}, false, ${p.department}, now())
    returning id`;
  const taskId = String(ins[0].id);
  await sql()`update requests set status = 'created', decided_by = ${p.who}, decided_at = now(), department = ${p.department}, priority = ${p.priority},
    proposal = coalesce(proposal, '{}'::jsonb) || ${JSON.stringify({ assignee: p.assignee, dueAt: p.dueAt?.toISOString() ?? null, department: p.department, priority: p.priority })}::jsonb where id = ${p.requestId}`;
  await sql()`insert into status_events (task_id, from_list, to_list, source) values (${taskId}, null, ${listId ?? listName}, 'hub')`;
  await writeSheetRow(taskId, p.who);
  return { taskId, cardId, link: cardId && boardId ? pulp.cardUrl(boardId, cardId) : "" };
}

/** Retry path: a task whose hold card (Staging / Needs scope) was never created. Creates it now; never approves anything. */
export async function createCardForTask(taskId: string): Promise<boolean> {
  if (!pulp.configured()) return false;
  const rows = await sql()`
    select t.id, t.pulp_card_id, t.board_id, t.title, t.priority, t.assignee, t.due_at, r.department, r.request_type, r.quote, r.draft, c.name as client_name, c.boards, m.channel, m.sender, m.permalink
    from tasks t join requests r on r.id = t.request_id left join clients c on c.id = t.client_id left join messages m on m.id = r.message_id
    where t.id = ${taskId} and t.pulp_card_id is null and t.origin = 'hub'`;
  if (!rows.length) return false;
  const x = rows[0];
  const draft = (x.draft ?? {}) as { description?: string; labels?: string[] };
  const own = (x.boards ?? {}) as Record<string, { board?: string; list?: string; staging?: string }>;
  const gated = !!ruleFor(String(x.request_type ?? ""))?.gated;
  const dep = gated ? "scope" : String(x.department);
  const boardRef = own[dep]?.board || boardsConfig().departments[dep]?.board || own[String(x.department)]?.board || boardsConfig().departments[String(x.department)]?.board || String(x.board_id ?? "");
  const boardId = await pulp.resolveBoardId(boardRef);
  if (!boardId) throw new Error(`board "${boardRef}" not found for ${dep}`);
  const holdList = gated ? own.scope?.list || boardsConfig().departments.scope?.list || "Needs scope" : own[dep]?.staging || boardsConfig().departments[dep]?.staging || "Staging";
  const listId = await pulp.ensureList(boardId, holdList);
  const description = [draft.description ?? "", "", `Original (${x.channel}, ${x.sender}):`, `> ${x.quote ?? ""}`, x.permalink ? `Source: ${x.permalink}` : "", `(card created on retry)`].filter((l) => l !== "").join("\n");
  const card = await pulp.createCard({
    boardId, listId, title: String(x.title), description, labels: [HUB_LABEL, ...(x.client_name ? [String(x.client_name)] : []), ...(draft.labels ?? []), String(x.priority)],
    assignee: (x.assignee as string | null) ?? null, dueAt: x.due_at ? new Date(x.due_at as string) : null,
  });
  await sql()`update tasks set pulp_card_id = ${card.id}, board_id = ${boardId}, list_id = ${listId}, staging = true where id = ${taskId}`;
  return true;
}

/**
 * Approve: move the card out of Staging into the target list (unless the PM already dragged it somewhere:
 * moveCard=false), write the sheet row, mark the request created.
 */
export async function approveRequest(requestId: string, decidedBy: string, opts: { moveCard?: boolean } = {}): Promise<void> {
  const rows = await sql()`
    select t.id as task_id, t.pulp_card_id, t.board_id, coalesce(t.department, r.department) as department, r.decided_by, c.boards
    from requests r
    left join tasks t on t.request_id = r.id
    left join clients c on c.id = r.client_id
    where r.id = ${requestId}`;
  if (!rows.length) throw new Error("request not found");
  const x = rows[0];

  // A retry keeps the original approver; only a real decision overwrites decided_by.
  const approver = decidedBy.startsWith("system:") && x.decided_by ? String(x.decided_by) : decidedBy;
  await sql()`update requests set status = 'approved', decided_by = ${approver}, decided_at = coalesce(decided_at, now()) where id = ${requestId}`;

  if (opts.moveCard !== false && x.task_id && x.pulp_card_id && pulp.configured()) {
    // The client's own board override, else the department's default list from boards.yaml.
    const boards = (x.boards ?? {}) as Client["boards"];
    const target = boards[x.department as string] ?? boardsConfig().departments[x.department as string];
    const listId = target ? await pulp.ensureList(x.board_id as string, target.list) : null;
    if (listId) {
      await pulp.moveCard(x.pulp_card_id as string, listId);
      await sql()`update tasks set staging = false, list_id = ${listId}, last_moved_at = now() where id = ${x.task_id}`;
      await sql()`insert into status_events (task_id, from_list, to_list, source) values (${x.task_id}, 'Staging', ${target!.list}, 'slack')`;
    }
  }

  if (x.task_id) await writeSheetRow(String(x.task_id), approver);

  await sql()`update requests set status = 'created' where id = ${requestId} and ${!!x.task_id}`;
}

/**
 * The sheet row for a hub task, written once: skipped when the task already has one (settings sheet_tab:<task>) or
 * while its card sits on a board whose rows are manual (the PMs board). A failure is queued for retry, never thrown.
 * Returns true only when a row was written now.
 */
export async function writeSheetRow(taskId: string, addedBy: string): Promise<boolean> {
  if (!sheetsConfigured()) return false;
  const rows = await sql()`
    select t.id as task_id, t.pulp_card_id, t.board_id, t.title, t.priority, t.assignee, t.due_at, coalesce(t.department, r.department) as department, r.client_id, r.decided_by,
           c.name as client_name, c.sheet_tab, m.channel, m.permalink, m.sender, tab.value as tab
    from tasks t
    join requests r on r.id = t.request_id
    left join clients c on c.id = t.client_id
    left join messages m on m.id = r.message_id
    left join settings tab on tab.key = 'sheet_tab:' || t.id::text
    where t.id = ${taskId} and t.origin = 'hub'`;
  if (!rows.length) return false;
  const x = rows[0];
  if (x.tab) return false;
  if (await sheetIsManual(x.board_id as string | null)) return false;
  const who = addedBy.startsWith("system:") && x.decided_by ? String(x.decided_by) : addedBy;
  try {
    const client = x.client_id ? { id: String(x.client_id), name: String(x.client_name ?? x.client_id), sheetTab: x.sheet_tab as string | null } as Client : null;
    const tab = await findClientTab(client);
    if (!tab) throw new Error(`no tab for ${client?.name ?? "Internal"} in the PM sheet`);
    const r = await insertTaskRow(tab, {
      title: String(x.title), department: String(x.department), priority: String(x.priority ?? "P3"), assignee: String(x.assignee ?? ""),
      pulp_link: x.pulp_card_id ? pulp.cardUrl(String(x.board_id), String(x.pulp_card_id)) : "",
      source_link: String(x.permalink ?? ""), created: new Date(), due: x.due_at ? new Date(x.due_at as string) : null,
      addedBy: who, source: sourceText(String(x.channel ?? ""), String(x.sender ?? "")),
    });
    await sql()`update tasks set sheet_row = ${r.row} where id = ${taskId}`;
    await sql()`insert into settings (key, value) values (${"sheet_tab:" + taskId}, ${JSON.stringify(tab)}::jsonb) on conflict (key) do update set value = excluded.value`;
    return true;
  } catch (e) {
    await enqueue("sync_sheet", { taskId }, 120);
    console.error("sheet append failed, queued:", (e as Error).message);
    return false;
  }
}

/**
 * A hub card that changed board: remember the board, re-derive the department from boards.yaml (the sheet's Department
 * cell and the target list follow it) and put the hub's labels back, since Pulp labels belong to a board.
 */
export async function cardChangedBoard(taskId: string, cardId: string, boardId: string, clientName: string | null): Promise<string | null> {
  const dep = await departmentForBoard(boardId);
  await sql()`update tasks set board_id = ${boardId}, department = coalesce(${dep}, department) where id = ${taskId}`;
  if (dep) await sql()`update requests r set department = ${dep} from tasks t where t.request_id = r.id and t.id = ${taskId}`;
  if (pulp.configured()) {
    for (const name of [HUB_LABEL, ...(clientName ? [clientName] : [])]) {
      try { await pulp.addLabel(boardId, cardId, name); } catch { /* label is a convenience; the move stands */ }
    }
  }
  return dep;
}

export async function dismissRequest(requestId: string, decidedBy: string): Promise<void> {
  await sql()`update requests set status = 'dismissed', decided_by = ${decidedBy}, decided_at = now() where id = ${requestId}`;
  const t = await sql()`select id, pulp_card_id from tasks where request_id = ${requestId}`;
  if (t.length && t[0].pulp_card_id && pulp.configured()) {
    try { await pulp.addComment(t[0].pulp_card_id as string, `Dismissed by ${decidedBy} (not a task).`); } catch { /* ignore */ }
  }
}

export async function mergeRequest(requestId: string, intoRequestId: string, decidedBy: string): Promise<void> {
  await sql()`update requests set status = 'merged', merged_into = ${intoRequestId}, decided_by = ${decidedBy}, decided_at = now() where id = ${requestId}`;
}
