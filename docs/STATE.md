# MangoEyes Task Hub — current state

Read this first when resuming. It is the operational memory of the project: what is decided, what exists,
what is verified, what is open. `PLAN.md` holds the design rationale; this file holds the live state.
Keep it updated with every change.

Last updated: 2026-09-08 (build day 1).

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
- **Review.** Everything to PM Review first (shadow mode) + a real card in a Pulp `Staging` list; Approve in Chat or
  drag out of Staging. Gate opens per request type after 30 approvals with ≥95% unedited, never before day 3.
  Meetings always reviewed.
- **PM Overview sheet** (`1NXjvbfpJB36pb0BkkG08JEcUa35AxQ3PV5Nsj95I9-8`, shared with the service account as Editor).
  Tasks are written into **each client's own tab** under its existing headers
  (S. NO. | TASK | PULP/CARD LINK | DATE ADDED | DUE DATE | PRIORITY | ASSIGNED TO | STATUS | DEPARTMENT | COMMENTS):
  next serial, `DD-MMM-YYYY` dates, department labels (Development/Content/Graphics/SEO/PM), Status "To Do",
  "Task assigned." in Comments, inserted **above the DONE divider**. After creation the hub only updates Status and
  Date Completed. Priority/Assigned To/Comments are write-once. The **Config** tab is the client directory only
  (id, name, scope, slack_team_id, aliases, email_domains, whatsapp_numbers, board overrides, client_facing_ack,
  sheet_tab), mirrored into the DB every minute.
- **Pulp.** `https://pulp.mangoeyes.io`, boards per department shared by all clients: SEO `d4424c02`,
  Content `54d3e767`, Development `0fac54b7`, Graphics unknown (config/boards.yaml). API endpoints are a
  Trello-style guess in `src/lib/pulp.ts` until confirmed. Status sync polls every minute until Pulp has a webhook.
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
- Unit tests: 50 passing (`npm test`). Build clean.

## Open items (owner: Arun)

1. Config tab: insert `sheet_tab` at AB, paste the 15 client rows (prompt given), set link headers.
2. First Google Chat live test: `@Task Hub HOH: …` in Intake → drafts in PM Review → Approve → row in
   "HOH - House Of Health". Then `/task`.
3. Install Slack app into one client workspace; put its T-id in that client's Config row (column D).
4. Pulp: API auth + endpoints (boards, lists, cards, comments), Graphics board id, `Staging` list on each board.

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
`INTAKE_PAUSED`, `PULP_BASE_URL`, `PULP_TOKEN`.

## Useful commands (replace the secret with the real CRON_SECRET)

```
curl -H "Authorization: Bearer <CRON_SECRET>" "https://pm-tasks.vercel.app/api/setup"          # apply schema, seed
curl -H "Authorization: Bearer <CRON_SECRET>" "https://pm-tasks.vercel.app/api/sheet-check"    # tabs + header mapping
https://pm-tasks.vercel.app/api/health                                                          # what is configured
```
