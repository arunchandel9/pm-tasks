# MangoEyes Task Hub — current state

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
- **Data retention.** Keep everything forever. `RAW_RETENTION_DAYS` exists but is off (0).
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
- **Milestone B reached 2026-09-09:** dragging the Dev card out of Staging wrote the row into the "HOH - House Of Health"
  tab within a minute (poll → approveRequest moveCard:false → insertTaskRow with stamp "approved by drag in Pulp").
  Card → Done then set Status "Done" and moved the row below the DONE divider (after the by-id poll fix).
- Unit tests: 59 passing (`npm test`). Build clean.

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

## Next build steps (owner: hub)

- Confirm Pulp client against the real API; create Staging cards; drag-out-of-Staging = approve; stage → sheet.
- Email intake: alias `intake@mangoeyesagency.com` on one mailbox + Gmail label, read via Gmail API.
- Edit / Merge dialogs in PM Review cards.
- Daily summary posting to PM Review (route exists, cron 17:30 UTC weekdays).
- MCP hub for PMs' assistants; Google Meet notes from the Drive folder; scope gate; new-page chain; asset handoff;
  weekly digest; approval-loop nudges.

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
