# Sudo Sapient

A calm, structured project management workspace: home dashboard, inbox, my tasks, projects with
board / list / table / calendar / timeline / files views, members, teams, activity and settings.

The client is plain JavaScript ES modules and CSS, bundled by [Vite](https://vite.dev), with no UI
framework. The server is [Hono](https://hono.dev) on Node's built-in SQLite (`node:sqlite`).

![Sudo Sapient home dashboard](docs/preview.png)

## Getting started

Requires Node.js 24 (`.nvmrc`) and pnpm (`corepack enable`).

```bash
pnpm install
pnpm dev          # API on :8787 + Vite on http://localhost:5173 (proxies /api), both reloading
pnpm db:seed      # optional: load the demo workspace; sign in as hello@gr8rstudio.com / gr8r-demo-123
pnpm build        # client production build in dist/
pnpm start        # production server: API + dist/ on :8787
pnpm test         # API tests (Vitest, in-memory database)
pnpm test:e2e     # builds, starts a throwaway server, runs the Playwright journeys
pnpm lint         # ESLint
pnpm format       # Prettier
```

The first account created becomes the workspace **Owner** and goes through setup. After that the
workspace is invite-only: invite people from Members (they get an email), or share a reusable invite
link. Emails are sent through [Resend](https://resend.com). Without `RESEND_API_KEY`, they are printed to the API console and, outside production, the verify /
reset screens offer the link directly. If Vite picks a port other than 5173, set `APP_URL` so emailed
links point at it.

## Configuration

All settings are environment variables with local defaults; see [`.env.example`](.env.example).
For production you need at least `APP_URL`, persistent `DATABASE_PATH` / `UPLOAD_DIR`, `RESEND_API_KEY` and a `MAIL_FROM` address on a domain verified in Resend
(sign-up requires email verification).

## How data flows

- **Bootstrap.** After sign-in the client loads `GET /api/bootstrap`: the whole workspace graph this
  person may see (projects, tasks, comments, members, notifications, files, …), in the same shape
  the UI renders from `S.data`.
- **Writes.** Actions keep mutating `S.data` and calling `save()`. `shell/sync.js` diffs `S.data`
  against what the server last confirmed and sends field-level operations to `POST /api/sync`.
  The server (`server/sync/`) validates each one, checks permissions, applies side effects (task
  keys, cascading deletes, notifications, invite emails) and returns the canonical record; a
  rejected change is rolled back on the client with a toast. `<html data-sync>` shows
  `saving` / `saved` / `offline`; changes made while offline are retried.
- **Live updates.** Other people's changes arrive over Server-Sent Events (`GET /api/events`) and are
  merged in, filtered to what each person can see.
- **Per-person data** (preferences, view settings, favourites, sidebar order, notification
  preferences) is stored per account, not in the browser.
- **Files** stream to `POST /api/files` and are served only to people who can see the project.
- **Jobs** (`server/jobs.js`) send due-date reminders, overdue alerts and daily digests.

## Security

Passwords are hashed with scrypt; sessions are random tokens in `HttpOnly`, `SameSite=Lax` cookies
(stored hashed). Mutating requests require an `X-Requested-With` header (CSRF), auth endpoints are
rate-limited, two-factor uses TOTP with single-use recovery codes, and responses carry a strict CSP.
Private projects (and, for Guests, every project they aren't added to) are filtered on the server.

## Project structure

```
index.html              HTML entry; loads src/main.js
public/favicon.svg      brand mark
vite.config.js          Vite config, including the Lucide icon-subset plugin
eslint.config.js        lint rules (ESLint flat config); formatting by Prettier (.prettierrc.json)
.github/workflows/      CI: lint, format check, build
docs/preview.png        README screenshot
src/
  main.js               entry: imports styles and modules, then boots the app
  styles/
    index.css           imports every stylesheet in cascade order
    tokens.css          colours, spacing, type, radius, the shared --gutter
    base.css  components.css  shell.css  panels.css  overlays.css  states.css  motion.css  responsive.css
    views/              list, board, table, calendar, timeline, projects & files
    pages/              settings, auth & onboarding
  core/                 utilities, constants, icons, store (state + lookups), theme, API client
  ui/                   shared render helpers, toasts, the select dropdown
  shell/                render loop and router, sidebar/topbar layout, skeletons, view engine, sync
  components/           task list renderer
  pages/                one module per route
  views/                project views: board, table, calendar, timeline, files, overview
  overlays/             task drawer, modals, popovers, context menu, command palette
  features/             teams, subtasks, archive (rendering)
  actions/              user actions, event wiring, keyboard shortcuts, drag and drop, session (auth)
server/
  index.js              process entry: HTTP server, housekeeping, scheduled jobs
  app.js                Hono app (routes, security headers, static files in production)
  auth.js  routes/      sessions; /api/auth, /api/files, bootstrap/sync/events, workspace endpoints
  sync/                 bootstrap graph, sync engine, per-collection rules and schemas
  notify.js  jobs.js    notifications (+ email), reminders and digests
  migrations/           SQL migrations, applied on start
  scripts/              dev-only demo seed
test/server/            API tests (Vitest)
e2e/                    user journeys (Playwright)
```

### Layers

Dependencies point downward:

1. `core/` depends on nothing else in the app.
2. `ui/`, `shell/`, `components/`, `pages/`, `views/`, `overlays/` and `features/` render HTML from state.
3. `actions/` change state and re-render. Each action module registers its handlers on the
   shared action table (`A`) when it loads, so `main.js` imports them after `actions/actions.js`.

## Conventions

- **Rendering:** each page or view is a function that returns an HTML string from the store
  (`S`). `render()` rebuilds the shell and keeps focus and scroll positions.
- **Interactions:** elements declare `data-a="actionName"`. `actions/events.js` delegates the
  click to `A.actionName`. Inputs use `data-in`, blur handlers use `data-blur`.
- **Layout:** every page edge uses `var(--gutter)`, so the breadcrumb, page header, toolbar,
  list, table and board start on the same line.
- **Dropdowns:** write a normal `<select class="select">`. `ui/select.js` renders it as the
  design-system menu and keeps the native element as the source of truth.
- **Icons:** call `ic('name')` with any [Lucide](https://lucide.dev) icon name. The
  `virtual:icons` plugin bundles only the icons the source uses.

## Continuous integration

Every push and pull request runs lint, the format check, the API tests, a production build and the
e2e journeys (`.github/workflows/ci.yml`).

## Deploy

The app is one Node process with a SQLite file and an uploads directory, so it needs a host with a
persistent disk (a VM, Fly.io, Railway, Render, …), not a static or serverless host. The
`Dockerfile` builds an image that serves everything on port 8787 and keeps data in the `/data`
volume. Back up `/data`.
