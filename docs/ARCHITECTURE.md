# MangoEyes Task Hub — the whole system, as it runs today

Current as of 2026-09-15 (go-live). This is the one document that describes the complete infrastructure and the complete
concept, end to end. `docs/STATE.md` holds the dated decisions and IDs behind it; `docs/FEATURES.md` is the row-by-row
register with statuses. Where an older document differs, this one and STATE.md win.

## 1. Purpose, in one paragraph

Clients (aesthetic clinics) ask for work through WhatsApp, email, Slack and meetings. The hub receives every such ask
from wherever it arrives, understands it, and sorts every item into one of five things: a task, a reminder, an idea, a
rule or a note. A task is proposed in the feed as a card with four pre-filled dropdowns; one tap makes the Pulp card in
To Do, assigned, and writes the row into the client's tab of the PM Overview sheet. A reminder comes back to the person
who asked, at its time, until Done; an idea comes back on Monday for a decision; a rule is printed on that client's
cards; a note is on record. The hub
keeps the row's Status in step with the card for the rest of its life, reports every event as one line in a Google
Chat feed, and keeps the whole record so anyone can ask "what is pending for Abela" or "what happened on 12 March"
from Claude. The team never types tasks by hand and nothing that comes in can leave without a visible trace.

## 2. Infrastructure

| Piece | What | Where / ID |
|---|---|---|
| Application | Next.js 16 (App Router, TypeScript), Node runtime. One deployment serves every endpoint. | Vercel project `pm-tasks`, https://pm-tasks.vercel.app, branch `claude/mangowise-task-automation-3qnd3k` (every push deploys in about 2 minutes) |
| Database | Postgres (Neon, via the Vercel integration). Twelve tables (section 4). Kept forever. | env `storage_DATABASE_URL` |
| Schedules | Vercel Cron. `/api/tick` every minute (with a budget: queue stops at 50 s, Pulp poll at 95 s; Pulp cards fetched ten at a time, Staging cards every minute, the rest and hand-made cards every 2 minutes, so the function lives a few seconds, not the whole minute); `/api/inbox-tick` every minute (three reads inside it, at 0/20/40 s); `/api/meet-tick` every 5 minutes (meetings in their own budget, two per run, trace before every slow step); `/api/eod` at 04:30 UTC Monday to Friday (10:00 India: the Today brief, and Monday's ideas). All authenticated with `CRON_SECRET` as a bearer token. | `vercel.json` |
| Model | Claude (Anthropic API), `claude-sonnet-5` by default, structured JSON output, prompt caching on the instructions (1 hour). Two calls per message: extract, then classify per ask; one call per meeting. Every call logged with tokens and cost in `llm_calls`. | env `ANTHROPIC_API_KEY`, `LLM_MODEL` |
| Google Cloud project | `mangoeyes-task-hub` (number `354018118635`). APIs on: Chat, Sheets, Drive, Gmail, Speech-to-Text, Cloud Storage. | env `GOOGLE_PROJECT_NUMBER` |
| Service account | `task-hub@mangoeyes-task-hub.iam.gserviceaccount.com` (unique id `117215744015492300607`). Acts as the Chat app, reads and writes the sheet (shared with it as Editor), reads Meet notes (folders shared with it as Viewer), runs Speech-to-Text, owns the voice bucket. | env `GOOGLE_SERVICE_ACCOUNT_B64` (the JSON key, base64) |
| Domain-wide delegation | The service account may act as `arun@mangoeyesagency.com` for two scopes only: `gmail.readonly` + `gmail.modify` (the intake mailbox) and `chat.messages.readonly` (reading the Drop space). Authorised in the Google Admin console. | env `GMAIL_MAILBOX`, `CHAT_READER` |
| Google Chat app | "Task Hub", add-on style, HTTP endpoint `/api/gchat`, visible to the Google Group `all.team@mangoeyesagency.com` (Cloud Console → Chat API → Configuration; do not edit that box). Avatar is an image URL served by the app (`/avatars/…`). | env `GCHAT_ENDPOINT_URL` |
| Chat spaces | **Task Hub Feed** (📋) `spaces/AAQAjieDBM4`: the record. **Task Hub Drop** (📥) `spaces/AAQA-Dk7A_k`: phone shares, found by name. The **DM** with the app: typing from a computer. The old Intake space `AAQAUYuXnAc` is retired. | env `GCHAT_REVIEW_SPACE`, `GCHAT_INBOX_NAME` ("Task Hub Drop") |
| Intake mailbox | `taskhub@mangoeyesagency.com`, an alias of arun@ (the old `intake@` alias is to be removed). Polled every minute as arun@. Processed mail gets the Gmail label "Task Hub". | env `GMAIL_INTAKE_ADDRESS` (comma-separated) |
| Slack app | "Task Hub", one app, distributed, installed per client workspace via OAuth (`/api/slack/install` → `/api/slack/oauth`), bot token stored per workspace. Events to `/api/slack/events`. Scopes: channels/groups history and read, chat:write, reactions, users:read(.email), commands, team:read, files:read. Home workspace MangoEyes `T05941HP5A4`. | env `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`; `slack-manifest.yaml` |
| Pulp | The task board. API v1 at `https://pulp.mangoeyes.io/api/v1`, bearer token acting as arun@ (member of every board). Six department boards: Development `0fac54b7…`, Writers `54d3e767…`, Graphics `088afc03…`, SEO `d4424c02…`, Onboarding & Automations `ec7258b2…`, Video `8f4eb438…`, plus **PMs - Board** (by exact name) for general and internal asks. Each has a Staging list. Card links `<base>/board/<board>?card=<card>`. | env `PULP_TOKEN`, `PULP_BASE_URL`; `config/boards.yaml` |
| PM Overview sheet | The PMs' record. One tab per client (headers: S. NO., TASK, PULP/CARD LINK, DATE ADDED, DUE DATE, PRIORITY, ASSIGNED TO, STATUS, DEPARTMENT, COMMENTS, some with DATE COMPLETED) with a DONE divider row; a **Config** tab that is the client directory. | env `PM_SHEET_ID`, `PM_SHEET_CONFIG_TAB` |
| Speech-to-Text | v2 (Chirp 3, then Chirp 2, then "long") with v1 fallback; vocabulary hints from client names and agency words. Notes under about a minute run synchronously; longer ones go to a Cloud Storage bucket and a long-running job polled every minute. | env `VOICE_BUCKET`, `VOICE_BUCKET_LOCATION`, `SPEECH_V2`, `SPEECH_V2_TRIES` |
| MCP server | `/api/mcp/<key>` over Streamable HTTP. One key per Claude account, stored hashed. Connected as a custom connector in every team Claude account. | `docs/MCP.md` |
| Health | `/api/health` (no auth): configuration flags, last run of every poll, recent activity; HTTP 503 when the minute loop is older than 5 minutes or any reader's heartbeat is stale (mailbox, Drop space, Pulp, sheet cards: 5 min; Meet: 20 min), listed under `stale`. An uptime monitor watches it. `/api/slack-check` shows per workspace which channels the bot is in. | |

Secrets never live in the repository; only their names do (full list in `docs/STATE.md`).

## 3. Code map

```
src/app/api/
  tick/          the minute loop (section 5)              inbox-tick/   reads the Drop space three times a minute
  gchat/         Google Chat events (DM, feed thread replies, card clicks, dialog)
  slack/events   Slack events, /task command, buttons      slack/install, slack/oauth   per-workspace install
  eod/           the daily brief (?dry=1 previews)         mcp/[key]/    the MCP server
  health/ setup/ sheet-check/ sheet-sync/ pulp-check/ gmail-check/ meet-check/   operations
src/lib/
  pipeline.ts        the one path every message takes (store → filter → dedupe → understand → route → card → feed)
  chat-intake.ts     one Chat message from a person (DM or Drop): names, voice notes, questions in the thread
  chat-inbox.ts      reading the Drop space as a person      gchat.ts / gchat-events.ts   Chat API, cards, event shapes
  gmail.ts           mailbox: forwards, signatures, quoted history, attachments
  slack.ts / normalize/slack.ts   workspaces, tokens, who is who, Slack markup → words, workspace ↔ client linking
  slack-replies.ts   reply reminders (20 min / 1 h / 1 day / daily) and the Acknowledged button
  meet.ts            Gemini notes from Google Meet → actions, ideas, decisions
  transcribe.ts      Speech-to-Text, short and long
  filter/noise.ts    what never reaches a model              dedupe.ts   repeats against open requests
  resolve.ts         client matching (prefix, whole-word name/alias, domain, number, thread, suggestion)
  llm/extract.ts, llm/classify.ts, llm/meeting.ts, llm/client.ts   the model calls, caching, cost log
  route.ts / config.ts   deterministic routing from config/*.yaml
  tasks.ts / pulp.ts     card creation (from a proposal), labels, card comments, client rules
  proposal.ts            the proposal card: options, posting, the tap or the typed answer
  reminders.ts / when.ts reminders and plain-language timing        ideas.ts   Monday's ideas post
  sheets.ts / sheet-sync.ts / sheet-cards.ts   rows, stamps, mirror, hand-made cards
  review.ts          the feed: headlines, thread details, cards, thread topics
  reprocess.ts       re-run a stored message the moment a person answers
  brief.ts           the daily brief                         hub.ts   the read side (MCP tools, summaries, date windows)
  db.ts / schema.ts / mcp-keys.ts / auth.ts / types.ts
config/  boards.yaml (boards, lists), routing.yaml (request types, departments, SLAs, labels, P1 words),
         sheet.yaml (columns, stamp, colours), noise.yaml (filters, dedupe window, reminder marks, daily cap)
db/schema.sql   applied by /api/setup (idempotent)        tests/   107 unit tests (vitest)
```

## 4. Data model (Postgres)

| Table | Holds |
|---|---|
| `clients` | The client directory, mirrored from the Config tab every minute: id, name, scope (client / internal), aliases, email domains, WhatsApp numbers, Slack workspace id, sheet tab, board overrides. |
| `messages` | Every incoming message, stored before anything else: channel (`intake` = Chat DM/Drop, `email`, `slack`, `task_cmd` = Claude or the form, `meet`), external id (unique per channel), client, sender, text, hash of the sender's own words, permalink, thread ref, raw envelope, `skip_reason` when nothing was made (see section 6). |
| `requests` | One row per distinct ask found in a message: summary, quote, request type, department, priority with reason, draft title/description, status (`pending_review` in Staging, `approved`, `merged` into another, `dismissed`). |
| `tasks` | One row per card: hub-made (`origin = hub`, from a request) or sheet-mirrored (`origin = sheet`). Pulp card and board ids, list id, sheet tab/row/status, assignee, due, created/completed, `last_moved_at`. |
| `status_events` | Every list move of a card (from, to, when, source). |
| `llm_calls` | Every model call: step, model, tokens in/out/cached, cost, latency, message. |
| `queue` | Background jobs with backoff: `create_card`, `sync_sheet`, `card_comment`, `process_message`, `transcribe_poll`, `reply_check`. Abandoned after 8 attempts and reported. |
| `meetings`, `meeting_items` | Each Gemini notes doc read: title, date, client, organiser, summary, notes; items typed action / idea / decision / discussion with owner, due text, outcome. |
| `slack_workspaces`, `slack_users` | Bot token per workspace; who is staff (by email domain) per user. |
| `settings` | Key-value: poll reports (`*_last`), Chat thread topics, reminder marks, acknowledgements, MCP keys (hashed), the Drop space id, cursors. |

Retention: everything forever. `RAW_RETENTION_DAYS` exists (off) and would only drop the raw envelope of old messages.

## 5. The minute loop (`/api/tick`) and the other schedules

Every minute, in order: refresh the client map from the Config tab → (every 10 min) mirror every client tab into
`tasks` → poll the mailbox → run due queue jobs (until 50 s) → poll every hub card in Pulp by id (until 95 s)
(status sync, approvals) → check up to 40 hand-made cards in rotation → (every 10 min) watchdog → heartbeat `tick_last`.

`/api/meet-tick`, every 5 minutes, reads new Meet notes: at most two meetings per run, a second only with most of the
budget left, a trace written before every slow step, a doc set aside after three cut-short attempts.
`/api/inbox-tick`, every minute, reads the Drop space at 0, 20 and 40 seconds (two-minute budget so a round that
transcribes and runs the model is never cut short). Google Chat pushes DM messages and clicks to `/api/gchat` in real
time. Slack pushes events to `/api/slack/events` in real time (acknowledged within 3 seconds, processed after).
`/api/eod` posts the Today brief at 10:00 India, Monday to Friday, and Monday's ideas post. Reminders due are posted by the minute loop (step 3b) and repeated at 10:00 India until Done.

## 6. The path of one message (`pipeline.ts`)

1. **Store first.** The message is written to `messages` before anything else, idempotent on (channel, external id). A re-run (a person picked the client, or said "make it a task") updates that row in place; it is never deleted.
2. **Reply timer (Slack only).** A client-authored Slack message queues reply checks at the marks in `config/noise.yaml` (20 min, 60 min, 1440 min).
3. **Noise filter, no model.** Acknowledgements ("ok thanks", 👍), too short, bot messages, Slack subtypes, staff messages in client channels, image-only posts: stored with a reason, nothing else. An image-only post asks the sender to type the ask.
4. **Pause switch.** `INTAKE_PAUSED=true` parks the message (retried every 5 minutes) until switched off.
5. **Unknown client.** No client → stored as `unknown_client`; the DM/Drop sender is asked in their thread; other channels get a "❓ Which client?" headline in the feed with a dropdown card in its thread. Picking or typing the client re-runs the message at once (`reprocess.ts`).
6. **Thread follow-up, no model.** A short reply inside a thread that already became a task is added as a comment on that card; "any update?" flags the card as client-waiting.
7. **Repeats, no model.** The hash of the sender's own words (quoted history excluded) is compared with open requests of the same client within 14 days: an exact or very similar repeat is commented onto the existing card and the feed shows a 🔁 line with the card link.
8. **Daily cap.** Per-client cap on model calls per day (100) as a safety valve.
9. **Extract (model call 1).** Every distinct ask, with the sender's exact words, deadlines and URLs; `is_request`; `tone` (neutral / unhappy / urgent); `needs_reply`. Quoted mail history is passed as labelled context, never as the ask. Voice transcripts are told they are transcripts and kept to one ask unless clearly several. A stated problem ("… is not working") is an ask by rule whatever the model said.
10. **No ask.** Unhappy tone → `client_unhappy`, one ⚠️ feed line "a person should reply". Otherwise `no_ask`, kept on record, listed as an update.
11. **Classify (model call 2, per ask).** Request type, department, priority hint, title, description, and whether it matches an open request (duplicate / nudge / change). Matches become card comments and a 🔁 line, never a new card.
12. **Route, no model.** `config/routing.yaml` decides board, list (To Do), labels, SLA due date; P1 keywords, or the sender saying urgent, force P1 with a 4-hour due. Request types marked `no_card` (updates, questions, ideas) make no card but never go silent: one ℹ️ "noted, no card" line.
13. **Kind, then proposal.** Every item is one of five kinds (extract). A reminder, idea, rule or note is stored and gets its line; only a task goes on: classify → route → a request in status `proposed` and a proposal card in the feed thread with Department, Assign to, Priority and Due pre-filled. Nothing reaches Pulp until a person taps Create card (then: card in To Do, assigned, labels, description with the original words and the client's rules, sheet row written) or types "create" in the thread. Remind me instead makes a reminder; No card makes nothing. Unanswered proposals are listed in the brief.
14. **Feed.** One headline per message: one card → its line is the headline; several → "🆕 Client · N cards" with a line per card in the thread. Details (the words, context, links) go in the thread as a boxed card. P1 adds a 🔴 line. Meetings post their card lines inside the meeting's own thread.

## 7. Each channel's mechanics

**Google Chat DM and Drop space (`chat-intake.ts`, `chat-inbox.ts`).** Same handler for both. Text and attachments. Audio (by type, name, or the first bytes, since WhatsApp notes arrive without an extension) is transcribed; a "🎙️ Voice note received, transcribing…" placeholder is edited into "Heard: …" when done. Client resolution: "Client:" prefix → whole-word name or alias → the thread's client → a name the same person typed in the last 15 minutes. A near-miss heard in a voice note is a suggestion only ("I heard 'a bella', is it Abela? Reply yes, or the client name"); aliases under five letters never match by sound. A message that is only a name (plus filler) is a hint for the next forward, not an ask. Replies in the thread: only when the sender must act, when nothing was created, or to show what was heard. The Drop space is read as arun@ (Google does not push unmentioned space messages to an app); only messages after the hub first looked; a mention there is ignored so nothing runs twice. Sender names come from the space's member list.

**Email (`gmail.ts`).** Query: to any intake address, not yet labelled, newer than 3 days, not spam/trash/drafts. Forwards are unwrapped (original sender and body; the forwarded header block runs to the first blank line so wrapped To/Cc lines never leak). Signatures, "Sent from …", Google Groups footers are cut. Quoted history (Gmail "On … wrote", Outlook From/Sent/To/Subject blocks, "-----" rules, ">" lines) is split off and handed to the model as "Earlier in this thread (context only, not the ask)", capped at 1,500 characters. Client: subject/first-line prefix → sender's domain → text. Staff mail is dropped as outgoing only when it is neither a forward nor addressed To an intake address. Audio attachments are transcribed. Dedupe on Message-ID. Replies to the sender are threaded on the mail.

**Slack (`slack.ts`, `normalize/slack.ts`, `slack-replies.ts`).** One workspace per client; the workspace is tied to its client on install when the workspace name carries the client's name or alias, else by the first "which client?" answer (the Config row is written). Every non-staff message in a channel the bot is in is read; staff (by `mangoeyesagency.com` email) are ignored as senders but count as replies. Slack markup becomes words (`<@U1>` → `@Renu`, links → their label); senders are named, never ids. Voice clips are downloaded with the bot token and transcribed. The hub never writes anything in a client workspace, not a reply and not a reaction (the 👀 receipt was removed 2026-09-21); the feed is the receipt. Reply reminders: after 20 minutes without a team reply in that channel, one feed line naming whoever the client tagged; again at 1 hour (⏰), 1 day (🔴), then daily until a team reply or the Acknowledged button (or "ack" typed in the thread). Never for thank-yous, noise, repeats, or messages the model marks `needs_reply = false`. One reminder per channel per mark. The brief lists clients still waiting.

**Google Meet (`meet.ts`).** Each organiser shares their "Meet Recordings" / "Google Meet" folder with the service account once. Every 5 minutes the hub finds every "… Notes by Gemini" doc it can see (any depth, shortcuts resolved), modified after it first looked. One model call sorts the notes into actions, ideas, decisions, discussion and names the client per item (MangoEyes for internal). Actions go through the pipeline as channel `meet`; the feed gets one headline per meeting ("📝 Meeting · client · day · N cards · N ideas · notes"), with card lines, a short summary and the ideas/decisions inside its thread. A doc that cannot be opened is recorded once as not readable and never retried.

**Claude (`/api/mcp`).** Read tools: `list_clients`, `search_tasks`, `task_detail`, `client_summary`, `recent_messages`, `daily_summary`, `meetings`, `meeting_detail`, `ideas`, `decisions`, `people`, `hub_status`. Every look-back takes `days` or `from`/`to` calendar days (India time, inclusive). Reads are plain SQL, no model, no hub cost. The one write, `add_request`, requires the name the person gave when Claude asked "Who is this request from?" (accounts are shared) plus the client, the ask and the assignee (department, priority, due optional); the pipeline creates the card at once in To Do, assigned, sheet row written, and the feed shows the line and the outcome, no proposal card (2026-09-23). The label reads "Anuj via Claude-Arun". Approving, moving or closing cards from Claude is impossible by design.

## 8. Cards, approval, the sheet

- **The proposal is the inbox.** No Staging list since 2026-09-22: the hub proposes in the feed, a person confirms with one tap, the card lands in To Do assigned. Cards made before that still sit in Staging and drag still approves them.
- **Create card = approval.** The tap makes the card and writes the row into the client's tab above the DONE divider (for older Staging cards, the minute poll still sees the drag and does the same): next serial, title, department label, priority, assignee, Pulp link, source link, dates, Status, and the Comments stamp ("Task assigned. Added by Task Hub · approved by drag in Pulp · 15-Sep-2026 14:32 IST · from Slack, Dr Mehta"). New rows are light yellow ("check me, then whiten").
- **PMs board, rows by hand.** A card on the PMs board (`sheet: manual` in `config/boards.yaml`) gets no row from the hub: the drag out of Staging approves it, the PM adds the row when wanted (card link in the client's tab; the mirror adopts it within 10 minutes and fills a blank Task cell), and Status follows from there. Moving the card to a department board writes the row at that moment.
- **Board mirror.** Every five minutes each board in `config/boards.yaml` is read in one call and every card nobody else tracks is kept with origin `board` (list, labels, assignee, due, client from a label or the title), so Claude answers about hand-made cards that have no sheet row. Reads only; a card that left the board is marked Archived; a mirrored card that gets a sheet row is the sheet's from then on (2026-09-23).
- **Board changes.** A hub card moved to another board keeps its identity: the hub records the new board, re-derives the department from the board map (Department cell, card link, target list), puts the `Task Hub` and client labels back, and writes the row if the card had none and the new board is not the PMs board. Rows are found by card id, never by the board in the link.
- **Status follows the card** every minute: list name into Status (as spelled in Pulp), Done fills Date Completed where the tab has that column and moves the row below the divider; moving back out of Done reopens it. Rows are located by Pulp link, so PMs may reorder freely. The last status written is remembered per task and re-compared, so a failed write is retried until it matches.
- **Hand-made cards.** A card created directly in Pulp and linked in a row by hand (title optional) is picked up by the 10-minute mirror; the hub fills a blank Task cell from the card and then checks the card in rotation (40 a minute), writing Status only when the card moves; a typed status is never overwritten on first look.
- **Sheet mirror.** Every 10 minutes all client tabs are read into `tasks` (origin `sheet`), keyed per tab by card id or serial+title, so Claude answers from the PMs' whole record, history included. A row that leaves a tab (deleted or re-keyed) leaves the hub on the next run. The mirror never creates Pulp cards; its one sheet write is the Task cell of a hand-added hub card row that was left blank.
- **Config tab** = the client directory (id, name, scope, slack_team_id, aliases, email_domains, whatsapp_numbers, board overrides, client_facing_ack, sheet_tab), read every minute. Adding a client is one row plus one tab.

## 9. The feed (Task Hub Feed)

One line per source message at the top level; everything about it in that line's thread (the words, per-card lines
with titles and links, the "which client?" card, context, the tally of a meeting, the counts of the brief, the
voice-note notice, "nothing created"). The headline says only what the thread is about: the client, what happened,
the source ("Task Hub, Arun" / "Slack, Dr Mehta" / "Email, name" / "Anuj via Claude-Arun"), e.g. `🆕 *HOH* · new task ·
Dev · Slack, Dr Mehta`, `💬 *Abela* · no reply for 20 min · Slack`, `📝 *Introduction Call* · TED · 15 Sep`. Nothing
else goes in it (Arun, 2026-09-18): a headline that carries the content makes the thread a repeat of itself.
Icons: 🆕 card · 🔁 repeat noted on a card · ℹ️ noted, no card · ⚠️ unhappy client · ❓ needs a person · 📝 meeting ·
🔴 P1 · 💬 ⏰ 🔴 reply reminders · 📋 daily brief. Typed replies in a thread answer that thread: a client name, "not a
task", "make it a task", "approve", "merge", "ack". The receipt rule for the team: no line within 2 minutes → send again.

## 10. The daily brief

23:00 India time, weekdays, one headline ("📋 Daily brief · Mon 14 Sep · 6 new · 3 waiting on you · 1 issue · 2 overdue
· 4 done") with the detail in its thread. Sections only when non-empty: New today (with card links), Waiting on you
(Staging cards older than a day, unanswered questions, clients waiting in Slack, unhappy clients), Waiting on a client,
Issues (failed messages, cards not created, abandoned jobs, a read that failed, a stale minute loop), Overdue (hub cards,
P1 first), Done today. A quiet day is one line. `daily_summary` from Claude gives the longer text form for any day or range.

## 11. Reliability

Store first, always. Every write to Pulp or the sheet that fails goes to the queue with backoff (never re-approving).
The watchdog every 10 minutes re-runs messages left half-done (up to three times, then marks them failed with a line),
creates cards for tasks that have none, and reports jobs abandoned after 8 attempts. Health returns 503 when the minute
loop stalls; `hub_status` shows every poll's last run, queue errors and stuck messages. A message that fails is still on
record with a reason. Nothing is ever deleted by the hub.

## 12. Configuration without code

`config/boards.yaml` (boards, lists, card URL shape) · `config/routing.yaml` (request types, departments, SLA days,
labels, `no_card` types, P1 keywords, gating) · `config/sheet.yaml` (column aliases, stamp wording, timezone, status
values, new-row colour) · `config/noise.yaml` (acknowledgements, minimum lengths, dedupe window, reminder marks, daily
cap, skipped senders and subtypes) · the Config tab (clients) · Vercel environment variables (secrets and switches).

## 13. Operations (see `docs/OPS.md` for the commands)

Health page and uptime monitor · new client in three steps · Slack install per workspace (browser) and invites (app)
· one MCP key per Claude account · the kill switch · the clean-start commands used once before go-live
(`label_hub_cards`, `purge_hub_tests`, `clear_chat`) · what not to touch on the Google side.

## 14. Costs

Model: about two calls per message with cached instructions, a few dollars a month at hundreds of messages; logged per
call. Speech-to-Text about 2 cents per audio minute. Claude questions cost the hub nothing. Vercel, Neon and Google
Cloud on their current plans.

## 15. Decisions that shaped it (the short list; dates in STATE.md)

Five kinds, only a task is proposed, one tap makes the card in To Do assigned · the feed is the receipt, one line per message · a client is set
only with full clarity · nothing leaves without a trace (no-card, unhappy, repeat lines) · Claude reads freely, writes
only with a named person · department boards only · the phone path is the Drop space because Google's share sheet does
not list an app's DM reliably · everything kept forever · Slack proves itself on real traffic (no outside tester) ·
the kill switch stays untested until needed · Ads/CRM/analytics stay on each person's own Claude connectors.

## 16. Known limits and what comes next

Long voice notes above 163 seconds are built but not yet seen live; the first real Slack client message, the next Meet
call and the first brief prove themselves on traffic. Chat has no bulk delete for people's messages. Reading the Drop
space relies on domain-wide delegation as arun@ (a per-user sign-in is a later option). The rest of the ideas are in
`docs/POST-LAUNCH.md`.
