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

Create one in **Settings → API**: a name, a scope, an expiry (30, 90, 365 days or never) and your
current password. The key (`ssk_…`) is shown once; only its hash is stored.
Revoking it stops it straight away, and changing or resetting your password revokes all of yours. Send it as `Authorization: Bearer ssk_…`. Session cookies are not accepted on
`/api/v1`, and no CSRF header is needed.

Settings → API makes the key with `POST /api/keys` (signed-in session only). Its `201` response has
two fields, and the names are easy to misread:

```json
{
  "key": {
    "id": "k…",
    "name": "Laptop CLI",
    "prefix": "ssk_AbCdEfGh",
    "scope": "write",
    "createdAt": 1762500000000,
    "lastUsedAt": null,
    "expiresAt": null,
    "createdBy": "m…"
  },
  "token": "ssk_…"
}
```

- `key` is the key's **metadata** (what Settings → API lists), not the secret.
- `token` is the **secret** to send as `Authorization: Bearer …`. It's returned only here, once.

`POST /api/bots/{id}/keys` answers in the same shape, plus `bot` (the bot with its keys).

### Scopes and roles

A key is **Read only** (every `GET`, and revoking itself) or **Read and write**. Either way it acts
as the person who made it: what it may do is what their role and project permissions allow in the
app, read again on every request. So an Owner's or Admin's key can administer the workspace (roles,
other people's names and titles, removing people, workspace settings, bots, the invite link,
deleting other people's comments, workspace-wide events, managing projects they aren't on), and
anyone else's key is refused (`403 forbidden`), as they would be in the app. Someone who is
demoted loses those powers on all their keys at once. A bot's keys act as the bot, which is a
Member or a Guest, never an admin.

Integrations work the same way. A Slack bot, for example, should link each Slack user to their
account and act as them, so each gets exactly their own privileges.

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
- Owners and Admins manage bots in Settings → API → Bots, or with their own key through
  `/api/v1/bots` (create, rename, role, projects, remove, revoke a key). A bot's keys are only ever
  made in Settings (`/api/bots/{id}/keys`, with a session and the admin's password): no API key can
  make another key. The session route `/api/bots` still refuses any bearer key.

## Endpoints

All under `/api/v1`. `{ref}` is an id or a key (`WEB-12` for a task, `WEB` for a project); people go
by id, email, full name, a unique first name, or `me`. 🔑 Owners and Admins only.

| Area          | Method and path                                                                         | What                                                                                             |
| ------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Me            | `GET /me`, `PATCH /me`                                                                  | The key's person or bot (`kind`), workspace and key scope; change your name, title, team, colour |
|               | `DELETE /me/key`                                                                        | Revoke the key making the request (any scope; it can't name another key)                         |
|               | `GET`, `PATCH /me/preferences`                                                          | Display preferences (theme, time zone, date format, …) and notification preferences              |
|               | `GET /me/favorites`, `PUT /me/project-order`                                            | Starred projects and tasks; sidebar order                                                        |
| Tasks         | `GET /tasks`, `POST /tasks`                                                             | List (`project`, `status`, `assignee`, `q`, `updatedSince`, `includeArchived`, `sort`); create   |
|               | `GET`, `PATCH`, `DELETE /tasks/{ref}`                                                   | Read; change only the fields sent (`project` moves it); delete with its comments                 |
|               | `POST /tasks/{id}/undelete`                                                             | Undo a delete within 10 minutes (whoever deleted it): key, comments and reactions come back      |
|               | `POST /tasks/{ref}/complete`, `/archive`, `/restore`, `/duplicate`                      | Complete (a repeating task schedules the next), archive, restore, copy                           |
|               | `PUT`, `DELETE /tasks/{ref}/favorite`                                                   | Star, unstar                                                                                     |
|               | `POST /tasks/{ref}/subtasks`, `PATCH`, `DELETE /tasks/{ref}/subtasks/{id}`, `…/promote` | Add, change (title, done, assignee, due), remove, turn into a task                               |
|               | `GET /tasks/{ref}/activity`                                                             | Newest first (`order=oldest` for oldest), with `via` and `total`                                 |
| Comments      | `GET`, `POST /tasks/{ref}/comments`                                                     | Oldest first (`order=newest` for newest), with `total`; comment (`@Name` mentions notify)        |
|               | `PATCH`, `DELETE /comments/{id}`, `POST /comments/{id}/undelete`                        | Edit your own; delete (yours, or anyone's 🔑); undo within 10 minutes                            |
|               | `PUT`, `DELETE /comments/{id}/reactions/{emoji}`                                        | React, unreact (👍 🎉 ❤️ 👀 🚀 ✅)                                                               |
| Projects      | `GET /projects`, `POST /projects`, `GET`, `PATCH`, `DELETE /projects/{ref}`             | List, create, read, change (lead, team, privacy, status, dates, milestones, …), delete           |
|               | `POST /projects/{ref}/archive`, `/restore`, `/duplicate`, `/request-access`             | Archive, restore, copy with its tasks, ask for access                                            |
|               | `PUT`, `DELETE /projects/{ref}/members/{member}`                                        | Share: list someone (with a permission) or take them off                                         |
|               | `PUT`, `DELETE /projects/{ref}/favorite`                                                | Star, unstar                                                                                     |
| Teams         | `GET`, `POST /teams`, `PATCH`, `DELETE /teams/{id}`                                     | With members; `members` sets who is on it                                                        |
| Members       | `GET /members`, `GET /members/{ref}`, `POST /members`                                   | People and bots (`kind`; Guests see only some emails); invite by email                           |
|               | `POST /members/{ref}/resend-invite`                                                     | A fresh invite                                                                                   |
|               | `PATCH /members/{ref}`                                                                  | Team (anyone but Guests); role, name, title of others 🔑                                         |
|               | `DELETE /members/{ref}`                                                                 | Remove from the workspace 🔑                                                                     |
| Bots          | `GET`, `POST /bots`, `PATCH`, `DELETE /bots/{id}`, `DELETE /bots/{id}/keys/{keyId}`     | 🔑 Create, rename, role, projects, remove, revoke a key (keys are made only in Settings)         |
| Files         | `GET /files`, `POST /files?project=\|task=&name=`                                       | List; upload (the raw bytes as the body)                                                         |
|               | `GET`, `PATCH`, `DELETE /files/{id}`, `GET /files/{id}/content`, `POST …/duplicate`     | Details; rename or attach to a task (`task: null` detaches); delete; download; copy              |
| Events        | `GET`, `POST /events`, `PATCH`, `DELETE /events/{id}`                                   | Calendar events (`from`, `to`, `project`); workspace-wide ones 🔑                                |
| Views         | `GET`, `POST /views`, `PATCH`, `DELETE /views/{id}`                                     | Saved views: named filters shown as a project tab                                                |
| Notifications | `GET /notifications`, `PATCH /notifications/{id}`, `POST /notifications/read-all`       | Inbox (`unread=true`), mark read or unread, mark all read                                        |
| Workspace     | `GET /workspace`, `PATCH /workspace` 🔑, `POST /workspace/invite-link` 🔑               | Settings; rename, colour and time zone; the reusable join link                                   |
|               | `GET /activity`                                                                         | The activity feed (`project`), newest first                                                      |
| Search        | `GET /search?q=`                                                                        | Tasks, projects and people                                                                       |

People can be given as an id, an email, a full name, a unique first name, or `me`. A start or due
is `YYYY-MM-DD` for all day, or an ISO 8601 date-time **with a zone** for a time of day
(`2026-11-09T23:59+05:30` or `…Z`); a date-time without a zone is refused, since it would be a
different moment on different clocks. Times are stored and returned in UTC
(`2026-11-09T18:29:00.000Z`): show them in the reader's time zone, not by cutting the string. See
[dates and times](architecture.md#dates-and-times).

**Time zones.** Each person's dates are read on one clock: their own zone, else the workspace's,
else UTC ([whose clock](architecture.md#whose-clock)). Every Member, `GET /me` and
`GET /me/preferences` say which, as `timeZone` (an IANA zone, always set) and `timeZoneSource`
(`person`, `workspace` or `default`); anyone who can see a member sees them, bots included. Use
`timeZone` to show someone their times and to read what they type ("Friday 5pm"), never your
machine's zone. `preferences.tz` is only the zone the person saved, so it's missing when they have
none; set it with `PATCH /me/preferences` (any IANA zone, like `Australia/Sydney`). The workspace's
is `timeZone` on `GET /workspace` (`null` when unset); Owners and Admins change it with
`PATCH /workspace` (`null` unsets it).

**History and events on your clock.** An Activity entry's `extra` ("to Nov 10, 5:00 PM") is worded
on the key's person's clock, whoever made the change. An entry that set a start or due also has
`when`, the value it was set to as stored (`null` when it was cleared); entries saved before it was
kept have no `when`, and their `extra` is in the words of whoever wrote them. A calendar event's
`date` and `time` are its day and start on the key's person's clock, and `when` is the event as
stored: `YYYY-MM-DD` for all day, or the UTC moment it starts, the same for everyone. A 10:00 event
added by someone in India is `time: "08:30"` for someone in Dubai. `POST` and `PATCH /events` take
`date` and `time` on the key's person's clock (a new day keeps the time, a new time keeps the day),
and `from` and `to` are their days.

**Acting for someone on another clock: `Sudo-Time-Zone`.** "The key's person's clock" above is the
caller's, and a client that acts for other people with one key (the Slack bot's, for a whole team)
can name the person it's asking for: send `Sudo-Time-Zone: <IANA zone>` (`Asia/Dubai`) and, for
that request only, everything the API words or reads as a day for the caller uses that zone instead
of the key's person's. That is Activity `extra` (for reading, and the words written with a change),
an event's `date` and `time` (in answers, and as sent to `POST` and `PATCH /events`), `from` and `to`
on `GET /events`, `sort=due` on `GET /tasks`, and "today" (a new project's start). The time format
(12 or 24 hours) stays the key's person's. It changes nothing else: no zone is saved, Member,
`GET /me` and `GET /me/preferences` still show the person's own `timeZone`, stored values are the
same UTC moments and days, and what the server does for other people keeps their clocks
(notifications, reminders and digests on each recipient's, a repeating task's next due on its
rule, read on the key's person's clock). A value that isn't an IANA zone (an offset such as
`+04:00`, a misspelling, anything over 64 characters) is ignored: the request is read on the key's
person's clock, as if no header was sent. `@sudosapient/client` sends it for a client given a zone
(the MCP tools' `useTimeZone(api, tz)`), which is how the Slack bot words history on each asker's
clock.

Finishing a task (`status: done`, or `…/complete`) sets `completedAt` from the server's clock;
moving it to any other status clears it. A repeating task finished with a due date gets one next
occurrence (due moved on by the repeat, in the key's person's time zone), however many people
finish it at once. Reopening the task removes that occurrence again only while nobody has changed
or commented on it; otherwise it stays, and finishing again adds no other.

`labels`, `dependsOn` and a project's `milestones` in a `PATCH` replace the whole list with the one sent (read the task, change the
list, send it back). The API reads and writes in one request, so unlike the app it never sends a
list it fetched long ago; the app sends what it edited from, and the server merges only its changes
(see [architecture](architecture.md#how-data-flows)).

## Conventions

- **Errors** are `{ "error": "…", "code": "not_found", "field": "title" }`. Codes: `invalid_request`,
  `unauthenticated`, `invalid_key`, `expired_key`, `insufficient_scope`, `forbidden`, `not_found`,
  `ambiguous`, `conflict`, `gone`, `too_large`, `storage_full`, `idempotency_mismatch`,
  `idempotency_in_progress`, `rate_limited`, `server_error`.
  Anything in a project the key can't open answers `404`, so nothing reveals what exists.
- **Pagination:** lists return `{ data, nextCursor }`; pass `cursor=<nextCursor>` for the next page
  (`limit` 1–100, default 50). Cursors are opaque.
- **Order:** `GET /tasks` is newest first. With `sort=due` it's soonest due first across every
  matching task (an all-day due counts as the end of its day in the key's person's time zone, as in
  the app; no due date last, ties newest first), and the answer carries `"sort": "due"`; a
  server without it ignores `sort` and leaves that out. Pass the same `sort` with each `cursor`.
- **Idempotency:** send `Idempotency-Key: <uuid>` on a POST or PATCH and a retry with the same key
  and body gets the first response back (header `Idempotent-Replayed: true`) for 24 hours. The same
  key with a different body is refused (`422`).
- **Atomic:** a request either applies whole or not at all.
- **Uploads** send the file's bytes as the body of `POST /files?project=WEB&name=spec.pdf` (or
  `task=WEB-12` to attach it), with any `Content-Type`, up to the server's `MAX_UPLOAD_MB`. They
  stream to disk, so they don't take an `Idempotency-Key`.
- **Undo:** deleting a task or comment answers `restoreUntil`; until then the same person can put it
  back with `…/undelete`, as the app's Undo does (`410 gone` once it's too late).
- **Lists inside a record** (subtasks, project members and permissions, reactions) change through
  their own routes, which send the server the value they edited from, so two clients changing
  different entries at once both count.
- **Rate limits:** `API_RATE_LIMIT` requests a minute per person, shared by all their keys (default
  120), with `RateLimit-Limit`,
  `RateLimit-Remaining` and `RateLimit-Reset` headers, and `429` with `Retry-After` when spent.
  A request refused this way was not handled at all, so it's always safe to send again after
  `Retry-After` seconds, writes included. `@sudosapient/client` (and so the CLI and the MCP server)
  does that by itself: up to 3 retries, each waiting what `Retry-After` says (at least 1 s) if that's
  at most 60 s, and at most 120 s in all for one request (for tools on the hosted `/api/mcp`, 20 s in
  all, so an assistant's tool call doesn't time out first).
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

## What the API covers

Everything people do in the app can be done with a key, except the things below that are kept out
on purpose. `@sudosapient/client` reaches every REST route (`get`, `post`, `patch`, `put`, `del`,
`upload`, `download`), and `sudo-cli api <METHOD> <path>` reaches any of them from a shell. 🔑 is for
Owners and Admins (their key, as their role allows); anything else needs **Read and write** to change
and any key to read. Bulk actions in
the app (select several, a whole column) are one request per task here.

| Area          | What people do in the app                                                                                        | REST (`/api/v1`)                                   | CLI (`sudo-cli`)                              | MCP tool                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------- |
| Tasks         | Create (title, description, status, priority, assignee, dates, labels, estimate, repeat, dependencies, subtasks) | `POST /tasks`                                      | `new`                                         | `create_task`                                                     |
|               | Change any field, move to another project                                                                        | `PATCH /tasks/{ref}`                               | `tasks edit`, `assign`                        | `update_task`, `assign`                                           |
|               | Complete, reopen (repeating tasks schedule and unschedule the next one)                                          | `…/complete`, `PATCH status`                       | `done`, `tasks edit -s`                       | `complete_task`, `update_task`                                    |
|               | Archive, restore                                                                                                 | `…/archive`, `…/restore`                           | `tasks archive`, `restore`                    | `update_task archived`                                            |
|               | Delete, and Undo within 10 minutes                                                                               | `DELETE`, `…/undelete`                             | `tasks rm`, `undelete`                        | `delete`, `undelete`                                              |
|               | Duplicate                                                                                                        | `…/duplicate`                                      | `tasks dup`                                   | `duplicate`                                                       |
|               | Star                                                                                                             | `PUT`/`DELETE …/favorite`                          | `tasks fav`, `unfav`                          | `update_settings star`                                            |
|               | Manual order (drag in a list or board)                                                                           | `PATCH order`                                      | `tasks edit --order`                          | —                                                                 |
|               | Subtasks: add, rename, done, assignee, due, remove, turn into a task                                             | `…/subtasks…`                                      | `subtask …`                                   | `edit_subtasks`                                                   |
|               | Attach a file (upload to the task), remove an attachment                                                         | `POST /files?task=`, `PATCH /files/{id}`           | `files upload --task`, `attach`, `detach`     | `manage_file`                                                     |
|               | Read: list, filter, search, details, activity                                                                    | `GET /tasks…`, `/search`                           | `tasks`, `show`, `search`                     | `list_tasks`, `list_my_work`, `get_task`, `search`                |
| Comments      | Comment (@mentions notify)                                                                                       | `POST …/comments`                                  | `comment`                                     | `comment`                                                         |
|               | Edit your own (the API allows it; the app has no button)                                                         | `PATCH /comments/{id}`                             | `comment edit`                                | `manage_comment`                                                  |
|               | Delete, and Undo within 10 minutes                                                                               | `DELETE`, `…/undelete`                             | `comment rm`, `undelete`                      | `manage_comment`, `undelete`                                      |
|               | React, unreact                                                                                                   | `PUT`/`DELETE …/reactions/{emoji}`                 | `react`, `unreact`                            | `manage_comment`                                                  |
| Projects      | Create (the app’s templates aren’t offered; tasks can be added after)                                            | `POST /projects`                                   | `projects new`                                | `create_project`                                                  |
|               | Edit name, description, icon, colour, status, lead, team, dates, milestones                                      | `PATCH /projects/{ref}`                            | `projects edit`                               | `update_project`                                                  |
|               | Privacy, members and their permissions (share dialog)                                                            | `PATCH private`, `PUT`/`DELETE …/members/{member}` | `projects edit --private`, `share`, `unshare` | `update_project`, `share_project`                                 |
|               | Archive, restore, delete                                                                                         | `…/archive`, `…/restore`, `DELETE`                 | `projects archive`, `restore`, `rm`           | `update_project archived`, `delete`                               |
|               | Duplicate                                                                                                        | `…/duplicate`                                      | `projects dup`                                | `duplicate`                                                       |
|               | Request access                                                                                                   | `…/request-access`                                 | `projects request-access`                     | `request_access`                                                  |
|               | Star, sidebar order                                                                                              | `…/favorite`, `PUT /me/project-order`              | `projects fav`, `order`                       | `update_settings`                                                 |
|               | Read: list, details, health                                                                                      | `GET /projects…`                                   | `projects`, `projects show`                   | `list_projects`, `summarise_project`                              |
| Teams         | Create, edit, set members, delete                                                                                | `/teams…`                                          | `teams …`                                     | `list_teams`, `manage_team`                                       |
| People        | Invite by email, resend an invite                                                                                | `POST /members`, `…/resend-invite`                 | `people invite`, `resend`                     | `manage_member`                                                   |
|               | Change role 🔑, team, title 🔑 (others’), remove 🔑                                                              | `PATCH`, `DELETE /members/{ref}`                   | `people role`, `edit`, `rm`                   | `manage_member`                                                   |
|               | Your own name, title, team, avatar colour                                                                        | `PATCH /me`                                        | `me edit`                                     | `update_settings profile`                                         |
|               | The reusable join link 🔑                                                                                        | `POST /workspace/invite-link`                      | `workspace invite-link`                       | `update_workspace`                                                |
|               | Read: people and bots                                                                                            | `GET /members…`                                    | `people`, `people show`                       | `list_members`                                                    |
| Bots 🔑       | Create, rename, role, projects, remove, revoke a key                                                             | `/bots…`                                           | `bots …`                                      | `list_bots`, `manage_bot`                                         |
| Files         | Upload to a project or task                                                                                      | `POST /files` (raw body)                           | `files upload`                                | `manage_file` (text or base64, ≤ 700 KB)                          |
|               | Download                                                                                                         | `GET /files/{id}/content`                          | `files download`                              | — (bytes aren’t useful in a chat; `list_files` gives the details) |
|               | Rename, copy, delete, list                                                                                       | `PATCH`, `…/duplicate`, `DELETE`, `GET /files`     | `files rename`, `dup`, `rm`, `files`          | `manage_file`, `duplicate`, `list_files`                          |
| Calendar      | Events: create, edit, delete, list (the app only shows them)                                                     | `/events…`                                         | `events …`                                    | `list_events`, `manage_event`                                     |
| Saved views   | Save a view, rename, change its filters, delete                                                                  | `/views…`                                          | `views …`                                     | `list_views`, `manage_view`                                       |
| Notifications | Inbox, mark read or unread, mark all read                                                                        | `/notifications…`                                  | `inbox …`                                     | `list_notifications`, `mark_notifications_read`                   |
| Activity      | The workspace, project and task feeds                                                                            | `GET /activity`, `…/activity`                      | `activity`, `show`                            | `list_activity`, `get_task`                                       |
| Workspace     | Rename, colour, time zone 🔑                                                                                     | `PATCH /workspace`                                 | `workspace edit`                              | `update_workspace`                                                |
| Preferences   | Display preferences (theme, accent, density, language, time zone, formats, …)                                    | `PATCH /me/preferences`                            | `prefs set`                                   | `update_settings preferences`                                     |
|               | Notification preferences (email, push and in-app per kind)                                                       | `PATCH /me/preferences`                            | `notify-prefs set`                            | `update_settings notifications`                                   |
| Keys          | See the key in use; revoke it                                                                                    | `GET /me`, `DELETE /me/key`                        | `whoami`, `logout --revoke`                   | —                                                                 |

### Not reachable with an API key

A stolen key mustn't be able to take over the account, lock its owner out, or make more keys. So
these stay with a signed-in session in the app (most also ask for the current password), whatever
the key's scope:

| Kept out                                                               | Why                                                                                                |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Changing or resetting the password                                     | It's how someone recovers from a leaked key: it revokes every key they have                        |
| Two-factor: set up, turn off, recovery codes                           | A key could switch off the second factor, or replace it with one the attacker holds                |
| Sessions: list, sign out one or all others                             | Signing the owner out (or seeing where they're signed in) would help an attacker keep the account  |
| Changing the sign-in email                                             | A key could move the account to an address the attacker reads, then reset the password             |
| Deleting the account                                                   | Irreversible, and needs the password in the app                                                    |
| Making API keys, personal or a bot's (or listing your other keys)      | A key must never mint a credential; `GET /me` shows the key in use and `DELETE /me/key` revokes it |
| Resetting someone else's two-factor (Owner)                            | It signs them out everywhere and lowers their account's security; needs the Owner's password       |
| Downloading your data (`/me/export`), and the Owner's workspace export | One request would hand over everything at once; the export is logged as a sensitive event          |
| Web Push subscriptions                                                 | They belong to a browser's signed-in session                                                       |

### Left out because they're the browser's own

- How a list looks for you: filters, sort, grouping, hidden columns and widths on each view, the
  collapsed sidebar, recent searches. They're saved per person but only mean something on screen.
  Saved views (shared project tabs) are covered.
- Signing up, in and out, email verification, invite and reset links, and first-run setup
  (onboarding).
- Copying a link or an email address, the palette, keyboard shortcuts and other navigation.
- The Settings → Permissions toggles ("Members can create projects", …): they're stored as personal
  preferences and nothing on the server reads them, so the API doesn't offer them.

## Not yet

OAuth apps, webhooks, a token-authenticated event stream, a generated TypeScript SDK and a shared
rate-limit store for several instances are planned in
[#6](https://github.com/sudosapient-labs/project-tracker/issues/6).
