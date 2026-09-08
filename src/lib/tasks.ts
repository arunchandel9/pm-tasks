import { sql, enqueue } from "./db";
import { pulp } from "./pulp";
import { appendTaskRow, sheetsConfigured } from "./sheets";
import type { Client, Draft, Message, RouteDecision } from "./types";

export interface TaskRow { id: string; pulpCardId: string | null }

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
  if (pulp.configured() && p.route.board) {
    try {
      listId = await pulp.findListId(p.route.board, p.route.staging ?? "Staging");
      if (!listId) throw new Error(`no list "${p.route.staging ?? "Staging"}" on board ${p.route.board}`);
      const card = await pulp.createCard({
        boardId: p.route.board, listId, title: p.draft.title, description, labels: p.draft.labels,
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
    values (${p.requestId}, ${p.client?.id ?? null}, ${pulpCardId}, ${p.route.board}, ${listId}, ${p.draft.title}, ${p.route.priority},
            ${p.route.assignee}, ${p.route.dueAt?.toISOString() ?? null}, true)
    returning id`;
  return { id: ins[0].id as string, pulpCardId };
}

/** Approve: move the card out of Staging into the target list, write the sheet row, mark request created. */
export async function approveRequest(requestId: string, decidedBy: string): Promise<void> {
  const rows = await sql()`
    select t.id as task_id, t.pulp_card_id, t.board_id, t.title, t.priority, r.department, r.request_type, r.client_id,
           c.name as client_name, c.boards, m.channel, m.permalink
    from requests r
    left join tasks t on t.request_id = r.id
    left join clients c on c.id = r.client_id
    join messages m on m.id = r.message_id
    where r.id = ${requestId}`;
  if (!rows.length) throw new Error("request not found");
  const x = rows[0];

  await sql()`update requests set status = 'approved', decided_by = ${decidedBy}, decided_at = now() where id = ${requestId}`;

  if (x.task_id && x.pulp_card_id && pulp.configured()) {
    const boards = (x.boards ?? {}) as Client["boards"];
    const target = boards[x.department as string];
    const listId = target ? await pulp.findListId(x.board_id as string, target.list) : null;
    if (listId) {
      await pulp.moveCard(x.pulp_card_id as string, listId);
      await sql()`update tasks set staging = false, list_id = ${listId}, last_moved_at = now() where id = ${x.task_id}`;
      await sql()`insert into status_events (task_id, from_list, to_list, source) values (${x.task_id}, 'Staging', ${target!.list}, 'slack')`;
    }
  }

  if (x.task_id && sheetsConfigured()) {
    const tab = x.client_name ? String(x.client_name) : "Internal";
    const now = new Date().toISOString().slice(0, 10);
    try {
      const rowNum = await appendTaskRow(tab, {
        taskId: String(x.task_id).slice(0, 8), client: String(x.client_name ?? "Internal"), department: String(x.department),
        type: String(x.request_type), title: String(x.title), pulpLink: x.pulp_card_id ? `${process.env.PULP_BASE_URL?.replace(/\/api$/, "")}/cards/${x.pulp_card_id}` : "",
        source: String(x.channel), sourceLink: String(x.permalink ?? ""), created: now, stage: "To Do", lastMoved: now, completed: "",
      });
      await sql()`update tasks set sheet_row = ${rowNum} where id = ${x.task_id}`;
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
