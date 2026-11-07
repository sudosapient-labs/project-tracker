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

| In Slack                         | What happens                                                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `@Sudo Tracker file this for me` | Reads the thread, checks for duplicates, creates well-formed tasks in the channel's project, links the thread to them         |
| `@Sudo Tracker mark WEB-12 done` | Holds the change and posts **Confirm / Cancel**; only the person who asked can decide                                         |
| `@Sudo Tracker what's overdue?`  | Answers from the tracker, within what the person can see                                                                      |
| DM the bot                       | The same agent, privately; flat DMs share one conversation per day, DM threads their own                                      |
| Follow-up mention in a thread    | Continues the same conversation, with only the thread's new messages added                                                    |
| Task cards under replies         | **Complete**, **Assign to me** and **Status**, acting as whoever clicks                                                       |
| Message ⋯ → **Create task**      | A modal prefilled from the message (title, description, project, assignee, priority, due date)                                |
| `/sudo new <title>`              | The same modal; `/sudo <title>` works too                                                                                     |
| `/sudo my`, `/sudo search …`     | Your open tasks, or tasks matching words (only you see the answer)                                                            |
| `/sudo project WEB`              | Links the channel to a project: tasks filed there default to it (`/sudo project none` unlinks)                                |
| `/sudo guidance …`               | Instructions the agent follows, for the workspace or one channel (`/sudo guidance channel …`); tracker Owners/Admins set them |
| `/sudo link`                     | Shows how your Slack account maps to the tracker; admins can link someone by hand                                             |
| Pasting a task or project link   | A preview with status, assignee and due date, only if the person who pasted it can open it                                    |

## Who it acts as

- **In the tracker, as itself.** It uses a bot member's key (Settings → API → Bots). Tasks and
  comments are by "Sudo Tracker", and Activity shows **Sudo Tracker via Slack (Ada Lovelace)**, so
  every change names who asked for it. Created tasks end with "Requested by Ada in Slack: <link to
  the thread>"; comments are signed "— Ada, via Slack".
- **For the person who asked.** Each Slack user is mapped to a tracker member by their Slack email,
  and when the emails differ an Owner or Admin can link them by hand with `/sudo link @person email`.
  Every tool checks that member's access, even where the bot has more: they only see projects they
  could open in the app, only edit where they could edit (Guests comment), and "me" means them.
  People who can't be matched get an explanation, not an answer.
- **The tracker still enforces the bot's own access.** Put the bot on the private projects it
  should serve. It can never see more than its own member can.
- **Known gap:** `/api/v1` doesn't expose the per-person levels set in a project's share dialog, so
  someone listed as "Can view" counts as an editor here. Closing this is on the roadmap.

**Thread content is untrusted.** Slack messages and task text are given to the model as fenced
data, never as instructions. Changes to existing tasks wait for Confirm by default, so an
instruction hidden in a thread can't silently close or reassign work.

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
Railway it's a second service from this repo, with these settings:

- **Dockerfile path** `packages/slack-bot/Dockerfile` (also set as the `RAILWAY_DOCKERFILE_PATH`
  variable), **health check** `/health`;
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
| `SLACK_BOT_TIMEZONE`     | `Asia/Kolkata`              | For "today", "Friday", "end of month"                                                                                                                |
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
              │     (reusing @sudosapient/mcp's tool code, so results match the MCP server's)
              ├─ mcp.js: extra read-only tools from MCP servers (Sudopedia) via @langchain/mcp-adapters
              ├─ middleware: per-channel system prompt + guidance · human-in-the-loop (Confirm) ·
              │              model retries · a 25-tool-call budget per run
              └─ checkpoints: SQLite (LangGraph SqliteSaver), so Confirm survives restarts
```

- **Skills** are Markdown files in [`src/skills/`](src/skills) (front matter `name` and
  `description`, then instructions): filing issues, updating work, answering questions, and how
  to write for Slack. They're part of the system prompt, which stays the same between requests so
  the provider can cache it. Add a file to add a skill.
- **Confirmations** use LangChain's `humanInTheLoopMiddleware` in per-call mode. (Batched mode drops
  the other tool calls of a turn when one is rejected, which leaves calls without results.) A new
  message in the thread before anyone presses a button cancels the waiting change.
- **One run at a time per conversation**, in arrival order. Slack redeliveries are recognised and
  handled once. Creating a task uses an idempotency key, so a replayed tool call can't create it
  twice.

## Tests

`pnpm test` from the repo root runs them with the other API tests: a real tracker on an in-memory
database, a fake Slack Web API, and LangChain's scripted `FakeToolCallingModel`, so they cost
nothing and need no keys. They cover mentions, the requester's access, Confirm/Cancel (including
across a restart), cards, `/sudo`, the modal, previews, and MCP tools loaded from the tracker's
own `/api/mcp` over HTTP.

`pnpm --filter @sudosapient/slack-bot test:live` runs the **live scenarios**
([`test/live/scenarios.live.js`](test/live/scenarios.live.js)): the real model through the LLM proxy
behind the whole bot (handlers, fake Slack, in-memory tracker), checking what ends up in the
tracker. The cases cover:

- filing from a thread (assignee, due date, project), then a follow-up in the same thread;
- one task per problem;
- finding a duplicate instead of filing it;
- "what's on my plate";
- private projects that must not leak;
- instructions planted in a thread;
- reschedules waiting for Confirm;
- comments in the asker's name;
- asking which project when it isn't clear;
- a Guest refused without a Confirm card.

They spend tokens (about a dollar a run), so run them before merging changes to prompts, skills or
tools, not on every commit.
