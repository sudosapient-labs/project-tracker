# Architecture

Sudo Sapient is one Node process: a Hono API on a SQLite file plus an uploads directory, which in
production also serves the built client from `dist/`. In development Vite serves the client and
proxies `/api` to the API on :8787.

## How data flows

- **Bootstrap.** After sign-in the client loads `GET /api/bootstrap`: the whole workspace graph this
  person may see (projects, tasks, comments, members, notifications, files, …), in the same shape
  the UI renders from `S.data`.
- **Writes.** Actions keep mutating `S.data` and calling `save()`. `shell/sync.js` diffs `S.data`
  against what the server last confirmed and sends field-level operations to `POST /api/sync` (up to
  500 per batch). The server (`server/sync/`) validates each one, checks permissions, applies side
  effects (task keys, cascading deletes, notifications, invite emails, a task's status lifecycle)
  and returns the canonical record, plus any other record the batch changed (`changes`, which the
  live stream doesn't send that tab); a rejected change is rolled back on the client with a toast. Each batch runs in one SQLite
  transaction. `<html data-sync>` shows `saving` / `saved` / `offline`; changes made while offline
  are retried. Consecutive changes to the same record are folded into one queued operation (the
  later value of each field wins), and each request stays within the server's limits (500 ops,
  4 MB, 900,000 characters of descriptions); an op the server defers because its per-request
  budget is spent (`retry`) is sent again, and a batch refused as too large (`413`) is split.
- **Unsaved edits are kept.** What's waiting to be saved is also written to IndexedDB under the
  signed-in person, so a reload, a crash, a discarded tab or an ended session doesn't lose it; it's
  sent after the next bootstrap, only for the same person (anyone else's is dropped, and they're
  told how many changes). Hiding the page sends what's waiting at once.
- **Lists and maps merge.** A project's `members`, `perms` and `milestones`, a task's `subtasks`,
  `labels` and `deps`, and a comment's reactions (`re`) are whole values, so the client sends each one with the value it edited from (`base`) and
  the server applies only that client's additions, removals and changes onto the current value
  (`src/core/merge.js`). A stale write (an offline queue, a tab behind) can't undo someone else's
  change: a person taken off a project stays off. Entries are matched by id (milestones by name),
  and reactions emoji by emoji, so two people reacting at once both count. A patch without `base` (the REST API, which
  reads and writes in one request) replaces the whole value.
- **Task status.** The server owns what follows from a task's status
  (`server/sync/task-status.js`, for sync and the REST API alike); clients only change `status`, and
  what they send for the other fields is ignored. Finishing sets `completedAt` and `prevStatus`
  (where it was, for Reopen and Undo); reopening clears both. A repeating task finished with a due
  date gets one next occurrence, made in the same transaction, so concurrent completions make one;
  the original names it (`nextId`) and it names the original (`repeatOf`, with a fingerprint of how
  the server made it). Reopening removes it only if it still matches that fingerprint (nobody has
  worked on it, whatever its timestamps say) and has no comments; otherwise it stays linked.
- **Edit windows and descriptions.** The task, project and team edit windows save only what was
  changed in them since they opened (lists merged onto the current value), so a field someone else
  changed meanwhile keeps their value. A task's description is sent with the one it was edited from
  (`base.desc`); when someone else's was saved meanwhile, the server refuses it (`desc_conflict`)
  and the app, which also notices one arriving while the editor has focus, keeps the person's text
  and asks whether to keep theirs or write it over.
- **Undo.** Undo puts back only the records the action changed, and in each only the fields it
  changed that nobody has changed since (lists and maps merged), so later edits stay. A record it deleted is re-sent
  with `restore: true`; the server then restores its own copy, kept in `recent_deletes` for 10
  minutes and only for the person who deleted it, so a comment keeps its author, time and
  reactions, a task its key, and nobody is notified again. When there is no such copy (too late,
  or someone else deleted it) the Undo is refused (`410`); records of other kinds (teams,
  events, …) are created like anything new. Deleting a project or a file and removing someone from
  the workspace offer no Undo: the server keeps nothing to restore them from.
- **Live updates.** Other people's changes arrive over Server-Sent Events (`GET /api/events`) and are
  merged in, filtered to what each person can see. A tab's own changes aren't echoed back to it
  (`x-client-id`). When the stream drops, the client reconnects and bootstraps again; a
  bootstrap that fails is retried with backoff (the tab shows offline meanwhile).
- **Per-person data** (preferences, view settings, favourites, sidebar order, notification
  preferences) is stored per account (`PUT /api/me/state`), not in the browser. Preferences are
  merged key by key, and the app sends only the ones changed in that tab, so a tab left open never
  puts back one changed elsewhere (a time zone set with the CLI).
- **Files** stream to `POST /api/files` as the raw request body, are written under `UPLOAD_DIR` with a
  random storage key, and are served (`GET /api/files/<id>/<name>`) only to people who can see the
  project.
- **Account.** Settings → Account changes the sign-in email (confirmed from a link sent to the new
  address; the old one is told when it's requested and again when it's done), downloads your data as
  JSON (`GET /api/me/export`: profile, preferences, your notifications, tasks assigned to you and your
  comments in projects you can see; the Owner also gets the workspace's people, teams and every
  project's settings, but the work of only the projects they can open, never password hashes,
  secrets or tokens; each workspace export is logged and appears in Activity), and deletes your
  account (password required; Owners hand ownership over first).
- **Notifications** (`server/notify.js`) are created by the server as a side effect of writes, gated
  by each recipient's notification preferences, and may also go out by email (through the outbox,
  `server/lib/mailer.js`) and Web Push.
- **Jobs** (`server/jobs.js`) send due-date reminders, overdue alerts and daily digests; see
  [operations](operations.md#scheduled-jobs).
- **Push.** The Push preferences belong to the account and say which kinds of notification are
  pushed; each browser gets them only once it's allowed notifications and the server holds its
  subscription (Web Push, VAPID). Notifications arrive even when the app is closed, and clicking one
  opens the task. Settings → Notifications → Push shows this device's state above the toggles
  (`src/actions/push.js`): on; not on yet, with a "Turn on push on this device" button that asks
  for permission from that tap (browsers refuse the prompt without one) and subscribes; blocked, with
  how to allow it again; or unsupported (no service worker or PushManager, an insecure origin, or an
  iPhone/iPad app not opened from the Home Screen). The Inbox offers the same button until it's
  dismissed on that browser. Browsers only allow push on HTTPS (or localhost). A subscription
  belongs to the session that made it and is deleted when that session ends (sign out, revoked,
  password change or reset, expiry, removal). After each sign-in, load or finished setup, a browser
  that already allows notifications, for an account that wants push, hands its subscription to the
  server again (making one if it has none) without asking; one that was never asked waits for the
  tap. A push's title is the whole headline, key information first ("Ada mentioned you in WEB-12:
  Fix login", "WEB-12 is due tomorrow: Fix login"), because phones cut titles short; the body adds
  the comment or details. Email subjects and the daily digest use the same line (`notifLine` in
  `server/notify.js`).

## Dates and times

A start or due (task start and due, subtask due, project start and due, milestone date) is one of
two shapes, defined once in `packages/client/dates.js` and used by the app, the server, the CLI, the
MCP server and the Slack bot:

| Shape   | Example                    | Means                                                         |
| ------- | -------------------------- | ------------------------------------------------------------- |
| All day | `2026-11-09`               | That calendar day wherever it's read; overdue once it's over. |
| Timed   | `2026-11-09T18:29:00.000Z` | One moment, stored in UTC; shown in the reader's time zone.   |

The sync schema accepts only these two; the API also takes a date-time with an offset and stores it
in UTC, and refuses one without a zone. A timed value's day depends on the reader (`2026-11-09T20:30Z`
is Nov 10, 2:00 AM in India), so code reads values with `dayOf`, `timeOf`, `label`, `instant`,
`isOverdue` and `compareDue` and the reader's time zone, never with `value.slice(0, 10)` or string
comparison. What people type ("fri 5pm") becomes a value through `parseWhen`. A calendar event's
start (`when`) has the same two shapes: an all-day event is a day, a timed one the moment it starts.

### Whose clock

Stored values don't depend on anyone's clock; reading or writing them in words or as a day does.
Which time zone that is, is decided in one place, in this order:

1. **The person's** saved zone (Settings → Date and time; `prefs.tz`, any IANA zone: what counts as
   one is `validZone` / `modernZone` in `packages/client/dates.js`, `validTz` / `modernTz` in the app
   and server).
2. **The workspace's** (Settings → Workspace, Owners and Admins; `tz` on the workspace doc,
   `timeZone` in `GET /workspace`), for people who haven't set one, and for bots such as the Slack
   bot's account.
3. **UTC**.

Never the machine's zone: on the server that is UTC, not anyone's. On the server the order lives in
`server/lib/clock.js` (`clockOf(repo, uid)` → `{ tz, time, source }`, and `workspaceClock(repo)`),
and everything the server writes or decides for someone goes through it: activity text,
notifications, reminders and digests, repeats, `sort=due`, "today" in the API, session dates. The
API shows the result as `timeZone` and `timeZoneSource` (`person`, `workspace` or `default`) on
Members, `GET /me` and `GET /me/preferences`, so other surfaces use the same clock: the MCP server
and the CLI read the person's from there, and fall back to their computer's only when an older
server doesn't say. What the API words or reads as a day for the caller (activity, events,
`sort=due`, "today") is on the key's person's clock, unless a client acting for someone else sends
that person's zone in the `Sudo-Time-Zone` header, for that request only (`clockOf` in
`server/api/v1.js`, [docs/api.md](api.md)); notifications, reminders and repeats never take it.
The Slack bot reads each request on the asker's clock, in the same order (their Member's `timeZone`;
their Slack profile's only from a server too old to say; `packages/slack-bot/src/clock.js`), and
sends it as `Sudo-Time-Zone`,
so history it reads back is worded on that clock too; timed dues in channel messages are Slack date
tokens, so each reader sees their own time. What the model reads and writes can't hold a token, so
there a timed due names its zone (`label(v, tz, { zone: true })`: `2026-11-20 17:00 GMT+4`).

The app (`src/core/clock.js`, `zoneOf`) uses the saved zone, else the browser's, else the
workspace's, else UTC. The browser's zone is never only shown: when someone with none saved opens
the app, it saves the browser's as theirs, once, and says so ("Time zone set to Dubai from your
browser"), so the server and the app agree. A zone they chose is never replaced. A new workspace
takes the Owner's zone when setup finishes; migration 014 gave existing ones the zone most of their
people had saved.

### History and events on the reader's clock

What is stored is the value; words are made when someone reads it, on their clock.

- **History.** An activity entry that sets a start or due (a task's start or due, a subtask's due)
  also keeps the value it was set to, `when` (`null` when cleared), next to `extra`, the words on
  the writer's clock. Every reader words `when` on their own clock: the app in task history and
  the activity feeds, and the REST API in `extra` for the caller, which is what the MCP
  server, the CLI and the Slack bot show. The rule lives in `src/core/activity.js` (`whenAct` to
  write, `actExtra` to read). Entries saved before `when` existed, and those written by apps from
  before it, only have `extra`, and show it as written. Nothing is rewritten.
- **Calendar events.** `when` is the event: a day for an all-day one, the UTC moment it starts for
  a timed one (a 10:00 standup set in India is 8:30 in Dubai). The calendar places it on the
  viewer's day and shows its time on their clock; the API gives `date` and `time` on the key's
  person's clock and reads them that way when given. The sync rules (`settleEventWhen` in
  `server/sync/rules.js`) also store `date` and `time` as the day and time on the saver's clock,
  for apps from before `when`, which show those. An app that sends only `date` and `time` has them
  read on its person's clock; one that can't be read is refused. Migration 015 read the events
  saved before on the workspace's clock, else UTC.

## Public API, MCP and CLI

- **`/api/v1`** (`server/api/`) is the public REST API for personal API keys (Settings → API).
  Routes are declared once in `v1.js` (tasks, comments, search) and `v1-more.js` (everything else),
  on one table that registers them and generates the OpenAPI 3.1 document
  (`/api/v1/openapi.json`, rendered at `/api/docs`) from the zod schemas in `schemas.js`. What the
  app does outside sync (uploads, invite links, resent invites, access requests, bots, display
  preferences) the API does by calling the same server functions as the app's own routes.
- **Writes are sync operations.** Each write builds the records and activity lines the app itself
  would send (e.g. a task `put` plus a "created" activity entry) and runs them through
  `engine.apply` in atomic mode: one transaction, all or nothing. So validation, permissions,
  notifications, emails and live updates to open apps are exactly the app's. The server stamps
  activity with `via` (the client's `X-Sudo-Client` label or the key's name).
- **MCP** (`packages/mcp`, whose only dependency is `packages/client`) is a small JSON-RPC server over stdio (`sudo-mcp`) and
  Streamable HTTP. The app hosts it at `/api/mcp`, where each tool calls `/api/v1` in-process with the
  caller's key. **The CLI** (`packages/cli`, `sudo-cli`) and the MCP server share
  `packages/client`, a fetch wrapper for `/api/v1`. See [the API reference](api.md).

## Installable app (PWA)

`public/manifest.webmanifest` and the service worker (`public/sw.js`) make the app installable. The
worker caches the app shell and build assets so it opens without a connection (it then shows that
the server can't be reached); API responses are never cached. In development it's registered as
`/sw.js?dev`, a pass-through mode, so Vite's hot reload is unaffected. In production `sw.js` and the
manifest are served with `Cache-Control: no-cache` so updates roll out; hashed `/assets/*` are cached
for a year.

## Permission model

### Workspace roles

The first account becomes the workspace **Owner**. Everyone else joins by invite as an **Admin**,
**Member** or **Guest** (only Owners and Admins can invite Admins; people joining through the reusable
invite link become Members). Only an Owner can make someone an Owner or change an Owner's role, and
nobody can change their own role.

- **Owner:** everything an Admin can do, plus finishing setup, resetting someone else's two-factor
  (with their own password) and the full workspace export. The Owner can't be removed, and can't
  delete their own account until another Owner changes their role.
- **Admin:** changes people's roles, teams and titles, removes people, creates the reusable invite
  link, and can always manage any project's settings (see Admin recovery).
- **Member:** creates projects and teams, invites people (as Members or Guests), resends invites.
- **Guest:** sees only projects they've been listed on, can't create projects or teams or invite
  people, and only sees the email addresses of people they share a project with.

### Project privacy

A project is either open to the whole workspace or private. `private: true` is canonical (set from
the share dialog's General access); `access` (`'workspace'` / `'private'`) mirrors it for the dialog,
and whichever one a change sets wins.

### Project permissions

Levels match the share dialog: **Can view**, **Can comment** (own comments and reactions), **Can
edit** (tasks, files, events, saved views) and **Full access** (also the project's members, privacy,
permissions, lead, archiving and deleting). Only a comment's author can edit it, and only its text;
everyone adds and removes only their own reactions. One helper, `src/core/access.js`, decides a person's
level for the server (sync rules, uploads, file downloads, notifications, digests, bootstrap, live
updates) and the client (which hides what the server would refuse):

1. The project's **lead** has Full access.
2. People **listed** on the project get the permission set for them in the share dialog. Without one,
   listed Guests can comment and everyone else can edit. The project's creator is listed with Full
   access when the project is created.
3. On a project **open to the workspace**, every unlisted non-Guest can edit.
4. Otherwise (a private project, or a Guest who isn't listed) there is no access.

Listing someone gives them exactly the permission shown, even on a project open to the whole
workspace (so "Can view" there is less than not being listed); the share dialog says so.

Consequences enforced on the server:

- People who can't open a project receive only a stub (key, name, icon, colour, lead, archived) for
  the locked card and the request-access page; Guests receive nothing at all.
- Work can only be assigned to someone who can open the project, and nobody is notified or emailed
  about a project they can't see. Digests mention work that has since moved out of sight without its
  key, title or what happened.
- Deleting work in a project is only announced to people who could see it.
- Asking for access (`POST /api/projects/:id/request-access`) answers the same whether or not the
  project exists and names nobody; the lead (or the Owner, when there's no lead) is notified.

### Admin recovery

Owners and Admins can always change a project's settings (members, privacy, permissions, lead,
archiving, deleting), even on a private project they're not in, so a project whose only lead left can
be recovered. Their stub of such a project also carries its members, permissions and access, but
they only see its work once they add themselves.

## Layers

Dependencies point downward:

1. `core/` depends on nothing else in the app. The server imports parts of it (`access.js`,
   `rich-text.js`, `constants.js`, `file-types.js`, `merge.js`), which is why the Docker image includes `src/core`.
2. `ui/`, `shell/`, `components/`, `pages/`, `views/`, `overlays/` and `features/` render HTML from state.
3. `actions/` change state and re-render. Each action module registers its handlers on the shared
   action table (`A`) when it loads, so `main.js` imports them after `actions/actions.js`.

On the server, `index.js` wires the process, `app.js` builds the Hono app from injected dependencies
(so tests run it against an in-memory database without opening a port), `routes/` hold the HTTP
endpoints, `sync/` the bootstrap and sync engine, and `lib/` the pieces with no app knowledge.

## Conventions

- **Rendering:** each page or view is a function that returns an HTML string from the store (`S`).
  `render()` rebuilds the shell and keeps focus and scroll positions. Everything people type is
  escaped when rendered (`esc`); task descriptions, the one rich-text field, go through DOMPurify.
- **Interactions:** elements declare `data-a="actionName"`. `actions/events.js` delegates the click
  to `A.actionName`. Inputs use `data-in`, blur handlers use `data-blur`.
- **Layout:** every page edge uses `var(--gutter)`, so the breadcrumb, page header, toolbar, list,
  table and board start on the same line.
- **Dropdowns:** write a normal `<select class="select">`. `ui/select.js` renders it as the
  design-system menu and keeps the native element as the source of truth.
- **Icons:** call `ic('name')` with any [Lucide](https://lucide.dev) icon name. The `virtual:icons`
  plugin in `vite.config.js` bundles only the icons the source names.
- **Routing:** the URL hash follows navigation (`#project/<key>/list`, `#settings/sessions`, …), so a
  reload keeps your place and back/forward work.
- **Server writes:** sync rules throw `Reject` to refuse a single operation without failing the batch;
  route handlers validate bodies with zod through `parseBody`.
- **Migrations:** files in `server/migrations/` run once each, in name order, inside a transaction,
  on start. Use `.sql`, or `.js` exporting `default (db)` for data changes SQL can't express.
  Foreign keys are off while a migration runs, so a table can be rebuilt (create, copy, drop,
  rename) without cascading deletes; a migration that leaves a broken reference
  (`PRAGMA foreign_key_check`) is rolled back and stops the start.
- **Formatting:** Prettier (`.prettierrc.json`, 160 columns, single quotes) and ESLint flat config;
  comments are short and explain why.

## Brand assets

The wordmark (`public/logo.svg`, `LOGO` in `src/core/icons.js`), the stacked app icon
(`public/icon.svg`, `public/icons/*.png`) and the "s" monogram (favicon, small marks) are outlines of
Archivo Black (SIL Open Font License) with the square accent from the original mark.
