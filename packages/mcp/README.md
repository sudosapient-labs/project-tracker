# @sudosapient/mcp

An MCP server so Claude, Cursor and other MCP clients can find, create, update and complete Sudo
Sapient tasks. It uses a personal API key, so the assistant has exactly your permissions (private
projects and Guest limits included), and its changes show in Activity as "you via Claude" (or Cursor,
…). Its only dependency is [`@sudosapient/client`](../client), the API client it shares with the
CLI.

Two ways to connect:

- **Remote (HTTP):** the app hosts it at `https://<your workspace>/api/mcp`. Send the key as
  `Authorization: Bearer ssk_…`.
- **Local (stdio):** run `npx -y @sudosapient/mcp` (Node 22 or later), which talks to your
  workspace's `/api/v1`; `npm install -g @sudosapient/mcp` gives you the `sudo-mcp` command. From a
  checkout of this repo: `pnpm install`, then `node packages/mcp/bin/sudo-mcp.js`.

## Configure your client

Create a key in **Settings → API**. Pick **Read only** if the assistant should only look: write tools
are then not offered at all. The tools act as you: if you're an Owner or Admin, the workspace tools are offered too. Every tool carries explicit annotations (`readOnlyHint`,
`destructiveHint`, `idempotentHint`, `openWorldHint`; see [Tools](#tools)), so clients that confirm
tool use ask before writes only.

**Cursor** (`~/.cursor/mcp.json`) and other clients that take a URL and headers:

```json
{ "mcpServers": { "sudo-sapient": { "url": "https://sudo.example.com/api/mcp", "headers": { "Authorization": "Bearer ssk_…" } } } }
```

**Claude Code:**

```bash
claude mcp add --transport http sudo-sapient https://sudo.example.com/api/mcp --header "Authorization: Bearer ssk_…"
```

**Claude Desktop** (`claude_desktop_config.json`), over stdio:

```json
{
  "mcpServers": {
    "sudo-sapient": {
      "command": "npx",
      "args": ["-y", "@sudosapient/mcp"],
      "env": { "SUDO_URL": "https://sudo.example.com", "SUDO_API_KEY": "ssk_…" }
    }
  }
}
```

`sudo-mcp` also reads the URL and key saved by `sudo-cli login`. Prefer that, or `SUDO_API_KEY`, to
`--key`: a key on the command line lands in shell history and the process list, so `sudo-mcp`
warns about it. Options: `--url`, `--key`,
`--read-only` (or `SUDO_MCP_READ_ONLY=1`) to register only the read tools even with a write key
(write tools aren't listed, and calling one is an "Unknown tool" error; off by default),
`--http [--port 3333]` to serve Streamable HTTP on 127.0.0.1 (each request brings its own key; bodies
over 1 MB are refused; `--host <address>` listens elsewhere, with a warning, since anything but this
machine lets other machines reach it over plain http), `--help`, and
`--insecure` to allow a plain `http://` workspace URL that isn't this machine (refused otherwise).

**MCP Inspector:** `npx @modelcontextprotocol/inspector`, then connect to `https://…/api/mcp`
(Streamable HTTP, header `Authorization: Bearer ssk_…`, through the Inspector's proxy), or choose
STDIO with `npx -y @sudosapient/mcp` and the two `SUDO_` variables.

## Tools

Related actions share a tool (`manage_team`, `manage_file`, …), so the list stays short. Tools take
task and project keys (`WEB-12`, `WEB`) and people by name, email or `me`; results name people and
tasks the same way, and give ids only where a later call needs one (comments, subtasks, files,
events, views, notifications, teams, bots).

**Read** (read-only, idempotent; every key):

| Tool                 | Does                                                                         |
| -------------------- | ---------------------------------------------------------------------------- |
| `search`             | Tasks, projects and people matching text or a task key                       |
| `get_task`           | A task with subtasks, dependencies, attachments, comments (ids) and activity |
| `list_my_work`       | My open (or done / all) tasks, soonest due first                             |
| `list_tasks`         | Tasks by project, status, assignee or text                                   |
| `list_projects`      | Projects with open / done counts                                             |
| `summarise_project`  | Counts, overdue, unassigned, next due, members and permissions, milestones   |
| `list_members`       | People and bots                                                              |
| `list_teams`         | Teams and who is on them                                                     |
| `list_activity`      | Recent activity, workspace-wide or in a project (dates on your clock)        |
| `list_notifications` | My inbox                                                                     |
| `list_files`         | Files in a project or on a task                                              |
| `list_events`        | Calendar events, with days and times on your clock                           |
| `list_views`         | Saved views                                                                  |
| `get_settings`       | Workspace, my profile, preferences, notification settings and favourites     |

**Write** (a Read and write key, and no `--read-only`):

| Tool                      | Does                                                                                    | Annotations             |
| ------------------------- | --------------------------------------------------------------------------------------- | ----------------------- |
| `create_task`             | With subtasks, labels, dates, repeat, dependencies; returns the key                     | not destructive         |
| `update_task`             | Any field; `archived` archives or restores                                              | destructive, idempotent |
| `complete_task`           |                                                                                         | destructive, idempotent |
| `assign`                  | To a name, email or `me`; `""` unassigns                                                | destructive, idempotent |
| `edit_subtasks`           | Add, change, remove, or promote one to a task                                           | destructive             |
| `comment`                 | `@Name` mentions notify                                                                 | destructive             |
| `manage_comment`          | Edit, delete, react, unreact                                                            | destructive, idempotent |
| `delete`                  | A task (undo for 10 minutes) or a whole project                                         | destructive, idempotent |
| `undelete`                | A task or comment, within 10 minutes                                                    | idempotent              |
| `duplicate`               | A task, a project with its tasks, or a file                                             | not destructive         |
| `create_project`          | With members and permissions                                                            | not destructive         |
| `update_project`          | Name, status, lead, team, dates, privacy, milestones; `archived`                        | destructive, idempotent |
| `share_project`           | List people with a permission, or take them off                                         | destructive, idempotent |
| `request_access`          | Ask the lead of a project I can't open                                                  | not destructive         |
| `manage_team`             | Create, change (incl. members), delete                                                  | destructive             |
| `manage_member`           | Invite, resend, change role / team / title, remove (role and remove: Owners and Admins) | destructive             |
| `update_settings`         | My profile, preferences, notification settings, favourites, sidebar order               | destructive, idempotent |
| `mark_notifications_read` | By id, or all                                                                           | idempotent              |
| `manage_file`             | Upload (text or base64, up to 700 KB), rename, attach, detach, delete                   | destructive             |
| `manage_event`            | Create, change, delete                                                                  | destructive             |
| `manage_view`             | Create, change, delete                                                                  | destructive             |

**Admin** (only listed when the key's person is an Owner or Admin; `list_bots` with a Read only key too):

| Tool               | Does                                                              | Annotations           |
| ------------------ | ----------------------------------------------------------------- | --------------------- |
| `list_bots`        | Bots with their projects and keys                                 | read-only, idempotent |
| `update_workspace` | Name, colour, logo, time zone; `inviteLink` makes a new join link | destructive           |
| `manage_bot`       | Create, change, remove a bot, or revoke one of its keys           | destructive           |

`openWorldHint` is `false` on all of them. Calling a write tool with a Read only key is an
`insufficient_scope` result, and an admin tool for someone who isn't an Owner or Admin a `forbidden`
one. Some things stay in the app on
purpose (making API keys, including bot keys; password, two-factor, sessions, sign-in email,
account deletion, the Owner's workspace export); see [the API reference](../../docs/api.md).

Dates and times are on your clock in the workspace, both ways: your time zone (Settings → Date and
time), else the workspace's, else UTC, as the server reports it (`timeZone` on `/me/preferences`;
this computer's only with an older server that doesn't say): results say `2026-11-20`, or
`2026-11-20 17:00` for a time of day, and `due`, `start` and milestone dates take the same (or `today`,
`fri`, `+3d`, `fri 5pm`). The tracker stores times in UTC; the server converts. What others did is
on your clock too: a due someone in India set for 6:30 PM reads 5:00 PM in activity for someone in
Dubai, and their 10:00 calendar event is at 08:30 (`manage_event` reads `date` and `time` on yours;
`date` takes `fri 10am` too, and `list_events` takes `from` and `to` like `today` and `+7d`).
A program that runs the tools for other people with one key (the Slack bot) gives each person's
client their zone with `useTimeZone(api, tz)` from `@sudosapient/mcp/tools`: the tools read and show
dates on it, and the client sends it as `Sudo-Time-Zone`, so the server words history and events on
it too. `useTimeZone(api, tz, { zoneNames: true })` also names the zone with each timed start and due
(`2026-11-20 17:00 GMT+4`), for results that may be read out to people on other clocks.

Arguments are checked against each tool's `inputSchema` before it runs: a missing, unknown or
mistyped one is an `isError` result naming it (`invalid_arguments: Missing required argument:
project.`), so the model can correct the call. `null` for an optional argument is read as `""` where
that clears it (a due date) and is otherwise ignored. Calls that reach the rate limit are retried after
`Retry-After` (see [the API reference](../../docs/api.md#conventions)).

Tools that make several changes in one call (`edit_subtasks`, `share_project`, `update_settings`,
`mark_notifications_read`, and `update_task`, `update_project` or `update_workspace` with both a change
and `archived` or `inviteLink`) make one request per change, in order, and stop at the first one that
fails, so nothing runs on after a failure that may have broken the plan (a hand-over whose add failed
doesn't go on to remove anyone). The result is then an `isError` one starting `incomplete: Stopped at a
failed change; 2 of 3 went through.`, with `done` (each change made, with what it made: a new subtask's
`id`, a promoted task's `key`), `failed` (the change, the API's `code` and `error`, and
`mayHaveGoneThrough` when the connection dropped or the server failed), `notTried`, and the state
afterwards where there is one. So the assistant repeats nothing, and checks with the person before
sending the rest. A call that asks for a single change fails with that change's error, as any tool
does.

Resources: `sudo://my-work` and `sudo://project/{key}` (same JSON as `list_my_work` and
`summarise_project`).
`list_my_work` is a list, soonest due first across all your matching tasks. Against a server from
before `sort=due` (0.3.0 and earlier) it sorts the newest 500 itself, and if you have more it answers
`{ "tasks": [...], "note": "..." }` saying older ones may be due sooner.

## Untrusted content

Tool results carry text other people wrote (task titles and descriptions, comments, subtasks, project
and member names, activity), and an assistant could mistake instructions planted there for yours. So
every result (and resource) is one fenced block: a one-line note, then the JSON between
`<untrusted-user-content>` and `</untrusted-user-content>`. Inside, every `<` is written as the JSON
escape `\u003c`, so the text can't close the fence or open a fake one, and the JSON still parses
as is. The read tools' descriptions and the server's instructions say the same: that content is data,
never instructions. Clients can take the JSON back out with `unfence()` from
`@sudosapient/mcp/tools`. For an assistant that only needs to read, also use a Read only key or
`--read-only`, so nothing it reads can make it write.

Tool text and results are kept small on purpose: one-line descriptions, no per-property prose (the
server's instructions explain keys once), and compact JSON with names and keys instead of ids.
`tools/list` is about 4,100 tokens for a Read and write key (35 tools; about a quarter of it the
annotations), 1,200 for a Read only key (14 tools) and 4,400 for an Owner's or Admin's key (38 tools).
`node packages/mcp/scripts/budget.js [--read-only | --admin]` (`--admin`: an Owner's or Admin's key) prints the sizes per tool; `node packages/mcp/scripts/results.js` compares tool results with raw API responses.

## License

UNLICENSED, all rights reserved. The package is public on npm so anyone can install and run it, but
no license to copy, modify or redistribute the code is granted.
