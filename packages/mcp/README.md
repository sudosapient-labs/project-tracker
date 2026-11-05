# @sudosapient/mcp

An MCP server so Claude, Cursor and other MCP clients can find, create, update and complete Sudo
Sapient tasks. It uses a personal API key, so the assistant has exactly your permissions (private
projects and Guest limits included), and its changes show in Activity as "you via Claude" (or Cursor,
…). No dependencies.

Two ways to connect:

- **Remote (HTTP):** the app hosts it at `https://<your workspace>/api/mcp`. Send the key as
  `Authorization: Bearer ssk_…`.
- **Local (stdio):** run `sudo-mcp`, which talks to your workspace's `/api/v1`. Not on npm yet; run
  it from a checkout: `pnpm install`, then `node packages/mcp/bin/sudo-mcp.js` (or symlink that file
  onto your PATH as `sudo-mcp`).

## Configure your client

Create a key in **Settings → API**. Pick **Read only** if the assistant should only look: write tools
are then not offered at all. Read tools are marked `readOnlyHint`, so clients that confirm tool use
ask before writes only.

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
      "command": "node",
      "args": ["/path/to/project-tracker/packages/mcp/bin/sudo-mcp.js"],
      "env": { "SUDO_URL": "https://sudo.example.com", "SUDO_API_KEY": "ssk_…" }
    }
  }
}
```

`sudo-mcp` also reads the URL and key saved by `sudo-cli login`. Options: `--url`, `--key`,
`--read-only` (or `SUDO_MCP_READ_ONLY=1`) to hide write tools even with a write key, and
`--http [--port 3333]` to serve Streamable HTTP on 127.0.0.1 (each request brings its own key).

**MCP Inspector:** `npx @modelcontextprotocol/inspector`, then connect to `https://…/api/mcp`
(Streamable HTTP, header `Authorization: Bearer ssk_…`, through the Inspector's proxy), or choose
STDIO with `node packages/mcp/bin/sudo-mcp.js` and the two `SUDO_` variables.

## Tools

| Tool                | Does                                                   |
| ------------------- | ------------------------------------------------------ |
| `search`            | Tasks, projects and people matching text or a task key |
| `get_task`          | A task with subtasks, recent comments and activity     |
| `list_my_work`      | My open (or done / all) tasks, soonest due first       |
| `list_projects`     | Projects with open / done counts                       |
| `list_members`      | People                                                 |
| `summarise_project` | Counts by status, overdue, unassigned, next due        |
| `create_task` ✎     | Returns the new key                                    |
| `update_task` ✎     | Title, status, priority, due, description, project     |
| `complete_task` ✎   |                                                        |
| `assign` ✎          | To a name, email or `me`; `""` unassigns               |
| `comment` ✎         | `@Name` mentions notify                                |

✎ needs a Read and write key. Resources: `sudo://my-work` and `sudo://project/{key}` (same JSON as
`list_my_work` and `summarise_project`).

Tool text and results are kept small on purpose: one-line descriptions, no per-property prose (the
server's instructions explain keys once), and compact JSON with names and keys instead of ids. All of
`tools/list` is about 650 tokens. `node packages/mcp/scripts/budget.js` prints the sizes per tool;
`node packages/mcp/scripts/results.js` compares tool results with raw API responses.
