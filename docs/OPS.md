# Task Hub — operations (Arun)

Everything you may need to do or check. Replace `<SECRET>` with the value of `CRON_SECRET` in Vercel.

## Is it alive?

- **https://pm-tasks.vercel.app/api/health** → `ok: true`, every `…Last` within its interval, `queueErrors: []`. Returns 503 when the minute loop is older than 5 minutes; the uptime monitor alerts on that.
- In Claude: **"hub status"** → the same, readable.
- In the feed: the daily brief's **Issues** section (only appears when there is one).

## When the feed is quiet and it should not be

1. Health page: `ok` true? `tickAgeSeconds` under 120?
2. The channel's last poll: `chatInboxLast` (Drop space), `gmailPollLast` (mail), `gchatLastEvent` (DM), `meetPollLast`. Each shows `errors`.
3. `queueErrors` and `stuckMessages` in hub status. A stuck message is retried by the watchdog every 10 minutes, up to three times, then reported as an Issue in the brief.
4. Still nothing: ask the person to send it again (the receipt rule), and tell me what the health page said.

## Add a client

1. PM Overview → **Config** tab → one row: `id` (short, lowercase, no spaces), `name`, `scope` = client, `aliases` (the short names people say: "TED", "Eye Doctor"), `email_domains` (the clinic's mail domain), `whatsapp_numbers`, `sheet_tab` (exact tab name).
2. A tab for the client with the standard headers (copy an existing tab; keep the DONE divider row).
3. Done. The hub reads Config every minute. Check: `https://pm-tasks.vercel.app/api/sheet-check` with the secret shows the tab mapped.

Aliases are matched as whole words only. Names under five letters never match by sound in a voice note, so give short clients an alias people actually say.

## Slack (client workspaces)

- Install: send the client `https://pm-tasks.vercel.app/api/slack/install`, or install it yourself as workspace owner. Then `/invite @Task Hub` in each channel to read.
- Put the workspace T-id in the client's Config row (column D). Staff are recognised by the `mangoeyesagency.com` domain.
- The app only reads and adds an emoji reaction in a client workspace. It never posts there.

## Claude connections (MCP)

One key per Claude account (accounts are shared, so the hub asks who is filing).

```
curl -H "Authorization: Bearer <SECRET>" "https://pm-tasks.vercel.app/api/setup?mcp_key=Team|team@mangoeyesagency.com"   # mint, shown once
curl -H "Authorization: Bearer <SECRET>" "https://pm-tasks.vercel.app/api/setup?mcp_list=1"                                # list
curl -H "Authorization: Bearer <SECRET>" "https://pm-tasks.vercel.app/api/setup?mcp_revoke=team@mangoeyesagency.com"       # revoke
```

Connect: Claude → Settings → Connectors → Add custom connector → URL from the mint output. Full steps in `docs/MCP.md`.

## Pause everything (emergency stop)

Vercel → pm-tasks → Settings → Environment Variables → `INTAKE_PAUSED` = `true` → Redeploy. Messages are still stored; no cards, no feed lines, no sheet writes. Set it back to `false` and redeploy: everything parked goes through, in order. Not tested in the soak by decision; if it is ever needed we test it then.

## Sheet and Pulp rules that keep the hub working

- Rows are found by their **Pulp link**. Move rows freely within a tab; never clear the link; never move a row to another tab.
- Only lists named **Done / Completed / Closed** count as finished. "Ready to Use" does not.
- Sheet Status shows the Pulp **list name as spelled in Pulp**. Keep list names matching the sheet dropdown (fix "Dependancy" → "Dependency" in Pulp).
- Every hub card carries the label `Task Hub`. Boards are the six department boards; no client or internal boards.
- The hub never touches priority, assignee or comments after a row is written.

## Google side (do not change casually)

- Chat app visibility (Cloud Console → Chat API → Configuration) holds `all.team@mangoeyesagency.com`. Every edit re-evaluates the app for every account; leave it.
- Domain-wide delegation for service account `task-hub@mangoeyes-task-hub.iam.gserviceaccount.com` (client id 117215744015492300607): Gmail read/modify (mailbox `arun@`), Chat messages read-only (the Drop space, read as you). Removing either scope silently stops that channel.
- Intake address: `taskhub@mangoeyesagency.com`, an alias of arun@. `GMAIL_INTAKE_ADDRESS` in Vercel lists the addresses read. Remove the old `intake@` alias only after the team has switched.
- Meet: each organiser shares their "Meet Recordings" / "Google Meet" folder with the service account as Viewer, once. `https://pm-tasks.vercel.app/api/meet-check` (with the secret) lists who is covered.

## Costs

- Model calls: only for understanding a message (about two per message, cached instructions). Logged per call with cost; `hub status` shows the 30-day total. Expect a few dollars a month.
- Speech-to-Text: about 2 cents per audio minute.
- Reading through Claude costs the hub nothing; it is plain database lookups.
- Data is kept forever. Nothing is deleted.

## Where things live

| Thing | Where |
|---|---|
| App, crons, environment variables | Vercel project `pm-tasks`, branch `claude/mangowise-task-automation-3qnd3k` |
| Database | Neon Postgres (Vercel integration) |
| Feed space, Drop space | Google Chat, IDs `AAQAjieDBM4` and `AAQA-Dk7A_k` (renaming a space changes nothing) |
| Clients, aliases, tabs | Config tab of PM Overview |
| Boards, routing, sheet columns, noise rules | `config/*.yaml` in the repo |
| The full feature list and every decision | `docs/FEATURES.md`, `docs/STATE.md` |
