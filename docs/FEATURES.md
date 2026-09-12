# MangoEyes Task Hub — feature register

The complete list of what the hub does. One line per feature, nothing left implied. The handover guide is built
from this file, and every feature here has a live check in the final round. Add a row whenever a feature is added;
strike a row when one is removed. Decisions that shaped a feature are in `docs/STATE.md`.

Legend: **Live** = deployed and verified on real traffic · **Built** = deployed, unit-tested, live check in the
final round · **Dropped** = decided against, kept here so it is not asked for again.

## 1. Where requests come from (intake)

| # | Feature | How it works | Status |
|---|---|---|---|
| 1.1 | Client Slack channels | The Task Hub Slack app is installed in a client's workspace and invited to its channels. Every non-staff message is read; staff messages are ignored. Workspace T-id sits in the client's Config row (column D). | Live in Abela; other clients in the final round |
| 1.2 | Google Chat: Intake space | Retired 2026-09-11: the DM with the app does everything with no mention. A group space still works if anyone wants one, with `@Task Hub` first (Google delivers a space message to an app only when mentioned). | Dropped |
| 1.3 | Google Chat: DM with Task Hub | The front door. Each person opens a DM with the app once (Chat → + → search "Task Hub" under Apps → Install). Forward a WhatsApp text, a voice note or a screenshot, or type an ask: no mention, delivered every time. Welcome text is one line. Client name can follow in the same thread. Source label in the feed and the sheet: "Task Hub, <name>". | Live |
| 1.4 | Client name before or after | A forwarded message with no client name is held; the sender adds the client name in the same thread and processing continues. A prefix like "HOH: …" is stripped and used as the client. Any later reply in that thread belongs to the same client, so "also broken on tablet" needs no name. | Live |
| 1.5 | `/task` form | Slash command that opens a dialog. Works, but not taught: Arun decided 2026-09-11 that the DM alone is simpler. Not in the guide, not in the welcome text. | Dropped from the guide (code kept) |
| 1.6 | Voice notes, short | Audio forwarded to the DM (WhatsApp notes included, with or without a file extension) goes to Google Speech-to-Text v2 with the Chirp model (needs the "Cloud Speech Client" role on the service account), which decodes the file itself and handles accents; falls back to v2 "long", then to the v1 engine. Both engines get a vocabulary hint list: every client name and alias plus agency words (CTA, homepage, hero image…). Client names in the transcript match fuzzily ("a bella" → Abela). The understanding step is told it is a transcript, keeps to one ask unless clearly two, and never invents detail. The DM echoes "Heard: …" so a mishearing is visible and a one-line reply corrects the card. Diagnostics: `voice_last` on health and hub_status. | Built (engine changed 2026-09-11) |
| 1.7 | Voice notes, long (up to 20 min) | Long audio goes to a Cloud Storage bucket and a long-running transcription; the hub polls until the text is ready, then processes it. | Built |
| 1.8 | Email | Mail to intake@mangoeyesagency.com (read from arun@ via domain-wide delegation) is polled every minute. Forwarded mails are unwrapped, signatures stripped, each mail processed once (Message-ID dedupe), then labelled "Task Hub". | Live (one forwarded mail verified) |
| 1.9 | Google Meet notes | Each organiser shares their Meet folder ("Meet Recordings" or "Google Meet", whichever Google made for them) with the service account once. Every 5 min the hub finds every "… Notes by Gemini" doc it can see, at any depth, shortcuts included. Only notes modified after the hub first looked (`meet_since`), never the backlog. | Live |
| 1.10 | MCP `add_request` | A PM's own Claude or Codex files a request straight into the hub. | Built |
| 1.11 | Unknown client | If no client can be matched: from the DM, the hub asks in that thread and continues when the person replies with the name; from Slack, email or a meeting, a "which client?" card goes to the feed for anyone to answer. Either way the message is stored with reason `unknown_client` and listed under "Needs a person" in the summary until resolved. The feed carries finals only. | Live |
| 1.12 | Kill switch | `INTAKE_PAUSED=1` in Vercel stops all intake without redeploying. | Built |

## 2. Understanding the request

| # | Feature | How it works | Status |
|---|---|---|---|
| 2.1 | Noise filter | Acknowledgements, emojis, attachment-only posts, tiny thread replies and known bot senders never reach a model. In the DM, "ok thanks" or a 👍 gets no reply at all; it is stored as skipped. | Live |
| 2.2 | Extract | One model call pulls every distinct ask out of a message (a message with two asks becomes two requests). A stated problem ("… is not working", "broken", "down") is always an ask, by rule, whatever the model says. | Live |
| 2.3 | Classify | Each ask gets a request type, department, priority with reason, and a card title and description. Prompt caching keeps cost low; every call is logged with tokens and cost. | Live |
| 2.4 | Deterministic routing | `config/routing.yaml` decides board, list, labels, SLA due date and P1 keywords. The model never decides these. | Live |
| 2.5 | P1 keywords | "site down", "form not working", "ad disapproved", "hacked" and the rest force P1 with a 4-hour due time. | Live |
| 2.6 | Dedupe and follow-ups | A message that matches an open task (same thread, or similar text within the window) is noted as a comment on that card instead of creating a new one. The feed shows a 🔁 line. | Live |
| 2.7 | Meeting sorter | Each notes doc is split into actions, ideas, decisions and discussion. Client actions become requests under that client; MangoEyes-internal items stay internal. Ideas and decisions are stored and searchable. | Live |
| 2.8 | Daily model cap | A per-client daily cap on model calls stops a runaway thread from spending money. | Built |

## 3. Cards, approval and the sheet

| # | Feature | How it works | Status |
|---|---|---|---|
| 3.1 | Staging card | Every approved-type ask becomes a real card in the **Staging** list of the right department board, with the client label, priority label, description, original quote, source link and due date. | Live |
| 3.2 | Needs scope card | New page and new feature asks go to the **Needs scope** list on the Development board instead, for a person to scope first. | Built |
| 3.3 | Drag = approval | A PM drags the card out of Staging (or Needs scope) to wherever it belongs. The hub sees the move within a minute, marks the request approved, and writes the sheet row. No buttons, no second step. | Live |
| 3.4 | Sheet row with stamp | The row lands in the client's tab with title, department, priority, assignee, Pulp link, source link, created and due dates. The Comments cell reads "Task assigned. Added by Task Hub · approved by drag in Pulp · 9 Sep 2026, 14:30 IST · from Slack, Dr Mehta". | Live |
| 3.4a | Yellow new rows | Every row the hub adds is coloured light yellow (`new_row_colour` in `config/sheet.yaml`). A person checks it is in the right place, moves it up or down if not, and makes it white. Moving a row never breaks the hub: rows are found by their Pulp link, not their position. | Built |
| 3.5 | Status sync | Every hub card is checked by id every minute. Status in the sheet follows the card's list; Done fills Date Completed and moves the row below the DONE divider; moving back out of Done reopens it. | Live |
| 3.6 | Hand-made cards | A card someone creates directly in Pulp and links in the sheet by hand is picked up by the sheet mirror. From then on the hub checks it in rotation and writes Status only when the card moves list (Done also closes the row). First look never overwrites a typed status. | Built |
| 3.7 | Sheet mirror | Every 10 min all client tabs are read into the hub (history from before the hub and hand-typed rows), so Claude answers from the PMs' own record. Never writes to the sheet. | Live (1,164 rows) |
| 3.8 | Retry without re-approving | A card that failed to create is retried by a background job that never changes the approval; a failed sheet write is retried the same way. | Built |
| 3.9 | Client board overrides | A client's Config row can point any department to another board or list; blank means the default in `config/boards.yaml`. | Built |
| 3.10 | New-page chain | Seven linked sub-cards per new page. | Dropped 2026-09-10: pages are mostly one person's work; the PM adds cards by hand |

## 4. Keeping a person in the loop

| # | Feature | How it works | Status |
|---|---|---|---|
| 4.1 | The feed space (Task Hub Feed, formerly PM Review) | One short line per task: client, title, department, priority, link to the card, source. All asks from one message in one post. No buttons. Everything about one source message sits in one thread: the "which client?" card, the "client set" line, the voice-note notice, the task lines. The hub knows the space by ID, so renaming it changes nothing. | Built (threading added 2026-09-11) |
| 4.2 | Thread replies | Replying in a feed thread with a client name or a correction is picked up and applied. | Live |
| 4.3 | Receipt rule | The feed line is the receipt. If no line appears within 2 minutes, send the message again. | Live |
| 4.4 | DM replies only when needed | The DM answers in the thread only when the sender must act ("Which client is this for?", "I can read text and voice notes, not images"), when nothing was created ("Nothing created: …"), or when a short or uncertain ask was filed ("Filed: … Anything to add? Reply here and it goes on the card"). A reply in that thread becomes a comment on the card. Otherwise the feed line is the receipt and the DM stays quiet. | Built (tightened 2026-09-11) |
| 4.5 | Reply nudges | If a client message has had no staff reply after the configured minutes, a nudge is posted. | Built |
| 4.6 | Daily summary | 17:30 UTC weekdays to PM Review: Created, Waiting for a person (Staging / Needs scope), Moved, Completed, Overdue, Needs a person, Waiting on client, Updates with no task, Needs attention. Eight lines per section, then "and N more (ask the hub)". | Live |

## 5. The hub (ask it from your own assistant)

| # | Feature | How it works | Status |
|---|---|---|---|
| 5.1 | MCP server | `https://pm-tasks.vercel.app/api/mcp/<personal key>` over Streamable HTTP. Works in Claude (web, desktop, Code) and Codex. Guide in `docs/MCP.md`. | Live |
| 5.2 | Personal keys | Minted, listed and revoked from `/api/setup?mcp_key=Name|email`, `?mcp_list`, `?mcp_revoke=`. Keys are stored hashed. | Live |
| 5.3 | Tools | `list_clients`, `search_tasks`, `task_detail`, `client_summary`, `recent_messages`, `daily_summary`, `add_request`, `meetings`, `meeting_detail`, `ideas`, `decisions`, `hub_status`. | Live |
| 5.4 | Answers cover the whole record | Hub-made tasks and sheet history both answer, with status, links, assignee and dates. | Live |
| 5.5 | External platforms | Ads, CRM, Search Console, analytics stay on each PM's own Claude/Codex connectors. The PM's assistant compiles hub data with platform data. Not connected to the hub by decision. | Decided 2026-09-10 |

## 6. Nothing gets lost (reliability)

| # | Feature | How it works | Status |
|---|---|---|---|
| 6.1 | Every message stored first | The raw message is saved before anything else happens, with a reason code if skipped. | Live |
| 6.2 | Retry queue | Card creation, comments, sheet writes, transcription polls and message processing all go through a queue with backoff. Abandoned jobs are reported. | Live |
| 6.3 | Watchdog | Every 10 min: half-processed messages are reprocessed, tasks without a card get one (without re-approving), stuck jobs are listed under "Needs attention" in the summary. | Live |
| 6.4 | Health page | `/api/health` shows what is configured, last poll times, recent messages and errors. Returns 503 when the minute tick is older than 5 minutes. Uptime monitor set by Arun. | Live |
| 6.5 | Self-healing sheet | The status the sheet last received is remembered per task and compared with the card every minute, so a failed write is retried until it matches. | Live |
| 6.6 | Sheet import is idempotent | Keys per tab and card; the same row is never inserted twice; re-runs update in place. | Live |

## 7. Configuration (no code changes needed)

| # | What | Where |
|---|---|---|
| 7.1 | Clients: name, aliases, Slack T-id, sheet tab, board overrides | Config tab of the PM Overview sheet, refreshed every minute |
| 7.2 | Department boards, Staging and Needs scope lists, card URL shape | `config/boards.yaml` |
| 7.3 | Request types, SLA days, labels, gating, P1 keywords | `config/routing.yaml` |
| 7.4 | Sheet columns, stamp wording, timezone, status values | `config/sheet.yaml` |
| 7.5 | Noise rules, dedupe window, nudge timings, daily cap | `config/noise.yaml` |
| 7.6 | Secrets and switches | Vercel environment variables (names in `docs/STATE.md`) |

## 8. Final-round live checks (one per feature that is still "Built")

1. DM the Task Hub with "HOH: the booking form is broken" → feed line, Staging card, P1.
2. Email intake@ with subject "Abela: update pricing page" → feed line within 2 minutes.
3. A 15-minute voice note in Intake → transcript processed, feed line.
4. Slack message in an Abela channel → feed line, card.
5. "We want a new landing page for Botox" in Intake → card under Needs scope on Development; drag it → sheet row.
6a. Drag a card out of Staging → the new sheet row is yellow; move the row two places up; move the card to Done → that same row goes Done.
6. Create a card by hand in Pulp, paste its link in a sheet row → after 10 min it appears in Claude; move it to Done → Status Done and row below the divider.
7. Claude: "what happened in the last meeting with The Eye Doctor" and "Abela, last 30 days".
8. Turn `INTAKE_PAUSED=1` on, post in Intake, confirm nothing happens, turn it off.

## 9. Endpoints (every URL the hub answers on)

| Endpoint | What it does | Who calls it |
|---|---|---|
| `/api/tick` | The minute loop: client map, sheet mirror (every 10 min), meeting notes (every 5 min), mailbox, retry queue, Pulp poll for hub cards, hand-made card check, watchdog (every 10 min), heartbeat. | Vercel Cron, every minute |
| `/api/eod` | Posts the daily summary to PM Review. `?dry=1` returns it without posting. | Vercel Cron, 17:30 UTC weekdays |
| `/api/gchat` | Google Chat events: Intake and DM messages, `/task` dialog, button clicks, feed-thread replies. | Google Chat |
| `/api/slack/events`, `/api/slack/install`, `/api/slack/oauth` | Slack messages from client channels; app install and OAuth for a new client workspace. | Slack |
| `/api/mcp/[key]` | The MCP hub for a PM's own Claude or Codex. | PMs' assistants |
| `/api/health` | Configuration flags, last poll times, recent activity, 503 when the tick is stale. | Uptime monitor, people |
| `/api/setup` | Applies the schema; seeds clients, Slack team ids, MCP keys; removes a test client. | Arun, with the cron secret |
| `/api/sheet-check` | Shows every client tab and how its headers map. | Arun |
| `/api/sheet-sync` | Runs the sheet mirror now (`?client=` for one client). | Arun |
| `/api/pulp-check` | Verifies the Pulp key, boards and lists (`?create=1` creates missing Staging lists). | Arun |
| `/api/gmail-check` | Verifies mailbox access and shows the last mails seen. | Arun |
| `/api/meet-check` | Lists the Meet folders shared with it, the organisers covered, and the notes docs it can see (`?run=1` processes new notes now). | Arun |

## 10. Code map (every module, and the feature rows it serves)

| Module | Serves |
|---|---|
| `src/lib/pipeline.ts` | 1.11, 2.1–2.6, 3.1, 4.1, 4.4, 4.5, 6.1 — the one path every message takes |
| `src/lib/filter/noise.ts`, `src/lib/dedupe.ts`, `src/lib/resolve.ts` | 2.1, 2.6, 1.4 (client matching) |
| `src/lib/llm/client.ts`, `src/lib/llm/extract.ts`, `src/lib/llm/classify.ts`, `src/lib/llm/meeting.ts` | 2.2, 2.3, 2.7, 2.8 (model calls, caching, cost log) |
| `src/lib/route.ts`, `src/lib/config.ts` | 2.4, 2.5, 3.2, section 7 |
| `src/lib/tasks.ts`, `src/lib/pulp.ts` | 3.1, 3.2, 3.3, 3.8, 3.9 |
| `src/lib/sheets.ts`, `src/lib/sheet-sync.ts`, `src/lib/sheet-cards.ts` | 3.4, 3.5, 3.6, 3.7, 6.5, 6.6, 7.1 |
| `src/lib/review.ts`, `src/lib/gchat.ts`, `src/lib/gchat-events.ts` | 1.2–1.5, 4.1–4.4 |
| `src/lib/slack.ts`, `src/lib/normalize/slack.ts` | 1.1 |
| `src/lib/gmail.ts` | 1.8 |
| `src/lib/transcribe.ts` | 1.6, 1.7 |
| `src/lib/meet.ts` | 1.9, 2.7 |
| `src/lib/hub.ts`, `src/lib/mcp-keys.ts` | 1.10, 4.6, section 5 |
| `src/lib/db.ts`, `src/lib/schema.ts`, `src/lib/schema-split.ts`, `src/lib/auth.ts`, `src/lib/types.ts` | storage, schema apply, cron secret check, shared types |

## Rule

Nothing built is allowed to exist only in code. A test (`tests/features.test.ts`) fails the build when an endpoint or
module is missing from this file, so a new piece of work cannot ship unlisted. The handover guide, the team brief and
any cost or summary document are written from this file, never from memory.
