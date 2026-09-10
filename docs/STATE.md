# MangoEyes Task Hub — current state

The full feature list, with status and the final-round checks, is `docs/FEATURES.md`. Keep both files current: a
feature is added or dropped there first, decisions and IDs are recorded here. Standing rule from Arun (2026-09-10):
nothing built may go unnoticed. Every feature appears in FEATURES.md, in the handover guide, in the handover message
and in any cost or summary document. `tests/features.test.ts` fails when an endpoint or module is not in FEATURES.md.

Read this first when resuming. It is the operational memory of the project: what is decided, what exists,
what is verified, what is open. `PLAN.md` holds the design rationale; this file holds the live state.
Keep it updated with every change.

Last updated: 2026-09-09 (build day 2).

## Decisions finalised

- **Shape.** One Next.js app on Vercel (project `mangoeyes-task-hub`, domain `pm-tasks.vercel.app`, branch
  `claude/mangowise-task-automation-3qnd3k`), Neon Postgres via the Vercel integration (variable `storage_DATABASE_URL`,
  code accepts any `*_DATABASE_URL`). Model: Claude Sonnet 5 (`LLM_MODEL`), two structured calls per message.
- **Slack = client side only.** One Slack app ("Task Hub"), distributed, installed per client workspace via
  `/api/slack/install`. One workspace = one client. Staff recognised by email domain `mangoeyesagency.com`
  (`STAFF_EMAIL_DOMAINS`, exceptions in `STAFF_EMAILS`). Bot reads channels it is invited to. Only ever writes an
  emoji reaction in a client workspace. Home workspace (MangoEyes) installed: `T05941HP5A4`.
- **Google Chat = team side.** Spaces: **PM Review** `AAQAjieDBM4` (drafts, questions, P1 alerts, acks, nudges,
  daily summary) and **Intake** `AAQAUYuXnAc` (paste WhatsApp/any message with `@Task Hub`, drop voice notes,
  `/task` form with client dropdown, notes, priority, source). Chat app configured in add-on mode; endpoint
  `/api/gchat` handles both classic and add-on event formats; token audience = project number or endpoint URL.
  Google Cloud project `mangoeyes-task-hub`, number `354018118635`, service account
  `task-hub@mangoeyes-task-hub.iam.gserviceaccount.com` (Sheets, Chat, Speech-to-Text, Drive, Gmail enabled).
- **Direct messages with Task Hub = intake without a mention.** Google only delivers space messages that mention
  the app, so the Intake space needs `@Task Hub`; a 1:1 chat with Task Hub delivers everything (forwarded WhatsApp
  text and voice notes from the phone's share sheet). Always on in the current Chat API config (no toggle exists).
- **Voice notes.** Google Speech-to-Text (same service account). ≤ ~1 min: synchronous, seconds. Longer (up to
  hours; Arun needs 20 min): uploaded to bucket `<project>-task-hub-voice` (auto-created in ASIA-SOUTH1 if the
  service account may; else `VOICE_BUCKET`), long-running recognition, polled by queue job `transcribe_poll` every
  minute, then processed like typed text; one 🎙️ line on receipt, task lines when done. Audio kept in the bucket.
  English with UK/IN/US accents; Hinglish would need a language switch. ~2 cents per audio minute.
- **Client name after (or before) a forward.** A forwarded message with no client name gets "Which client is this
  for?" in its own thread (Intake) or chat (DM) plus the needs-a-person card in PM Review. A reply that is just a
  client name in that thread, or the next message in the DM within 30 min, sets the client and processes it; the PM
  Review card is replaced by one line. A name sent *before* the forward is kept 15 min (`client_hint:<sender>`) and
  applied to the next message without a client. Answering from PM Review (dropdown or thread reply) still works.
- **Email intake** (built 2026-09-09). `intake@mangoeyesagency.com` is an alias of arun@mangoeyesagency.com, so
  `GMAIL_MAILBOX=arun@mangoeyesagency.com` and `GMAIL_INTAKE_ADDRESS=intake@mangoeyesagency.com` (set in Vercel
  2026-09-09). Domain-wide delegation added for service-account unique id 117215744015492300607 with gmail.readonly +
  gmail.modify. Service account project role: Storage Admin only (for the voice bucket).
  Service account impersonates it via domain-wide delegation (scopes gmail.readonly + gmail.modify). Every minute:
  mails to the intake address without the Gmail label "Task Hub" (newer than 3 days) are parsed (forwards read from
  the inside: original sender + body; quoted history dropped), noise-filtered (`emailNoise`), client resolved from
  subject/note prefix → original sender's domain → text, run through the pipeline as channel `email`, then labelled.
  `/api/gmail-check` proves the connection; `gmail_poll_last` on /api/health shows the last run.
- **Meeting notes** (built 2026-09-10, untested until a folder is shared). Each organiser shares their Drive folder
  "Meet Recordings" with the service account once (Viewer); the hub finds every folder of that name shared with it
  (`MEET_FOLDER_NAMES`, default "Meet Recordings,Task Hub Notes") plus any "… - Notes by Gemini" doc shared
  directly. Every 5 minutes (minute % 5 == 2) new docs from the last 3 days are read (max 3 per tick). One model call
  (`sortMeeting`) sorts items into action / idea / decision / discussion and names the client per item (MangoEyes for
  internal). Actions go per client through the normal pipeline as channel `meet` (dedupe against open tasks, Staging
  card, feed line; no client → needs-a-person card); ideas 💡 and decisions 📌 are stored in `meeting_items` and get
  one line each (max 6); discussion stays in `meetings.notes`. Feed: one 📝 header per meeting + a ↳ tally line.
  MCP tools: meetings, meeting_detail, ideas, decisions. `/api/meet-check` shows folders/docs visible; `?run=1` reads now.
  Tables `meetings`, `meeting_items` (schema applied by `/api/setup`).
- **Acknowledgements.** Every team-side intake (Intake space, /task, forwarded email, voice note) gets one line in
  PM Review with the outcome. Client-channel messages produce drafts, not ack lines. Client-facing replies: never.
- **Unanswered client nudge.** Client posts in Slack and no MangoEyes reply → one line in PM Review at 5 min and at
  60 min (`reply_nudge_minutes: [5, 60]`), one per channel per mark, any team reply clears. No model call.
- **Review = Staging in Pulp, not buttons in Chat** (decided 2026-09-08). Every task becomes a real card in the board's
  `Staging` list; the PM drags it out and assigns it, and that is the approval (sheet row written then, stamp says
  "drag in Pulp"). PM Review is a short feed, one line per task, all asks from one message in a single post
  (`🆕 *HOH* · title · Dev · P2 · Staging card · Slack, Dr Mehta`; P1 lines start with 🔴). Messages that belong to an
  existing task are commented onto that card and get one 🔁 line, nothing new created. Only these still need a
  person in Chat: "needs a person" cards (unknown client, voice note too long) and the unanswered-client nudges.
  Those cards are answered either with the dropdown/buttons or by a typed reply in the card's thread that mentions
  @Task Hub (client name, "not a task", "make it a task", "approve", "merge"); card threads are remembered in
  settings `gchat_thread:<thread>`.
  `REVIEW_MODE=approve` brings back Approve/Not-a-task cards; that mode is used automatically while Pulp is not
  connected (no Staging list to approve from). No automatic move from Staging to To Do yet: who to assign is
  undecided; revisit later.
- **PM Overview sheet** (`1NXjvbfpJB36pb0BkkG08JEcUa35AxQ3PV5Nsj95I9-8`, shared with the service account as Editor).
  Tasks are written into **each client's own tab** under its existing headers
  (S. NO. | TASK | PULP/CARD LINK | DATE ADDED | DUE DATE | PRIORITY | ASSIGNED TO | STATUS | DEPARTMENT | COMMENTS):
  next serial, `DD-MMM-YYYY` dates, department labels (Development/Content/Graphics/SEO/PM), Status "To Do",
  "Task assigned." in Comments, inserted **above the DONE divider**. After creation the hub only updates Status and
  Date Completed, locating the row by Pulp link (PMs may rearrange rows freely); a Done task is moved below the
  DONE divider automatically. Priority/Assigned To/Comments are write-once. Comments carries the audit stamp on creation:
  `Task assigned. Added by Task Hub · approved by <PM name> · 08-Sep-2026 14:32 IST · from Slack, <sender>` (template
  `initial_note` and `stamp_timezone` in config/sheet.yaml; "drag in Pulp" when approved by dragging; retries keep the
  original approver). No extra column. The **Config** tab is the client directory only
  (id, name, scope, slack_team_id, aliases, email_domains, whatsapp_numbers, board overrides, client_facing_ack,
  sheet_tab), mirrored into the DB every minute.
- **Pulp.** API v1 at `https://pulp.mangoeyes.io/api/v1`, Bearer `PULP_TOKEN` (`pulp_sk_…`, acts as one Pulp user who
  must be a member of every board; created in Pulp → Settings → API Keys). `src/lib/pulp.ts` is written against the
  real brief: `{data}` envelope, UUID ids, `POST /boards/{id}/cards {list_id,name}` then `PATCH /cards/{id}`
  (description, due_date), labels and members attached by name, `POST /cards/{id}/move {list_id}`,
  `POST /cards/{id}/comments {content}`. No updated-since endpoint and `GET /boards/{id}/cards` is capped at 1000
  (the Development board has more), so the minute poll fetches each hub card by id (`GET /cards/{id}`, open or
  completed in the last 7 days, max 150 per tick) and diffs `list_id`; the sheet Status is reconciled against
  `settings sheet_stage:<task>` every minute, so a failed write is retried. `pulp_poll_last` in settings (shown on
  /api/health) carries the last run's per-task reasoning and errors. Boards in config/boards.yaml may be a
  UUID, the 8-char URL prefix, or the board name (Graphics is by name); lists (`Staging`, `To Do`, `Needs scope`)
  are created by the hub if missing. Card links are `<base>/board/<board>?card=<card>` (`card_url` in boards.yaml);
  the Pulp board page opens that card's pop-up on load (confirmed 2026-09-09). Department sprint boards (renamed weekly, ids stable),
  all clients on each, client name as a label: SEO `d4424c02-a0ee-4bec-93be-afb4d6547a88`, Content (Writers)
  `54d3e767-8899-4875-b88f-faf45b0d82af`, Development `0fac54b7-3a47-4645-9d67-87f7d24ed32a` (also PM/general,
  internal, Needs scope), Graphics `088afc03-75da-4c0f-a7f6-a37a9208c515`, Automation (Onboarding & Automations)
  `ec7258b2-556c-4fcd-be34-21ed81b078e0`, Video `8f4eb438-d311-4e6a-8288-9b73bd64271b`. Other boards are never touched.
  List names match ignoring case/punctuation ("To-Do" = "To Do"); only lists named Done/Completed/Closed count as
  finished ("Ready to Use / Go Live" does not). Boards' own To Do lists are spelled "To-Do"/"To-do" on Dev, Writers,
  Graphics, Automation; "To Do" on SEO, Video.
  `/api/pulp-check` proves the connection (add `?create=1` to create missing lists). 2026-09-09: first key was bound to
  Arun's personal profile (arunchandel9@gmail.com, no board memberships) because Pulp's key dropdown listed both of
  his profiles by name only; Pulp fixed (dropdown shows workspace members with email, /me + /boards share the web
  app's visibility). New key for arun@mangoeyesagency.com in `PULP_TOKEN`; `/api/pulp-check` all `ok` on 2026-09-09
  (Staging lists created on all six boards). Mistake that day: the first `?create=1` run also created a duplicate
  "To Do" list on Development, Writers, Graphics and Onboarding & Automations because matching was exact; Arun to
  archive those four extra lists in the UI (API cannot). Matching fixed since.
- **Nothing fails quietly** (built 2026-09-10). Every message is stored before processing; card and sheet writes retry
  from the queue (`create_card` creates the missing Staging card without approving; `sync_sheet` re-runs the approval
  keeping the approver). Watchdog every 10 min (minute % 10 == 5): messages older than 3 min with no outcome and no
  request are reprocessed up to 3 times, then marked `failed` + one ⚠️ line in PM Review with the link; hub tasks with
  no Pulp card are created on retry, ⚠️ after 3 failures; queue jobs report ⚠️ at 5 attempts and are abandoned at 8.
  Daily summary has a "⚠️ Needs attention" section for all three. Heartbeat `tick_last`: /api/health returns
  `tickAgeSeconds` and HTTP 503 with `ok:false` when the tick is older than 5 min, for an uptime monitor.
  Team rule for the guide: the feed is the receipt; no line within 2 minutes means it is not in the system, use /task.
- **Data retention.** Keep everything forever. `RAW_RETENTION_DAYS` exists but is off (0).
- **Sheet → hub mirror** (built 2026-09-09). Every client tab of the PM Overview sheet is read into `tasks` with
  `origin='sheet'` (key `card:<pulp id>` or `row:<tab>:<serial>:<title>`): title, status text, department label,
  priority, assignee, dates (DD-MMM-YYYY and common variants), Comments; rows below the DONE divider count as done.
  Runs at `/api/sheet-sync` on demand and every 10 minutes from the tick. Never writes to the sheet or Pulp. Hub-made
  rows are matched by Pulp link and only pick up a PM-typed Assigned To. The Pulp poll only follows hub-origin tasks.
  So the MCP hub and the summary answer from the PMs' own record, history included. First full import 2026-09-09:
  15 tabs, 1164 rows, no errors (per-tab keys; upsert on conflict). Tab names may carry stray spaces ("Dr Sabrina ",
  " Dr Tanov Eyes & Aesthetics"); matching trims them.
- **MCP hub** (built 2026-09-09). `https://pm-tasks.vercel.app/api/mcp/<key>` (Streamable HTTP via `mcp-handler`
  2.x / `@modelcontextprotocol/server` 2.0). Per-person keys `mh_…` minted with `/api/setup?mcp_key=<name>|<email>`,
  sha256 stored in settings `mcp_key:<hash>`, revoked with `?mcp_revoke=`. Tools: list_clients, search_tasks,
  task_detail, client_summary, recent_messages, daily_summary, add_request (→ normal pipeline, Staging), hub_status.
  Read side lives in `src/lib/hub.ts`; the EOD route uses the same `dailySummaryText` (`/api/eod?dry=1` previews).
  How-to for PMs: `docs/MCP.md`.
- **Cost.** Only two model calls per message; ~$6/month at 500 messages on Sonnet 5. Hub questions run on each PM's
  own assistant over MCP (phase 3), never on the API bill.
- **Not Hermes.** Intake is event-driven and must not decide; Hermes runs code only when its agent decides and needs
  an always-on server. Hermes may later sit beside the hub as a chat client. Full text in `PLAN.md` Appendix A.

## Verified working

- Vercel deploy, database tables (`/api/setup`), health page, cron secret `CRON_SECRET` (value known to Arun).
- Service account reads the sheet: `/api/sheet-check` maps every active client tab completely.
- Slack app created from manifest, distribution on, installed in MangoEyes (home).
- Google Chat app configured and added to both spaces (welcome message will appear after the add-on-format fix).
- Pulp: key acts as arun@mangoeyesagency.com, six department boards reachable, Staging lists present.
- **Milestone A reached 2026-09-09:** Intake message → two requests → two Staging cards (Dev, Writers) → one two-line
  post in PM Review with card links. Google's caller for the add-on style app is
  `service-<project>@gcp-sa-gsuiteaddons.iam.gserviceaccount.com` (accepted since; before that every event got 401 and Chat
  showed "Task Hub not responding").
- **Milestone C reached 2026-09-09:** Arun's Claude connected to `/api/mcp/<key>` and answered "what is pending for
  HOH" with the Staging task, links and counts. Sheet history imported afterwards so answers cover pre-hub tasks.
- **Milestone B reached 2026-09-09:** dragging the Dev card out of Staging wrote the row into the "HOH - House Of Health"
  tab within a minute (poll → approveRequest moveCard:false → insertTaskRow with stamp "approved by drag in Pulp").
  Card → Done then set Status "Done" and moved the row below the DONE divider (after the by-id poll fix).
- **Scope gate built 2026-09-10:** gated request types (`new_page`, `new_feature` in `config/routing.yaml`) create their
  card in the **Needs scope** list on the Development board (`departments.scope` in `config/boards.yaml`; a client row
  can override) instead of Staging. Request status `needs_scope`; feed line links "Needs scope card"; hub/MCP status
  "Needs scope"; daily summary section "Waiting for a person: Staging / Needs scope" marks them. Dragging the card out
  of Needs scope is the approval, same as Staging (sheet row, stamp). The retry job also honours the gate. Live test:
  send "we want a new landing page for Botox" in Intake, expect the card under Needs scope on Development.
- Unit tests: 73 passing (`npm test`). Build clean.

## Open items (owner: Arun)

1. ~~Config tab~~ done: 15 client rows, sheet_tab at AB, link headers set (Template renamed; Dr Anil, MangoEyes blank header filled).
2. ~~Google Chat live tests~~ all passed 2026-09-09: Intake message → feed + Staging cards; drag → sheet row; Done →
   row below divider; `/task` form opens, submits, acks. Add-on facts learned: caller is the gsuiteaddons service
   agent; dialogs open with `action.navigations[].pushCard` and close with `endNavigation CLOSE_DIALOG`; every
   button/dropdown `function` must be the endpoint URL (hub uses `…/api/gchat?fn=<name>`); click events carry the
   original message so clicks are handled before the `/task` text check. Left: delete the test cards and HOH test row.
3. Install Slack app into one client workspace; put its T-id in that client's Config row (column D).
5. Name the mailbox for email intake (blocking the email build's test); run `/api/setup?remove_client=test-client`;
   archive the four duplicate "To Do" lists.
4. ~~Pulp API~~ connected and verified 2026-09-09. Left: archive the duplicate "To Do" lists the hub created on
   Development, Writers, Graphics, Onboarding & Automations (keep the boards' own "To-Do").
6. Slack: Abela workspace linked 2026-09-10 (`slack_team:abela=T0APH26RDK3`). Left: `/invite @Task Hub` in each Abela
   channel; install in the other client workspaces during the final round.
7. ~~New-page chain~~ decided 2026-09-10: not built. Uptime monitor already set by Arun.
   Handover rule (Arun, 2026-09-10): a card someone creates directly in Pulp gets its row and card link added to the
   client tab by hand. From then on the hub tracks it too (feature 3.6 in FEATURES.md, `src/lib/sheet-cards.ts`):
   40 such cards are checked per minute in rotation, Status is written only when the card moves list, Done closes
   the row. Filing the extra card through `/task` or Claude's add_request avoids even the manual row.
   Ads / CRM / Search Console / analytics stay connected to each PM's own Claude or Codex, not to the hub (decided
   2026-09-10); the hub is the task and conversation record only.
8. Final round (Arun's call to defer): MangoEyes board override `c898e940-b4df-4467-baf6-272f5acbc24a` in Config;
   two Claude checks ("last meeting with The Eye Doctor", "Abela last 30 days"); review or delete the three
   meeting-created Staging cards.

## Phases (agreed 2026-09-09; six phases, timings set by Arun)

| Phase | Covers | Status |
|---|---|---|
| 1. Foundation | App, DB, config, Config tab, Google Cloud, Slack app | Done |
| 2. Intake | Slack, Chat + DMs, /task form, voice notes (short + long), email, noise filter, extract/classify, client detection | Done; email and long voice notes await their first live test |
| 3. Cards and sheet | Pulp Staging cards, drag approval, sheet rows + stamp, Done sync, nudges, daily summary | Done |
| 4. Hub | MCP with per-person keys, sheet history mirrored every 10 min | Done (milestone C) |
| 5. Meetings and routing | Meet notes from the Drive folder, scope gate | Done. New-page chain dropped 2026-09-10 (pages are mostly one person's work now; PM adds extra cards by hand) |
| 6. Soak and handover | 2 hours on live traffic with filter tuning; 1 hour team brief + one-page guide. Plan: `docs/SOAK.md` | starting |

After go-live, one hour each when wanted: weekly per-client digest, approval-loop nudges, auto-move Staging → To Do.

## Environment variables in Vercel (names only)

`storage_DATABASE_URL` (Neon), `ANTHROPIC_API_KEY`, `LLM_MODEL` (optional), `CRON_SECRET`, `SLACK_CLIENT_ID`,
`SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`, `GOOGLE_SERVICE_ACCOUNT_B64`, `GOOGLE_PROJECT_NUMBER`, `PM_SHEET_ID`,
`GCHAT_REVIEW_SPACE`, `GCHAT_INTAKE_SPACE`, `REVIEW_SURFACE=gchat`. Optional: `STAFF_EMAILS`, `RAW_RETENTION_DAYS`,
`INTAKE_PAUSED`, `PULP_TOKEN` (required for cards), `PULP_BASE_URL` (only if not `<base_url>/api/v1`), `REVIEW_MODE`.

## Useful commands (replace the secret with the real CRON_SECRET)

```
curl -H "Authorization: Bearer <CRON_SECRET>" "https://pm-tasks.vercel.app/api/setup"          # apply schema, seed
curl -H "Authorization: Bearer <CRON_SECRET>" "https://pm-tasks.vercel.app/api/sheet-check"    # tabs + header mapping
curl -H "Authorization: Bearer <CRON_SECRET>" "https://pm-tasks.vercel.app/api/pulp-check?create=1"  # Pulp key, boards, lists
https://pm-tasks.vercel.app/api/health                                                          # what is configured
```
