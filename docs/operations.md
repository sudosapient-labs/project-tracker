# Operations

Running Sudo Sapient day to day: backups, logs, background work and the limits to know about.
Deploying is covered in [deployment](deployment.md).

## Health

`GET /api/health` answers `{"ok":true}` while the database answers a query, and 503 otherwise. The
Docker image's `HEALTHCHECK` uses it; point your host's health check at it too.

## Backups

`pnpm db:backup` (or `node server/scripts/backup.js` where there's no pnpm, such as the Docker image:
`docker exec <container> node server/scripts/backup.js`) writes a consistent copy of the database
(SQLite `VACUUM INTO`, safe while the app runs) and mirrors uploaded files into `BACKUP_DIR`:

```
BACKUP_DIR/
  sudo-sapient-20261031T030000Z.db    one per run; the newest BACKUP_KEEP (default 14) are kept
  uploads/ab/b…                       every uploaded file, copied once (stored files never change)
```

Uploads are copied incrementally and never removed from the mirror, so every kept database copy still
has its files. Without `BACKUP_DIR` the script writes to `backups` next to the database
(`/data/backups` in the Docker image). With `BACKUP_DIR` set, the running server also takes one a day:
it checks hourly, and only backs up when the newest copy is a day old, so restarts don't skip or
repeat one.

**A backup on the same disk or volume as the data is not a backup**: it survives a bad deploy or a
mistaken delete, not a lost disk. Point `BACKUP_DIR` at separate storage (in Docker, mount another
volume at `/backups`, which the image creates writable for the app, and set `BACKUP_DIR=/backups`),
then copy it off the machine as well. On Railway, where a service has one volume, see
[backups on Railway](deployment.md#backups-on-railway).

### Restore

1. Stop the app.
2. Replace `DATABASE_PATH` with the backup file, and delete any `DATABASE_PATH-wal` / `-shm` files
   next to it.
3. Copy `BACKUP_DIR/uploads` back into `UPLOAD_DIR` (extra files there are harmless).
4. Start the app. Migrations newer than the backup run on start.

## Logging and shutdown

Everything goes to stdout and stderr; ship the logs to whatever you use. Lines are prefixed by area:

- `[api]` startup (address, mode) and warnings about a missing `RESEND_API_KEY` or `SECRET_KEY`;
- `[setup]` the first-run setup link, while no workspace exists;
- `[http]` in production, one line per request: method, path, status and time; never bodies, cookies,
  query strings or tokens;
- `[mail]` each email when there's no `RESEND_API_KEY` (recipient and subject only in production),
  and failed sends;
- `[push]`, `[jobs]`, `[housekeeping]`, `[backup]` failures, and each backup written;
- `[export]` each workspace export by the Owner (also shown in Activity);
- `[security]` two-factor secrets that are encrypted while `SECRET_KEY` is missing;
- `[process]` unhandled rejections, and uncaught exceptions, after which the process exits for the
  host to restart it.

There is no error tracker built in. On `SIGTERM` / `SIGINT` the server stops its timers, closes
live-update streams, lets open requests finish, closes the database and exits (forced after 3 seconds).

## Scheduled jobs

`server/index.js` runs these in-process; nothing needs a separate scheduler.

| Every     | Job                                                                                                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| minute    | Housekeeping (below), then delivering queued email.                                                                                                                                                    |
| 5 minutes | Reminders: "due tomorrow" and "overdue" notifications for assignees, once per task and due date, judged in the assignee's time zone.                                                                   |
| 5 minutes | Daily digests: on weekdays from 08:00 in each person's time zone, one email listing unread notifications from the last day, for people with Daily digest on. Nothing is sent when there's nothing new. |
| hour      | With `BACKUP_DIR` set: a backup when the newest one is a day old (and once at startup).                                                                                                                |

Email is queued in the database (`outbox`) in the same transaction as the change that caused it and
delivered right after; failed sends are retried by the minute job up to 5 times, except errors a retry
can't fix (an unverified sender, an invalid address), which stop at once.

## Housekeeping and pruning

Every minute the server deletes:

- expired sessions (and with them their push subscriptions) and expired device cookies;
- sign-in, reset, invite and other link tokens a week after they expired;
- mail sent, or given up on, more than 30 days ago;
- read notifications older than 180 days;
- reminder records for tasks that are gone or done.

Push subscriptions the push service reports as gone are deleted when a send fails. A file's bytes are
deleted with the last record that uses them.

## Known limits

- **One process.** Rate limits (per IP, per email, per device) and live-update connections are kept in
  memory, so the app runs as a single Node process; limits reset when it restarts. Running several
  instances would need a shared store behind `server/lib/rate-limit.js` and the sync engine's fan-out.
  (Two-factor lockouts are stored in the database.)
- **Reconnects re-bootstrap.** When the live-update stream drops, the client reloads the whole graph
  (`GET /api/bootstrap`) rather than catching up from a cursor; fine for a team-sized workspace,
  costly for a very large one.
- **SQLite.** One writer at a time; each sync batch is one transaction. Plenty for a team, but the
  database and uploads must live on a local, persistent disk.
- **No error tracker or metrics.** Only the logs above, plus `GET /api/health`.
