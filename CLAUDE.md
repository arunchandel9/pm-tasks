# MangoEyes Task Hub — read this first

The hub is live (go-live 2026-09-15). It turns client asks from Google Chat (DM and the "Task Hub Drop" space),
email (taskhub@mangoeyesagency.com), client Slack channels and Google Meet notes into Pulp cards and PM Overview
sheet rows, posts one line per message in the "Task Hub Feed" space, and answers questions over MCP from the
team's Claude accounts. Deployed on Vercel from branch `claude/mangowise-task-automation-3qnd3k`
(project `pm-tasks`, https://pm-tasks.vercel.app). Nothing runs locally; the sandbox cannot reach vercel.app.

## Where everything is (reading order)

1. `docs/STATE.md` — every decision with its date, IDs, the Google/Slack/Pulp facts, environment variable names, useful commands.
2. `docs/FEATURES.md` — the register: every feature, how it works, status (Live / Built / Dropped), endpoints, code map. `tests/features.test.ts` fails when a module or endpoint is missing from it.
3. `docs/SOAK.md` — the live checks and what passed, with the progress line under block A.
4. `docs/OPS.md` — operations for Arun: health, new client, Slack install, MCP keys, pause, clean-start commands, costs.
5. `docs/GUIDE.md` — one page per role for the team. `docs/TEAM-BRIEF.md` — the team message. `docs/POST-LAUNCH.md` — what still proves itself on real traffic and what could come next.
6. `docs/MCP.md` — connecting Claude, the tools, from/to dates.
7. `PLAN.md` — the original design rationale (older; STATE.md wins where they differ).

## Working rules (from Arun)

- Nothing built may exist only in code: add a row to `docs/FEATURES.md`, note the decision in `docs/STATE.md`, keep `docs/SOAK.md` current.
- Every bug is fixed at the root and its siblings checked; the same thing must not happen twice.
- Do not build before the doubt is cleared and Arun says go. Ask one crisp question, no loops.
- The feed is one line per message; everything else goes in that line's thread. A headline must look like a headline.
- A client is set only with full clarity; near-misses are suggestions the sender confirms.
- Writes from Claude ask who is asking (label "Anuj via Claude-Arun"); reads ask nothing.
- One Staging list per board; no client or internal boards; no separate Needs scope list.
- Speed: replies as instant as possible (Drop space read every 20 s; client picks re-run inline).
- Commit messages end with the Co-Authored-By and Claude-Session lines; no model identifiers in code or docs.

## Observing the live hub from a session

The Task_Hub MCP connector (tools `hub_status`, `recent_messages`, `search_tasks`, `daily_summary`, …) is the window
into the live database. `hub_status` shows every poll's last run, queue errors and stuck messages. `/api/health` is the
same for a browser.

## Checks before pushing

`npx tsc --noEmit` and `npx vitest run` (107 tests). Vercel deploys the branch in about two minutes.
