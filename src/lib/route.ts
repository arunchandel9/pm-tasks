import { routing, boards as boardDefaults } from "./config";
import { parseWhen } from "./when";
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
  /** The sender said it is urgent in plain words (extract.urgent): P1 with the 4-hour due, shown on the proposal. */
  urgent?: boolean;
  /** Timing the sender gave, verbatim ("by Friday", "within 24 hours"): becomes the due date when it parses. */
  deadline?: string | null;
}): RouteDecision {
  const now = opts.now ?? new Date();
  const rule = ruleFor(opts.requestType);
  const department = (rule?.department ?? opts.modelDepartment) as RouteDecision["department"];

  const kw = keywordPriority(opts.text);
  const priority: Priority = kw.p1 || opts.urgent ? "P1" : opts.priorityHint;
  const priorityReason = kw.p1 ? `keyword: "${kw.keyword}"` : opts.urgent ? "the sender said it is urgent" : opts.priorityReason;

  const noCard = !!rule?.no_card;
  const gated = !!rule?.gated;
  const own = opts.client?.boards ?? {};
  const def = boardDefaults().departments;
  const pick = (k: string) => (own[k]?.board ? own[k] : def[k]?.board ? { ...def[k], ...(own[k] ?? {}), board: def[k].board } : own[k] ?? def[k]);
  const target = gated ? pick("scope") ?? pick(department) : pick(department);

  let dueAt: Date | null = null;
  if (!noCard) {
    const said = parseWhen(opts.deadline, now);
    if (said && said > now) dueAt = said;
    else if (priority === "P1") dueAt = new Date(now.getTime() + routing().p1_sla_hours * 3600 * 1000);
    else if (rule?.sla_days) dueAt = addWorkingDays(now, rule.sla_days);
    else dueAt = addWorkingDays(now, priority === "P2" ? 3 : 5);
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
