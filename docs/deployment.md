# Deployment

The app is one Node process with a SQLite file and an uploads directory, so it needs a host with a
persistent disk (a VM, Railway, Fly.io, Render, …), not a static or serverless host. Run exactly one
instance: rate limits and live-update connections live in memory (see
[known limits](operations.md#known-limits)).

## The Docker image

The `Dockerfile` builds the client (`pnpm build`) in a build stage, then copies `node_modules`
(production dependencies only), `dist/`, `server/` and `src/core/` (shared with the server) into a
`node:24-slim` image that:

- runs `node server/index.js` as the unprivileged `node` user, serving the API and the client on port
  8787 (`PORT`);
- sets `NODE_ENV=production`, `DATABASE_PATH=/data/sudo-sapient.db` and `UPLOAD_DIR=/data/uploads`;
- starts through `docker-entrypoint.sh`, which gives root-owned mounts (as Railway creates them) to
  `node` and then drops to `node`; started with `--user`, it runs as that user unchanged. It only
  takes ownership of directories under `/data` or `BACKUP_DIR` (after resolving symlinks, and
  without following any), and refuses to start when `DATABASE_PATH` or `UPLOAD_DIR` points
  elsewhere or `BACKUP_DIR` is a system directory;
- declares no `VOLUME` (Railway's builder rejects it): mount persistent storage at `/data` yourself;
- has a `HEALTHCHECK` on `GET /api/health`, which also runs a database query and answers 503 when the
  database isn't usable.

Migrations run on start, so the first start creates the database.

## Railway

Railway deploys `prod` with the `Dockerfile`. The build and deploy settings live on the Railway
service itself, not in a file in the repo: a root `railway.json` would apply to every service built
from this repo, including the Slack bot, and Railway no longer lets a service point at a different
one. Set on the service (Settings): builder Dockerfile, Dockerfile path `Dockerfile`, health check
`/api/health` with a 120-second timeout, restart policy On failure with 5 retries.

1. **Create the service** from the GitHub repository, branch `prod`. Railway uses the root
   `Dockerfile`.
2. **Attach a volume** mounted at `/data`. It holds the database and uploads. Railway mounts it owned
   by `root`; the entrypoint hands it to `node`, so don't set `RAILWAY_RUN_UID`.
3. **Set the variables** (service → Variables):

   | Variable         | Value                                                                                 |
   | ---------------- | ------------------------------------------------------------------------------------- |
   | `APP_URL`        | the public URL, e.g. `https://<service>.up.railway.app` or your custom domain         |
   | `RESEND_API_KEY` | your Resend API key                                                                   |
   | `MAIL_FROM`      | e.g. `Sudo Sapient <no-reply@your-domain>`, on a domain verified in Resend            |
   | `SECRET_KEY`     | `openssl rand -base64 32`; store it somewhere safe as well, and never change it       |
   | `TRUST_PROXY`    | `1`: Railway's edge adds one `X-Forwarded-For` hop                                    |
   | `SETUP_TOKEN`    | optional: a long random string, if you'd rather not take the setup link from the logs |
   | `BACKUP_DIR`     | optional, see Backups below                                                           |

   Leave `PORT` to Railway: the app listens on whatever `PORT` it's given (8787 by default). Don't set
   `DISABLE_RATE_LIMIT`. See [configuration](configuration.md) for everything else.

4. **Networking:** generate a domain (or add a custom one) and make sure `APP_URL` matches it exactly;
   emailed links use it.
5. **Keep one replica.** Railway doesn't combine replicas with volumes anyway.

### First run

With no workspace yet, the deploy logs show:

```
[setup] No workspace yet. Create the owner account at https://…/#setup/<token>
```

Open that link and sign up: that account becomes the workspace Owner. Without `SETUP_TOKEN` the token
is new on every start until the workspace exists, so use the link from the latest start. With
`SETUP_TOKEN` set, open `APP_URL/#setup/<SETUP_TOKEN>` instead. After that the workspace is
invite-only: invite people from Members (they get an email), or have an Owner or Admin share the
reusable invite link.

Check the startup log for warnings: a missing `RESEND_API_KEY` means no email goes out (and sign-up
can't be verified), a missing `SECRET_KEY` means two-factor secrets are stored unencrypted.

### The Android app

To let the Android app open without an address bar, set `ANDROID_PACKAGE_NAME` (e.g.
`dev.sudosapient.app`) and `ANDROID_CERT_FINGERPRINTS` (the SHA-256 fingerprint of the key the APK
is signed with: `keytool -list -v -keystore <keystore> -alias <alias>`) on the service, and redeploy.
A malformed value stops the new deployment from starting, so check its logs. Then:

```sh
curl -si https://<your-domain>/.well-known/assetlinks.json
```

should answer `200` with `Content-Type: application/json` and your package name and fingerprint,
with no redirect in between. A `404` means one of the two variables isn't set. Android and Chrome
remember the result of the check for a while, so after changing the file, reinstall the app (or
clear its data) to see the change at once. See [configuration](configuration.md#android-app).

### Backups on Railway

A Railway service has a single volume, so `BACKUP_DIR` can't be a second volume on the same service.
Combine:

- **In-app backups:** set `BACKUP_DIR=/data/backups`. The server then writes a consistent copy of the
  database a day and mirrors uploads into it, keeping `BACKUP_KEEP` copies. On the same volume, this
  protects against a bad deploy or a mistaken delete, not against losing the volume.
- **Railway volume backups:** schedule them in the service's Backups tab. They are snapshots tied to
  the volume (wiping the volume deletes them), so they don't replace an off-site copy.
- **An off-host copy:** regularly copy `/data/backups` somewhere else (Railway's CLI can reach the
  volume's files, e.g. over `railway ssh`).

To take a backup now: `railway ssh`, then `node server/scripts/backup.js`. Restoring is described in
[operations](operations.md#restore).

### Upgrading

Push (or merge) to `prod`; Railway builds and deploys the new image. Pending migrations run on start,
in a transaction each; a failing migration stops the server from starting. A service with a volume has
a short downtime on each deploy, because Railway doesn't mount the volume on two deployments at once.
Take a backup before deploys that add migrations.

## Other Docker hosts

```bash
docker build -t sudo-sapient .
docker run -d --name sudo-sapient -p 8787:8787 \
  -v sudo-sapient-data:/data -v sudo-sapient-backups:/backups \
  -e APP_URL=https://tracker.example.com -e RESEND_API_KEY=… -e MAIL_FROM='Sudo Sapient <no-reply@example.com>' \
  -e SECRET_KEY=… -e TRUST_PROXY=1 -e BACKUP_DIR=/backups \
  sudo-sapient
docker logs sudo-sapient   # the [setup] link for the first account
```

- Put it behind a reverse proxy that terminates HTTPS (cookies are `Secure` in production, and Web
  Push needs HTTPS). Set `TRUST_PROXY` to the number of proxies that append to `X-Forwarded-For`, or
  leave it unset when clients connect to the container directly.
- Mount `/data` on persistent storage, and `/backups` on separate storage (another disk, or storage
  that is copied off the machine).
- The image's `HEALTHCHECK` marks the container unhealthy when `/api/health` fails.
- To upgrade, build or pull the new image and replace the container; migrations run on start.
- Stopping sends `SIGTERM`, which the server handles by finishing open requests and closing the
  database (see [operations](operations.md#logging-and-shutdown)).
