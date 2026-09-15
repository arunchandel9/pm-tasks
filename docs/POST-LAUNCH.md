# After go-live — when wanted

Each item is about an hour unless noted. None is needed for the hub to run.

## Still to prove on real traffic (no work, just watch)

- Slack: first real client message in a client channel → feed line, card (A9, A10). Reminder after 20 minutes of silence, naming who was tagged (C4).
- Google Meet: next real client call with Gemini notes → one headline in the feed, cards in its thread (A11).
- A voice note longer than 10 minutes (the long path is built; the longest verified is 163 seconds).
- The first daily brief at 23:00 (C3).

## Small improvements

- **Per-user sign-in for the Drop space** instead of domain-wide delegation: each reader authorises once; narrower than reading as Arun.
- **Duplicate-send guard**: if people double-send in bursts, hold the second copy for a minute instead of a 🔁 line.
- **Merged messages in `recent_messages`**: a follow-up that became a card comment shows 0 tasks and no reason; show "added to card" instead.
- **Health page pretty print** so it reads without the browser checkbox.

## Bigger pieces

- Weekly per-client digest in the feed (or by mail to the client lead).
- Approval-loop nudges: a Staging card older than two days pings its board's PM.
- Auto-move Staging → To Do with an assignee rule (who to assign was left undecided).
- Board watcher: cards made in Pulp without a sheet row get one automatically (today the PM pastes the link).
- Platform alerts creating cards by themselves: ad disapproved, form down, site down.
- Workspace Events API for Chat spaces (push instead of the 20-second read), if Google's quota or latency ever matters.
