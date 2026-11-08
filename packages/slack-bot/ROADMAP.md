# Sudo Tracker roadmap

Where the Slack agent is going, and how the current design leaves room for it. The aim is a
teammate in Slack that keeps work moving, like a good project manager. It files and updates work
when asked (today), follows up when work stalls, reports with charts, and notices work the team
has discussed but nobody has filed.

## Principles that carry through every phase

- **A separate service.** It talks to the tracker only through `/api/v1` (and MCP for other
  sources). Anything it needs from the tracker becomes a public API feature, not a back door.
- **The bot acts as itself, for a known person.** Tracker changes are by the bot member, labelled
  "via Slack (<person>)". Proactive work (reminders, follow-ups) is the bot's own, and every
  request someone makes is checked against their access (people.js).
- **Writes that change existing work wait for a human by default.** Proactive suggestions are
  always suggestions (buttons), never silent changes.
- **Other people's text is data.** Slack threads, task text and Sudopedia pages are fenced as
  untrusted in every prompt.
- **New abilities are new tools, skills and jobs.** A tool is a LangChain tool in `src/tools*.js`.
  A skill is a Markdown file in `src/skills/`. A job (phase 2 onward) is a scheduled LangGraph run.
  The Slack layer and the agent don't change shape.

## Phase 1: agent in Slack (done)

The [README](README.md) describes what it does today:

- `@mention` and DMs run the agent, which files, updates, links and answers.
- Changes to existing tasks wait for Confirm and Cancel buttons.
- Task cards come with action buttons.
- `/sudo` covers new, my, search, project, link and guidance.
- A "Create task" message shortcut opens a prefilled modal.
- Pasted task and project links get previews.
- Each Slack user is mapped to a tracker member.
- Guidance can be set for the workspace or a channel.
- Skills are Markdown files.
- Read-only MCP sources can be added, for Sudopedia.

## Phase 2: the rest of Linear's Slack integration

- **Synced threads.** For a task linked to a thread, new Slack replies become task comments, and
  tracker comments and status changes post back into the thread. Thread links are already
  stored (`threads` table). The tracker has no webhooks yet (#6), so the first version polls
  `GET /tasks?updatedSince=` and each linked task's comments every minute. Webhooks replace polling
  when they ship.
- **Personal notifications as DMs.** Assignments, mentions and due-date reminders go to the
  person's Slack, following their notification preferences, as a "Slack" channel next to Email and
  Push. This needs a notifications feed or webhooks from the tracker (#6).
- **Project channels.** `/sudo project WEB` already links a channel to a project. Next, the bot
  posts when tasks are created or completed and when a status changes, with a per-channel choice
  of events.
- **Issue keys in messages.** `WEB-12` mentioned anywhere in a channel the bot is in gets a
  compact card, at most once an hour per task per channel, like Linear. This is opt-in per
  channel, because it means reading every message (`channels:history`).
- **App Home.** "My work" (due soon, overdue, in progress) with the same card buttons.
- **Intake (like Linear Asks).** A 🎫 reaction or a DM files a request into a project's backlog
  for people without tracker accounts. The requester gets updates in their thread.
- **Templates** per channel, for title prefixes, labels and description sections.
- **Files.** Slack attachments become task attachments once the API takes files (#6).

## Phase 3: a manager in Slack

- **Daily work reminder.** Each morning, in each person's time zone, they get a DM with what's
  due today, what's overdue and what's in progress, plus a prompt: "Anything to update?". Their
  reply is read by the agent and turned into comments and status changes on the right tasks, with
  Confirm as usual. It can also post to `#daily-work` as that day's thread, the team's existing
  convention.
- **Follow-ups.**
  - When a task has gone quiet (no activity for N days, past due, or stuck in review), the bot
    asks the assignee in the task's Slack thread or a DM.
  - It records that it asked as a comment on the task ("Asked Ada for an update on 8 Nov"), so
    the tracker shows the chase.
  - If nothing changes after a second nudge, it tells the project lead.
- **Weekly project digest** in each project channel: what was done, what slipped, what's next.
- **Design.**
  - A scheduler (`src/jobs/`) runs each job as a LangGraph graph with its own checkpoints. Jobs
    use the same tools as the agent, as the bot, with no requester.
  - Nudges are stored (`nudges` table) to enforce quiet hours, per-person opt-out (`/sudo
reminders off`) and limits ("never nudge the same task twice in 2 days").
  - Admins set cadence and thresholds with `/sudo guidance` or settings.

## Phase 4: charts

- A `make_chart` tool: the agent builds a Vega-Lite spec from tracker data, and the bot renders
  it to PNG server-side (`vega` + `@resvg/resvg-js`, both pure JS or WASM) and uploads it to the
  thread with `files.uploadV2`. This needs the `files:write` scope.
- A charts skill covering burn-down for a project or milestone, status breakdown, workload per
  person, overdue trend, and throughput per week (from `completedAt`).
- Charts in the weekly digest (phase 3).

## Phase 5: Sudopedia, the team's memory

- **Grounded answers (works today).** Set `SLACK_BOT_MCP_SERVERS` to Sudopedia's MCP
  endpoint (`uv run sudopedia mcp --http`, port 8765 on the tailnet), allow `get_context`, `search`
  and `read`, and the agent can answer "what did the client say about the launch date" with
  citations. It can also enrich new tasks with project context. Sudopedia has no authentication
  yet, so the bot must run inside the tailnet.
- **A skill** for when to consult Sudopedia (client and project questions, before filing work
  for a client), and how to cite it ("per the 3 Nov call with Audesy").
- **Issue suggestions.**
  - A job reads what Sudopedia learned per project since its last run (new or changed claims),
    asks the agent whether any of it implies untracked work, and searches the tracker for
    duplicates.
  - It posts suggestions to the project's channel with **Create task** and **Dismiss** buttons.
    Dismissals are remembered so the same claim isn't suggested twice.
  - Sudopedia never posts anywhere by design, so the bot is the one that speaks.
  - This needs a "changes since" query on Sudopedia's API or MCP, which it doesn't have yet.

## Platform work along the way

- **Exact access for the requester.**
  - The tracker's share-dialog levels ("Can view", "Can comment") aren't in `/api/v1`, so a
    listed person counts as an editor in the bot today.
  - Fix this by adding the caller's level per project to the API, or better, delegated access:
    an OAuth app or an "act for member" grant on the bot's key (#6), with Activity showing
    "Sudo Tracker for Ada".
- **Webhooks** (#6) replace polling for synced threads, notifications and project channels.
- **Evals.**
  - A set of real (anonymised) threads with the tasks a good PM would file, run on every prompt
    or skill change, scored for project, title, assignee and dates, and for not filing
    duplicates.
  - Turn on LangSmith tracing (`LANGSMITH_TRACING=true`) to inspect runs.
- **More than one instance.** Move the store and checkpoints to Postgres (LangGraph has a
  Postgres checkpointer) so the bot can run highly available.
- **Pruning.** Drop checkpoints, cursors and confirmations of conversations idle for weeks.
- **Context size.** Add LangChain's summarization middleware for long DM conversations and very
  long threads.
