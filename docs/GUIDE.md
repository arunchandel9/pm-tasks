# Task Hub — how to use it

One page per role. Everything here is verified on live traffic (see `docs/FEATURES.md` for the full register).

## Everyone on the team

**Where to send a client ask**

| From | Do |
|---|---|
| Phone (WhatsApp text, voice note, screenshot) | Share → **Task Hub Drop** (the Google Chat space with the 📥 icon) |
| Computer | Google Chat → DM **Task Hub**, or forward the mail to **taskhub@mangoeyesagency.com** |
| Meeting | Nothing. Gemini notes from Google Meet are read on their own |

Put the client first when the message does not say it: `HOH: the booking form is broken`.

**Five rules**

1. **The feed line is the receipt.** Every message gets one line in **Task Hub Feed** (📋). Nothing within 2 minutes → send it again.
2. **Answer the hub in its thread.** "Which client?" → reply with the name, or `yes` to its suggestion. "Heard: …" on a voice note → if it misheard, reply with the correction and the card follows.
3. **Say the client name in a voice note.** No name → the hub asks, nothing is filed until you answer.
4. **Nothing vanishes.** An update with no ask gets an ℹ️ "noted, no card" line. An unhappy client gets a ⚠️ line: a person replies to the client, the hub never does.
5. **Do not send twice.** A repeat gets a 🔁 line pointing at the card that already exists. Add detail by replying in the feed thread or the DM thread; it lands on the card.

## PMs

- **Staging is the inbox.** Every new card lands in **Staging** on the department board (Development, Writers, Graphics, SEO, Onboarding & Automations, Video) with the labels `Task Hub`, client and priority, the original words and the source link.
- **Drag = approval.** Drag the card out of Staging to where it belongs and assign it. Within a minute the row appears in the client's tab of PM Overview, **yellow**. Check the row, move it up or down if needed, make it white. Never clear the Pulp link, never move rows between tabs.
- **Status is automatic from then on.** Move the card, the row follows. Done fills Date Completed where the tab has that column and moves the row below the DONE divider. Moving back out of Done reopens it.
- **Not a task?** Archive the card in Pulp. No row exists yet, nothing else to do.
- **Cards you make by hand in Pulp:** paste the card link in a new row of the client's tab. The Task cell may stay blank, the hub fills it from the card within 10 minutes. Status follows from the next move.
- **Ask the hub from Claude:** "what is pending for HOH", "what happened in the last meeting with TED", "what happened on 12 September", "anything overdue this week". To file a request from Claude it asks who is asking: answer with your name, and the card reads "Anuj via Claude-Arun".
- **The daily brief** lands in the feed at 23:00 on weekdays: one line, details in its thread. **Waiting on you** is your list for the morning.

## Arun

- **Health:** https://pm-tasks.vercel.app/api/health → `ok: true`, `queueErrors` empty. The uptime monitor watches it.
- **A new client:** one row in the Config tab of PM Overview (id, name, aliases, email domains, WhatsApp numbers, sheet tab), one tab with the standard headers. Live within a minute. Slack, when the client has a workspace: install the app there and put the workspace T-id in the Config row.
- **Everything else** (keys, pause, costs, what "Needs attention" means, what to check when the feed is quiet): `docs/OPS.md`.
