# Configuration

Everything is configured through environment variables, read once at startup by
`server/config.js`. Locally nothing needs setting: `pnpm dev` works with the defaults below.

Nothing loads a `.env` file automatically. Set variables in your host's environment (on Railway, the
service's Variables), or locally load a file with Node's flag:
`node --env-file=.env server/index.js`. [`.env.example`](../.env.example) lists every server variable
with production-style values.

Booleans are on only for the exact string `true`, except `REQUIRE_EMAIL_VERIFICATION`, which is off
only for `false`.

## `NODE_ENV`

Only `NODE_ENV=development` (set by `pnpm dev` and `pnpm db:seed`) and `NODE_ENV=test` relax
security. Every other value, and no value at all, runs with production behaviour: `Secure` cookies,
the setup token for the first account, request logging, static files served from `dist/`, and
emailed links never returned by the API. So `staging`, a typo, or starting `node server/index.js`
without it all fail closed. `pnpm start` and the Docker image set `production`.

## Server

| Variable         | Default                                   | Meaning                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`       | `production` when unset                   | See above.                                                                                                                                                                                                                                                                                                                                                                                    |
| `PORT`           | `8787`                                    | HTTP port.                                                                                                                                                                                                                                                                                                                                                                                    |
| `HOST`           | `0.0.0.0` in production, else `127.0.0.1` | Interface to listen on.                                                                                                                                                                                                                                                                                                                                                                       |
| `APP_URL`        | `http://localhost:5173`                   | Public URL people open; used in emailed links and the setup link. Trailing `/` is dropped. If Vite picks another port locally, set it so emailed links work.                                                                                                                                                                                                                                  |
| `DATABASE_PATH`  | `data/sudo-sapient.db`                    | SQLite database file; its directory is created. Keep it on persistent storage. Locally, an existing `data/gr8r.db` (the name before the rename) is used when `data/sudo-sapient.db` doesn't exist.                                                                                                                                                                                            |
| `UPLOAD_DIR`     | `data/uploads`                            | Where uploaded files are stored. Persistent storage.                                                                                                                                                                                                                                                                                                                                          |
| `MAX_UPLOAD_MB`  | `250`                                     | Largest upload, in MB.                                                                                                                                                                                                                                                                                                                                                                        |
| `STATIC_DIR`     | `dist`                                    | Built client to serve.                                                                                                                                                                                                                                                                                                                                                                        |
| `SERVE_STATIC`   | `true` in production, else `false`        | Serve `STATIC_DIR` (with `index.html` for client-side routes).                                                                                                                                                                                                                                                                                                                                |
| `SECURE_COOKIES` | `true` in production, else `false`        | Mark session and device cookies `Secure` (HTTPS only).                                                                                                                                                                                                                                                                                                                                        |
| `TRUST_PROXY`    | `false` (0)                               | Number of reverse proxies in front of the app that append to `X-Forwarded-For` (`true` means 1). The client address is read that many entries from the right; entries further left are written by the client. Rate limits key on that address, so getting this wrong either lets clients pick their own IP or puts everyone behind the proxy's. Leave it unset when clients connect directly. |

## Accounts and sign-up

| Variable                     | Default | Meaning                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SETUP_TOKEN`                | none    | Token needed to create the first (Owner) account: open `APP_URL/#setup/<token>`. In production, when unset and there's no workspace yet, a one-off token is generated at each start and the link is printed to the log (`[setup] No workspace yet. Create the owner account at …`). In development and test, the first sign-up needs no token unless this is set.                               |
| `ALLOW_OPEN_SIGNUP`          | `false` | After the first account, anyone may sign up as a Member without an invite. Invited addresses still need their invite link.                                                                                                                                                                                                                                                                      |
| `REQUIRE_EMAIL_VERIFICATION` | `true`  | New accounts must verify their email before using the workspace. Set `false` only for trusted internal deployments without email.                                                                                                                                                                                                                                                               |
| `SECRET_KEY`                 | none    | Encrypts two-factor (TOTP) secrets at rest with AES-256-GCM. At least 32 bytes (startup fails otherwise), e.g. `openssl rand -base64 32`. Existing secrets are encrypted the next time the server starts with it. Don't lose or change it: without the same key authenticator codes stop working (recovery codes still do). Unset, secrets are stored unencrypted and production startup warns. |

## Email

| Variable          | Default                             | Meaning                                                                                                                                                                                                                                                                                                                                                         |
| ----------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RESEND_API_KEY`  | none                                | Sends email (verification, password reset, invites, email changes, notifications, digests) through [Resend](https://resend.com). Without it nothing is sent: development prints each message with its link to the API console, production logs only the recipient and subject and warns at startup. Sign-up needs email verification, so production needs this. |
| `MAIL_FROM`       | `Sudo Sapient <no-reply@localhost>` | Sender. Its domain must be verified in Resend.                                                                                                                                                                                                                                                                                                                  |
| `LOG_EMAIL_LINKS` | `false`                             | Production without `RESEND_API_KEY`: also log each email's link. Anyone who can read the logs can then use those sign-in, reset and invite links.                                                                                                                                                                                                               |

## Web Push

| Variable            | Default                                                               | Meaning                                                                                                                                                                                                                 |
| ------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VAPID_PUBLIC_KEY`  | generated                                                             | With `VAPID_PRIVATE_KEY`, the VAPID key pair. When either is unset, a pair is generated on first start and kept in the database (`server_keys`). Set them explicitly to share keys between databases or to rotate them. |
| `VAPID_PRIVATE_KEY` | generated                                                             | See above.                                                                                                                                                                                                              |
| `VAPID_SUBJECT`     | `mailto:` + the address in `MAIL_FROM`, else `mailto:admin@localhost` | Contact the push services may use.                                                                                                                                                                                      |

## Backups

| Variable      | Default | Meaning                                                                                                                                                                                                    |
| ------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BACKUP_DIR`  | none    | Where backups go. When set, the running server also writes one a day. Unset, `pnpm db:backup` writes to `backups` next to the database and the server takes none. See [operations](operations.md#backups). |
| `BACKUP_KEEP` | `14`    | How many database copies to keep (at least 1).                                                                                                                                                             |

## Development and test only

| Variable             | Default            | Meaning                                                                                   |
| -------------------- | ------------------ | ----------------------------------------------------------------------------------------- |
| `DISABLE_RATE_LIMIT` | `false`            | Turns off every in-memory rate limit. The e2e server sets it; never set it in production. |
| `DEMO_PASSWORD`      | `sapient-demo-123` | Password for the demo people `pnpm db:seed` creates.                                      |
| `API_PORT`           | `8787`             | Where Vite's dev server proxies `/api`. Set it if the API runs on another `PORT`.         |
| `E2E_PORT`           | `8790`             | Port of the throwaway server `pnpm test:e2e` starts.                                      |

## The Docker image

The `Dockerfile` sets `NODE_ENV=production`, `PORT=8787`, `DATABASE_PATH=/data/sudo-sapient.db` and
`UPLOAD_DIR=/data/uploads`. For production you need at least `APP_URL`, `RESEND_API_KEY`, `MAIL_FROM`
and `SECRET_KEY`, plus `TRUST_PROXY` behind a proxy; see [deployment](deployment.md).
