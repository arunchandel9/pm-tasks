# Task Hub — how to use it

One page per role. Everything here is verified on live traffic (see `docs/FEATURES.md` for the full register).

## Everyone on the team

**Where to send a client ask**

| From | Do |
|---|---|
| Phone (WhatsApp text, voice note, screenshot) | Share → **Task Hub Drop** (the Google Chat space with the 📥 icon) |
| Computer | Google Chat → DM **Task Hub**, or forward the mail to **taskhub@mangoeyesagency.com** |
| Meeting | Nothing. Gemini notes from Google Meet are read on their own |
| Client's Slack | Nothing. Every client message in a channel the hub is in is read on its own; a client left without a reply gets a reminder in the feed after 20 min, 1 hour, 1 day, then daily. Reply in Slack, or press **Acknowledged** under the reminder |

Put the client first when the message does not say it: `HOH: the booking form is broken`.

**Five rules**

1. **The feed line is the receipt.** Every message gets one line in **Task Hub Feed** (📋). Nothing within 2 minutes → send it again.
2. **Answer the hub in its thread.** "Which client?" → reply with the name, or `yes` to its suggestion. "Heard: …" on a voice note → if it misheard, reply with the correction and the card follows.
3. **Say the client name in a voice note.** No name → the hub asks, nothing is filed until you answer.
4. **Nothing vanishes, nothing becomes a card on its own.** Every message becomes one of five things: a **task** (the hub proposes a card, you confirm with one tap), a **reminder** ("remind me tomorrow": it comes back to you in the feed, @mentioned, until you press Done), an **idea** (comes back on Monday for a decision), a **rule** for a client (printed on their cards), or a **note** (on record, ℹ️ line). An unhappy client gets a ⚠️ line: a person replies to the client, the hub never does.
5. **Do not send twice.** A repeat gets a 🔁 line pointing at the card that already exists. Add detail by replying in the feed thread or the DM thread; it lands on the card.

## PMs

- **The proposal is the inbox.** When a message holds a task, the hub posts a card in that message's feed thread, addressed to you: the task, and four fields already filled in: Department, Assign to, Priority, Due, Remind me on. Check them, change any that is wrong, then tap **Create card**. The Pulp card appears in To Do on that board, assigned, and the sheet row is written at the same moment. No dragging, no assigning afterwards.
- **Not a card?** Tap **No card** and nothing is made. Want to be nudged later instead? Tap **Remind me instead**: it comes back to you on the day selected in **Remind me on** (tomorrow unless you change it).
- **You can also type in the thread:** "create", "create for Anuj", "remind me Friday", "no card".
- **Cards on PMs - Board** get no sheet row from the hub: add the row yourself when it deserves one (paste the card link in the client's tab) and Status follows from then on. Move the card to a department board and the row is written at once.
- **Status is automatic from then on.** Move the card, the row follows. Done fills Date Completed where the tab has that column and moves the row below the DONE divider. Moving back out of Done reopens it.
- **Not a task?** Archive the card in Pulp. No row exists yet, nothing else to do.
- **Cards you make by hand in Pulp:** paste the card link in a new row of the client's tab. The Task cell may stay blank, the hub fills it from the card within 10 minutes. Status follows from the next move.
- **Ask the hub from Claude:** "what is pending for HOH", "what happened in the last meeting with TED", "what happened on 12 September", "anything overdue this week". To create a card from Claude, it asks who is asking, the client, the ask and who to assign it to; the card is made at once (To Do, assigned, sheet row) and the feed shows the outcome, nothing to tap there. The card reads "Anuj via Claude-Arun".
- **Today, at 10:00** on weekdays: one line in the feed, and in its thread every item that is waiting on a named person, you @mentioned on yours: proposals you have not answered, reminders due, clients waiting in Slack. Nothing waiting, no post.
- **Monday, 10:00:** the week's ideas, one card each. Tap **Make it a task** or **Not now**. An idea nobody decides on comes back the next Monday.

## Arun

- **Health:** https://pm-tasks.vercel.app/api/health → `ok: true`, `queueErrors` empty. The uptime monitor watches it.
- **A new client:** one row in the Config tab of PM Overview (id, name, aliases, email domains, WhatsApp numbers, sheet tab), one tab with the standard headers. Live within a minute. Slack, when the client has a workspace: install the app there and put the workspace T-id in the Config row.
- **Everything else** (keys, pause, costs, what "Needs attention" means, what to check when the feed is quiet): `docs/OPS.md`.
