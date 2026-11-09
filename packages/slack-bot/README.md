# Sudo Tracker (Slack agent)

Mention **@Sudo Tracker** in a Slack thread, or DM it, and it turns the conversation into tasks,
updates them, and answers questions about the work, the way Linear's Slack agent does. It is a
separate service from the tracker: it talks to it only through the public API (`/api/v1`), as a
**bot member**, and checks every request against the Slack person who asked.

Built with [LangChain](https://docs.langchain.com/oss/javascript/langchain/overview) (`createAgent`
on LangGraph, with human-in-the-loop, retry and tool-limit middleware), [Bolt for
JavaScript](https://docs.slack.dev/tools/bolt-js/), and Claude through `@langchain/anthropic` by
default. Plans for what comes next: [ROADMAP.md](ROADMAP.md).

## What it does

| In Slack                         | What happens                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `@Sudo Tracker file this for me` | Reads the thread, checks for duplicates, creates well-formed tasks in the channel's project, links the thread to them          |
| `@Sudo Tracker mark WEB-12 done` | Holds the change and posts **Confirm / Cancel**; only the person who asked can decide, and the card acts only on what it shows |
| `@Sudo Tracker what's overdue?`  | Answers from the tracker, within what the person can see                                                                       |
| `@Sudo Tracker status of WEB?`   | Lists, breakdowns and workload come as a card under the reply: Slack's native table and charts, key numbers, a header          |
| DM the bot                       | The same agent, privately; flat DMs share one conversation per day, DM threads their own                                       |
| Follow-up mention in a thread    | Continues that person's conversation, with only the thread's new messages added (each person in a thread has their own)        |
| Task cards under replies         | **Complete**, **Assign to me** and **Status**, acting as whoever clicks                                                        |
| Message ⋯ → **Create task**      | A modal prefilled from the message (title, description, project, assignee, priority, due date and time)                        |
| `/sudo new <title>`              | The same modal; `/sudo <title>` works too                                                                                      |
| `/sudo my`, `/sudo search …`     | Your open tasks, or tasks matching words (only you see the answer)                                                             |
| `/sudo project WEB`              | Links the channel to a project: tasks filed there default to it (`/sudo project none` unlinks); Members who can edit it        |
| `/sudo guidance …`               | Instructions the agent follows, for the workspace or one channel (`/sudo guidance channel …`); tracker Owners/Admins set them  |
| `/sudo link`                     | Shows how your Slack account maps to the tracker; admins can link someone by hand (see below)                                  |
| Pasting a task or project link   | A preview with status, assignee and due date, if the person who pasted it can open it and it may be shown in that channel      |

## Who it acts as

- **In the tracker, as itself.** It uses a bot member's key (Settings → API → Bots). Tasks and
  comments are by "Sudo Tracker", and Activity shows **Sudo Tracker via Slack (Ada Lovelace)**, so
  every change names who asked for it. Created tasks end with "Requested by Ada in Slack: <link to
  the thread>"; comments are signed "— Ada, via Slack".
- **For the person who asked.** Each Slack user is mapped to a tracker member by their Slack email.
  Every tracker tool checks that member's access, even where the bot has more: they only see
  projects they could open in the app, only edit where they could edit (Guests comment), and "me"
  means them. Their identity comes from Slack, never from what a message claims. People who can't
  be matched get an explanation only they can see.
- **Linking by hand.** When someone's Slack email differs from their tracker email, an Owner or
  Admin can run `/sudo link @person their-tracker-email`. It never links to an Owner or Admin, to
  yourself, or to a member another Slack account already maps to, so it can't be used to take over
  someone's identity. The person is told, and the link stops working if the admin who made it is
  no longer one, or if the linked member becomes an Owner or Admin.
- **Each person has their own conversation.** In a channel thread, every person who mentions the bot
  has a separate conversation, so nobody inherits what it looked up for someone else; a DM has one
  per day, and DM threads their own.
- **Private projects stay out of shared channels.** Replies, task cards and link previews in a
  channel are seen by everyone in it, not just the person who asked. So a private project's work is
  only discussed in a DM with the bot, or in a private channel linked to that project
  (`/sudo project KEY`). Elsewhere the bot says it can't discuss it there. `/sudo my` and
  `/sudo search` answer only you, so they include everything you can open.
- **The tracker still enforces the bot's own access.** Put the bot on the private projects it
  should serve. It can never see more than its own member can.
- **Knowledge sources over MCP** (Sudopedia) answer with their own access, not the requester's, so
  they're refused to Guests, load only the tools you list, and should only hold knowledge every
  Member may have.

**What waits for Confirm.** By default (`SLACK_BOT_CONFIRM=edits`), changes to tasks that already
exist, assignments, completions and comments (they're signed with your name and notify people) wait
for the person who asked to press **Confirm**. Each card acts only on the changes it shows; a new
message from that person cancels it (the card says so), and it expires after a day. Changes the
person isn't allowed to make are refused at once, without a card. Creating a task and linking a
thread run straight away, as in Linear.

**Thread content is untrusted.** Slack messages, task text and MCP results are given to the model
as fenced data, never as instructions, and what the bot writes back can't ping `@channel` or
people, or disguise where a link goes. An instruction planted in a thread can't change existing
work without the asker's Confirm; it could still lead the bot to create a task, which is visible
and easy to archive.

**Known gaps.**

- `/api/v1` doesn't expose the per-person levels set in a project's share dialog, so someone listed
  as "Can view" counts as an editor here (the roadmap closes it with delegated access).
- The mapping trusts Slack: a Slack workspace admin who changes someone's Slack email changes which
  tracker member they're matched to.
- Conversations and their checkpoints aren't pruned or summarised yet; very long threads will
  eventually exceed the model's context.

## Set up

1. **Tracker:** in **Settings → API → Bots**, create a bot named "Sudo Tracker" (role Member), put
   it on the private projects it should work in, and make it a **Read and write** key. That key is
   `SUDO_API_KEY`.
2. **Slack:** at https://api.slack.com/apps choose **Create New App → From a manifest**, pick the
   workspace, and paste [`slack-manifest.json`](slack-manifest.json) (production) or
   [`slack-manifest.staging.json`](slack-manifest.staging.json) ("Sudo Tracker (staging)", with
   `/sudo-staging`, so the two can live in one workspace). Each lists its tracker's domain for
   link previews. Then:
   - **Basic Information → App-Level Tokens:** create one with `connections:write`. That's
     `SLACK_APP_TOKEN` (`xapp-…`).
   - **Install App:** install it to the workspace. The **Bot User OAuth Token** is
     `SLACK_BOT_TOKEN` (`xoxb-…`).
   - Invite it to channels where people will mention it: `/invite @Sudo Tracker`.
3. **Model:** calls go through Sudo Sapient's LLM proxy: set `LLM_PROXY_BASE_URL`
   (`https://llm-proxy.sudosapient.dev`) and `LLM_PROXY_API_KEY`. `SLACK_BOT_MODEL` picks the model.
4. **Run** from the repo root:

   ```bash
   pnpm install
   SUDO_URL=https://tracker.example.com SUDO_API_KEY=ssk_… \
   SLACK_BOT_TOKEN=xoxb-… SLACK_APP_TOKEN=xapp-… LLM_PROXY_BASE_URL=… LLM_PROXY_API_KEY=… \
   pnpm --filter @sudosapient/slack-bot start
   ```

   `pnpm --filter @sudosapient/slack-bot dev` restarts on changes. It logs which Slack workspace
   and tracker identity it runs as, and warns if the key belongs to a person or is read-only.

**Socket Mode** (the default) needs no public URL: the bot connects out to Slack, so it can run on
a machine behind the tailnet. To take Slack's HTTP requests instead, set `SLACK_SOCKET_MODE=false`
and `SLACK_SIGNING_SECRET`, serve `HOST:PORT` behind a public HTTPS URL, and use
`https://<that URL>/slack/events` for events, interactivity and the slash command.

### Without Slack

Slack is only the surface. The same agent, tools, access checks and confirmations run in a
terminal against any tracker, which is how the bot is tried before Slack is connected:

```bash
SUDO_URL=https://sudo-tracker-staging.up.railway.app SUDO_API_KEY=ssk_… LLM_PROXY_BASE_URL=… LLM_PROXY_API_KEY=… \
  pnpm --filter @sudosapient/slack-bot chat --as bea@example.com --project WEB
> file a bug for me: the signup page is blank on Safari 17
```

`--as` names the person asking (an active tracker member's email); the bot then does only what they
could. Changes that would wait for Confirm in Slack ask `Confirm? [y/N]`, or pass `--yes` / `--no`.
Put a request after the options to run it once and exit.

### Deploying

The bot has its own image: `packages/slack-bot/Dockerfile`, built from the repository root. On
Railway it's a second service from this repo, with these settings on the service (the repo has no
`railway.json`: one at the root would make Railway build the tracker for this service too):

- **Dockerfile path** `packages/slack-bot/Dockerfile`, **health check** `/health` (120-second timeout),
  restart policy On failure with 5 retries;
- **watch paths** `packages/slack-bot/**`, `packages/client/**`, `packages/mcp/src/**`,
  `pnpm-lock.yaml`, `pnpm-workspace.yaml`, so only changes to the bot deploy it;
- a **volume** at `/data` (mappings, thread links, pending confirmations, conversations);
- the variables below (`SUDO_URL` pointing at the same environment's tracker);
- **one replica**: conversations and pending confirmations live in its SQLite files, and two
  processes on one Slack app token would split Slack's events between them.

It follows the branches like the tracker does: `dev` → the `staging` environment, `prod` →
`production` (see [CI and releases](../../docs/ci-and-releases.md)). Each environment needs its own
Slack app (e.g. "Sudo Tracker (staging)"), since one app's events go to only one connection. Socket
Mode, so no public domain is needed.

## Configuration

| Variable                 | Default                     | What                                                                                                                                                 |
| ------------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUDO_URL`               | (required)                  | The tracker's base URL                                                                                                                               |
| `SUDO_API_KEY`           | (required)                  | The bot member's **Read and write** key                                                                                                              |
| `SLACK_BOT_TOKEN`        | (required)                  | `xoxb-…`                                                                                                                                             |
| `SLACK_APP_TOKEN`        | (required in Socket Mode)   | `xapp-…` with `connections:write`                                                                                                                    |
| `SLACK_SOCKET_MODE`      | `true`                      | `false` to serve Slack's HTTP requests on `HOST:PORT` (needs `SLACK_SIGNING_SECRET`)                                                                 |
| `LLM_PROXY_BASE_URL`     | (none)                      | The LLM proxy (Anthropic API at its root, OpenAI's at `/v1`); `SLACK_BOT_LLM_BASE_URL` overrides it, and without either `ANTHROPIC_BASE_URL` is used |
| `LLM_PROXY_API_KEY`      | (none)                      | The proxy's key; `SLACK_BOT_LLM_API_KEY` overrides it, and without either `ANTHROPIC_API_KEY` is used                                                |
| `SLACK_BOT_MODEL`        | `anthropic:claude-opus-5-5` | A LangChain `provider:model`; other providers go through `initChatModel` and need their own `@langchain/<provider>` package and key                  |
| `SLACK_BOT_EFFORT`       | `medium`                    | Anthropic effort: `low` answers faster, `high` thinks harder                                                                                         |
| `SLACK_BOT_MAX_TOKENS`   | `16000`                     | Per model call                                                                                                                                       |
| `SLACK_BOT_CONFIRM`      | `edits`                     | What waits for Confirm: `edits` (changes to existing tasks), `all` (every write) or `none`                                                           |
| `SLACK_BOT_TIMEZONE`     | `UTC`                       | Optional. Only the last fallback for whose clock, when the tracker doesn't say a person's zone (an older server); see **Whose clock** below          |
| `SLACK_BOT_MCP_SERVERS`  | (none)                      | Read-only knowledge sources over MCP, as JSON: `{"sudopedia":{"url":"http://<tailnet-ip>:8765/mcp","tools":["get_context","search","read"]}}`        |
| `SLACK_BOT_UNFURL_HOSTS` | `SUDO_URL`'s host           | Comma list of hosts whose task and project links get previews                                                                                        |
| `SLACK_BOT_DATA_DIR`     | `./data`                    | Where `slack-bot.db` (mappings, links, confirmations) and `slack-bot-checkpoints.db` (conversations) live                                            |
| `SLACK_BOT_NAME`         | `Sudo Tracker`              | What it calls itself                                                                                                                                 |
| `PORT`                   | (none)                      | In Socket Mode, serves only `GET /health` (for the host's health check), on `HOST` (default `0.0.0.0`)                                               |

## How it works

```
Slack (Socket Mode / HTTP)
  └─ Bolt listeners: ack within 3s ─▶ slack/handlers.js
        ├─ who's asking: people.js (Slack email → tracker member; access mirrors the app's rule)
        ├─ what's being discussed: slack/context.js (thread transcript, names, permalink)
        └─ agent.js: LangChain createAgent (a LangGraph graph), one thread per Slack thread
              ├─ model: ChatAnthropic (Claude Opus 5.5, adaptive thinking) or any initChatModel provider
              ├─ tools.js: tracker tools over /api/v1, scoped to the requester
              │     (reusing @sudosapient/mcp's tool code, so results match the MCP server's),
              │     and show_card: a card for the reply (slack/cards.js)
              ├─ mcp.js: extra read-only tools from MCP servers (Sudopedia) via @langchain/mcp-adapters
              ├─ middleware: per-channel system prompt + guidance · human-in-the-loop (Confirm) ·
              │              model retries · a 25-tool-call budget per run
              └─ checkpoints: SQLite (LangGraph SqliteSaver), so Confirm survives restarts
```

- **Skills** are Markdown files in [`src/skills/`](src/skills) (front matter `name` and
  `description`, then instructions): filing issues, updating work, answering questions, and how
  to write for Slack. They're part of the system prompt, which stays the same between requests so
  the provider can cache it. Add a file to add a skill.
- **Cards** ([`src/slack/cards.js`](src/slack/cards.js)). For lists of tasks, status breakdowns and
  workload, the agent calls `show_card` with a [json-render](https://json-render.dev) spec. It
  becomes a Chat SDK card (`@json-render/chat`'s `toCard`) and then Block Kit (`@chat-adapter/slack`'s
  `cardToBlockKit`): a header, text, fields, Slack's native `data_table` and up to two
  `data_visualization` charts (pie, bar, line, area). The tool checks the spec with the same code
  that posts it, so problems (a third chart, a label over 20 characters) go back to the model to
  fix. Short answers stay plain text.
  - Neither library escapes anything, so the bot does: text gets the same treatment as replies (no
    `<!channel>` or `<@…>`, links only to the tracker and Slack), and plain text (header, cells, chart
    labels) can't form a mention or a link. The posted blocks are checked again before they go out.
  - The catalog has no Actions, Button, LinkButton or Image, and no Card image. The only buttons are
    the bot's own (task cards, Confirm/Cancel).
  - A card only shows what the agent got from its tools, in the same message as its reply, so
    `shownHere()` applies to it like everything else.
  - If Slack refuses the blocks, the same card goes out as text (tables and charts in code blocks).
    `sudo-tracker chat` prints that text version.
- **Confirmations** use LangChain's `humanInTheLoopMiddleware` in per-call mode. (Batched mode drops
  the other tool calls of a turn when one is rejected, which leaves calls without results.) A new
  message from the same person, or a run that broke off (a timeout, a restart), starts a fresh
  round of that conversation rather than resuming it, so its history is never left with a tool call
  that has no result.
- **Whose clock** ([`src/clock.js`](src/clock.js)). Every request is read on the clock of the person
  asking, never one clock for the team: "Friday 5pm" from someone in Dubai is 5 PM in Dubai. It's
  their zone saved in the tracker (a Member's `timeZone` when `timeZoneSource` is `person`), else
  their Slack profile's, else the tracker's for them (the workspace's, else UTC), else
  `SLACK_BOT_TIMEZONE`. It's resolved once per request (members are cached for a minute, Slack
  profiles for five, so a changed zone is used within minutes) and used for "today", the due times
  the model sends and reads, the "Today is …" line of the request, `/sudo my`, the create modal
  (the time picker shows the zone), and for a task card button the clicker's. Each request gets its
  own tracker client on that zone, so people asking at the same time never share one; it sends the
  zone as `Sudo-Time-Zone`, so what the tracker words itself (history like "to Nov 10, 5:00 PM",
  calendar events) is on the asker's clock too, not the bot member's. A change
  waiting for Confirm keeps the asker's zone, and its dates are read when it's asked ("tomorrow
  17:00" is saved as the moment it meant then), so the card shows, and Confirm makes, whenever it's
  pressed and after a restart, the change they asked for.
  - Messages in a channel are read by everyone, each on their own clock, so a timed due on a task
    card, a list, a preview or a confirmation is Slack's date token
    (`<!date^UNIX^{date_short_pretty} {time}|fallback>`): each viewer sees their own day and time.
    The fallback (notifications, clients that can't show the token) is on the asker's clock, with
    the zone. An all-day due is a plain date. Slack shows the token only in mrkdwn, so dates never go
    in plain text, headers or modals. `sudo-tracker chat` uses the requester's saved zone (else the
    tracker's for them).
  - The model's own words can't hold a token (its replies and cards are escaped, so a token it
    writes shows as text), so what it reads names the zone instead: a timed due or start in a tool
    result is `2026-11-20 17:00 GMT+4` (the zone's short name on the asker's clock; an all-day one
    stays `2026-11-20`), the prompt and the `slack-style` skill tell it to keep the zone with every
    time it writes in a channel, and a card with a time of day and no zone after it goes back to the
    model to fix. A due it sends back with that zone is read as the same moment; one naming another
    clock's zone is refused.
- **One run at a time per conversation**, in arrival order; a run stops after 3 minutes and each
  tracker call after 20 seconds. Slack redeliveries are recognised and
  handled once. Creating a task uses an idempotency key, so a replayed tool call can't create it
  twice.
- **Restarts.** On shutdown the bot waits up to 10 seconds for runs already going. Whatever a
  restart still cuts off is told on the next start, never run again (a write may already have
  happened): a reply left at "Working on it…" says the bot restarted and to ask again; a Confirm
  the agent hadn't started on gets its buttons back (nothing was changed); one it had started on
  says it can't tell whether the change went through, to check first; a Cancel says it was
  cancelled.

## Tests

`pnpm test` from the repo root runs them with the other API tests: a real tracker on an in-memory
database, a fake Slack Web API, and LangChain's scripted `FakeToolCallingModel`, so they cost
nothing and need no keys. They cover mentions, the requester's access, each person's clock (India
and Dubai at once, the Slack profile's and the workspace's zone), Confirm/Cancel (including
across a restart), task cards, reply cards (spec → Block Kit, escaping, what a card can't have,
Slack's limits, the plain-text fallback), `/sudo`, the modal, previews, and MCP tools loaded from the tracker's
own `/api/mcp` over HTTP.

`pnpm --filter @sudosapient/slack-bot test:live` runs the **live scenarios**
([`test/live/scenarios.live.js`](test/live/scenarios.live.js)): the real model through the LLM proxy
behind the whole bot (handlers, fake Slack, in-memory tracker), checking what ends up in the
tracker. The cases cover:

- filing from a thread (assignee, due date, project), then a follow-up in the same thread;
- one task per problem;
- finding a duplicate instead of filing it;
- "what's on my plate";
- "status of WEB" as a card, without the private project;
- private projects that must not leak;
- instructions planted in a thread;
- reschedules waiting for Confirm;
- comments in the asker's name;
- asking which project when it isn't clear;
- a Guest refused without a Confirm card.

They spend tokens (about a dollar a run), so run them before merging changes to prompts, skills or
tools, not on every commit.

With `SUDO_STAGING_URL` and `SUDO_STAGING_KEY` (the staging bot member's key) set, the same command
also runs [`test/live/staging.live.js`](test/live/staging.live.js) against the **deployed** staging
tracker, without Slack. It runs as the people `scripts/seed-staging.js` makes, covering:

- filing with priority and a due date, and the "via Slack (Bea Member)" label;
- a reschedule after confirmation;
- "my plate";
- no leaks from a private project;
- a Guest refused without a confirmation.

It archives what it created.
