# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
