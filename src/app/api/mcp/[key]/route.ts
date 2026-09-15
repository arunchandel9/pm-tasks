import { NextResponse } from "next/server";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { verifyMcpKey, type McpKeyOwner } from "@/lib/mcp-keys";
import { allClients, sql } from "@/lib/db";
import { searchTasks, taskDetail, clientSummary, recentMessages, dailySummaryText, listMeetings, meetingDetail, listItems } from "@/lib/hub";
import { processMessage } from "@/lib/pipeline";
import { humanOutcome } from "@/lib/review";
import type { Message } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The MCP hub: a PM connects their own Claude / Codex / Cursor to https://pm-tasks.vercel.app/api/mcp/<their key>
 * and asks questions in plain language. Read tools run plain SQL; the one write tool (add_request) goes through the
 * normal intake pipeline, so it lands in Staging like everything else. Model cost is on the PM's assistant, not the hub.
 */
function buildHandler(owner: McpKeyOwner) {
  return createMcpHandler(
    (server) => {
      const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });

      server.registerTool("list_clients", {
        title: "List clients", description: "All clients the hub knows, with their short names (aliases) and sheet tab.",
        inputSchema: z.object({}),
      }, async () => text((await allClients()).map((c) => ({ id: c.id, name: c.name, scope: c.scope, aliases: c.aliases ?? [], sheetTab: c.sheetTab ?? null }))));

      server.registerTool("search_tasks", {
        title: "Search tasks",
        description: "Tasks by client, status, department or words in the title/ask. status: open (default), done, overdue, waiting (on client), staging (not yet approved), all. days limits to tasks created in the last N days.",
        inputSchema: z.object({
          client: z.string().optional().describe("Client name, id or alias, e.g. HOH"),
          status: z.enum(["open", "done", "overdue", "waiting", "staging", "all"]).optional(),
          department: z.enum(["dev", "content", "design", "seo", "automation", "video", "general", "internal"]).optional(),
          query: z.string().optional().describe("Words to look for in the title or the original ask"),
          days: z.number().int().positive().optional(),
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
        title: "Recent messages", description: "What clients (and the team) have sent recently, across Slack, email, Chat, with how many tasks each message produced. Includes updates that were not tasks.",
        inputSchema: z.object({
          client: z.string().optional(), channel: z.enum(["slack", "email", "intake", "task_cmd", "meet"]).optional(),
          days: z.number().int().positive().optional().describe("default 7"), limit: z.number().int().positive().max(200).optional(),
          includeSkipped: z.boolean().optional().describe("also show messages the filter dropped (acks, noise)"),
        }),
      }, async (a) => text(await recentMessages(a)));

      server.registerTool("daily_summary", {
        title: "Daily summary", description: "The full day or week in text: created, in Staging, moved, completed, overdue, needs a person, waiting on client, updates. days=1 is today; 7 for the week. (The feed gets a shorter brief at 23:00.)",
        inputSchema: z.object({ days: z.number().int().positive().max(31).optional() }),
      }, async ({ days }) => text(await dailySummaryText(days ?? 1)));

      server.registerTool("add_request", {
        title: "Add a request", description: "File a client request. It goes through the normal pipeline: a card in Staging for a PM to approve, one line in the Task Hub Feed. Use the client's words. This assistant account may be shared by several people, so `by` (the name of the person asking you) is required: ask them if you do not know it, never guess it.",
        inputSchema: z.object({
          client: z.string().describe("Client name, id or alias"),
          request: z.string().describe("What was asked, as close to the original words as possible"),
          by: z.string().min(2).describe("The name the person gave when you asked them 'Who is this request from?' in this chat. Their answer verbatim. Never the connection owner's name, never inferred."),
          asked: z.literal(true).describe("true only if you asked the person for their name in this chat and they answered. If you have not asked, ask first; do not call this tool."),
          priority: z.enum(["P1", "P2", "P3"]).optional(),
          source: z.string().optional().describe("Where it came from: WhatsApp, phone, meeting…"),
        }),
      }, async ({ client, request, by, priority, source }) => {
        const who = by.trim();
        const label = who.toLowerCase() === owner.name.trim().toLowerCase() ? who : `${who} (${owner.name})`;
        const clients = await allClients();
        const c = clients.find((x) => x.id.toLowerCase() === client.toLowerCase() || x.name.toLowerCase() === client.toLowerCase() || (x.aliases ?? []).some((a) => a.toLowerCase() === client.toLowerCase()));
        if (!c) return text({ error: `unknown client "${client}"; call list_clients` });
        const body = [request, source ? `\nCame via: ${source}` : "", priority === "P1" ? "\nMarked urgent (P1) by the team." : priority === "P2" ? "\nMarked important by the team." : ""].join("");
        const m: Message = {
          channel: "task_cmd", externalId: `mcp:${owner.email}:${Date.now()}`, teamId: null, clientId: c.id, scope: c.scope,
          sender: label, senderIsStaff: true, sentAt: new Date(), text: body, permalink: null, threadRef: null, raw: { mcp: true, by: who, account: owner.email },
        };
        const r = await processMessage(m, { skip: false, reason: null });
        const n = r.requestIds?.length ?? 0;
        return text(n ? `${n} task${n > 1 ? "s" : ""} created in Staging for ${c.name}; a PM will approve by dragging the card out.` : humanOutcome(r.outcome, r.reason));
      });

      server.registerTool("meetings", {
        title: "Meetings", description: "Recent meetings (Google Meet notes read by the hub): title, date, client, summary, and counts of actions, ideas, decisions. Filter by client and days (default 30).",
        inputSchema: z.object({ client: z.string().optional(), days: z.number().int().positive().optional(), limit: z.number().int().positive().max(100).optional() }),
      }, async (a) => text(await listMeetings(a)));

      server.registerTool("meeting_detail", {
        title: "Meeting detail", description: "One meeting: summary, every item (action / idea / decision / discussion) with what became of it, and the notes text. Pass the meeting id, or words from the title.",
        inputSchema: z.object({ meeting: z.string() }),
      }, async ({ meeting }) => text((await meetingDetail(meeting)) ?? { error: "no such meeting" }));

      server.registerTool("ideas", {
        title: "Ideas", description: "Ideas and future plans raised in meetings, by client (or MangoEyes for internal), newest first. days default 90.",
        inputSchema: z.object({ client: z.string().optional(), days: z.number().int().positive().optional(), limit: z.number().int().positive().max(200).optional() }),
      }, async (a) => text(await listItems("idea", a)));

      server.registerTool("decisions", {
        title: "Decisions", description: "Decisions recorded in meetings, by client, newest first. days default 90.",
        inputSchema: z.object({ client: z.string().optional(), days: z.number().int().positive().optional(), limit: z.number().int().positive().max(200).optional() }),
      }, async (a) => text(await listItems("decision", a)));

      server.registerTool("hub_status", {
        title: "Hub status", description: "Counts and health: messages by channel this week, tasks created, model spend, last polls.",
        inputSchema: z.object({}),
      }, async () => {
        const byChannel = await sql()`select channel, count(*)::int as messages from messages where created_at > now() - interval '7 days' group by channel order by 2 desc`;
        const tasks = (await sql()`select count(*) filter (where created_at > now() - interval '7 days')::int as created_7d, count(*) filter (where completed_at is null)::int as open, count(*) filter (where staging and completed_at is null)::int as staging from tasks`)[0];
        const spend = (await sql()`select count(*)::int as calls, coalesce(sum(cost_usd),0)::numeric(10,4) as usd from llm_calls where created_at > now() - interval '30 days'`)[0];
        const polls = await sql()`select key, value from settings where key in ('pulp_poll_last','gmail_poll_last','gchat_last_event','voice_last','sheet_cards_last','meet_poll_last','tick_last','chat_inbox_last')`;
        const queueErrors = await sql()`select kind, attempts, left(coalesce(last_error, ''), 300) as last_error, payload->>'messageId' as message_id, next_run_at from queue where done_at is null and last_error is not null order by next_run_at limit 10`;
        const stuck = await sql()`select m.id, m.channel, left(m.text, 60) as text, m.created_at from messages m where m.skip_reason is null and m.created_at > now() - interval '2 days' and m.created_at < now() - interval '3 minutes' and not exists (select 1 from requests r where r.message_id = m.id) order by m.created_at desc limit 10`;
        return text({ you: owner, messagesByChannel7d: byChannel, tasks, modelSpend30d: spend, lastPolls: Object.fromEntries(polls.map((p) => [p.key, p.value])), queueErrors, stuckMessages: stuck });
      });
    },
    {
      serverInfo: { name: "mangoeyes-task-hub", version: "1.0.0" },
      instructions: `You are connected to the MangoEyes Task Hub. This connection is shared by several people, so you do not know who is talking to you. Clients are aesthetic clinics; tasks live on Pulp department boards and in the PM Overview sheet. Use search_tasks / client_summary for status questions, task_detail to read the original ask, daily_summary for "what happened today", meetings / meeting_detail for "what happened in the last call with X", ideas and decisions for what was raised or agreed, add_request to file a new client ask (it goes to Staging for a PM to approve). Reading needs nothing. Before add_request, ask the person "Who is this request from?" and wait for their answer; never fill in a name yourself, not from this connection's owner, not from earlier context.`,
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
