# Public API, MCP server and CLI

Scripts, the terminal and AI assistants work with Sudo Sapient through `/api/v1`, using a
**personal API key**. A key acts as the person who made it: the same projects, role and Guest limits
as in the app. Changes go through the same rules as the app, notify the same people, appear live in
open tabs, and show in Activity as "Ada via CLI" or "Ada via Claude".

- Reference with a try-it console: **`/api/docs`**. Spec: **`/api/v1/openapi.json`** (OpenAPI 3.1).
- MCP server: [`packages/mcp`](../packages/mcp/README.md), hosted by the app at **`/api/mcp`**.
- CLI: [`packages/cli`](../packages/cli/README.md) (`sudo-cli`).
- How it's tested and measured: [API, MCP and CLI evaluation](api-mcp-cli-eval.md).

## Keys

Create one in **Settings → API**: a name, **Read and write** or **Read only**, an expiry (30, 90, 365
days or never) and your current password. The key (`ssk_…`) is shown once; only its hash is stored.
Revoking it stops it straight away, and changing or resetting your password revokes all of yours. Send it as `Authorization: Bearer ssk_…`. Session cookies are not accepted on
`/api/v1`, and no CSRF header is needed.

Optionally send `X-Sudo-Client: <name>` to label your changes in Activity ("via <name>"); otherwise
they're labelled with the key's name.

## Bots

For automation (a release script, CI, an internal tool), an Owner or Admin creates a **bot** in
**Settings → API → Bots** instead of borrowing someone's key. A bot is a member with a name, a role
(**Member** or **Guest**, never Owner or Admin) and the projects it's on, so Guest limits, private
projects and Can view / Can comment apply to it exactly as to a person.

- Its keys are made by an Owner or Admin (same `ssk_` format, scopes and expiry, and the admin's
  current password) and are listed under the bot, not with the admin's own keys. Each records which
  admin made it.
- Changes made with a bot key are by the bot: Activity shows "Release Bot via GitHub Actions" with a
  **Bot** badge, and comments and tasks have the bot as their author.
- A bot can't sign in, use the app or `/api/sync`, or be sent sign-in, reset, verify or invite
  email. It gets no notifications, emails or push, and isn't offered in assignee or @mention pickers.
- Removing a bot revokes its keys. Removing the admin who made a key doesn't; that admin changing or
  resetting their password does.
- It has its own rate-limit budget, separate from any person's.
- `GET /me` and `GET /members` report `kind: "bot"` (or `"person"`); a bot's `email` is empty.
- Bots are managed with a signed-in session only (`/api/bots`); API keys, including a bot's own, get
  `403`.

## Endpoints

| Method | Path                    | What                                                                                                      |
| ------ | ----------------------- | --------------------------------------------------------------------------------------------------------- |
| GET    | `/me`                   | The key's person or bot (`kind`), workspace and key scope                                                 |
| GET    | `/tasks`                | Newest first; `project`, `status` (comma list or `open`), `assignee` (`me`/id/email), `q`, `updatedSince` |
| POST   | `/tasks`                | Create: `project`, `title`, optional `description`, `status`, `priority`, `assignee`, `due`, `labels`, …  |
| GET    | `/tasks/{ref}`          | A task by id or key (`WEB-12`)                                                                            |
| PATCH  | `/tasks/{ref}`          | Change only the fields sent; `project` moves it                                                           |
| POST   | `/tasks/{ref}/complete` | Mark done (completing a repeating task schedules the next one, as in the app)                             |
| POST   | `/tasks/{ref}/archive`  | Archive (`/restore` undoes it)                                                                            |
| GET    | `/tasks/{ref}/comments` | Oldest first                                                                                              |
| POST   | `/tasks/{ref}/comments` | `text`; `@Name` mentions notify, as in the app                                                            |
| GET    | `/tasks/{ref}/activity` | Newest first, with `via`                                                                                  |
| GET    | `/projects`             | Projects the key can open, with open / done counts                                                        |
| GET    | `/projects/{ref}`       | By id or key (`WEB`)                                                                                      |
| GET    | `/members`              | People and bots (`kind`); Guests see only the emails of people they share a project with                  |
| GET    | `/search?q=`            | Tasks, projects and people                                                                                |

People can be given as an id, an email, a full name, a unique first name, or `me`. Dates are
`YYYY-MM-DD` or ISO 8601 date-times.

`labels` in a `PATCH` replaces the task's whole list with the one sent (read the task, change the
list, send it back). The API reads and writes in one request, so unlike the app it never sends a
list it fetched long ago; the app sends what it edited from, and the server merges only its changes
(see [architecture](architecture.md#how-data-flows)).

## Conventions

- **Errors** are `{ "error": "…", "code": "not_found", "field": "title" }`. Codes: `invalid_request`,
  `unauthenticated`, `invalid_key`, `expired_key`, `insufficient_scope`, `forbidden`, `not_found`,
  `ambiguous`, `idempotency_mismatch`, `idempotency_in_progress`, `rate_limited`, `server_error`.
  Anything in a project the key can't open answers `404`, so nothing reveals what exists.
- **Pagination:** lists return `{ data, nextCursor }`; pass `cursor=<nextCursor>` for the next page
  (`limit` 1–100, default 50). Cursors are opaque.
- **Idempotency:** send `Idempotency-Key: <uuid>` on a POST or PATCH and a retry with the same key
  and body gets the first response back (header `Idempotent-Replayed: true`) for 24 hours. The same
  key with a different body is refused (`422`).
- **Atomic:** a request either applies whole or not at all.
- **Rate limits:** `API_RATE_LIMIT` requests a minute per person, shared by all their keys (default
  120), with `RateLimit-Limit`,
  `RateLimit-Remaining` and `RateLimit-Reset` headers, and `429` with `Retry-After` when spent.
  Counted in memory: they reset on restart and assume one instance (see
  [operations](operations.md#known-limits)).
- **Versioning:** `v1` changes only by adding endpoints and fields. Removing or changing one needs
  `v2`, with `v1` kept through a deprecation window.

## Example

```bash
KEY=ssk_…; URL=https://sudo.example.com/api/v1
curl -s -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -H "Idempotency-Key: $(uuidgen)" \
  -d '{"project":"WEB","title":"Fix login bug","due":"2026-11-20","assignee":"me"}' $URL/tasks
curl -s -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"text":"On it"}' $URL/tasks/WEB-212/comments
curl -s -H "Authorization: Bearer $KEY" -X POST $URL/tasks/WEB-212/complete
```

## Not yet

OAuth apps, webhooks, a token-authenticated event stream, an `admin` scope (members, roles,
workspace settings), files, teams, saved views, notifications, a generated TypeScript SDK and a
shared rate-limit store for several instances are planned in
[#6](https://github.com/sudosapient-labs/project-tracker/issues/6).
