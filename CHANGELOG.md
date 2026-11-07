# Changelog

All notable changes to this project are documented here. From 0.2.0 on this file is written by
[release-please](https://github.com/googleapis/release-please) from Conventional Commit messages
when the release PR is merged (see [CI and releases](docs/ci-and-releases.md)), so don't edit those
entries by hand. Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0](https://github.com/sudosapient-labs/project-tracker/compare/v0.2.0...v0.3.0) (2026-11-07)


### Features

* **api:** cover everything people do in the app, as the key's person ([273cc9e](https://github.com/sudosapient-labs/project-tracker/commit/273cc9ea3b21ed4b8cd9459aa04f0e87f7120af0))


### Bug Fixes

* **app:** load over plain http on another address, not a blank page ([66c1e34](https://github.com/sudosapient-labs/project-tracker/commit/66c1e3481c9642d3ac74e715e1edaec5a3b07247))
* **client:** wait out rate limits using Retry-After ([5d9a675](https://github.com/sudosapient-labs/project-tracker/commit/5d9a67507e71be49308e317ed4b721fb26d6bfff))
* **mcp:** check tool arguments against each tool's inputSchema ([97b58f6](https://github.com/sudosapient-labs/project-tracker/commit/97b58f66c0712a350e9cdb632566138200e787c8))
* **ui:** don't pull focus to a dialog's first field after someone picked another ([#21](https://github.com/sudosapient-labs/project-tracker/issues/21)) ([b88bbc2](https://github.com/sudosapient-labs/project-tracker/commit/b88bbc22d00b7ffd12322ce616fe96d97d31ed26))

## [0.2.0](https://github.com/sudosapient-labs/project-tracker/compare/v0.1.1...v0.2.0) (2026-11-07)


### Features

* API keys, bot members, REST API, MCP, CLI and npm releases ([#11](https://github.com/sudosapient-labs/project-tracker/issues/11)) ([c8f9770](https://github.com/sudosapient-labs/project-tracker/commit/c8f9770047dfa6a23605dbfddf50bbd2d5db917a))
* **api:** let a key revoke itself with DELETE /api/v1/me/key ([e1b9a3e](https://github.com/sudosapient-labs/project-tracker/commit/e1b9a3e7b6d61322a03accc55d6a3f420e3d6d9d))


### Bug Fixes

* **auth:** answer refused sign-ups the same whether or not the address has an account or invite ([72eb6d8](https://github.com/sudosapient-labs/project-tracker/commit/72eb6d8a410fe10fe80d2f4b4cb9d68998a68480))
* **auth:** check access again when a write happens, not only when it starts ([d478594](https://github.com/sudosapient-labs/project-tracker/commit/d478594d4e61071d9beb0dd57881a83221bd2aa4))
* **auth:** count password attempts before checking them, per account ([f129472](https://github.com/sudosapient-labs/project-tracker/commit/f1294723b73c622b779d6d220442f654be591a58))
* **auth:** don't open a session for a password that changed while it was checked ([7b060d2](https://github.com/sudosapient-labs/project-tracker/commit/7b060d2d388f6adb108ed7ba86f1520dbf10a566))
* **auth:** give password-confirmed actions their own per-person budget ([7cb4b28](https://github.com/sudosapient-labs/project-tracker/commit/7cb4b287321ea001d4414ed7ade878f0f3539621))
* **auth:** leave nothing of the person in the tab after signing out ([92d605d](https://github.com/sudosapient-labs/project-tracker/commit/92d605d37a6691ab43e89dc6ff35ee7b972d2ee5))
* **auth:** refuse requests without credentials before reading their body ([c0764f7](https://github.com/sudosapient-labs/project-tracker/commit/c0764f75543028ca4918a3ea372181d4b9aee471))
* **auth:** retire a join link when its creator stops being an Owner or Admin ([372490b](https://github.com/sudosapient-labs/project-tracker/commit/372490b506277a1722dd153dfe001697dc64fa2d))
* **auth:** revoke API keys when the password is changed ([#17](https://github.com/sudosapient-labs/project-tracker/issues/17)) ([492003e](https://github.com/sudosapient-labs/project-tracker/commit/492003ed6e199955d83fb7fe3928984884399f07))
* **bots:** escape the bot name in the revoke-key confirmation ([b28e103](https://github.com/sudosapient-labs/project-tracker/commit/b28e103799a47cd9c278055b0c5ab59f380e6164))
* **cli:** open only links on the workspace's origin, and clean error messages before printing ([36ef29d](https://github.com/sudosapient-labs/project-tracker/commit/36ef29d7d7fdcf8202b77b99fb0b102c7cd275f3))
* close high and medium findings from the platform audit ([193642a](https://github.com/sudosapient-labs/project-tracker/commit/193642ac08c5058da09306dce1d34d14edcb6d91))
* close low findings from the platform audit and its reviews ([7f55827](https://github.com/sudosapient-labs/project-tracker/commit/7f55827802bd2a6e78ce97c504cff2b9500ede74))
* **db:** run migrations with foreign keys off and refuse one that leaves a broken reference ([3d448c8](https://github.com/sudosapient-labs/project-tracker/commit/3d448c80bbbb9a72776455cd464f1685f950452f))
* **docker:** never follow symlinks when chowning, and only touch /data and BACKUP_DIR ([e756284](https://github.com/sudosapient-labs/project-tracker/commit/e75628482ed9266d85aa38eac74bf800425a2882))
* **drag:** drop on a collapsed column, and no timeline drags in read-only projects ([7df7f17](https://github.com/sudosapient-labs/project-tracker/commit/7df7f17a0c7094edf09fb8e51dee6633abc7286c))
* **files:** add an upload rate limit, a workspace quota and a free-disk reserve ([05c80bc](https://github.com/sudosapient-labs/project-tracker/commit/05c80bc78f1eff32fb4ca2b25b13c944a990655a))
* **files:** reserve the room an upload needs while it streams in ([91aba98](https://github.com/sudosapient-labs/project-tracker/commit/91aba98934595da803472136ad85e84f7d1db0fe))
* **jobs:** remind whoever a task is reassigned to, and cover everything since the last digest ([379cee8](https://github.com/sudosapient-labs/project-tracker/commit/379cee8aaf7128d136e38e3ba98035c72df9543e))
* **mcp:** fence untrusted workspace text and annotate every tool ([0dae512](https://github.com/sudosapient-labs/project-tracker/commit/0dae512548e73884888bd138569f8319b0d9eba2))
* **packages:** let release-please bump the CLI and MCP version constants ([c599542](https://github.com/sudosapient-labs/project-tracker/commit/c599542133df4de722f620e69863b385be8d6653))
* **palette:** suggest shortcuts into real projects, not demo data ([4b58143](https://github.com/sudosapient-labs/project-tracker/commit/4b58143da24ae306846108dd44aa0f6497ad2335))
* **pwa:** cache only the app page as the offline shell ([97e8a2e](https://github.com/sudosapient-labs/project-tracker/commit/97e8a2e280d68e4fd0f75603eae1259fb2b68be8))
* **security:** drop over-long link targets before sanitising, and rate-limit sync per person ([20f2ac8](https://github.com/sudosapient-labs/project-tracker/commit/20f2ac82a5c24f568b20dd4ab9e6f6b39c3dc6c1))
* **security:** key IPv6 clients' rate limits on their /64, and warn when a proxy goes unconfigured ([08c6233](https://github.com/sudosapient-labs/project-tracker/commit/08c62337f7d70a1da4ef3b728464ba33d06f9d09))
* **security:** no-store every API answer, clear the cache on sign-out, and deny framing ([73370b7](https://github.com/sudosapient-labs/project-tracker/commit/73370b7519ac8e16a125eeefd28b9b2781da82ac))
* **session:** a tab signs out when someone else signs in on this browser ([bf1dbcd](https://github.com/sudosapient-labs/project-tracker/commit/bf1dbcd0dea7fa5e9abca433c3d3c70b57f0db6a))
* **session:** signing out asks before dropping unsaved changes, and needs the server to end the session ([bcd6244](https://github.com/sudosapient-labs/project-tracker/commit/bcd62449081b21ed0302fe8875f5b1578c081f3b))
* **sync:** a reload and an answer on its way converge on the server's latest ([3f07eb2](https://github.com/sudosapient-labs/project-tracker/commit/3f07eb28b704439318953f6a6ddb8de595cd3ca9))
* **sync:** answer a favourite of a record someone can't open like a missing one, and store nothing ([b33f62b](https://github.com/sudosapient-labs/project-tracker/commit/b33f62b88d050b5f0285021c098f7405d57c2a35))
* **sync:** bound rich-text descriptions before sanitising them ([f80c213](https://github.com/sudosapient-labs/project-tracker/commit/f80c213aa4c5cfa4088a6dacb1ecc0b62b31a88e))
* **sync:** close the hidden-record probe and refuse a stale tab's changes for a new sign-in ([2f2bab0](https://github.com/sudosapient-labs/project-tracker/commit/2f2bab0e822089a671d78f06246ff8538ac5ccab))
* **sync:** fold queued edits to a record together and keep batches within the server's limits ([3ae5f9c](https://github.com/sudosapient-labs/project-tracker/commit/3ae5f9cc529c9bdd1b7166279bf47bd0abc75dd8))
* **sync:** going offline and retrying don't re-render under the caret ([0cd6e82](https://github.com/sudosapient-labs/project-tracker/commit/0cd6e825cb578ef70efc247c294834c80e873579))
* **sync:** keep edits made while a reload loads, and defer the rest of a batch after a deferred op ([b789b37](https://github.com/sudosapient-labs/project-tracker/commit/b789b37aace4e12ba71035c2d8122098eee8a331))
* **sync:** keep queued edits until the server confirms them, across pagehide ([c9add33](https://github.com/sudosapient-labs/project-tracker/commit/c9add33af8979a444a95c0ea7de68bc4a96aee40))
* **sync:** keep queued edits when the app reloads, and send them on unload ([a7d0a98](https://github.com/sudosapient-labs/project-tracker/commit/a7d0a98b57fd843bbf9fee993a9f7f0dca911590))
* **sync:** let a comment's author change only its text, and their own reactions like everyone else ([fc227c2](https://github.com/sudosapient-labs/project-tracker/commit/fc227c28ebbcc267ca7094269c16a8a474eb68ba))
* **sync:** make the project task-key counter server-owned ([c6ab7a7](https://github.com/sudosapient-labs/project-tracker/commit/c6ab7a7532fcf43040c960a1d98623048e4b1be9))
* **sync:** measure rich-text depth with the sanitiser's own parser, with a time backstop ([11869d0](https://github.com/sudosapient-labs/project-tracker/commit/11869d0f4f0db182a8beb7e0f2c78347767a69ff))
* **sync:** measure rich-text nesting as the sanitiser parses it, per request ([639e24d](https://github.com/sudosapient-labs/project-tracker/commit/639e24defbf3a5a3ce317cd709c922fd401d27dc))
* **sync:** merge stale edits of list and map fields instead of replacing them ([ee16e65](https://github.com/sudosapient-labs/project-tracker/commit/ee16e65134f1ecec9e222fb33eb1de31202ef3e4))
* **sync:** never fold a later edit into an Undo restore or an op already sent on pagehide ([d03c5ba](https://github.com/sudosapient-labs/project-tracker/commit/d03c5ba32d6ce50c3db1fa2998c5b0f2d72553dc))
* **sync:** purge expired Undo copies on a timer and at startup, and a removed member's with them ([3070e97](https://github.com/sudosapient-labs/project-tracker/commit/3070e970f00c8f86a911b119dfbd0d4f86d24f3c))
* **sync:** refuse an Undo whose kept copy is gone instead of creating the record anew ([92d19e7](https://github.com/sudosapient-labs/project-tracker/commit/92d19e7b892db5564f8f09fae542b44f238ce5af))
* **sync:** report refused changes to every save waiting, and keep descriptions and pre-delete edits apart ([517f33a](https://github.com/sudosapient-labs/project-tracker/commit/517f33a7d563c7142f64b91ca9fb30f3a2edd0e0))
* **sync:** restore deleted records as they were when a delete is undone ([873787c](https://github.com/sudosapient-labs/project-tracker/commit/873787c32a1b200f609f449231eb8ff3c34309d3))
* **sync:** send one ordered keepalive request on pagehide, and keep what the server defers ([6e62188](https://github.com/sudosapient-labs/project-tracker/commit/6e621886bee295b632a3202d6abfc6b7b5f3e671))
* **sync:** three-way merge comment reactions and project milestones ([c053c24](https://github.com/sudosapient-labs/project-tracker/commit/c053c24ca99e970bef6a242d91981f5c96078ab5))
* **tasks:** keep rich descriptions intact in quick edit ([cd80c94](https://github.com/sudosapient-labs/project-tracker/commit/cd80c944c4fbd262ca7c2f067e0f43f5e22e16d9))
* **tasks:** reopening a repeating task removes the next occurrence it scheduled ([e21878c](https://github.com/sudosapient-labs/project-tracker/commit/e21878c3525de624ff4f27a1dcfb99c0aac17b66))


### Performance Improvements

* **rich-text:** check and sanitise each description once ([05db28f](https://github.com/sudosapient-labs/project-tracker/commit/05db28febd753b15b0c141134838df698a358785))

## [0.1.1](https://github.com/sudosapient-labs/project-tracker/compare/v0.1.0...v0.1.1) (2026-11-05)


### Bug Fixes

* **docs:** record that the prod rename and release setup are done ([#9](https://github.com/sudosapient-labs/project-tracker/issues/9)) ([6f64f45](https://github.com/sudosapient-labs/project-tracker/commit/6f64f4563a10167ee9e942b198afca1a2189515a))

## [0.1.0] - 2026-10-31

First release of Sudo Sapient.

### Added

#### Workspace

- Home dashboard, inbox, my tasks, favourites, notifications, search and a command palette.
- Projects with board, list, table, calendar, timeline and files views, an overview, saved views,
  filters, and archiving.
- Tasks with subtasks, comments, reactions, mentions, attachments, repeat settings, start and due
  dates with optional times, and undo that only rewinds what its action touched.
- Members, teams, activity and settings; a single, self-hosted workspace (no billing or workspace
  switching).
- A real time-zone setting and time format; due dates, overdue and reminders follow each person's
  zone.
- URL routing for every page and view, so reloads keep your place, back/forward work and deep links
  to tasks, projects and files open after sign-in.

#### Backend and accounts

- Hono API on Node's built-in SQLite with migrations (`.sql` and `.js`) applied on start.
- Sign-up (the first account owns the workspace), email verification, sign-in, password reset and
  change, and a list of signed-in sessions that can be ended.
- Two-factor authentication with TOTP and recovery codes.
- Sync engine: the client sends field-level changes, the server validates and permission-checks each
  one and returns the canonical record; changes made offline are retried.
- Live updates to other people and tabs over Server-Sent Events.
- Per-account preferences, view settings, favourites and sidebar order.
- Change your sign-in email (confirmed from the new address), download your data as JSON, and delete
  your account.

#### Collaboration

- Emailed invites with roles, resending invites, and a reusable workspace invite link.
- Project sharing: workspace-wide or private projects, with Can view / Can comment / Can edit / Full
  access per person.
- Requesting access to a private project notifies its lead.
- Guests only see the projects they're added to.

#### Files

- Uploads stream to disk (up to 250 MB by default) with real progress, from the drawer, comments, the
  files view and drag and drop; image thumbnails and previews; duplicated files share stored bytes.

#### Notifications, email and push

- Notification preferences for mentions (including @team and @workspace), assignments, status changes
  and comments.
- Email through Resend: mention, assignment and comment emails, and a weekday morning digest.
- Due-tomorrow reminders and overdue alerts.
- Web Push notifications that arrive with the app closed and open the task when clicked.

#### App

- Installable PWA: web app manifest, app icons and a service worker that opens the app without a
  connection.
- Sudo Sapient brand: wordmark, app icon and monogram.

#### Operations

- Dockerfile for a single-process deployment with a persistent `/data` volume and a health check,
  and `railway.json` for deploying on Railway.
- `GET /api/health`, which also checks the database.
- Backups of the database and uploads (`pnpm db:backup`, or daily in the server with `BACKUP_DIR`).
- Request logging without secrets, clean shutdown, and pruning of old sessions, tokens, mail and
  notifications.
- Demo workspace seed for development (`pnpm db:seed`).
- CI running lint, format check, API tests (Vitest), a production build and end-to-end journeys
  (Playwright).
- Documentation for architecture, configuration, deployment, security and operations.

### Security

- Passwords hashed with scrypt; sessions are random tokens stored hashed, in `HttpOnly`,
  `SameSite=Lax`, `Secure` cookies.
- CSRF protection through a required request header on every mutating request.
- Production behaviour unless `NODE_ENV` is `development` or `test`; the first account in production
  needs a setup token.
- Rate limits on auth, invites, invite links and access requests; per-account sign-in lockout with
  device cookies so the lockout can't be used to keep the owner out; `X-Forwarded-For` read by hop
  count (`TRUST_PROXY`).
- Two-factor hardening: codes work once, recovery codes are used up atomically, an account-wide pause
  after repeated wrong codes, re-authentication to set up or turn off, and Owner resets for lost
  phones. TOTP secrets encrypted at rest with `SECRET_KEY`.
- Changing or resetting the password ends other sessions, their push subscriptions and pending email
  changes.
- Project permissions enforced on the server for every write, upload, download, notification, digest,
  bootstrap and live update; Owners and Admins can recover a locked project without reading its work.
- Rich-text descriptions sanitised on the server and in the client against one allowlist; every
  user-typed field escaped; choice fields, file types and attachment links validated on write.
- Strict Content Security Policy; served files sandboxed; request body size limits.
- Emailed links wiped from the outbox after sending and never returned by the API in production.
- Push only to the browsers' push services.

[Unreleased]: https://github.com/sudosapient-labs/project-tracker/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sudosapient-labs/project-tracker/releases/tag/v0.1.0
