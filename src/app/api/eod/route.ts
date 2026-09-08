import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { web } from "@/lib/slack";
import { env } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Once a day (Vercel Cron). Created / Moved / Completed / Overdue / Needs a decision / Waiting on client / Updates, no task / Spend. */
export async function GET(req: Request) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) return new NextResponse("unauthorized", { status: 401 });

  const created = await sql()`
    select coalesce(c.name,'Internal') as client, left(t.id::text,8) as id, r.department, t.title, m.channel, t.priority
    from tasks t join requests r on r.request_id = r.id join messages m on m.id = r.message_id left join clients c on c.id = t.client_id
    where t.created_at > now() - interval '1 day' and r.status in ('created','approved') order by c.name`;
  const moved = await sql()`
    select coalesce(c.name,'Internal') as client, left(t.id::text,8) as id, s.from_list, s.to_list
    from status_events s join tasks t on t.id = s.task_id left join clients c on c.id = t.client_id
    where s.at > now() - interval '1 day' and s.from_list is distinct from 'Staging' order by c.name`;
  const completed = await sql()`
    select coalesce(c.name,'Internal') as client, left(t.id::text,8) as id, t.title from tasks t left join clients c on c.id = t.client_id
    where t.completed_at > now() - interval '1 day'`;
  const overdue = await sql()`
    select coalesce(c.name,'Internal') as client, left(t.id::text,8) as id, t.title, t.priority, to_char(t.due_at,'Dy DD Mon') as due
    from tasks t left join clients c on c.id = t.client_id where t.completed_at is null and t.due_at < now() and t.staging = false order by t.due_at`;
  const decisions = await sql()`
    select coalesce(c.name,'Unknown') as client, r.status, r.draft->>'title' as title from requests r left join clients c on c.id = r.client_id
    where r.status in ('pending_review','needs_scope') order by r.created_at`;
  const waiting = await sql()`
    select coalesce(c.name,'Internal') as client, left(t.id::text,8) as id, t.title, to_char(t.waiting_on_client_since,'Dy DD Mon') as since
    from tasks t left join clients c on c.id = t.client_id where t.waiting_on_client_since is not null and t.completed_at is null`;
  const updates = await sql()`
    select coalesce(c.name,'Unknown') as client, left(m.text,80) as text from messages m left join clients c on c.id = m.client_id
    where m.skip_reason = 'no_ask' and m.created_at > now() - interval '1 day'`;
  const spend = await sql()`
    select count(*)::int as calls, coalesce(sum(cost_usd),0)::numeric(10,4) as usd, coalesce(sum(cache_read_tokens),0)::int as cached
    from llm_calls where created_at > now() - interval '1 day'`;

  const day = new Date().toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  const line = (rows: Record<string, unknown>[], f: (r: Record<string, unknown>) => string) => rows.length ? rows.map((r) => "  " + f(r)).join("\n") : "  —";
  const text = [
    `MangoEyes PM summary · ${day}`,
    "",
    `Created (${created.length})`, line(created, (r) => `${r.client}  ${r.id}  ${r.department}  ${r.title}  ${r.channel}${r.priority === "P1" ? "  🔴" : ""}`),
    `Moved (${moved.length})`, line(moved, (r) => `${r.client}  ${r.id}  ${r.from_list ?? "—"} → ${r.to_list}`),
    `Completed (${completed.length})`, line(completed, (r) => `${r.client}  ${r.id}  ${r.title}`),
    `Overdue (${overdue.length})`, line(overdue, (r) => `${r.client}  ${r.id}  ${r.title}  due ${r.due}, ${r.priority}`),
    `Needs a decision (${decisions.length})`, line(decisions, (r) => `${r.client}  ${r.status === "needs_scope" ? "Needs scope" : "Review"}: ${r.title}`),
    `Waiting on client (${waiting.length})`, line(waiting, (r) => `${r.client}  ${r.id}  ${r.title}  since ${r.since}`),
    `Updates, no task (${updates.length})`, line(updates, (r) => `${r.client}  ${r.text}`),
    "",
    `Spend today: ${spend[0].calls} model calls, $${spend[0].usd}${Number(spend[0].cached) === 0 && Number(spend[0].calls) > 3 ? "  ⚠️ cache reads were zero" : ""}`,
  ].join("\n");

  await web().chat.postMessage({ channel: env.reviewChannel(), text: "```" + text + "```" });
  return NextResponse.json({ ok: true, created: created.length, moved: moved.length, overdue: overdue.length });
}
