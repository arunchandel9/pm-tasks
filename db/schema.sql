-- MangoEyes Task Hub — database schema (Postgres / Neon)
-- Apply with: npm run db:migrate   (idempotent)

create extension if not exists pg_trgm;
create extension if not exists pgcrypto;

-- Kill switches, gate state, misc settings. key examples:
--   intake_paused (bool), channel_paused:slack (bool), gate:dev_issue (jsonb)
create table if not exists settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- Client map. Mirrors the Config tab of the PM sheet; refreshed by /api/tick.
create table if not exists clients (
  id               text primary key,          -- slug, e.g. clinic-x
  name             text not null,
  scope            text not null default 'client',   -- client | internal
  slack_channels   text[] not null default '{}',     -- channel IDs
  email_domains    text[] not null default '{}',
  whatsapp_numbers text[] not null default '{}',
  boards           jsonb  not null default '{}',     -- {dev:{board,list,staging,assignee}, content:{...}, design:{...}, seo:{...}}
  client_facing_ack boolean not null default false,
  slack_team_id    text,                             -- one workspace per client
  aliases          text[] not null default '{}',     -- other names people use: "Dr Patel", "the clinic"
  updated_at       timestamptz not null default now()
);
alter table clients add column if not exists slack_team_id text;
alter table clients add column if not exists aliases text[] not null default '{}';
alter table clients add column if not exists sheet_tab text;

-- One row per Slack workspace the app is installed in (MangoEyes' own + one per client).
create table if not exists slack_workspaces (
  team_id      text primary key,
  team_name    text,
  bot_token    text not null,
  bot_user_id  text,
  is_home      boolean not null default false,       -- the MangoEyes workspace (#pm-review, #intake live here)
  installed_at timestamptz not null default now()
);

-- Cached Slack users so staff detection (by email domain) costs one API call per person.
create table if not exists slack_users (
  team_id   text not null,
  user_id   text not null,
  email     text,
  is_staff  boolean not null default false,
  is_bot    boolean not null default false,
  seen_at   timestamptz not null default now(),
  primary key (team_id, user_id)
);

-- Every inbound message, whether or not it became a request.
create table if not exists messages (
  id              uuid primary key default gen_random_uuid(),
  channel         text not null,             -- slack | email | intake | task_cmd | meet
  external_id     text not null,             -- slack ts, gmail message id, drive file id
  client_id       text references clients(id),
  scope           text,                      -- client | internal | unknown
  sender          text,
  sender_is_staff boolean not null default false,
  sent_at         timestamptz not null,
  text            text not null,
  text_hash       text not null,
  permalink       text,
  thread_ref      text,                      -- slack thread_ts, email thread id
  raw             jsonb,
  skip_reason     text,                      -- null = entered the pipeline
  created_at      timestamptz not null default now(),
  unique (channel, external_id)
);
create index if not exists messages_text_trgm on messages using gin (text gin_trgm_ops);
create index if not exists messages_client_sent on messages (client_id, sent_at desc);

-- One row per distinct ask. A message can produce several.
create table if not exists requests (
  id                uuid primary key default gen_random_uuid(),
  message_id        uuid not null references messages(id),
  client_id         text references clients(id),
  scope             text not null,
  ask_index         int  not null default 0,
  summary           text not null,
  quote             text,
  request_type      text not null,           -- see config/routing.yaml
  department        text not null,           -- dev | content | design | seo | general
  priority          text not null default 'P3',
  priority_reason   text,
  confidence        numeric(4,3) not null,
  confidence_reason text,
  draft             jsonb not null,          -- {title, description, labels}
  status            text not null default 'pending_review',
                    -- pending_review | approved | created | dismissed | merged | needs_scope
  merged_into       uuid references requests(id),
  decided_by        text,
  decided_at        timestamptz,
  created_at        timestamptz not null default now()
);
create index if not exists requests_client_status on requests (client_id, status);

-- One row per Pulp card. This is the audit trail.
create table if not exists tasks (
  id            uuid primary key default gen_random_uuid(),
  request_id    uuid not null references requests(id),
  client_id     text references clients(id),
  pulp_card_id  text,
  board_id      text,
  list_id       text,
  title         text not null,
  priority      text not null,
  assignee      text,
  due_at        timestamptz,
  sheet_row     int,
  staging       boolean not null default true,
  waiting_on_client_since timestamptz,
  created_at    timestamptz not null default now(),
  last_moved_at timestamptz,
  completed_at  timestamptz
);
create index if not exists tasks_client on tasks (client_id, created_at desc);
-- Rows imported from the PM Overview sheet (history and tasks PMs add by hand) live in the same table.
alter table tasks alter column request_id drop not null;
alter table tasks add column if not exists origin text not null default 'hub';       -- hub | sheet | board (2026-09-23: every card on the boards, mirrored by board-mirror.ts)
alter table tasks add column if not exists sheet_key text;                            -- card:<pulp id> | row:<tab>:<serial>:<title>
alter table tasks add column if not exists sheet_tab text;
alter table tasks add column if not exists sheet_status text;                         -- Status cell as the PM wrote it
alter table tasks add column if not exists department text;
alter table tasks add column if not exists notes text;                                -- Comments cell
alter table tasks add column if not exists pulp_checked_at timestamptz;               -- sheet rows with a hand-made card: last time the card was looked at
alter table tasks add column if not exists labels text[] not null default '{}';       -- the card's labels as Pulp shows them (board mirror)
create unique index if not exists tasks_sheet_key on tasks (sheet_key) where sheet_key is not null;

-- Every list change observed in Pulp.
create table if not exists status_events (
  id        uuid primary key default gen_random_uuid(),
  task_id   uuid not null references tasks(id),
  from_list text,
  to_list   text not null,
  at        timestamptz not null default now(),
  source    text not null default 'poll'    -- poll | webhook | hub | slack
);

-- Every model call, for the EOD spend line and the cache check.
create table if not exists llm_calls (
  id                 uuid primary key default gen_random_uuid(),
  step               text not null,          -- extract | classify
  model              text not null,
  message_id         uuid references messages(id),
  input_tokens       int not null,
  cache_read_tokens  int not null default 0,
  cache_write_tokens int not null default 0,
  output_tokens      int not null,
  cost_usd           numeric(10,6) not null,
  latency_ms         int not null,
  created_at         timestamptz not null default now()
);

-- Work queue for retries: anything that failed mid-pipeline lands here.
create table if not exists queue (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null,                 -- process_message | create_task | sync_sheet
  payload     jsonb not null,
  attempts    int not null default 0,
  last_error  text,
  next_run_at timestamptz not null default now(),
  done_at     timestamptz
);
create index if not exists queue_due on queue (next_run_at) where done_at is null;

-- Meeting notes (Google Meet "Notes by Gemini" docs, or any notes doc shared with the hub).
create table if not exists meetings (
  id             uuid primary key default gen_random_uuid(),
  drive_file_id  text not null unique,
  title          text not null,
  held_at        timestamptz,
  organiser      text,
  attendees      jsonb not null default '[]'::jsonb,
  client_id      text references clients(id),
  scope          text not null default 'unknown',    -- client | internal | unknown
  doc_url        text,
  notes          text not null,                      -- full text of the notes doc
  summary        jsonb not null default '[]'::jsonb, -- 2-5 bullet points
  created_at     timestamptz not null default now()
);
create index if not exists meetings_client on meetings (client_id, held_at desc);

-- Every item the sorter found in a meeting: what it was and what became of it.
create table if not exists meeting_items (
  id          uuid primary key default gen_random_uuid(),
  meeting_id  uuid not null references meetings(id),
  kind        text not null,                          -- action | idea | decision | discussion
  client_id   text references clients(id),
  text        text not null,
  owner       text,
  due_text    text,
  outcome     text not null default 'noted',          -- task | on_existing_card | idea | decision | noted
  request_id  uuid references requests(id),
  created_at  timestamptz not null default now()
);
create index if not exists meeting_items_kind on meeting_items (kind, client_id, created_at desc);

-- 2026-09-22: every message becomes one of five things (task, reminder, idea, rule, note). A task is proposed in the
-- feed and made only when a person confirms; the other kinds have their own homes below.
alter table messages add column if not exists sender_user text;                       -- Chat user (users/<id>) or email, so the hub can @mention the sender
alter table requests add column if not exists kind text not null default 'task';       -- task | reminder | idea | rule | note
alter table requests add column if not exists asked_user text;                         -- who the proposal @mentions (users/<id> or email)
alter table requests add column if not exists proposal jsonb;                          -- {cardName, thread, assignee, dueAt, department, priority}

-- "Remind me on Friday": to the person who asked, at that time, every morning until Done.
create table if not exists reminders (
  id             uuid primary key default gen_random_uuid(),
  message_id     uuid references messages(id),
  request_id     uuid references requests(id) on delete set null,
  client_id      text references clients(id),
  owner_name     text not null,
  owner_user     text,                        -- users/<id> or email, for the @mention
  text           text not null,
  due_at         timestamptz not null,
  last_posted_at timestamptz,
  post_name      text,                        -- the latest feed message, replaced by the outcome on Done
  thread_key     text,
  done_at        timestamptz,
  done_by        text,
  created_at     timestamptz not null default now()
);
create index if not exists reminders_due on reminders (due_at) where done_at is null;

-- Ideas wait for a decision on Monday: Make it a task, or Not now. Undecided ones come back the next Monday.
create table if not exists ideas (
  id          uuid primary key default gen_random_uuid(),
  client_id   text references clients(id),
  message_id  uuid references messages(id),
  meeting_id  uuid references meetings(id),
  text        text not null,
  said_by     text,
  source      text,                           -- "Slack, Dr Mehta" / "Meeting · Intro call"
  source_link text,
  said_at     timestamptz not null default now(),
  decided_at  timestamptz,
  decision    text,                           -- task | not_now
  decided_by  text,
  request_id  uuid references requests(id) on delete set null,
  card_name   text,                           -- the Monday card, replaced by the outcome
  created_at  timestamptz not null default now()
);
create index if not exists ideas_open on ideas (client_id, said_at) where decided_at is null;

-- A client's standing instruction ("ask my permission before changing appointment durations"): printed on that client's cards.
create table if not exists client_rules (
  id          uuid primary key default gen_random_uuid(),
  client_id   text references clients(id),
  message_id  uuid references messages(id),
  text        text not null,
  said_by     text,
  said_at     timestamptz not null default now()
);
