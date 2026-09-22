import { sql, allClients } from "./db";
import * as gchat from "./gchat";
import { pulp } from "./pulp";
import { boards as boardsConfig } from "./config";
import { rememberThread, feedThreadKeyOf, senderUserOf, postText } from "./review";
import { createFromProposal, rulesFor, HUB_LABEL } from "./tasks";
import { createReminder, daysFromNowMorning, mention } from "./reminders-util";
import { parseWhen, whenLabel } from "./when";
import type { Client, Message, Priority, Draft, RouteDecision } from "./types";

/**
 * The proposal: the hub's guess for one task, posted in the feed thread as a card with four pre-filled dropdowns
 * (department, assignee, priority, due) and three buttons. Nothing reaches Pulp until Create card is tapped.
 * Decision 2026-09-22: replaces the Staging list.
 */

export const DEPT_LABEL: Record<string, string> = { dev: "Development", content: "Content (Writers)", design: "Graphics", seo: "SEO", automation: "Onboarding & Automations", video: "Video", general: "PMs", internal: "PMs (internal)" };

export function departmentOptions(): Array<{ value: string; text: string }> {
  return Object.keys(boardsConfig().departments).filter((k) => k !== "scope").map((k) => ({ value: k, text: DEPT_LABEL[k] ?? k }));
}

let _people: { at: number; names: string[] } | null = null;
/** Everyone on any department board, by name, cached ten minutes: the Assign to dropdown. */
export async function peopleOptions(): Promise<string[]> {
  if (_people && Date.now() - _people.at < 10 * 60_000) return _people.names;
  const names = new Set<string>();
  if (pulp.configured()) {
    for (const [dep, d] of Object.entries(boardsConfig().departments)) {
      if (dep === "scope") continue;
      try {
        const id = await pulp.resolveBoardId(d.board);
        if (id) for (const m of await pulp.membersOnBoard(id)) if (m.name) names.add(m.name);
      } catch { /* one board unreadable: the rest still list */ }
    }
  }
  _people = { at: Date.now(), names: [...names].sort((a, b) => a.localeCompare(b)) };
  return _people.names;
}

/** The Due dropdown: the hub's date first, then the usual choices. Values are ISO instants. */
export function dueOptions(dueAt: Date | null, now = new Date()): { dues: Array<{ value: string; text: string }>; due: string } {
  const list: Array<{ value: string; text: string }> = [];
  const add = (d: Date, label?: string) => { const v = d.toISOString(); if (!list.some((x) => x.value === v)) list.push({ value: v, text: label ?? whenLabel(d, true) }); };
  if (dueAt) add(dueAt);
  add(new Date(now.getTime() + 4 * 3_600_000), `In 4 hours (${whenLabel(new Date(now.getTime() + 4 * 3_600_000), true)})`);
  add(daysFromNowMorning(now, 1), `Tomorrow (${whenLabel(daysFromNowMorning(now, 1))})`);
  for (const n of [2, 3, 5, 7, 14]) add(daysFromNowMorning(now, n), `${whenLabel(daysFromNowMorning(now, n))}`);
  return { dues: list, due: (dueAt ?? daysFromNowMorning(now, 3)).toISOString() };
}

/** Match a name the sender wrote ("@Anuj", "Anuj can you") to a person on the boards. */
export function matchPerson(owner: string | null | undefined, people: string[]): string | null {
  if (!owner) return null;
  const o = owner.replace(/^@/, "").trim().toLowerCase();
  if (!o) return null;
  return people.find((p) => p.toLowerCase() === o) ?? people.find((p) => p.toLowerCase().startsWith(o) || o.startsWith(p.toLowerCase().split(" ")[0])) ?? null;
}

export async function postProposal(p: { requestId: string; client: Client | null; message: Message; messageId: string; draft: Draft; route: RouteDecision; owner: string | null; quote: string }): Promise<void> {
  const people = await peopleOptions();
  const assignee = matchPerson(p.owner, people);
  const { dues, due } = dueOptions(p.route.dueAt);
  const askedUser = senderUserOf(p.message);
  const askedName = p.message.senderIsStaff ? p.message.sender.replace(/\s*<[^>]+>\s*$/, "") : null;
  const rules = p.client ? await rulesFor(p.client.id) : [];
  await sql()`update requests set proposal = ${JSON.stringify({ assignee, dueAt: due, department: p.route.department, priority: p.route.priority })}::jsonb, asked_user = ${askedUser} where id = ${p.requestId}`;
  const threadKey = feedThreadKeyOf(p.message, p.messageId);
  if (!gchat.gchatConfigured()) {
    await postText(`Task to confirm: ${p.draft.title} · ${DEPT_LABEL[p.route.department] ?? p.route.department} · ${p.route.priority} · reply "create", "remind me" or "no card"`, { threadKey });
    return;
  }
  const card = gchat.proposalCard({
    requestId: p.requestId, askedName, askedUser, clientName: p.client?.name ?? "Unknown client", title: p.draft.title, description: p.draft.description, quote: p.quote,
    departments: departmentOptions(), department: p.route.department, people, assignee, priority: p.route.priority, dues, due, rules,
    urgentReason: p.route.priority === "P1" ? p.route.priorityReason : null,
  });
  const sent = await gchat.sendCard(gchat.reviewSpace(), card, `Task to confirm: ${p.draft.title}`, `prop-${p.requestId}`, threadKey);
  await rememberThread(sent.thread, { kind: "proposal", requestId: p.requestId });
  await sql()`update requests set proposal = coalesce(proposal, '{}'::jsonb) || ${JSON.stringify({ cardName: sent.name, thread: sent.thread })}::jsonb where id = ${p.requestId}`;
}

export interface ProposalChoice { department?: string | null; assignee?: string | null; priority?: Priority | null; dueAt?: Date | null }

/** The tap, or the typed word. Returns the outcome line that replaces the card. */
export async function decideProposal(kind: "create" | "remind" | "no", requestId: string, who: string, whoUser: string | null, choice: ProposalChoice, words?: string): Promise<string> {
  const r = (await sql()`select r.id, r.status, r.client_id, r.message_id, r.draft, r.proposal, r.department, r.priority, c.name as client_name, m.raw->>'feedThreadKey' as feed_thread
    from requests r left join clients c on c.id = r.client_id join messages m on m.id = r.message_id where r.id = ${requestId}`)[0];
  if (!r) return "That proposal no longer exists.";
  if (r.status !== "proposed") return `Already decided: ${String(r.status)}.`;
  const prop = (r.proposal ?? {}) as { assignee?: string | null; dueAt?: string; department?: string; priority?: Priority };
  const draft = (r.draft ?? {}) as Draft;
  if (kind === "no") {
    await sql()`update requests set status = 'dismissed', decided_by = ${who}, decided_at = now() where id = ${requestId}`;
    return `— No card · ${who} · "${draft.title}"`;
  }
  if (kind === "remind") {
    const dueAt = (words ? parseWhen(words) : null) ?? daysFromNowMorning(new Date(), 2);
    // The reminder comes back in the same feed thread as the message it came from.
    const threadKey = (r.feed_thread as string | null) ?? `msg-${String(r.message_id)}`;
    await createReminder({ messageId: String(r.message_id), requestId, clientId: r.client_id as string | null, ownerName: who, ownerUser: whoUser, text: draft.title, dueAt, threadKey });
    await sql()`update requests set status = 'reminder', decided_by = ${who}, decided_at = now() where id = ${requestId}`;
    return `⏰ Reminder set for ${mention({ ownerName: who, ownerUser: whoUser })} · ${whenLabel(dueAt, true)} · "${draft.title}" · reply here with a day to change it`;
  }
  const department = choice.department || prop.department || String(r.department);
  const priority = (choice.priority || prop.priority || String(r.priority)) as Priority;
  const dueAt = choice.dueAt ?? (prop.dueAt ? new Date(prop.dueAt) : null);
  const assignee = choice.assignee === undefined ? prop.assignee ?? null : choice.assignee;
  const made = await createFromProposal({ requestId, department, assignee, priority, dueAt, who });
  const person = assignee ? ` · assigned to ${assignee}` : " · nobody assigned yet";
  return `✅ Card created by ${who} · ${DEPT_LABEL[department] ?? department} · ${priority}${dueAt ? ` · due ${whenLabel(dueAt, true)}` : ""}${person}${made.link ? ` · <${made.link}|open the card>` : ""}`;
}

/** A typed reply in a proposal's thread: "create", "no card", "remind me Friday", or a person's name to assign. */
export async function answerProposal(requestId: string, text: string, who: string, whoUser: string | null): Promise<string> {
  const t = text.toLowerCase().trim();
  let out: string | null = null;
  if (/\b(no card|not a task|no task|drop|skip|ignore)\b/.test(t)) out = await decideProposal("no", requestId, who, whoUser, {});
  else if (/\bremind\b/.test(t)) out = await decideProposal("remind", requestId, who, whoUser, {}, t.replace(/.*\bremind( me)?\b/, ""));
  else if (/\b(create|make it|make the card|yes|go ahead|ok(ay)?|approve)\b/.test(t)) {
    const people = await peopleOptions();
    const named = people.find((p) => t.includes(p.toLowerCase())) ?? matchPerson(t.match(/\b(?:for|to|assign(?:ed)? to)\s+(\w+)/)?.[1] ?? null, people);
    out = await decideProposal("create", requestId, who, whoUser, { assignee: named ?? undefined });
  }
  if (out === null) return "Say \"create\" (add a name to assign it), \"remind me <day>\", or \"no card\". Or tap a button on the card above.";
  // The card's buttons must not stay live after a typed decision: replace the card with the outcome as a tap would.
  const r = await sql()`select proposal->>'cardName' as card from requests where id = ${requestId}`;
  const cardName = r[0]?.card as string | null;
  if (cardName) { try { await gchat.updateMessageText(cardName, out); } catch (e) { console.error("proposal card update failed", (e as Error).message); } }
  return out;
}

export { HUB_LABEL };

/** Post (again) the proposal for a stored request: used by the retry job when the first post failed. */
export async function repostProposal(requestId: string): Promise<void> {
  const r = (await sql()`select r.*, m.channel, m.external_id, m.client_id as m_client, m.scope as m_scope, m.sender, m.sender_is_staff, m.sent_at, m.text, m.permalink, m.thread_ref, m.raw
    from requests r join messages m on m.id = r.message_id where r.id = ${requestId} and r.status = 'proposed'`)[0];
  if (!r) return;
  const clients = await allClients();
  const client = clients.find((c) => c.id === r.client_id) ?? null;
  const m: Message = { channel: r.channel as Message["channel"], externalId: String(r.external_id), teamId: null, clientId: (r.m_client as string | null) ?? null, scope: r.m_scope as Message["scope"], sender: String(r.sender), senderIsStaff: !!r.sender_is_staff, sentAt: new Date(String(r.sent_at)), text: String(r.text), permalink: (r.permalink as string | null) ?? null, threadRef: (r.thread_ref as string | null) ?? null, raw: r.raw };
  const draft = (r.draft ?? {}) as Draft;
  const prop = (r.proposal ?? {}) as { assignee?: string | null; dueAt?: string };
  const route: RouteDecision = { department: String(r.department) as RouteDecision["department"], board: null, list: null, staging: null, assignee: prop.assignee ?? null, labels: draft.labels ?? [], priority: String(r.priority) as Priority, priorityReason: (r.priority_reason as string | null) ?? null, dueAt: prop.dueAt ? new Date(prop.dueAt) : null, gated: false, noCard: false, backlog: null };
  await postProposal({ requestId, client, message: m, messageId: String(r.message_id), draft, route, owner: prop.assignee ?? null, quote: String(r.quote ?? "") });
}
