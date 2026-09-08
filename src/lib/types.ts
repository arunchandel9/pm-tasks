export type Channel = "slack" | "email" | "intake" | "task_cmd" | "meet";
export type Scope = "client" | "internal" | "unknown";
export type Priority = "P1" | "P2" | "P3";
export type Department = "dev" | "content" | "design" | "seo" | "general" | "internal";

/** One shape for every inbound message, whatever the channel. */
export interface Message {
  channel: Channel;
  externalId: string;
  teamId: string | null;      // Slack workspace the message came from
  clientId: string | null;
  scope: Scope;
  sender: string;
  senderIsStaff: boolean;
  sentAt: Date;
  text: string;
  permalink: string | null;
  threadRef: string | null;
  raw: unknown;
}

export interface BoardTarget {
  board: string;
  list: string;
  staging?: string;
  assignee?: string;
}

export interface Client {
  id: string;
  name: string;
  scope: "client" | "internal";
  slackChannels: string[];
  emailDomains: string[];
  whatsappNumbers: string[];
  boards: Record<string, BoardTarget>;
  clientFacingAck: boolean;
  slackTeamId?: string | null;
  aliases?: string[];
}

export interface RequestTypeRule {
  department: Department;
  sla_days?: number;
  labels?: string[];
  gated?: boolean;
  no_card?: boolean;
  backlog?: string;
  follow_up?: { request_type: string; department: Department; title_prefix: string };
  chain?: Array<{ step: string; department: Department; title: string; waiting_on_client?: boolean }>;
}

export interface RoutingConfig {
  p1_sla_hours: number;
  p1_keywords: string[];
  request_types: Record<string, RequestTypeRule>;
}

export interface NoiseConfig {
  min_chars: number;
  thread_reply_followup_min_chars: number;
  duplicate_window_days: number;
  per_client_daily_llm_cap: number;
  reply_nudge_minutes: number;
  similarity: { merge_at: number; review_at: number };
  acknowledgements: string[];
  ack_words: string[];
  slack_skip_subtypes: string[];
  email_skip_senders: string[];
  email_allow_senders: string[];
}

export interface Draft {
  title: string;
  description: string;
  labels: string[];
}

export interface RouteDecision {
  department: Department;
  board: string | null;
  list: string | null;
  staging: string | null;
  assignee: string | null;
  labels: string[];
  priority: Priority;
  priorityReason: string | null;
  dueAt: Date | null;
  gated: boolean;
  noCard: boolean;
  backlog: string | null;
}
