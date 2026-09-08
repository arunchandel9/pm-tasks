import { routing } from "./config";
import type { Client, Priority, RouteDecision, RequestTypeRule } from "./types";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Keyword rule from config: only ever raises priority to P1, never lowers.
 * A phrase matches when its words appear in order with up to two other words between them,
 * so "ad disapproved" catches "the ad got disapproved" and "site down" catches "site is currently down".
 */
export function keywordPriority(text: string): { p1: boolean; keyword: string | null } {
  const t = text.toLowerCase();
  for (const k of routing().p1_keywords) {
    const words = k.toLowerCase().split(/\s+/).filter(Boolean).map(escape);
    const re = new RegExp(`\\b${words.join("(?:\\W+\\w+){0,2}?\\W+")}`, "u");
    if (re.test(t)) return { p1: true, keyword: k };
  }
  return { p1: false, keyword: null };
}

export function addWorkingDays(from: Date, days: number): Date {
  const d = new Date(from);
  let left = days;
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d;
}

export function ruleFor(requestType: string): RequestTypeRule | null {
  return routing().request_types[requestType] ?? null;
}

/**
 * Deterministic routing: request type + client map → board, list, assignee, labels, priority, due date.
 * The model never decides any of this.
 */
export function route(opts: {
  requestType: string;
  modelDepartment: string;
  priorityHint: Priority;
  priorityReason: string | null;
  text: string;
  client: Client | null;
  now?: Date;
}): RouteDecision {
  const now = opts.now ?? new Date();
  const rule = ruleFor(opts.requestType);
  const department = (rule?.department ?? opts.modelDepartment) as RouteDecision["department"];

  const kw = keywordPriority(opts.text);
  const priority: Priority = kw.p1 ? "P1" : opts.priorityHint;
  const priorityReason = kw.p1 ? `keyword: "${kw.keyword}"` : opts.priorityReason;

  const noCard = !!rule?.no_card;
  const gated = !!rule?.gated;
  const boards = opts.client?.boards ?? {};
  const target = gated ? boards["scope"] ?? boards[department] : boards[department];

  let dueAt: Date | null = null;
  if (!noCard) {
    if (priority === "P1") dueAt = new Date(now.getTime() + routing().p1_sla_hours * 3600 * 1000);
    else if (rule?.sla_days) dueAt = addWorkingDays(now, rule.sla_days);
  }

  return {
    department,
    board: target?.board ?? null,
    list: gated ? target?.list ?? "Needs scope" : target?.list ?? null,
    staging: target?.staging ?? null,
    assignee: target?.assignee ?? null,
    labels: [...(rule?.labels ?? []), priority],
    priority,
    priorityReason,
    dueAt,
    gated,
    noCard,
    backlog: rule?.backlog ?? null,
  };
}
