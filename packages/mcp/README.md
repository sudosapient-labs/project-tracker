# @sudosapient/mcp

An MCP server so Claude, Cursor and other MCP clients can find, create, update and complete Sudo
Sapient tasks. It uses a personal API key, so the assistant has exactly your permissions (private
projects and Guest limits included), and its changes show in Activity as "you via Claude" (or Cursor,
…). Its only dependency is [`@sudosapient/client`](../client), the API client it shares with the
CLI.

Two ways to connect:

- **Remote (HTTP):** the app hosts it at `https://<your workspace>/api/mcp`. Send the key as
  `Authorization: Bearer ssk_…`.
- **Local (stdio):** run `npx -y @sudosapient/mcp` (Node 20 or later), which talks to your
  workspace's `/api/v1`; `npm install -g @sudosapient/mcp` gives you the `sudo-mcp` command. From a
  checkout of this repo: `pnpm install`, then `node packages/mcp/bin/sudo-mcp.js`.

## Configure your client

Create a key in **Settings → API**. Pick **Read only** if the assistant should only look: write tools
are then not offered at all. Every tool carries explicit annotations (`readOnlyHint`,
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

`sudo-mcp` also reads the URL and key saved by `sudo-cli login`. Options: `--url`, `--key`,
`--read-only` (or `SUDO_MCP_READ_ONLY=1`) to register only the read tools even with a write key
(write tools aren't listed, and calling one is an "Unknown tool" error; off by default),
`--http [--port 3333]` to serve Streamable HTTP on 127.0.0.1 (each request brings its own key), and
`--insecure` to allow a plain `http://` workspace URL that isn't this machine (refused otherwise).

**MCP Inspector:** `npx @modelcontextprotocol/inspector`, then connect to `https://…/api/mcp`
(Streamable HTTP, header `Authorization: Bearer ssk_…`, through the Inspector's proxy), or choose
STDIO with `npx -y @sudosapient/mcp` and the two `SUDO_` variables.

## Tools

| Tool                | Does                                                   | Annotations                    |
| ------------------- | ------------------------------------------------------ | ------------------------------ |
| `search`            | Tasks, projects and people matching text or a task key | read-only, idempotent          |
| `get_task`          | A task with subtasks, recent comments and activity     | read-only, idempotent          |
| `list_my_work`      | My open (or done / all) tasks, soonest due first       | read-only, idempotent          |
| `list_projects`     | Projects with open / done counts                       | read-only, idempotent          |
| `list_members`      | People                                                 | read-only, idempotent          |
| `summarise_project` | Counts by status, overdue, unassigned, next due        | read-only, idempotent          |
| `create_task` ✎     | Returns the new key                                    | write, not destructive         |
| `update_task` ✎     | Title, status, priority, due, description, project     | write, destructive, idempotent |
| `complete_task` ✎   |                                                        | write, destructive, idempotent |
| `assign` ✎          | To a name, email or `me`; `""` unassigns               | write, destructive, idempotent |
| `comment` ✎         | `@Name` mentions notify                                | write, destructive             |

✎ needs a Read and write key (and no `--read-only`). `openWorldHint` is `false` on all of them.
Resources: `sudo://my-work` and `sudo://project/{key}` (same JSON as `list_my_work` and
`summarise_project`).

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
server's instructions explain keys once), and compact JSON with names and keys instead of ids. All of
`tools/list` is about 950 tokens, a third of it the annotations. `node packages/mcp/scripts/budget.js`
prints the sizes per tool; `node packages/mcp/scripts/results.js` compares tool results with raw API responses.

## License

UNLICENSED, all rights reserved. The package is public on npm so anyone can install and run it, but
no license to copy, modify or redistribute the code is granted.
