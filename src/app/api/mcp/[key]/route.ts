import { NextResponse } from "next/server";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { verifyMcpKey, type McpKeyOwner } from "@/lib/mcp-keys";
import { allClients, sql } from "@/lib/db";
import { searchTasks, taskDetail, clientSummary, recentMessages, dailySummaryText, listMeetings, meetingDetail, listItems } from "@/lib/hub";
import { processMessage } from "@/lib/pipeline";
import { humanOutcome } from "@/lib/review";
import type { Message } from "@/lib/types";
import { parseWhen, whenLabel } from "@/lib/when";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The MCP hub: a PM connects their own Claude / Codex / Cursor to https://pm-tasks.vercel.app/api/mcp/<their key>
 * and asks questions in plain language. Read tools run plain SQL; the one write tool (add_request) goes through the
 * normal intake pipeline with the details decided in the chat, so the card is made at once. Model cost is on the PM's assistant, not the hub.
 */
function buildHandler(owner: McpKeyOwner) {
  return createMcpHandler(
    (server) => {
      const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
      // Every look-back tool takes either `days` (the last N days) or `from` / `to` (calendar days in Indian time, both
      // inclusive; one of them alone means that single day). from/to win over days.
      const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
      const window = {
        days: z.number().int().positive().optional().describe("the last N days"),
        from: day.optional().describe("first calendar day, YYYY-MM-DD (Indian time); alone = that one day"),
        to: day.optional().describe("last calendar day, YYYY-MM-DD, inclusive"),
      };

      server.registerTool("list_clients", {
        title: "List clients", description: "All clients the hub knows, with their short names (aliases) and sheet tab.",
        inputSchema: z.object({}),
      }, async () => text((await allClients()).map((c) => ({ id: c.id, name: c.name, scope: c.scope, aliases: c.aliases ?? [], sheetTab: c.sheetTab ?? null }))));

      server.registerTool("search_tasks", {
        title: "Search tasks",
        description: "Tasks by client, status, department or words in the title/ask. status: open (default), done, overdue, waiting (on client), staging (not yet approved), all. days limits to tasks created in the last N days; from/to to tasks created on those calendar days.",
        inputSchema: z.object({
          client: z.string().optional().describe("Client name, id or alias, e.g. HOH"),
          status: z.enum(["open", "done", "overdue", "waiting", "staging", "all"]).optional(),
          department: z.enum(["dev", "content", "design", "seo", "automation", "video", "general", "internal"]).optional(),
          query: z.string().optional().describe("Words to look for in the title or the original ask"),
          ...window,
          limit: z.number().int().positive().max(200).optional(),
        }),
      }, async (a) => text(await searchTasks(a)));

      server.registerTool("task_detail", {
        title: "Task detail", description: "Everything about one task: the original message, who asked, approval, status history, card link. Pass the task id (or its first 8 characters) or the Pulp card id.",
        inputSchema: z.object({ id: z.string() }),
      }, async ({ id }) => text((await taskDetail(id)) ?? { error: "no such task" }));

      server.registerTool("client_summary", {
        title: "Client summary", description: "One client at a glance: open, staging, overdue, waiting-on-client, done in 30 days, message volume, and the open task list.",
        inputSchema: z.object({ client: z.string() }),
      }, async ({ client }) => text((await clientSummary(client)) ?? { error: "no such client" }));

      server.registerTool("recent_messages", {
        title: "Recent messages", description: "What clients (and the team) have sent recently, across Slack, email, Chat, with how many tasks each message produced. Includes updates that were not tasks. days default 7, or from/to for exact days.",
        inputSchema: z.object({
          client: z.string().optional(), channel: z.enum(["slack", "email", "intake", "task_cmd", "meet"]).optional(),
          ...window, limit: z.number().int().positive().max(200).optional(),
          includeSkipped: z.boolean().optional().describe("also show messages the filter dropped (acks, noise)"),
        }),
      }, async (a) => text(await recentMessages(a)));

      server.registerTool("daily_summary", {
        title: "Daily summary", description: "The full day or week in text: created, in Staging, moved, completed, overdue, needs a person, waiting on client, updates. days=1 is today; 7 for the week; from/to for a past day or range, e.g. what happened on 2025-03-12. (The feed gets a shorter brief at 23:00.)",
        inputSchema: z.object({ days: z.number().int().positive().max(31).optional(), from: window.from, to: window.to }),
      }, async ({ days, from, to }) => text(await dailySummaryText(days ?? 1, { from, to })));

      server.registerTool("add_request", {
        title: "Create a card", description: "Create a Pulp card for a client ask, with every detail decided here in this chat (2026-09-23): the card is made at once in To Do, assigned, the sheet row is written, and the Task Hub Feed gets the line and the outcome. Nothing to confirm in the feed. Before calling: ask who is asking (`by`), which client, what was asked (their words), and who it should be assigned to (`assignee`, a name from `people`, call it if you do not know the names). Department, priority and due are optional: pass them when the person said them, otherwise the hub decides. If what was asked is not a task (a reminder, an idea, a rule, information) the hub records it as such and says so. This assistant account may be shared by several people, so `by` is required: ask, never guess.",
        inputSchema: z.object({
          client: z.string().describe("Client name, id or alias"),
          request: z.string().describe("What was asked, as close to the original words as possible"),
          by: z.string().min(2).describe("The name the person gave when you asked them 'Who is this request from?' in this chat. Their answer verbatim. Never the connection owner's name, never inferred."),
          asked: z.literal(true).describe("true only if you asked the person for their name in this chat and they answered. If you have not asked, ask first; do not call this tool."),
          assignee: z.string().min(2).describe("Who does the work: a name exactly as `people` lists it. Ask the person; never guess."),
          department: z.enum(["dev", "content", "design", "seo", "automation", "video", "general", "internal"]).optional().describe("Only when the person said it; otherwise the hub decides"),
          priority: z.enum(["P1", "P2", "P3"]).optional().describe("Only when the person said it; otherwise the hub decides (urgent words give P1)"),
          due: z.string().optional().describe("Only when the person said it: a date YYYY-MM-DD, or words like 'Friday', 'in 3 days', 'within 24 hours'"),
          source: z.string().optional().describe("Where it came from: WhatsApp, phone, meeting…"),
        }),
      }, async ({ client, request, by, assignee, department, priority, due, source }) => {
        const who = by.trim();
        const label = `${who} via Claude-${owner.name.trim()}`; // the person, then the Claude account it came through
        const clients = await allClients();
        const c = clients.find((x) => x.id.toLowerCase() === client.toLowerCase() || x.name.toLowerCase() === client.toLowerCase() || (x.aliases ?? []).some((a) => a.toLowerCase() === client.toLowerCase()));
        if (!c) return text({ error: `unknown client "${client}"; call list_clients` });
        const { peopleOptions, matchPerson } = await import("@/lib/proposal");
        const person = matchPerson(assignee, await peopleOptions());
        if (!person) return text({ error: `"${assignee}" is not on any board; call people and ask the person to pick a name from it` });
        const dueAt = due ? parseWhen(due) : null;
        if (due && !dueAt) return text({ error: `could not read the due date "${due}"; use YYYY-MM-DD or words like "Friday", "in 3 days"` });
        const body = [request, source ? `\nCame via: ${source}` : ""].join("");
        const m: Message = {
          channel: "task_cmd", externalId: `mcp:${owner.email}:${Date.now()}`, teamId: null, clientId: c.id, scope: c.scope,
          sender: label, senderIsStaff: true, sentAt: new Date(), text: body, permalink: null, threadRef: null,
          raw: { mcp: true, by: who, account: owner.email, direct: { assignee: person, department: department ?? null, priority: priority ?? null, dueAt: dueAt?.toISOString() ?? null } },
        };
        const r = await processMessage(m, { skip: false, reason: null });
        const ids = r.requestIds ?? [];
        if (!ids.length) return text(humanOutcome(r.outcome, r.reason));
        const made = await sql()`select t.title, t.board_id, t.pulp_card_id, t.priority, t.assignee, t.due_at, r.status, r.department from requests r left join tasks t on t.request_id = r.id where r.id = any(${ids}::uuid[])`;
        const { pulp } = await import("@/lib/pulp");
        return text(made.map((t) => t.pulp_card_id
          ? `Card created for ${c.name}: "${t.title}" · ${String(t.department)} · ${t.priority} · assigned to ${t.assignee}${t.due_at ? ` · due ${whenLabel(new Date(String(t.due_at)), true)}` : ""} · ${pulp.cardUrl(String(t.board_id), String(t.pulp_card_id))}. The feed has the line; the sheet row is written.`
          : `"${t.title ?? request}" could not be created now (status ${String(t.status)}); it stays proposed in the feed thread and can be confirmed there.`).join("\n"));
      });

      server.registerTool("people", {
        title: "People on the boards", description: "The names a card can be assigned to (everyone on the department boards). Use before add_request when you do not know the exact name.",
        inputSchema: z.object({}),
      }, async () => { const { peopleOptions } = await import("@/lib/proposal"); return text(await peopleOptions()); });

      server.registerTool("meetings", {
        title: "Meetings", description: "Recent meetings (Google Meet notes read by the hub): title, date, client, summary, and counts of actions, ideas, decisions. Filter by client and days (default 30) or from/to.",
        inputSchema: z.object({ client: z.string().optional(), ...window, limit: z.number().int().positive().max(100).optional() }),
      }, async (a) => text(await listMeetings(a)));

      server.registerTool("meeting_detail", {
        title: "Meeting detail", description: "One meeting: summary, every item (action / idea / decision / discussion) with what became of it, and the notes text. Pass the meeting id, or words from the title.",
        inputSchema: z.object({ meeting: z.string() }),
      }, async ({ meeting }) => text((await meetingDetail(meeting)) ?? { error: "no such meeting" }));

      server.registerTool("ideas", {
        title: "Ideas", description: "Ideas and future plans raised in meetings, by client (or MangoEyes for internal), newest first. days default 90, or from/to.",
        inputSchema: z.object({ client: z.string().optional(), ...window, limit: z.number().int().positive().max(200).optional() }),
      }, async (a) => text(await listItems("idea", a)));

      server.registerTool("decisions", {
        title: "Decisions", description: "Decisions recorded in meetings, by client, newest first. days default 90, or from/to.",
        inputSchema: z.object({ client: z.string().optional(), ...window, limit: z.number().int().positive().max(200).optional() }),
      }, async (a) => text(await listItems("decision", a)));

      server.registerTool("hub_status", {
        title: "Hub status", description: "Counts and health: messages by channel this week, tasks created, model spend, last polls.",
        inputSchema: z.object({}),
      }, async () => {
        const byChannel = await sql()`select channel, count(*)::int as messages from messages where created_at > now() - interval '7 days' group by channel order by 2 desc`;
        const tasks = (await sql()`select count(*) filter (where created_at > now() - interval '7 days')::int as created_7d, count(*) filter (where completed_at is null)::int as open, count(*) filter (where staging and completed_at is null)::int as staging from tasks`)[0];
        const spend = (await sql()`select count(*)::int as calls, coalesce(sum(cost_usd),0)::numeric(10,4) as usd from llm_calls where created_at > now() - interval '30 days'`)[0];
        const polls = await sql()`select key, value from settings where key in ('pulp_poll_last','gmail_poll_last','gchat_last_event','slack_last_event','voice_last','sheet_cards_last','meet_poll_last','tick_last','chat_inbox_last')`;
        const queueErrors = await sql()`select kind, attempts, left(coalesce(last_error, ''), 300) as last_error, payload->>'messageId' as message_id, next_run_at from queue where done_at is null and last_error is not null order by next_run_at limit 10`;
        const stuck = await sql()`select m.id, m.channel, left(m.text, 60) as text, m.created_at from messages m where m.skip_reason is null and m.created_at > now() - interval '2 days' and m.created_at < now() - interval '3 minutes' and not exists (select 1 from requests r where r.message_id = m.id) order by m.created_at desc limit 10`;
        const workspaces = await sql()`select w.team_id, w.team_name, w.is_home, w.installed_at, c.name as client from slack_workspaces w left join clients c on c.slack_team_id = w.team_id order by w.installed_at`;
        return text({ you: owner, messagesByChannel7d: byChannel, tasks, modelSpend30d: spend, lastPolls: Object.fromEntries(polls.map((p) => [p.key, p.value])), slackWorkspaces: workspaces, queueErrors, stuckMessages: stuck });
      });
    },
    {
      serverInfo: { name: "mangoeyes-task-hub", version: "1.0.0" },
      instructions: `You are connected to the MangoEyes Task Hub. This connection is shared by several people, so you do not know who is talking to you. Clients are aesthetic clinics; tasks live on Pulp department boards and in the PM Overview sheet. Use search_tasks / client_summary for status questions, task_detail to read the original ask, daily_summary for "what happened today", meetings / meeting_detail for "what happened in the last call with X", ideas and decisions for what was raised or agreed, from/to (YYYY-MM-DD) on any of these for "what happened on 12 March" or "between 1 and 15 March", add_request to create a card for a client ask: it is made at once in Pulp with the details decided in this chat, and the feed shows the outcome. Reading needs nothing. Before add_request, ask the person "Who is this request from?" and wait for their answer (never fill in a name yourself, not from this connection's owner, not from earlier context), then ask which client, what was asked, and who it should be assigned to (the names come from the people tool). Department, priority and due date only if the person says them; otherwise the hub decides.`,
    },
  );
}

async function handle(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  const owner = await verifyMcpKey(key);
  if (!owner) return new NextResponse("unauthorized", { status: 401 });
  return buildHandler(owner)(req);
}

export { handle as GET, handle as POST, handle as DELETE };
