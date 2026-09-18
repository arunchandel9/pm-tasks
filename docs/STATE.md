# MangoEyes Task Hub — current state

The full feature list, with status and the final-round checks, is `docs/FEATURES.md`. Keep both files current: a
feature is added or dropped there first, decisions and IDs are recorded here. Standing rule from Arun (2026-09-10):
nothing built may go unnoticed. Every feature appears in FEATURES.md, in the handover guide, in the handover message
and in any cost or summary document. `tests/features.test.ts` fails when an endpoint or module is not in FEATURES.md.

Read `docs/ARCHITECTURE.md` first for the whole system as it runs today; this file is the operational memory behind
it: what is decided (dated), the IDs, what is verified, what is open. `PLAN.md` holds the original design rationale.
Entries below are dated; a later entry supersedes an earlier one (for example the Intake space and the 5/60-minute
nudges described in older entries are gone: Drop space and 20 min / 1 h / 1 day / daily reminders since 2026-09-15).
Keep it updated with every change.

Last updated: 2026-09-18 (PMs board rules, short headlines, `main` branch; `CLAUDE.md` is the entry point).

## Decisions finalised

- **2026-09-15, soak decisions (Arun):** one Staging list for every card, no Needs scope gate (`gated` off in
  `config/routing.yaml`); no client or internal boards, every card on a department board; one MCP key per Claude
  account, the hub asks who is filing ("Anuj via Claude-Arun"); the kill switch stays untested until ever needed;
  Slack checks wait for the first real client message; the feed is one line per message with everything else in the
  thread. Bug fixed the same day: a sheet row with a card link but a blank Task cell was skipped by the mirror (now
  mirrored, title filled from the card). Added: `from`/`to` calendar days on every MCP look-back tool. Handover:
  `docs/GUIDE.md` (one page per role), `docs/OPS.md` (operations), `docs/TEAM-BRIEF.md` (the message for the feed),
  `docs/POST-LAUNCH.md` (what is left to watch and what could come next).
- **2026-09-18, headlines (Arun):** a feed headline says what the thread is about and nothing more: client, what
  happened, source. Titles, the sender's words, card links, tagged names, tallies and counts live in the thread. Every
  headline shape changed: `🆕 *HOH* · new task · Dev · Slack, Dr Mehta` (`🔴 … · P1 task`, `… · 3 new tasks, one P1`),
  `🔁 *HOH* · update to a task · …`, `ℹ️ *HOH* · noted, no task · …`, `⚠️ *HOH* · client unhappy, reply needed · …`,
  `❓ *Which client?* · Task Hub, Arun`, `💬 *Abela* · no reply for 20 min · Slack`, `📝 *Introduction Call* · TED · 15 Sep`
  (tally and notes link are the first reply, rewritten as jobs finish), `📋 *Daily brief · Mon 14 Sep*` (counts open the
  thread). Reason: the headline carried the whole context and the thread repeated it. The rule applies to every future
  feed line. Kept in the headline on purpose: the client name (how the feed is scanned) and the P1 mark.
- **2026-09-18, `main` branch (Arun):** the repository now has a `main` branch, created from the working branch at the
  PMs board commit. Work continues on `claude/mangowise-task-automation-3qnd3k`; a finished change is merged into `main`.
  Arun switches GitHub's default branch and Vercel's Production Branch (project `pm-tasks` → Settings → Git) to `main`;
  until then Vercel still deploys the working branch.
- **2026-09-18, PMs board (Arun):** asks that belong to no department (general: coordination, follow-ups, "share the
  document") and MangoEyes-internal items go to a **PMs** board, where a PM decides what they are; the Development board
  is no longer the catch-all. Pulp's API has no board creation, so Arun created it by hand the same day, named
  **"PMs - Board"** (`config/boards.yaml` uses the exact name). Rules that came with it: (1) a card on the PMs board gets
  **no sheet row from the hub** (`sheet: manual`); the drag out of Staging is still the approval, and the PM adds the row
  by hand when wanted, after which Status follows the card like any hub card (the mirror adopts the row within 10
  minutes and fills a blank Task cell from the card title). (2) **Moving a card to another board counts like any drag
  out of Staging**: Development Staging → Writers To Do, or PMs Staging → SEO To Do, writes the sheet row at once with
  the department of the new board; only moves within the PMs board's own lists write nothing. A card with a row keeps
  it whatever board it moves to; rows are found by card id, so the board part of the link may change. The hub puts the
  `Task Hub` and client labels back on the new board. Sibling fixed on the way: approval from the feed thread ("yes")
  now moves the card to the department's default To Do when the client has no board override (before, only overrides
  moved it).
- **2026-09-17, nothing runs silent (after the first two live days):** the Meet reader had stood still for a day
  inside the minute loop (a long meeting outran the function budget, the run died without a trace, and that minute's
  mailbox and queue steps died with it). Now: meetings run in their own 5-minute cron (`/api/meet-tick`), at most two per
  run, a trace written before every slow step, a doc set aside after three cut-short attempts; the minute loop keeps a
  budget (queue stops at 50 s, Pulp poll at 95 s); the health page returns 503 and the brief lists an Issue when any
  reader's heartbeat is stale (5 min; Meet 20 min); every Slack event is recorded with its outcome and `/api/slack-check`
  shows per workspace which channels the bot is in (nine workspaces had the app but no invites). Meetings: only the
  agency's actions become cards, the client's to-dos are listed; the sorter knows the team by name; the headline is the
  call's name; a doc Gemini has not finished is left for later; action items run as queue jobs of five; a message never
  matches its own cards. Old test cards and the soak records were purged; the daily brief lists every item.
- **2026-09-15, Slack (Arun):** no test with an outside actor; the Slack path is built to the feed standard and proves
  itself on the first real client message. Reply reminders at 20 min, 1 hour, 1 day, then daily until a team reply or
  the Acknowledged button; never for thank-yous or messages the model reads as closing. Install is a browser step per
  workspace (`/api/slack/install`), invites from the Slack app; the workspace links itself to the client by name, or
  from the first "which client?" answer. `files:read` added for voice clips (Abela to be reinstalled once).

- **2026-09-11, Google Chat surfaces:** the DM with the Task Hub app is the front door (forward, type, voice, `/task`; no
  mention). The Intake space is retired (a space app only gets mentioned messages; the Workspace Events API could
  change that later, about an hour plus admin scopes, not for go-live). The review space stays, renamed by Arun
  (hub knows it by ID `AAQAjieDBM4`). Source label for DM messages: "Task Hub, <name>". Feed wording: "the feed". Feed space renamed "Task Hub Feed".
  App install: manual, one click per person (Chat → + → Apps → Task Hub → Install). Chat app visibility box (Cloud
  Console → Chat API → Configuration) holds the Google Group `all.team@mangoeyesagency.com`; do not edit it again:
  each change re-evaluates the app for every account and on 2026-09-14 it detached the app from Arun's phone
  (share sheet showed only the service-account contact, "Direct message couldn't be created"). Reinstalling the app
  fixed it. The `task-hub@…` contact in Chat is the service account (from Drive sharing), never the app. Marketplace admin push
  considered 2026-09-11 and not done (three console prompts exist in the session if ever wanted). Guide step 1.
  **Correction 2026-09-14:** the share-sheet failure was not the visibility box. Google's "Send to" sheet lists spaces
  and directory people; an app's DM appears only while it is fresh in the phone's cache (proved: open the DM, send
  "test", and the app is back in the list). So the phone path is the space **Task Hub Drop** (register row 1.13),
  read by the hub itself every minute as Arun; the DM stays for typing on a computer. Space avatars are emoji only:
  Drop 📥, Feed 📋, both on the orange background.

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
- **Email intake** (built 2026-09-09). The intake address is an alias of arun@mangoeyesagency.com, so
  `GMAIL_MAILBOX=arun@mangoeyesagency.com` and `GMAIL_INTAKE_ADDRESS=taskhub@mangoeyesagency.com,intake@mangoeyesagency.com`
  (renamed 2026-09-14 on Arun's decision; comma-separated list, drop intake@ once the team has switched). Domain-wide delegation added for service-account unique id 117215744015492300607 with gmail.readonly +
  gmail.modify. Service account project role: Storage Admin only (for the voice bucket).
  Service account impersonates it via domain-wide delegation (scopes gmail.readonly + gmail.modify). Every minute:
  mails to the intake address without the Gmail label "Task Hub" (newer than 3 days) are parsed (forwards read from
  the inside: original sender + body; quoted history dropped), noise-filtered (`emailNoise`), client resolved from
  subject/note prefix → original sender's domain → text, run through the pipeline as channel `email`, then labelled.
  `/api/gmail-check` proves the connection; `gmail_poll_last` on /api/health shows the last run.
- **Meeting notes** (built 2026-09-10, untested until a folder is shared). Each organiser shares their Drive folder
  "Meet Recordings" or "Google Meet" (Google made one or the other, per account and date) with the service account
  once (Viewer); since 2026-09-11 the hub does not walk folders but queries every "… Notes by Gemini" doc it can
  see at any depth, shortcuts resolved (Google's newer layout is "Google Meet/<meeting> - <date>/"), plus any doc shared
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
  (headline `🆕 *HOH* · new task · Dev · Slack, Dr Mehta` since 2026-09-18, the card line with title and link in the thread; P1 lines start with 🔴). Messages that belong to an
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

## Open items (as of 2026-09-15, go-live day)

Everything from the build and soak is closed. What remains proves itself on real traffic: the first client message in
a Slack channel (feed line, card, reply reminders), the next real Meet call with Gemini notes, a voice note over 10
minutes, and the first daily brief. Arun's remaining housekeeping: remove the old `intake@` alias once the team uses
`taskhub@`; rename the Pulp list "Dependancy" to "Dependency". Ideas for later are in `docs/POST-LAUNCH.md`.

Older items, all done: Config tab (15 clients), Chat live tests, Pulp key and Staging lists, duplicate To Do lists
archived, mailbox named, Slack installed per client workspace by Arun, new-page chain dropped, uptime monitor set,
board override kept but unused (decision: department boards only), test cards, rows and records purged before go-live.

## Phases (agreed 2026-09-09; six phases, timings set by Arun)

| Phase | Covers | Status |
|---|---|---|
| 1. Foundation | App, DB, config, Config tab, Google Cloud, Slack app | Done |
| 2. Intake | Slack, Chat + DMs, /task form, voice notes (short + long), email, noise filter, extract/classify, client detection | Done; email and long voice notes await their first live test |
| 3. Cards and sheet | Pulp Staging cards, drag approval, sheet rows + stamp, Done sync, nudges, daily summary | Done |
| 4. Hub | MCP with per-person keys, sheet history mirrored every 10 min | Done (milestone C) |
| 5. Meetings and routing | Meet notes from the Drive folder, scope gate | Done. New-page chain dropped 2026-09-10 (pages are mostly one person's work now; PM adds extra cards by hand) |
| 6. Soak and handover | 2 hours on live traffic with filter tuning; 1 hour team brief + one-page guide. Plan: `docs/SOAK.md` | Done 2026-09-15 except what only real traffic can prove (first Slack client message, next Meet call, tonight's brief). Handover pages written; team brief ready to post |

After go-live, one hour each when wanted: weekly per-client digest, approval-loop nudges, auto-move Staging → To Do.

## Environment variables in Vercel (names only)

Required: `storage_DATABASE_URL` (Neon; any `*_DATABASE_URL` or `POSTGRES_URL` is accepted), `ANTHROPIC_API_KEY`,
`CRON_SECRET`, `GOOGLE_SERVICE_ACCOUNT_B64`, `GOOGLE_PROJECT_NUMBER`, `PM_SHEET_ID`, `GCHAT_REVIEW_SPACE` (the feed),
`PULP_TOKEN`, `GMAIL_MAILBOX` (arun@), `GMAIL_INTAKE_ADDRESS` (comma-separated intake aliases), `SLACK_CLIENT_ID`,
`SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`.
Optional, with defaults: `LLM_MODEL` (claude-sonnet-5), `REVIEW_SURFACE` (gchat), `REVIEW_MODE` (notify),
`GCHAT_INBOX_NAME` ("Task Hub Drop"), `CHAT_READER` (defaults to `GMAIL_MAILBOX`; the account the Drop space is read as),
`GCHAT_ENDPOINT_URL`, `GCHAT_INTAKE_SPACE` (retired space), `PM_SHEET_CONFIG_TAB` (Config), `PULP_BASE_URL`,
`STAFF_EMAIL_DOMAINS` (mangoeyesagency.com), `STAFF_EMAILS`, `VOICE_BUCKET`, `VOICE_BUCKET_LOCATION`, `SPEECH_V2` (off = v1 engine only), `SPEECH_V2_TRIES`,
`SLACK_BOT_TOKEN` (fallback only), `SLACK_REVIEW_CHANNEL`, `SLACK_INTAKE_CHANNEL`, `SLACK_P1_CHANNEL`,
`RAW_RETENTION_DAYS` (0 = keep everything), `INTAKE_PAUSED` (the kill switch).

## Useful commands (replace the secret with the real CRON_SECRET)

```
curl -H "Authorization: Bearer <CRON_SECRET>" "https://pm-tasks.vercel.app/api/setup"          # apply schema, seed
curl -H "Authorization: Bearer <CRON_SECRET>" "https://pm-tasks.vercel.app/api/sheet-check"    # tabs + header mapping
curl -H "Authorization: Bearer <CRON_SECRET>" "https://pm-tasks.vercel.app/api/pulp-check?create=1"  # Pulp key, boards, lists
https://pm-tasks.vercel.app/api/health                                                          # what is configured
```
