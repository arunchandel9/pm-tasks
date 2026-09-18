# Phase 6 — soak on live traffic, then handover

Two hours of soak, one hour of handover. Every row in `docs/FEATURES.md` gets its live check here; a row turns
**Live** only when its check passes on real data. Anything that fails is fixed and re-checked in the same block.
Work top to bottom. Each check says who does it, what to do, and what "pass" looks like.

Google Chat, decided 2026-09-11: the **DM with Task Hub** is the front door for everything (forward, type, voice
note, screenshot), no mention needed, no form. The Intake space is retired. The review space stays, renamed by Arun,
and the hub knows it by ID. Every "Intake:" step below means "in the DM with Task Hub".

Roles: **A** = Arun · **H** = the hub builder (me) · **PM** = one project manager · **C** = someone acting as a client
(a non-MangoEyes Slack account, or a real client who agrees to post one line).

## 0. Before the clock starts (A, about 20 minutes)

| # | Item | Done when |
|---|---|---|
| 0.1 | Google Cloud report from the browser prompt (Storage Admin on the task-hub service account, Cloud Storage API on, billing linked) | Report pasted here |
| 0.2 | Slack: list of client workspaces to install in during the soak, and who holds admin in each | List sent |
| 0.3 | PM names and emails for MCP keys | List sent |
| 0.4 | Who plays the client in the Slack test (0.2's workspace) | Named |
| 0.5 | A real voice note longer than 10 minutes, ready to post in Intake | File ready |
| 0.6 | Housekeeping in Pulp: archive the duplicate "To Do" lists; delete or drag the five meeting-made Staging cards | Done |
| 0.7 | Housekeeping in the sheet: delete the HOH test row from milestone B | Done |
| 0.8 | Everyone who will use the hub is a member of the feed space and has opened a DM with Task Hub (Chat app visibility set for the domain in the Cloud Console) | Confirmed |
| 0.10 | Task Hub Drop space: created, the app and `all.team@` added, and the scope `https://www.googleapis.com/auth/chat.messages.readonly` authorised for the service account under domain-wide delegation | `chat_inbox_last` on hub_status shows the space and no errors |
| 0.9 | Every meeting organiser (Arun, Saurav, each PM who hosts client calls) shares the Meet folder they own ("Meet Recordings" and "Google Meet", whichever exist in their My Drive, plain folder icon, not the ones with a person icon) with `task-hub@mangoeyes-task-hub.iam.gserviceaccount.com` as Viewer | `/api/meet-check` lists each organiser under `organisersCovered` |

## Block A — intake, every channel (40 min)

| # | Register | Who | Do | Pass |
|---|---|---|---|---|
| A1 | 1.3 | A | DM: `HOH: the Book Now button on the contact page is not working on mobile` | Feed line in PM Review within 2 min, 🔴 P1, Dev, Staging card link. Ack in the Intake thread. |
| A2 | 1.4 | A | DM with Task Hub: forward a WhatsApp text with no client name, nothing else typed | Hub asks for the client in the DM thread only. Reply `Abela`. One feed thread with the task line follows; no question card in the feed. |
| A3 | 1.3 | PM | DM the Task Hub: `TED: please update the opening hours on the footer` | Feed line, Dev or Content, card. |
| A4 | 1.5 | — | Dropped: the form is not taught. | — |
| A5 | 1.6 | A | Forward a 30-second voice note, say the client name in it: from the phone WhatsApp → Share → Chat → **Task Hub Drop**; on a computer drop it in the Task Hub DM | Feed line with the transcribed ask. |
| A6 | 1.7 | A | From the phone: WhatsApp → Share → Chat → Task Hub Drop, a voice note over 2 minutes (Gmail → intake@ also works) | "Received, transcribing" line in the feed. Task line within about 5 min. Audio visible in the bucket `mangoeyes-task-hub-task-hub-voice`. |
| A5b | 1.13 | A | Share a text into Task Hub Drop with no client name | Hub asks "which client?" in that message's thread within 2 min. Reply the name there; feed line follows. |
| A7 | 1.8 | A | Email to intake@mangoeyesagency.com, subject `Abela: pricing page shows old prices`, two lines of body | Feed line within 2 min, label "Task Hub" on the mail. |
| A8 | 1.8 | A | Forward a real client email to intake@ with the client name as the first line | Feed line, signature and quoted history not in the card. |
| A9 | 1.1 | C | One line in an Abela Slack channel the app is in: `can you add the new offer banner to the home page` | Feed line, card with the Abela label. Staff replies in that channel produce nothing. |
| A10 | 1.1 | A | Install in the next client workspace: open `https://pm-tasks.vercel.app/api/slack/install`, then `curl -H "Authorization: Bearer <secret>" "https://pm-tasks.vercel.app/api/setup?slack_team=<client>|<T-id>"`, then `/invite @Task Hub` in its channels | Repeat A9 there. Repeat for each workspace in 0.2. |
| A11 | 1.9 | A | Next real Google Meet with Gemini notes, or one 3-minute test call with notes on | Feed line per client action, ideas and decisions visible in Claude (D3). |
| A12 | 1.10 | PM | In their Claude: `add a request for HOH: change the hero image on the home page` | Feed line, Staging card, Claude reports the card link. |
| A13 | 1.11 | A | DM: `please fix the popup` with no client anywhere | Hub asks in the DM. Leave it. Nothing in the feed. It appears under "Needs a person" in C3. |
| A14 | 2.1 | A | DM with Task Hub: `ok thanks 👍`, then a photo with no text | No feed line. DM says "Nothing created: …" for the first and asks for text for the photo. |
| A15 | 2.2 | A | DM: `HOH: two things - the blog page is slow, and can we get a reel for the new laser` | Two feed lines in one post, two cards (Dev and Video). |
| A16 | 2.5 | covered by A1 | | |

Progress (15 Sep): passed A1, A2, A3, A5 (DM and Drop), A5b, A7, A8 (real forwarded reply: unwrapped, client found, thread as context, unhappy-client warning), A12 (Claude asks who is filing; "Anuj via Claude-Arun"), A13, A14, A15, B1 to B7 (yellow row, manual row move, status follow, Done and back; Date Completed fills only where a tab has that column), B9, B10. A7 needed two mail fixes first (self-sent mail was excluded as Sent; staff mail addressed To intake@ was dropped as outgoing). B8 found a bug: a row with a card link but a blank Task cell was skipped by the mirror, so the card was never watched; fixed (the row is mirrored and the hub fills the Task cell from the card), re-check after the next 10-minute mirror by moving the card. B11 skipped by decision (no separate boards). B12 passed (hub_status: no queue errors, no stuck messages). A6 passed (long voice note without an ask: "noted, no card" line and thread reply). B8 passed after the fix (blank Task cell filled from the card; status followed the move within a minute of the mirror import). E1 passed (health ok, queue empty, cache reads above zero). E2 skipped by decision: the kill switch stays Built, tried only if ever needed. E3 passed (no "Needs attention" in the summary, no abandoned jobs, nothing reprocessed unexpectedly). E4 passed (every message of the last two days has a card, a card comment or a reason; three unresolved "which client?" test messages from 14 Sep age out of the brief after three days). E5 passed (the recorded sheet stage matches the sheet for every block B row and the hand-made card). C1, C2, C5, C6 covered by block A. D1 covered by the one-key-per-Claude-account decision. Slack rebuilt to the feed standard on 15 Sep (names, words, voice clips, workspace linking, 20 min / 1 h / 1 day / daily reminders with Acknowledged): A9, A10, C4 prove themselves on the first real client message, A11 (Meet, next real call), C3 (tonight's brief). A10 done (app installed and invited per workspace by Arun). D1 to D3 passed (every Claude account connected with the one key; the six questions answered with real tasks, links and the hand-made card). D5 needs nothing. Handover pages written: `docs/GUIDE.md`, `docs/OPS.md`, `docs/TEAM-BRIEF.md`, `docs/POST-LAUNCH.md`. 18 Sep: PMs board rules built (3.3a, 3.3b); they prove themselves on the first real cards: (1) a PMs-board card dragged to To Do → approved, no row; (2) that card moved to a department board → row within a minute; (3) a Development Staging card dragged to Writers' To Do → row with department Content; (4) a PMs-board card link pasted in a tab by hand → Task cell filled and Status following within 10 minutes.
Client-matching audit (14 Sep, after a voice note with no client name was filed under TED because "TED" sat inside "reported"): names and aliases now match whole words only; fuzzy (misheard) matches are suggestions the sender confirms with "yes", never decisions; aliases under 5 letters never fuzz. Remaining certain sources, in order: "Client:" prefix, whole-word name or alias, client email domain, WhatsApp number, the thread's client, a name typed in the last 15 minutes. Anything else asks.

## Block B — cards, approval, sheet (30 min)

| # | Register | Who | Do | Pass |
|---|---|---|---|---|
| B1 | 3.1 | PM | Open the A1 card in Pulp | Client label, P1 label, description, original quote, source link, due in 4 hours. |
| B2 | 3.3, 3.4, 3.4a | PM | Drag the A1 card from Staging to To Do | Within 1 min: yellow row in the HOH tab, Status To Do, Pulp link, Comments stamp "approved by drag in Pulp · <time> IST · from Intake, Arun". |
| B3 | 3.4a | PM | Move that row two places up by hand, make it white | Nothing breaks (checked in B5). |
| B4 | 3.5 | PM | Move the card to In Progress | Status cell reads the list name within 1 min. |
| B5 | 3.5 | PM | Move the card to Done | Date Completed filled, row below the DONE divider, still the row moved in B3. |
| B6 | 3.5 | PM | Move the card back to In Progress | Row Status back to In Progress, Date Completed cleared, row above the divider. Then Done again. |
| B7 | 3.2 | A | Drop: `TED: we want a new landing page for the Botox offer` | Card in Staging with the new-page label (Needs scope list dropped 2026-09-15). Drag it to To Do → sheet row, yellow. |
| B8 | 3.6, 3.7 | PM | Create a card by hand in Pulp, paste its link in a new row of the client's tab (the Task cell may stay blank) | Within 10 min Claude lists it (D3) and a blank Task cell shows the card's title. Move the card to Done → within 5 min the row reads Done and sits below the divider. |
| B9 | 2.6 | A | DM: the same text as A1 again | 🔁 line "same as …", comment on the A1 card, no new card. |
| B10 | 2.6 | A | Reply in the DM thread of A1: `also broken on tablet` | 🔁 line "update to …", comment on the card. |
| B11 | 3.9 | — | Skipped 2026-09-15: no card goes to a separate board (Arun). The override is kept for later. | — |
| B12 | 3.8 | H | Read the queue: no failed `create_card` or `sync_sheet` jobs older than 10 min | Empty, or each one explained and fixed. |

## Block C — feed, acknowledgements, summary (15 min)

| # | Register | Who | Do | Pass |
|---|---|---|---|---|
| C1 | 4.1 | all | Read the feed lines from block A | Every line: icon, client, title, department, priority, card link, source. Nothing else. |
| C2 | 4.4 | all | Read the DM replies from block A | Only questions and "Nothing created" lines; silence when a task was created. |
| C3 | 4.6 | A | `curl -H "Authorization: Bearer <secret>" "https://pm-tasks.vercel.app/api/eod?dry=1"` | Created lists block A; Waiting for a person shows Staging and Needs scope; Needs a person shows A13; Completed shows B5; Needs attention is empty. |
| C4 | 4.5 | C | One more Slack line, and nobody replies for 20 min | 💬 line in the feed after 20 min naming who was tagged, Acknowledged button in its thread. Then a staff reply in the channel → no 1-hour line. Left unanswered: ⏰ at 1 hour, 🔴 at a day, then daily. |
| C5 | 4.2 | A | In the DM thread of A13, reply `Perfect Skin` | Message processed, feed line follows. |
| C6 | 4.3 | all | Agree the rule out loud: the feed line is the receipt; no line in 2 minutes → send it again | In the guide. |

## Block D — the hub in each PM's assistant (20 min)

| # | Register | Who | Do | Pass |
|---|---|---|---|---|
| D1 | 5.2 | A | `curl -H "Authorization: Bearer <secret>" "https://pm-tasks.vercel.app/api/setup?mcp_key=<Name>|<email>"` once per PM | Each PM gets their link privately. `?mcp_list` shows them. |
| D2 | 5.1 | PM | Connect the link in Claude (Settings → Connectors → add custom) or Codex, per `docs/MCP.md` | Tool list appears. |
| D3 | 5.3, 5.4 | PM | Ask: `what is pending for Abela`, `what happened in the last meeting with The Eye Doctor`, `Abela, last 30 days`, `what happened today`, `any ideas raised this week`, `hub status` | Answers name real tasks with links, sheet history included, B8's hand-made card included. |
| D4 | 1.10 | covered by A12 | | |
| D5 | 5.5 | PM | Ask one question that mixes hub data with an Ads or CRM connector they already have | The assistant combines both. Nothing to build. |

## Block E — nothing gets lost (15 min)

| # | Register | Who | Do | Pass |
|---|---|---|---|---|
| E1 | 6.4 | A | Open `https://pm-tasks.vercel.app/api/health` | `ok: true`, every `…Last` time within its interval, `queueErrors` empty. |
| E2 | 1.12 | A | Vercel → Settings → Environment Variables → `INTAKE_PAUSED` = `true`, redeploy; DM: `HOH: test while paused`; set it back to `false`, redeploy | While paused: no feed line, health shows `intakePaused: true`. After: the message is processed within 5 min, feed line appears. |
| E3 | 6.3 | H | Read `watchdog` in the last tick report and the "Needs attention" section | Nothing reprocessed unexpectedly, nothing abandoned. |
| E4 | 6.1 | H | Count messages stored vs feed lines plus acks in block A | Every message accounted for, with a reason where skipped. |
| E5 | 6.5 | H | Compare `sheet_stage` records with the sheet for block B rows | All match. |

## Tuning loop (runs through every block)

When a real message is handled wrongly, fix the cause, not the case:

| Symptom | Fix where |
|---|---|
| Noise reached a model, or a real ask was filtered | `config/noise.yaml` |
| Wrong client matched | Aliases in the client's Config row |
| Wrong department, priority or request type | `config/routing.yaml`, or a prompt example in `src/lib/llm/classify.ts` |
| Wrong board or list | Config row override, or `config/boards.yaml` |
| Sheet column not filled | Header alias in `config/sheet.yaml` |

Each fix: change, push, wait for the deploy, re-run the failed check. Record the decision in `docs/STATE.md`.

## Exit criteria for the soak

- Every row in `docs/FEATURES.md` reads Live or Dropped. No row reads Built.
- Slack installed in every workspace from 0.2, or the remaining ones listed with an owner and a date.
- Every PM connected and answered by the hub from their own assistant.
- Health `ok: true`, queue errors empty, "Needs attention" empty.

## Handover (1 hour)

1. **Guide, one page per role**, written from the register: PM, team member, Arun. Rules included: the feed is the receipt; cards born in the hub are tracked; a hand-made card gets a row with its link; yellow means check me and whiten; move rows, never across tabs, never clear the link; Staging and Needs scope are the approval; `/task` when in doubt.
2. **Operations page for Arun**: health, the setup commands, add a client, add a Slack workspace, mint or revoke a key, pause intake, what "Needs attention" means and what to do, where the costs are logged.
3. **Team brief in PM Review**: what the hub is, the three rules, where the guide is. Each PM's MCP link sent privately.
4. **The register** as the final feature document, every row Live or Dropped.
5. **Post-launch list** with an hour each when wanted: weekly per-client digest, approval-loop nudges, auto-move Staging → To Do, board watcher for cards made in Pulp without a sheet row, platform alerts (ad disapproved, form down) creating cards by themselves.
