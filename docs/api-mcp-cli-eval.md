# API, MCP and CLI: evaluation

How the public API (`/api/v1`), the MCP server and `sudo-cli` were proven to work, and how to check
again. Background: [API reference](api.md), [MCP server](../packages/mcp/README.md),
[CLI](../packages/cli/README.md).

## Automated checks

```bash
pnpm test                                # everything below plus the existing suites
pnpm exec vitest run test/server/api.test.js test/server/bots.test.js packages/mcp packages/cli
pnpm test:e2e                            # all journeys; 09-api signs in as the owner the earlier ones create
node packages/mcp/scripts/budget.js      # MCP context budget (tables below)
node packages/mcp/scripts/results.js     # tool results vs raw API responses
```

| Requirement                                                                        | Proven by                                                                                                                                                                             |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Key created in Settings → API; Bearer auth on `/api/v1`                            | `e2e/09-api.spec.js` (creates the key in the UI, uses it, revokes it in the UI → 401); `api.test.js › personal API keys` (hashed storage, shown once, revoke, expiry, no cookie auth) |
| Script / CLI creates, comments, completes; the open app shows each step live       | `e2e/09-api.spec.js` (list, drawer comments and activity update without reload); `api.test.js › create → comment → complete …` (SSE fan-out, notifications, bootstrap)                |
| MCP client finds / creates / completes with a personal key; activity says "via …"  | `packages/mcp/test/mcp.test.js`: the **official MCP SDK client** over Streamable HTTP (`/api/mcp`) and over stdio (spawning `sudo-mcp` against a real HTTP server)                    |
| Guest and private-project limits enforced                                          | `api.test.js › permissions through the API` and `mcp.test.js › enforces the key’s person`                                                                                             |
| Read-only scope                                                                    | `api.test.js › read-only keys …` (403 `insufficient_scope`); `mcp.test.js` (write tools hidden and refused)                                                                           |
| Writes go through the app's rules, atomically                                      | `api.test.js › writes behave like the app’s` (same activity verbs as the app, recurring tasks, all-or-nothing rollback, `via` can't be forged from the app)                           |
| Idempotency-Key, cursors, `{ error, code, field }`, RateLimit / 429                | `api.test.js › API conventions`                                                                                                                                                       |
| OpenAPI 3.1 served and in sync                                                     | `api.test.js › OpenAPI`: every `$ref` resolves, and real responses from every GET endpoint parse against the documented schemas (strictly: no undocumented fields)                    |
| CLI arguments, dates, happy path                                                   | `packages/cli/test/cli.test.js` (login saves a 0600 config, `new` / `tasks` / `comment` / `assign` / `done` / `show` / `open` / `--json`, every step logged "via CLI")                |
| MCP tool text stays small                                                          | `mcp.test.js › context budget` fails if any description passes 80 characters or `tools/list` passes 2,700                                                                             |
| Impossible dates refused (`2026-02-31` → 400 `due`)                                | `api.test.js › refuses dates that don’t exist, which would otherwise break repeating tasks`                                                                                           |
| Key names can't inject control / bidi characters into "via"                        | `api.test.js › labels changes with the key’s name when the client sends no label, and the app can’t forge one`                                                                        |
| One person's keys share one rate limit; each MCP batch message counts              | `api.test.js › limits each person’s keys together, …`; `mcp.test.js › limits protocol messages per person too, counting each message in a batch`                                      |
| A broken live stream can't stop fan-out to others or a removed person's disconnect | `api.test.js › a broken stream doesn’t keep changes from other apps, or keep a removed person connected`                                                                              |
| No API key over plain http to another machine without `--insecure`                 | `cli.test.js › treats only plain http to another machine as insecure` and the happy path; `mcp.test.js › won’t send the key over plain http …`                                        |
| Bots: Owner/Admin manage them and their keys; Members, Guests and keys get 403     | `bots.test.js › managing bots` (create, rename, re-scope, remove, keys with password; 403s; sync can't edit or mint a bot)                                                            |
| Bots: a bot key gets the bot's role and projects, and its own rate limit           | `bots.test.js › a bot key acts with the bot’s role and projects only` (Guest bot, Member bot, Can view / Can comment, private projects, separate budget)                              |
| Bots: work by a bot key is by the bot; `me.kind`                                   | `bots.test.js › attribution`; `e2e/10-bots.spec.js` (bot made in Settings, its key used, "Release Bot" + Bot badge in the open app's Activity and comments)                           |
| Bots never sign in, get links, email, notifications or push                        | `bots.test.js › bots never sign in or get mail`                                                                                                                                       |
| Bots outlive the admin who made the key; removing a bot revokes its keys           | `bots.test.js › lifecycle`                                                                                                                                                            |
| MCP and CLI work unchanged with a bot key                                          | `mcp.test.js › works unchanged with a bot’s key …`; `cli.test.js › works unchanged with a bot’s key, as the bot`                                                                      |

## Try it by hand

```bash
pnpm dev                     # API :8787, app http://localhost:5173
pnpm db:seed                 # optional demo workspace: hello@sudosapient.dev / sapient-demo-123
```

1. Open the app, **Settings → API**, create a key "Laptop" (Read and write; it asks for your
   password). Copy it.
2. Keep a browser tab open on a project's **List**, with any task's drawer on **Activity**.
3. In a terminal:

   ```bash
   node packages/cli/bin/sudo-cli.js login --url http://localhost:5173   # paste the key
   node packages/cli/bin/sudo-cli.js new "Try the API" -p WEB --due friday -a me
   node packages/cli/bin/sudo-cli.js comment WEB-301 "From the terminal"   # use the key it printed
   node packages/cli/bin/sudo-cli.js done WEB-301
   ```

4. MCP: point a client at it (configs in the [MCP README](../packages/mcp/README.md)), e.g.

   ```bash
   claude mcp add --transport http sudo-sapient http://localhost:5173/api/mcp --header "Authorization: Bearer ssk_…"
   npx @modelcontextprotocol/inspector   # or STDIO: node packages/mcp/bin/sudo-mcp.js with SUDO_URL / SUDO_API_KEY
   ```

   Ask it to "find the Try the API task, comment that it works, and complete it".

Checklist for the open tab (nothing reloaded):

- [ ] The new task appears in the list as soon as `new` returns.
- [ ] Its drawer shows the comment, then the task done.
- [ ] Activity reads "You via CLI created / commented on / completed", and "via Claude" (or Cursor,
      MCP Inspector, …) for the assistant's changes.
- [ ] Another person assigned to the task gets the assignment and mention notifications, as when
      done in the app.
- [ ] A Guest's key can't see private projects or projects they aren't on (404), and in a "Can
      comment" project can comment but not complete (403).
- [ ] Revoking the key in Settings → API makes the next CLI command fail with "Run sudo-cli login".

## MCP context budget

What an assistant loads before doing anything: `tools/list`, plus resources and the one-line server
instructions. Characters ÷ 4 ≈ tokens.

**Trim pass.** The first working version already had one-line descriptions. The pass then removed
per-property prose that repeated across tools ("Task key, e.g. WEB-12" on six tools, "Project key" on
three, "Name, email or me" on two) in favour of one sentence in the server instructions, and
shortened four descriptions.

| Tool                      | Before (chars) | After (chars) | After ≈ tokens |
| ------------------------- | -------------: | ------------: | -------------: |
| `search`                  |            208 |           190 |             48 |
| `get_task`                |            268 |           209 |             53 |
| `list_my_work`            |            260 |           260 |             65 |
| `list_projects`           |            177 |           161 |             41 |
| `list_members`            |            148 |           148 |             37 |
| `summarise_project`       |            269 |           233 |             59 |
| `create_task`             |            440 |           374 |             94 |
| `update_task`             |            526 |           476 |            119 |
| `complete_task`           |            186 |           148 |             37 |
| `assign`                  |            261 |           185 |             47 |
| `comment`                 |            236 |           198 |             50 |
| **`tools/list`**          |      **3,001** |     **2,604** |       **≈651** |
| + resources, instructions |    ≈838 tokens |   ≈741 tokens |                |

Read-only keys see 6 tools: 1,218 chars ≈ 305 tokens (≈395 with resources and instructions).

For comparison, a generic generator making one tool per OpenAPI operation, with the full request
schemas, would load 15 tools and 8,395 chars (≈2,099 tokens): 3.2 times as much.

**Results** matter more than descriptions, since they're paid on every call. Tools return compact
JSON: task keys and people's names instead of ids, empty fields dropped, comments and activity as
one line each, descriptions cut at 2,000 characters, at most 10 to 30 items. On the demo workspace (49
tasks, 9 comments, 8 people), against the raw REST responses a generic bridge would pass through
(including the `/members` lookup needed to name people):

| Tool                | Raw REST chars | Tool result chars | Smaller by |
| ------------------- | -------------: | ----------------: | ---------: |
| `list_my_work`      |          4,155 |               971 |        77% |
| `search` "Create"   |          1,275 |               159 |        88% |
| `get_task` WEB-109  |          3,003 |             1,034 |        66% |
| `summarise_project` |         10,090 |             1,757 |        83% |
| `list_projects`     |          2,231 |               450 |        80% |

No `outputSchema` or `structuredContent` is sent: they'd repeat each result in the context a second
time.
