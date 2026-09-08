# MangoEyes Task Hub

Turns client requests from any channel into the right task on the right board, keeps the PM sheet in sync, and lets any PM's assistant ask the hub.

- Plan and decisions: `PLAN.md`
- Team pages: `docs/overview.html` (technical), `docs/team-summary.html` (non-technical)

## Run locally

```bash
cp .env.example .env.local   # fill in DATABASE_URL, ANTHROPIC_API_KEY, SLACK_*
npm install
npm run db:migrate
npm run dev                  # http://localhost:3000/api/health
npm test
npm run typecheck
```

## Deploy

Vercel project → import this repo → set the env vars from `.env.example` → deploy. `vercel.json` schedules `/api/tick` every minute and `/api/eod` at 17:30 UTC on weekdays. Set `CRON_SECRET`; Vercel sends it as a bearer token on cron calls.

## Slack

One workspace per client. Create the app once from `slack-manifest.yaml`, set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET` in Vercel, activate distribution, then open `https://pm-tasks.vercel.app/api/slack/install` while signed in to each workspace (MangoEyes first: it becomes the home workspace where `#pm-review` and `#intake` live). Tokens are stored per workspace. Invite the bot to channels with `/invite @Task Hub`.

Seed once via `/api/setup?intake_channel_id=C…` (and `home_team_id=T…` if the first install wasn't MangoEyes). Staff are recognised by email domain (`STAFF_EMAIL_DOMAINS`).

## Client map

Lives in the `Config` tab of the PM sheet and is mirrored every minute. Columns: `id, name, scope, slack_team_id, slack_channels, email_domains, whatsapp_numbers, dev_board, dev_list, dev_staging, dev_assignee, content_board, …, scope_board, scope_list, client_facing_ack`. See `config/clients.example.yaml` for the shape.

## Kill switch

`INTAKE_PAUSED=true` in Vercel pauses everything. Per channel: set `channel_paused:slack` (or `email`, `intake`, `meet`) to `true` in `settings`. Paused messages queue and are processed when unpaused.
