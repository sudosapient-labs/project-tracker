# Sudo Sapient

A calm, structured project management workspace: home dashboard, inbox, my tasks, projects with
board / list / table / calendar / timeline / files views, members, teams, activity and settings.
One self-hosted workspace per deployment, with real accounts, two-factor sign-in, invites, live
updates, file storage, email and push notifications, and an installable app (PWA).

![Sudo Sapient home dashboard](docs/preview.png)

## Stack

- **Client:** plain JavaScript ES modules and CSS, no UI framework, bundled by [Vite](https://vite.dev).
  Icons are a build-time subset of [Lucide](https://lucide.dev).
- **Server:** [Hono](https://hono.dev) on Node.js 24, with Node's built-in SQLite (`node:sqlite`) and
  [zod](https://zod.dev) validation. Email through [Resend](https://resend.com), Web Push through
  `web-push`.
- **Tests:** [Vitest](https://vitest.dev) API tests against an in-memory database, and
  [Playwright](https://playwright.dev) user journeys against a built app.

## Getting started

Requires Node.js 24 (`.nvmrc`) and pnpm (`corepack enable`).

```bash
pnpm install
pnpm dev            # API on :8787 + Vite on http://localhost:5173 (proxies /api), both reloading
pnpm db:seed        # optional: load the demo workspace; sign in as hello@sudosapient.dev / sapient-demo-123
```

Open http://localhost:5173 and sign up: locally the first account needs no setup link, becomes the
workspace **Owner** and goes through setup. Without `RESEND_API_KEY`, emails (verification, reset,
invites) are printed with their links to the API console, and the verify and reset screens offer the
link directly. The local database is `data/sudo-sapient.db`; delete `data/` to start over.

| Script           | What it does                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `pnpm dev`       | `dev:server` (API, `NODE_ENV=development`, restarts on change) + `dev:web` (Vite)                |
| `pnpm build`     | client production build in `dist/`                                                               |
| `pnpm start`     | production server (`NODE_ENV=production`): API + `dist/` on :8787                                |
| `pnpm preview`   | `build`, then `start`                                                                            |
| `pnpm db:seed`   | load the demo workspace into an empty development database                                       |
| `pnpm db:backup` | copy the database and new uploads to `BACKUP_DIR` (see [operations](docs/operations.md#backups)) |
| `pnpm test`      | API tests (Vitest, in-memory database); `pnpm test:watch` to re-run on change                    |
| `pnpm test:e2e`  | build, start a throwaway server on :8790, run the Playwright journeys                            |
| `pnpm lint`      | ESLint                                                                                           |
| `pnpm format`    | Prettier (`pnpm format:check` only checks, as CI does)                                           |

The e2e journeys need a browser once: `pnpm exec playwright install chromium`.

## Documentation

- [Architecture](docs/architecture.md): how data flows, layers, conventions and the permission model
- [Configuration](docs/configuration.md): every environment variable and its default
- [Deployment](docs/deployment.md): Railway, and any other Docker host
- [Security](docs/security.md): authentication, sessions, CSRF, rate limits, content security
- [Operations](docs/operations.md): backups and restore, logging, scheduled jobs, known limits
- [Changelog](CHANGELOG.md)

## Project structure

```
index.html              HTML entry; loads src/main.js
public/                 copied as-is into dist/: service worker (sw.js), web app manifest,
                        logo.svg, icon.svg, favicon.svg, icons/ (PNG app icons)
src/
  main.js               entry: imports styles and modules, then boots the app
  styles/               index.css imports the rest in cascade order; tokens.css holds the design
                        tokens; views/ (list, board, table, calendar, timeline, projects & files)
                        and pages/ (settings, auth & onboarding)
  core/                 depends on nothing else in the app; the server imports parts of it too
    access.js           project permissions, shared by client and server
    rich-text.js        the rich-text allowlist, shared by both sanitisers
    api.js              HTTP client for /api, uploads included (adds the CSRF header)
    store.js            state (S) and lookups
    constants.js  file-types.js  icons.js  theme.js  utils.js
  ui/                   shared render helpers (incl. DOMPurify), toasts, the select dropdown
  shell/                render loop and router, layout, skeletons, view engine, sync with the server
  components/           task list renderer
  pages/                one module per route
  views/                project views: board, table, calendar, timeline, files, overview
  overlays/             task drawer, modals, popovers, context menu, command palette
  features/             teams, subtasks, archive (rendering)
  actions/              user actions, event wiring, keyboard shortcuts, drag and drop, session (auth),
                        account, push
server/
  index.js              process entry: HTTP server, housekeeping, scheduled jobs, backups, shutdown
  app.js                Hono app: routes, security headers, body limits, static files in production
  config.js             environment → config (see docs/configuration.md)
  db.js  repo.js        SQLite connection, migrations, transactions; one table per synced collection
  auth.js               sessions, device cookies, CSRF guard
  notify.js  jobs.js    notifications (+ email, push); reminders, digests, housekeeping
  routes/               /api/auth, /api/files, data (bootstrap, sync, events, export, push), workspace
  sync/                 bootstrap graph, sync engine, per-collection rules and schemas
  lib/                  backup, crypto, http helpers, mailer (Resend), push, rate-limit, rich-text
  migrations/           applied on start in name order: .sql, or .js exporting `default (db)` for data fixes
  scripts/              backup.js; seed-demo.js + demo-data.js (development only)
test/server/            API tests (Vitest)
e2e/                    user journeys (Playwright); serve.js starts the throwaway server
docs/                   documentation and the README screenshot
Dockerfile              production image (see docs/deployment.md)
docker-entrypoint.sh    hands root-owned volume mounts to `node`, then drops to it
railway.json            Railway build, health check and restart policy
.github/                CI workflow and pull request template
```

## Contributing

Every push to `main` and every pull request runs lint, the format check, the API tests, a production
build and the e2e journeys (`.github/workflows/ci.yml`). Note user-facing changes under
`[Unreleased]` in [CHANGELOG.md](CHANGELOG.md).
