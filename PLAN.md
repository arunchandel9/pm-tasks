# Mangowise PM Automation — Planning Document (v0.1, draft for discussion)

Status: **discussion draft**. Nothing here is built yet. This document exists so we can
argue about the design before writing code.

## 1. Problem statement

Mangowise runs multiple clients / clinics. Client requests arrive on whichever channel
the client happens to use (Slack, email, WhatsApp to a staff member's phone, ad-platform
notifications). A human PM has to notice the message, work out what is being asked,
create the task on the board ("Pulp" Kanban), and keep the PM overview sheet in sync.

Goals:

1. **One intake point.** Every request, from any channel, lands in one queue.
2. **Automatic triage.** Summarise, classify (client / department / request type),
   draft a properly-formatted task, create the card, update the PM sheet.
3. **Transparency.** Anyone can look at the sheet and see what is in flight, what
   priority it is, and where it came from.
4. **Human-in-the-loop only when needed.** Ambiguous requests get flagged for review
   rather than guessed at.
5. **Daily oversight.** End-of-day summary of what was created, what moved, what needs
   a decision.

Non-goals (for now): replacing client conversations, estimating effort, invoicing.

## 2. Proposed architecture

```mermaid
flowchart LR
    subgraph Channels
        S[Slack client channels]
        E[Shared mailbox\npm@... ]
        W[WhatsApp\n(forwarded)]
        A[Ad platform\nnotifications]
        F[Manual intake\n/task command or form]
    end

    S --> N
    E --> N
    W --> N
    A --> N
    F --> N

    N[Normaliser\none Message schema] --> D[Dedupe]
    D --> X[Extract & summarise\nClaude, structured output]
    X --> C[Classify & route\nrules + Claude, with confidence]
    C -->|confident| T[Draft task]
    C -->|low confidence| R[Review queue\nSlack channel with approve / edit]
    R -->|approved| T
    T --> B[Board: create card]
    T --> G[PM sheet: append row]
    B --> K[Ack back on source thread\naudit link]

    B -.status changes.-> Y[Status sync]
    Y --> G
    Y --> EOD[End-of-day summary]
```

### 2.1 Single source of truth

A small database (Postgres; SQLite is fine to start) owned by the automation holds:

- `messages` — every inbound message, raw text, channel, sender, client, permalink,
  content hash, embedding.
- `requests` — one row per distinct client ask (a message can contain several, and
  several messages can be the same ask). Holds summary, classification, confidence,
  routing decision, review state.
- `tasks` — one row per board card created, with board id, list/stage, sheet row id,
  and the `request` it came from. This is the audit trail.
- `status_events` — every stage change observed on the board, timestamped.

The PM sheet and the board are **views** the system writes to, not the source of
truth. This matters for dedupe, audit, and for surviving someone hand-editing a row.

Human-owned vs bot-owned columns in the sheet must be explicit (see §5) so that a PM
changing a priority by hand is respected and read back, and a bot update never
overwrites a human edit.

### 2.2 Intake channels (phased)

| Channel | How we get messages | Difficulty | Phase |
|---|---|---|---|
| Slack | Slack app in client channels, Events API (`message`, `app_mention`, reactions) | Low | 1 |
| Email | One shared mailbox (e.g. `pm@mangowise…`); clients CC it, staff forward to it. Gmail API push or 5-min poll. | Low | 1 |
| Manual | `/task` slash command in Slack, or a tiny web form. Covers "client called me". | Low | 1 |
| WhatsApp | Honest answer: personal WhatsApp numbers cannot be monitored. Options: (a) staff forward the message to the shared mailbox or paste into `/task`; (b) move client WhatsApp to a WhatsApp Business (Cloud API) number with webhooks. Recommend (a) now, (b) later. | High | 2 |
| Ad platforms | Almost all of these already arrive as email notifications, so they ride on the email channel. Direct API polling only if a specific platform needs it. | Med | 2 |

Every channel normalises to the same `Message` shape:

```
Message {
  id, channel, client_id (resolved), sender, sent_at,
  text, attachments[], permalink, thread_ref,
  raw (original payload)
}
```

**Client resolution** is the first thing that has to work: Slack channel → client,
sender email domain → client, WhatsApp number → client. This is a config table we
maintain, not something the model guesses.

### 2.3 Pipeline stages

1. **Normalise.** Channel adapter converts to `Message`, resolves `client_id`.
2. **Dedupe.** Exact hash match, then embedding similarity against open `requests` for
   the same client in the last N days (start with 14). Above a high threshold →
   attach message to existing request and post "already tracked as TASK-123" back
   to the thread. In a grey band → send to review queue as "possible duplicate".
3. **Extract & summarise.** Claude with a strict JSON schema: bullet summary, list of
   distinct asks (one message may contain three), quoted evidence for each ask,
   any mentioned deadline or URL.
4. **Classify & route.** Per ask: department (content / dev / design / SEO / general),
   request type (new page, content feedback, dev issue, graphic fix, general update,
   question), priority signal, and a **confidence score with a stated reason**.
   Deterministic routing rules (§3) run on top of the classification.
5. **Gate.** Confidence ≥ threshold → auto-create. Otherwise → review queue.
   Threshold tuned per request type; start conservative (everything except the
   clearest cases goes to review for the first two weeks, then loosen).
6. **Draft task.** Title, description (summary + quoted original + link to source),
   labels, board/list, priority, client tab. Format matches how the board is set up
   today (needs the board structure from you, see §7).
7. **Create.** Card on board + row in PM sheet + `tasks` row. Then post an
   acknowledgement in the source thread (Slack reply / email reply) with the card
   link. That reply *is* the audit trail from the client's side.
8. **Status sync.** Poll the board (or webhook if the tool supports it) every few
   minutes; on stage change, update the sheet row and log a `status_event`.
9. **EOD summary.** Scheduled job at a fixed time per day, posted to a Slack channel
   and/or email (format in §6).

### 2.4 Review queue

A Slack channel (e.g. `#pm-review`) where each flagged item is a message with buttons:
**Approve** (creates as drafted), **Edit** (opens a modal to change client /
department / title), **Merge into…** (duplicate), **Not a task** (dismiss). Every
decision is recorded and later used to tune prompts and thresholds.

## 3. Routing rules (from Anuj's brief)

These are deterministic and live in config, not in a prompt.

| Request type | Route |
|---|---|
| New page development | Creates a **parent task** plus ordered sub-tasks: SEO research → Content creation → Web development → Graphic design (page assets/photos) → Client approval → Build → Menu linking. Only the first sub-task is "ready"; the rest unblock as the previous one completes. |
| Content feedback | Content board / content writers |
| Development feedback / dev issue | Dev board, as a dev task |
| Graphic issue | Design board first (fix the asset); on completion, auto-create the follow-up dev task to push it live |
| General update / question | No card. Logged, and surfaced in EOD summary as "client updates". Unless a PM marks it as a task in review. |
| Anything else / low confidence | Review queue |

Open question: for "new page" chains, do we want all sub-tasks created up front (visible
plan, more noise) or created one at a time as each stage completes (cleaner board)?
Recommend: all created up front, but only the active one shows in the "ready" list.

## 4. Duplicate detection

- Layer 1: same client + normalised text hash → exact duplicate (forwarded email).
- Layer 2: same client + embedding cosine similarity > 0.90 against open requests →
  auto-merge, reply "tracked as …".
- Layer 3: 0.75–0.90 → review queue item "possible duplicate of TASK-123".
- Cross-channel: because everything goes through the same `requests` table, a Slack
  message and an email about the same thing will meet here.

## 5. PM sheet contract

Could not read the sheet from this environment (Drive connector needs re-authorising;
direct access to docs.google.com is blocked). The following is the proposed contract,
to be reconciled with the real sheet.

Bot-owned columns (system writes, humans should not edit):
`Task ID`, `Client`, `Department`, `Type`, `Title`, `Board link`, `Source channel`,
`Source link`, `Created at`, `Stage`, `Last moved at`, `Completed at`.

Human-owned columns (system reads, never overwrites):
`Priority`, `Owner`, `PM notes`, `Client-facing ETA`.

One overview tab (all clients) + one tab per client, both written by the system from the
same `tasks` table. If the current sheet has a different layout, we either adapt the
writer or add a hidden "system" tab and let the existing tabs formula off it.

## 6. End-of-day summary format

Posted at a fixed time, one per day, to Slack + email:

```
Mangowise PM summary — Mon 7 Sep

Created today (N)
  • [Client] TASK-131  Dev   — Fix broken booking button on /contact   (from Slack)
  • …

Moved stage (N)
  • [Client] TASK-118  Content → Web development
  • …

Completed (N)
  • …

Needs your decision (N)
  • Possible duplicate: TASK-129 vs new email from …   [review link]
  • Low confidence: "can we do something with the homepage" (Client X)   [review link]

Client updates logged, no task created (N)
  • …
```

## 7. What we need from you before building

1. **What is "Pulp"?** No product by that name with a task/board API turned up. Is it a
   different spelling (Plane? Pulse? Plaky?), an internal tool, or a hosted product?
   Whether it has an API or webhooks decides how the "board update" and "status sync"
   stages work. If it has no API, the options are: browser automation (fragile),
   move the board to a tool with an API, or make the sheet the board.
2. **PM sheet access.** Re-authorise the Google Drive connector, or paste the tab
   names and header rows here. We need the real column layout for §5.
3. **Board structure.** One board per client or per department? What are the
   lists/stages, and what labels exist today?
4. **Client → channel map.** Which Slack channels, email addresses/domains, and
   WhatsApp numbers belong to which client.
5. **Priority.** How is priority decided today in the sheet? Is it something the
   system should infer (client tier, deadline words, "urgent") or purely human?
6. **Reviewer.** Who owns the review queue (Anuj?) and where should it live
   (Slack channel is the recommendation).
7. **Hosting.** Preference between a small VPS, Railway/Fly, or a serverless setup.
   Any of them works; the pipeline is a single service plus a scheduler.
8. **"J2D communications"** was mentioned in the brief; please clarify what this
   refers to (a client? a channel? day-to-day comms?).

## 8. Proposed build order

| Phase | Scope | Outcome |
|---|---|---|
| 0 | Config: client map, routing rules, sheet contract, board structure | Agreed spec |
| 1 | Slack + email + `/task` intake → normalise → dedupe → extract → classify → **review queue for everything** → create card + sheet row + ack | PM stops watching channels; still approves each task |
| 2 | Confidence gate (auto-create clear cases), status sync, EOD summary | PM approves only ambiguous ones |
| 3 | New-page chain automation, graphic→dev follow-up, WhatsApp Business, ad-platform APIs | Full routing rules live |

Phase 1 running "review everything" first is deliberate: it produces the labelled
examples we need to set thresholds honestly instead of guessing.

## 9. Tech choices (proposal)

- **Language / runtime:** Python 3.12, one service (FastAPI for webhooks + a worker
  loop for polling and scheduled jobs).
- **LLM:** Claude via the Anthropic API with structured outputs for extraction and
  classification; embeddings for dedupe.
- **DB:** SQLite to start, Postgres when hosted.
- **Integrations:** Slack Bolt, Gmail API, Google Sheets API, board API (TBD).
- **Config over prompts:** client map, routing rules, thresholds, and sheet column map
  all live in versioned YAML in this repo.
- **Observability:** every pipeline decision logged with the model's stated reason, so
  a PM can always answer "why did it do that?".
