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
  effects (task keys, cascading deletes, notifications, invite emails) and returns the canonical
  record; a rejected change is rolled back on the client with a toast. Each batch runs in one SQLite
  transaction. `<html data-sync>` shows `saving` / `saved` / `offline`; changes made while offline
  are retried.
- **Live updates.** Other people's changes arrive over Server-Sent Events (`GET /api/events`) and are
  merged in, filtered to what each person can see. A tab's own changes aren't echoed back to it
  (`x-client-id`). When the stream drops, the client reconnects and bootstraps again.
- **Per-person data** (preferences, view settings, favourites, sidebar order, notification
  preferences) is stored per account (`PUT /api/me/state`), not in the browser.
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
- **Push.** Turning on a Push preference subscribes the browser (Web Push, VAPID); notifications
  arrive even when the app is closed, and clicking one opens the task. Browsers only allow push on
  HTTPS (or localhost); on iPhone/iPad the app must be added to the Home Screen first. A subscription
  belongs to the session that made it and is deleted when that session ends (sign out, revoked,
  password change or reset, expiry, removal); the browser subscribes again after its next sign-in.

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
permissions, lead, archiving and deleting). One helper, `src/core/access.js`, decides a person's
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
   `rich-text.js`, `constants.js`, `file-types.js`), which is why the Docker image includes `src/core`.
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
- **Formatting:** Prettier (`.prettierrc.json`, 160 columns, single quotes) and ESLint flat config;
  comments are short and explain why.

## Brand assets

The wordmark (`public/logo.svg`, `LOGO` in `src/core/icons.js`), the stacked app icon
(`public/icon.svg`, `public/icons/*.png`) and the "s" monogram (favicon, small marks) are outlines of
Archivo Black (SIL Open Font License) with the square accent from the original mark.
