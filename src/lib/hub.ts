import { sql, allClients } from "./db";
import { pulp } from "./pulp";

/**
 * Read-side of the hub: the questions PMs (and the daily summary) ask. Plain SQL, no model.
 * Used by the MCP server (/api/mcp/<key>) and by the end-of-day summary.
 */

export interface TaskRow {
  origin: string; sheetTab: string | null; notes: string | null;
  id: string; title: string; client: string | null; department: string | null; priority: string | null; status: string;
  staging: boolean; assignee: string | null; due: string | null; created: string; completed: string | null; lastMoved: string | null;
  pulpLink: string | null; sourceChannel: string | null; sourceLink: string | null; sender: string | null; waitingOnClientSince: string | null;
}

const listNameCache = new Map<string, string>();
async function listName(boardId: string | null, listId: string | null, staging: boolean, needsScope = false): Promise<string> {
  if (staging) return needsScope ? "Needs scope" : "Staging";
  if (!boardId || !listId) return "Unknown";
  const key = `${boardId}:${listId}`;
  const hit = listNameCache.get(key);
  if (hit) return hit;
  if (!pulp.configured()) return listId;
  try {
    const id = await pulp.resolveBoardId(boardId);
    const lists = id ? await pulp.listsOnBoard(id) : [];
    for (const l of lists) listNameCache.set(`${boardId}:${l.id}`, l.name);
    return listNameCache.get(key) ?? listId;
  } catch { return listId; }
}

export async function resolveClientId(ref: string | null | undefined): Promise<string | null> {
  if (!ref) return null;
  const r = ref.trim().toLowerCase();
  const clients = await allClients();
  const c = clients.find((x) => x.id.toLowerCase() === r || x.name.toLowerCase() === r || (x.aliases ?? []).some((a) => a.toLowerCase() === r))
    ?? clients.find((x) => x.name.toLowerCase().includes(r));
  return c?.id ?? null;
}

export interface TaskQuery { client?: string | null; status?: "open" | "done" | "overdue" | "waiting" | "staging" | "all"; department?: string | null; query?: string | null; days?: number | null; limit?: number | null }

export async function searchTasks(q: TaskQuery): Promise<TaskRow[]> {
  const clientId = await resolveClientId(q.client);
  if (q.client && !clientId) return [];
  const status = q.status ?? "open";
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const like = q.query ? `%${q.query.trim()}%` : null;
  const days = q.days ?? null;
  const rows = await sql()`
    select t.id, t.title, c.name as client, coalesce(r.department, t.department) as department, t.priority, t.staging, r.status as request_status, t.assignee, t.due_at, t.created_at, t.completed_at, t.last_moved_at,
           t.board_id, t.list_id, t.pulp_card_id, t.waiting_on_client_since, t.origin, t.sheet_status, t.sheet_tab, t.notes, m.channel, m.permalink, m.sender
    from tasks t
    left join clients c on c.id = t.client_id
    left join requests r on r.id = t.request_id
    left join messages m on m.id = r.message_id
    where (${clientId}::text is null or t.client_id = ${clientId})
      and (${q.department ?? null}::text is null or coalesce(r.department, t.department) = ${q.department ?? null})
      and (${like}::text is null or t.title ilike ${like} or r.summary ilike ${like} or r.quote ilike ${like})
      and (${days}::int is null or t.created_at > now() - (${days} || ' days')::interval)
      and case ${status}
            when 'open' then t.completed_at is null
            when 'done' then t.completed_at is not null
            when 'overdue' then t.completed_at is null and t.due_at < now() and t.staging = false
            when 'waiting' then t.completed_at is null and t.waiting_on_client_since is not null
            when 'staging' then t.staging = true and t.completed_at is null
            else true end
    order by case when t.priority = 'P1' then 0 when t.priority = 'P2' then 1 else 2 end, t.due_at nulls last, t.created_at desc
    limit ${limit}`;
  const out: TaskRow[] = [];
  for (const t of rows) {
    out.push({
      id: String(t.id), title: String(t.title), client: (t.client as string | null) ?? null, department: (t.department as string | null) ?? null,
      priority: (t.priority as string | null) ?? null,
      status: t.origin === "sheet" ? String(t.sheet_status ?? (t.completed_at ? "Done" : "Open")) : await listName(t.board_id as string | null, t.list_id as string | null, !!t.staging, t.request_status === "needs_scope"),
      origin: String(t.origin ?? "hub"), sheetTab: (t.sheet_tab as string | null) ?? null, notes: (t.notes as string | null) ?? null,
      staging: !!t.staging, assignee: (t.assignee as string | null) ?? null, due: t.due_at ? new Date(t.due_at as string).toISOString().slice(0, 10) : null,
      created: new Date(t.created_at as string).toISOString(), completed: t.completed_at ? new Date(t.completed_at as string).toISOString() : null,
      lastMoved: t.last_moved_at ? new Date(t.last_moved_at as string).toISOString() : null,
      pulpLink: t.pulp_card_id && t.board_id ? pulp.cardUrl(String(t.board_id), String(t.pulp_card_id)) : null,
      sourceChannel: (t.channel as string | null) ?? null, sourceLink: (t.permalink as string | null) ?? null, sender: (t.sender as string | null) ?? null,
      waitingOnClientSince: t.waiting_on_client_since ? new Date(t.waiting_on_client_since as string).toISOString() : null,
    });
  }
  return out;
}

export async function taskDetail(ref: string): Promise<Record<string, unknown> | null> {
  const r = ref.trim();
  const rows = await sql()`
    select t.*, c.name as client_name, r.summary, r.quote, r.request_type, coalesce(r.department, t.department) as department, r.priority_reason, r.confidence, r.status as request_status, r.decided_by, r.decided_at, r.draft,
           m.channel, m.sender, m.text as message_text, m.permalink, m.sent_at
    from tasks t left join clients c on c.id = t.client_id left join requests r on r.id = t.request_id left join messages m on m.id = r.message_id
    where t.id::text = ${r} or t.pulp_card_id = ${r} or t.id::text like ${r + "%"} limit 1`;
  if (!rows.length) return null;
  const t = rows[0];
  const history = await sql()`select from_list, to_list, source, at from status_events where task_id = ${t.id} order by at`;
  return {
    id: t.id, title: t.title, client: t.client_name, origin: t.origin, department: t.department ?? t.department, requestType: t.request_type, priority: t.priority, priorityReason: t.priority_reason,
    status: t.origin === "sheet" ? (t.sheet_status ?? (t.completed_at ? "Done" : "Open")) : await listName(t.board_id as string | null, t.list_id as string | null, !!t.staging, t.request_status === "needs_scope"),
    sheetTab: t.sheet_tab, notes: t.notes, assignee: t.assignee, due: t.due_at, created: t.created_at, completed: t.completed_at,
    pulpLink: t.pulp_card_id && t.board_id ? pulp.cardUrl(String(t.board_id), String(t.pulp_card_id)) : null,
    description: (t.draft as { description?: string } | null)?.description ?? null,
    ask: t.summary, quote: t.quote, confidence: t.confidence, approval: { status: t.request_status, by: t.decided_by, at: t.decided_at },
    source: { channel: t.channel, sender: t.sender, sentAt: t.sent_at, link: t.permalink, text: t.message_text },
    waitingOnClientSince: t.waiting_on_client_since,
    history: history.map((h) => ({ from: h.from_list, to: h.to_list, by: h.source, at: h.at })),
  };
}

export async function clientSummary(ref: string): Promise<Record<string, unknown> | null> {
  const id = await resolveClientId(ref);
  if (!id) return null;
  const c = (await allClients()).find((x) => x.id === id)!;
  const counts = (await sql()`
    select count(*) filter (where completed_at is null and staging = false)::int as open,
           count(*) filter (where staging = true and completed_at is null)::int as staging,
           count(*) filter (where completed_at is null and due_at < now() and staging = false)::int as overdue,
           count(*) filter (where completed_at is null and waiting_on_client_since is not null)::int as waiting_on_client,
           count(*) filter (where completed_at > now() - interval '30 days')::int as done_last_30_days,
           count(*) filter (where created_at > now() - interval '30 days')::int as created_last_30_days
    from tasks where client_id = ${id}`)[0];
  const msgs = (await sql()`
    select count(*)::int as messages_last_30_days, max(sent_at) as last_message_at,
           count(*) filter (where skip_reason = 'no_ask' and created_at > now() - interval '7 days')::int as updates_no_task_last_7_days
    from messages where client_id = ${id} and created_at > now() - interval '30 days'`)[0];
  const open = await searchTasks({ client: id, status: "open", limit: 25 });
  return { client: { id: c.id, name: c.name, scope: c.scope, aliases: c.aliases ?? [], sheetTab: c.sheetTab ?? null }, ...counts, ...msgs, openTasks: open };
}

export async function recentMessages(q: { client?: string | null; channel?: string | null; days?: number | null; limit?: number | null; includeSkipped?: boolean }) {
  const clientId = await resolveClientId(q.client);
  if (q.client && !clientId) return [];
  const days = q.days ?? 7, limit = Math.min(Math.max(q.limit ?? 30, 1), 200);
  const rows = await sql()`
    select m.id, c.name as client, m.channel, m.sender, m.sender_is_staff, m.sent_at, left(m.text, 500) as text, m.skip_reason, m.permalink,
           (select count(*) from requests r where r.message_id = m.id and r.status in ('created','approved','pending_review','needs_scope'))::int as tasks
    from messages m left join clients c on c.id = m.client_id
    where (${clientId}::text is null or m.client_id = ${clientId}) and (${q.channel ?? null}::text is null or m.channel = ${q.channel ?? null})
      and m.sent_at > now() - (${days} || ' days')::interval and (${!!q.includeSkipped} or m.skip_reason is null or m.skip_reason = 'no_ask')
    order by m.sent_at desc limit ${limit}`;
  return rows;
}

/** The end-of-day summary as plain text. `days` = window in days (1 = today). */
export async function dailySummaryText(days = 1): Promise<string> {
  const iv = `${days} days`;
  const created = await sql()`
    select coalesce(c.name,'Internal') as client, left(t.id::text,8) as id, r.department, t.title, m.channel, t.priority
    from tasks t join requests r on r.id = t.request_id join messages m on m.id = r.message_id left join clients c on c.id = t.client_id
    where t.created_at > now() - ${iv}::interval order by c.name`;
  const moved = await sql()`
    select coalesce(c.name,'Internal') as client, left(t.id::text,8) as id, s.from_list, s.to_list, t.board_id, t.title
    from status_events s join tasks t on t.id = s.task_id left join clients c on c.id = t.client_id
    where s.at > now() - ${iv}::interval order by c.name`;
  // Sheet-mirrored rows count as completed only when the sheet carries a real completion date (sheet_status Done
  // with a Date Completed); rows that merely sit below the divider are dated by their import and would flood the list.
  const completed = await sql()`
    select coalesce(c.name,'Internal') as client, left(t.id::text,8) as id, t.title from tasks t left join clients c on c.id = t.client_id
    where t.completed_at > now() - ${iv}::interval and (t.origin = 'hub' or t.completed_at::date <> t.created_at::date)`;
  const overdue = await sql()`
    select coalesce(c.name,'Internal') as client, left(t.id::text,8) as id, t.title, t.priority, to_char(t.due_at,'Dy DD Mon') as due
    from tasks t left join clients c on c.id = t.client_id where t.completed_at is null and t.due_at < now() and t.staging = false
    order by case when t.priority = 'P1' then 0 when t.priority = 'P2' then 1 else 2 end, t.due_at desc`;
  const staging = await sql()`
    select coalesce(c.name,'Unknown') as client, t.title, to_char(t.created_at,'Dy DD Mon') as since, (r.status = 'needs_scope') as needs_scope
    from tasks t left join clients c on c.id = t.client_id left join requests r on r.id = t.request_id
    where t.staging = true and t.completed_at is null order by t.created_at`;
  const decisions = await sql()`
    select coalesce(c.name,'Unknown') as client, m.skip_reason, left(m.text, 70) as text from messages m left join clients c on c.id = m.client_id
    where m.skip_reason in ('unknown_client','attachment_only') and m.created_at > now() - interval '3 days' order by m.created_at`;
  const waiting = await sql()`
    select coalesce(c.name,'Internal') as client, left(t.id::text,8) as id, t.title, to_char(t.waiting_on_client_since,'Dy DD Mon') as since
    from tasks t left join clients c on c.id = t.client_id where t.waiting_on_client_since is not null and t.completed_at is null`;
  const updates = await sql()`
    select coalesce(c.name,'Unknown') as client, left(m.text,80) as text from messages m left join clients c on c.id = m.client_id
    where m.skip_reason = 'no_ask' and m.created_at > now() - ${iv}::interval`;
  const spend = await sql()`
    select count(*)::int as calls, coalesce(sum(cost_usd),0)::numeric(10,4) as usd, coalesce(sum(cache_read_tokens),0)::int as cached
    from llm_calls where created_at > now() - ${iv}::interval`;
  const attention = await sql()`
    select 'message could not be processed: ' || coalesce(c.name,'Unknown') || ' · "' || left(m.text, 60) || '"' as what from messages m left join clients c on c.id = m.client_id
      where m.skip_reason = 'failed' and m.created_at > now() - interval '7 days'
    union all
    select 'no Pulp card yet: ' || coalesce(c.name,'Unknown') || ' · ' || t.title from tasks t left join clients c on c.id = t.client_id
      where t.origin = 'hub' and t.pulp_card_id is null and t.completed_at is null and t.created_at < now() - interval '10 minutes' and t.created_at > now() - interval '7 days'
    union all
    select 'background step abandoned: ' || kind || ' · ' || left(coalesce(last_error,''), 60) from queue where last_error like 'abandoned:%' and done_at > now() - interval '1 day'
    limit 20`;

  const movedNamed: Array<Record<string, unknown>> = [];
  for (const r of moved) {
    const from = r.from_list ? await listName(r.board_id as string | null, String(r.from_list), String(r.from_list) === "Staging") : "—";
    const to = await listName(r.board_id as string | null, String(r.to_list), false);
    if (from === "Staging" && to !== "Done") continue; // approvals show under Created
    movedNamed.push({ ...r, from, to });
  }
  const day = new Date().toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
  const CAP = 8;
  const line = (rows: Record<string, unknown>[], f: (r: Record<string, unknown>) => string) =>
    rows.length ? [...rows.slice(0, CAP).map((r) => "  " + f(r)), ...(rows.length > CAP ? [`  … and ${rows.length - CAP} more (ask the hub)`] : [])].join("\n") : "  —";
  return [
    `MangoEyes PM summary · ${day}${days > 1 ? ` (last ${days} days)` : ""}`,
    "",
    `Created (${created.length})`, line(created, (r) => `${r.client}  ${r.department}  ${r.title}  via ${r.channel}${r.priority === "P1" ? "  🔴" : ""}`),
    `Waiting for a person: Staging / Needs scope (${staging.length})`, line(staging, (r) => `${r.client}  ${r.title}  ${r.needs_scope ? "needs scope, " : ""}since ${r.since}`),
    `Moved (${movedNamed.length})`, line(movedNamed, (r) => `${r.client}  ${r.title}  ${r.from} → ${r.to}`),
    `Completed (${completed.length})`, line(completed, (r) => `${r.client}  ${r.title}`),
    `Overdue (${overdue.length})`, line(overdue, (r) => `${r.client}  ${r.title}  due ${r.due}, ${r.priority}`),
    `Needs a person (${decisions.length})`, line(decisions, (r) => `${r.client}  ${String(r.skip_reason).replace(/_/g, " ")}: "${r.text}"`),
    `Waiting on client (${waiting.length})`, line(waiting, (r) => `${r.client}  ${r.title}  since ${r.since}`),
    `Updates, no task (${updates.length})`, line(updates, (r) => `${r.client}  ${r.text}`),
    ...(attention.length ? [`⚠️ Needs attention (${attention.length})`, line(attention, (r) => String(r.what))] : []),
    "",
    `Model spend: ${spend[0].calls} calls, $${spend[0].usd}${Number(spend[0].cached) === 0 && Number(spend[0].calls) > 3 ? "  ⚠️ cache reads were zero" : ""}`,
  ].join("\n");
}

export async function listMeetings(q: { client?: string | null; days?: number | null; limit?: number | null }) {
  const clientId = await resolveClientId(q.client);
  if (q.client && !clientId) return [];
  const days = q.days ?? 30, limit = Math.min(Math.max(q.limit ?? 20, 1), 100);
  return sql()`
    select m.id, m.title, m.held_at, c.name as client, m.scope, m.organiser, m.summary, m.doc_url,
           (select count(*) from meeting_items i where i.meeting_id = m.id and i.kind = 'action')::int as actions,
           (select count(*) from meeting_items i where i.meeting_id = m.id and i.kind = 'idea')::int as ideas,
           (select count(*) from meeting_items i where i.meeting_id = m.id and i.kind = 'decision')::int as decisions
    from meetings m left join clients c on c.id = m.client_id
    where (${clientId}::text is null or m.client_id = ${clientId} or exists (select 1 from meeting_items i where i.meeting_id = m.id and i.client_id = ${clientId}))
      and m.held_at > now() - (${days} || ' days')::interval
    order by m.held_at desc limit ${limit}`;
}

export async function meetingDetail(ref: string): Promise<Record<string, unknown> | null> {
  const r = ref.trim();
  const rows = await sql()`select m.*, c.name as client_name from meetings m left join clients c on c.id = m.client_id where m.id::text = ${r} or m.id::text like ${r + "%"} or m.drive_file_id = ${r} or m.title ilike ${"%" + r + "%"} order by m.held_at desc limit 1`;
  if (!rows.length) return null;
  const m = rows[0];
  const items = await sql()`select i.kind, c.name as client, i.text, i.owner, i.due_text, i.outcome, i.request_id from meeting_items i left join clients c on c.id = i.client_id where i.meeting_id = ${m.id} order by i.kind, i.created_at`;
  return { id: m.id, title: m.title, heldAt: m.held_at, client: m.client_name, scope: m.scope, organiser: m.organiser, attendees: m.attendees, docUrl: m.doc_url, summary: m.summary, items, notes: String(m.notes).slice(0, 12000) };
}

export async function listItems(kind: "idea" | "decision", q: { client?: string | null; days?: number | null; limit?: number | null }) {
  const clientId = await resolveClientId(q.client);
  if (q.client && !clientId) return [];
  const days = q.days ?? 90, limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  return sql()`
    select i.text, c.name as client, i.owner, i.due_text, m.title as meeting, m.held_at, m.doc_url
    from meeting_items i left join clients c on c.id = i.client_id join meetings m on m.id = i.meeting_id
    where i.kind = ${kind} and (${clientId}::text is null or i.client_id = ${clientId}) and m.held_at > now() - (${days} || ' days')::interval
    order by m.held_at desc limit ${limit}`;
}
