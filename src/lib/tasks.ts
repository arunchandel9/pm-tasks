import { sql, enqueue } from "./db";
import { pulp } from "./pulp";
import { boards as boardsConfig } from "./config";
import { insertTaskRow, sheetsConfigured, findClientTab } from "./sheets";
import { ruleFor } from "./route";
import type { Client, Draft, Message, RouteDecision } from "./types";

export interface TaskRow { id: string; pulpCardId: string | null; boardId: string | null }

/**
 * Where a new card waits for a person: "Staging" for ordinary asks, "Needs scope" for gated types (new page, new feature).
 * Both are hold lists: dragging the card out of either is the approval.
 */
export function holdListName(route: { gated: boolean; list: string | null; staging: string | null }): string {
  return route.gated ? route.list ?? "Needs scope" : route.staging ?? "Staging";
}

/** "Slack, Dr Mehta" / "Task Hub, Priya" (DM with the app) / "/task, Priya" — the origin stamped into the sheet's Comments cell. */
export function sourceText(channel: string, sender: string): string {
  const where = { slack: "Slack", intake: "Task Hub", email: "Email", task_cmd: "/task", meet: "Meeting" }[channel] ?? channel;
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
        boardId, listId, title: p.draft.title, description, labels: [...(p.client?.name ? [p.client.name] : []), ...p.draft.labels],
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
    boardId, listId, title: String(x.title), description, labels: [...(x.client_name ? [String(x.client_name)] : []), ...(draft.labels ?? []), String(x.priority)],
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
    select t.id as task_id, t.pulp_card_id, t.board_id, t.title, t.priority, r.department, r.request_type, r.client_id, r.decided_by,
           c.name as client_name, c.boards, c.sheet_tab, m.channel, m.permalink, m.sender
    from requests r
    left join tasks t on t.request_id = r.id
    left join clients c on c.id = r.client_id
    join messages m on m.id = r.message_id
    where r.id = ${requestId}`;
  if (!rows.length) throw new Error("request not found");
  const x = rows[0];

  // A retry keeps the original approver; only a real decision overwrites decided_by.
  const approver = decidedBy.startsWith("system:") && x.decided_by ? String(x.decided_by) : decidedBy;
  await sql()`update requests set status = 'approved', decided_by = ${approver}, decided_at = coalesce(decided_at, now()) where id = ${requestId}`;

  if (opts.moveCard !== false && x.task_id && x.pulp_card_id && pulp.configured()) {
    const boards = (x.boards ?? {}) as Client["boards"];
    const target = boards[x.department as string];
    const listId = target ? await pulp.ensureList(x.board_id as string, target.list) : null;
    if (listId) {
      await pulp.moveCard(x.pulp_card_id as string, listId);
      await sql()`update tasks set staging = false, list_id = ${listId}, last_moved_at = now() where id = ${x.task_id}`;
      await sql()`insert into status_events (task_id, from_list, to_list, source) values (${x.task_id}, 'Staging', ${target!.list}, 'slack')`;
    }
  }

  if (x.task_id && sheetsConfigured()) {
    try {
      const client = x.client_id ? { id: String(x.client_id), name: String(x.client_name ?? x.client_id), sheetTab: x.sheet_tab as string | null } as Client : null;
      const tab = await findClientTab(client);
      if (!tab) throw new Error(`no tab for ${client?.name ?? "Internal"} in the PM sheet`);
      const t = (await sql()`select due_at, assignee, priority from tasks where id = ${x.task_id}`)[0];
      const r = await insertTaskRow(tab, {
        title: String(x.title), department: String(x.department), priority: String(t?.priority ?? "P3"), assignee: String(t?.assignee ?? ""),
        pulp_link: x.pulp_card_id ? pulp.cardUrl(String(x.board_id), String(x.pulp_card_id)) : "",
        source_link: String(x.permalink ?? ""), created: new Date(), due: t?.due_at ? new Date(t.due_at as string) : null,
        addedBy: approver, source: sourceText(String(x.channel), String(x.sender ?? "")),
      });
      await sql()`update tasks set sheet_row = ${r.row} where id = ${x.task_id}`;
      await sql()`insert into settings (key, value) values (${"sheet_tab:" + x.task_id}, ${JSON.stringify(tab)}::jsonb) on conflict (key) do update set value = excluded.value`;
    } catch (e) {
      await enqueue("sync_sheet", { taskId: x.task_id }, 120);
      console.error("sheet append failed, queued:", (e as Error).message);
    }
  }

  await sql()`update requests set status = 'created' where id = ${requestId} and ${!!x.task_id}`;
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
