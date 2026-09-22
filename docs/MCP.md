# Ask the hub from your own assistant (MCP)

One link per Claude account (accounts are shared, so the hub asks who is filing a request). Add it to Claude, Codex or Cursor once, then ask in plain language:
"what is open for HOH", "anything overdue this week", "what did Dr Mehta ask on Tuesday", "summarise today",
"add a request for PSS: the gallery page shows old photos". Answers come from the hub's database, not from a model
guessing. Filing a request goes through the normal pipeline: a proposal card in the feed that the person confirms with one tap.

## Get a link

Arun runs (one per person, shown once):

```
curl -H "Authorization: Bearer <CRON_SECRET>" "https://pm-tasks.vercel.app/api/setup?mcp_key=Priya|priya@mangoeyesagency.com"
```

The output contains `https://pm-tasks.vercel.app/api/mcp/mh_…`. Treat the link like a password.
Revoke: `…/api/setup?mcp_revoke=priya@mangoeyesagency.com`. List: `…/api/setup?mcp_list=1`.

## Connect

**Claude Code (terminal):**
```
claude mcp add --transport http task-hub https://pm-tasks.vercel.app/api/mcp/mh_YOUR_KEY
```

**Claude desktop / claude.ai:** Settings → Connectors → Add custom connector → name `Task Hub`,
URL `https://pm-tasks.vercel.app/api/mcp/mh_YOUR_KEY` → Add. No OAuth; the key is in the link.

**Codex CLI:**
```
codex mcp add task-hub --url https://pm-tasks.vercel.app/api/mcp/mh_YOUR_KEY
```

**Cursor:** Settings → MCP → Add → type `streamableHttp`, URL as above.

## Tools it exposes

| Tool | What it answers |
|---|---|
| `list_clients` | clients, short names, sheet tabs |
| `search_tasks` | by client, status (open/done/overdue/waiting/staging/all), department, words, days or from/to |
| `task_detail` | one task: original ask, who, approval, status history, card link |
| `client_summary` | one client at a glance: counts + open list |
| `recent_messages` | what came in, by client/channel, incl. updates that were not tasks |
| `daily_summary` | the PM summary for today, the last N days, or a past day / range (from/to) |
| `add_request` | file a client ask → feed line + proposal card (Create card / Remind me instead / No card) |
| `meetings`, `meeting_detail`, `ideas`, `decisions` | Meet notes: what was said, raised and agreed, by client and days or from/to |
| `hub_status` | volumes, spend, last polls |

Dates on any tool are calendar days in Indian time, `YYYY-MM-DD`, both ends inclusive: "what happened on 12 March 2025" is `from: 2025-03-12`; "the first half of March" is `from: 2025-03-01, to: 2025-03-15`. Claude works these out from plain words.
