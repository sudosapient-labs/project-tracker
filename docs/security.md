# Security

How Sudo Sapient protects accounts and data. Production behaviour applies whenever `NODE_ENV` isn't
`development` or `test` (see [configuration](configuration.md#node_env)).

## Accounts and setup

- The first account creates the workspace and becomes its Owner. In production it needs the setup
  token (`SETUP_TOKEN`, or the one-off link printed to the log), so whoever reaches a fresh deployment
  first can't claim it.
- After that the workspace is invite-only unless `ALLOW_OPEN_SIGNUP=true`. An invited address (and the
  role it was invited with) can only be claimed through its own invite link; the reusable join link
  makes Members. Making a new join link retires the previous one, and only Owners and Admins can. A
  join link stops working once whoever made it is no longer an Owner or Admin (or leaves).
- Sign-up without a valid invite for that address or a join link gets one answer in an invite-only
  workspace (`403 invite_only`), whether the address already has an account, has a pending invite
  or neither, so it can't be used to find out who is in the workspace.
- New accounts verify their email (`REQUIRE_EMAIL_VERIFICATION`), except those who signed up through
  an emailed invite, which already proves the address.
- Passwords: at least 10 characters including a number or symbol, hashed with scrypt.

## Sessions

- A session is a random token in an `HttpOnly`, `SameSite=Lax` cookie (`ss_sid`, `Secure` in
  production); only its SHA-256 is stored, so a database leak doesn't hand out live sessions. "Remember
  me" sessions last 30 days, others one day (and end with the browser).
- Settings → Sessions lists sessions and can end any of them, or all others.
- Signing out (or a session ending) reloads the tab, so nothing of the person stays in memory for
  whoever uses it next (a key just created, recovery codes, drafts, forms). The browser keeps only
  display preferences (theme, accent, density); name and title are never cached there.
- Changing the password or email signs out every other session; resetting the password signs out all
  of them. Live-update streams close when their session ends, and push subscriptions are deleted with
  it.
- A pending email change is cancelled by a password change or reset, revoking sessions, turning
  two-factor on or off, or deleting the account. Links sent to an old address stop working once the
  email changes.

## Sign-in throttling and device cookies

- Auth endpoints are rate-limited per client IP (an IPv6 client per /64; see `TRUST_PROXY`), e.g. 10 sign-ins a minute, 10
  sign-ups and 5 password-reset requests per 10 minutes.
- Each email is locked for 15 minutes after 10 failed sign-ins from anywhere. Each attempt is counted
  before the password is checked (and given back when it was right), so parallel guesses can't all
  be checked before the first failures count.
- Signed-in actions that ask for the password (changing it or the email, API and bot keys, setting
  up or turning off two-factor, deleting the account, the Owner's two-factor reset) have their own
  budget per person: 10 wrong passwords in 15 minutes, counted the same way, then `429` until it
  resets. Strangers failing to sign in don't touch it, so they can't lock someone out of changing
  their password; but each wrong password there also counts towards the email's sign-in lock, so a
  stolen session can't guess faster than sign-in allows.
- So that strangers can't use that lock to keep the owner out, a browser that has signed in to the
  account before carries a **device cookie** (`ss_dev`: random, `HttpOnly`, one year, path
  `/api/auth`, stored hashed; the OWASP device-cookie pattern). Its sign-ins skip the per-email lock and
  have their own limit of 10 failures per 15 minutes, after which it counts as a stranger again.
- Signing out keeps the device cookie. Resetting the password forgets every device of the account, and
  changing it forgets all but the browser that changed it.
- A password reset answers the same whether or not the account exists; a sign-in with an unknown
  email still spends the time of a password check.

## Two-factor authentication

- TOTP (each code is accepted once) with single-use recovery codes, consumed atomically so concurrent
  requests can't share one.
- A sign-in waiting for its code ends after 5 wrong ones. After 10 wrong codes in 15 minutes for an
  account (whatever the session), two-factor sign-in pauses for 15 minutes and the person gets an
  email. This lock is stored in the database, so it survives restarts.
- Setting two-factor up needs the current password; turning it off needs the password or a current
  code. The Owner can reset someone else's (lost phone) with their own password, which emails that
  person and signs them out everywhere.
- With `SECRET_KEY` set, TOTP secrets are encrypted at rest (AES-256-GCM).

## Emailed links

- Verification (48 hours), password reset (30 minutes), email change (24 hours), invite (14 days) and
  join (30 days) links carry single-use random tokens, stored hashed. Issuing a new verify or reset
  link retires older unused ones.
- Once a message is sent (or given up on), its link and body are wiped from the outbox, and sent mail
  is deleted after 30 days. Only local development without `RESEND_API_KEY` keeps them, as its
  mailbox.
- In production the API never returns emailed links, and without `RESEND_API_KEY` only each message's
  recipient and subject are logged, unless `LOG_EMAIL_LINKS=true`.

## Requests

- **CSRF:** mutating requests must carry `X-Requested-With: sudo-sapient`. Browsers can't add a custom
  header cross-site without a CORS preflight, which this API never approves, so together with
  `SameSite` cookies this blocks cross-site requests.
- **Body limits:** 64 KB for `/api/auth`, 10 MB for `/api/sync` (and at most 500 operations), 1 MB
  elsewhere. Uploads stream to disk under their own `MAX_UPLOAD_MB`, and are also bounded by a
  workspace quota (`UPLOAD_QUOTA_MB`), a reserve of free disk space (`MIN_FREE_DISK_MB`, since the
  volume also holds the database) and `UPLOADS_PER_HOUR` per person. Uploads still streaming in
  reserve their size (their `Content-Length`, or as much as they may take) against the quota and
  the disk reserve, so parallel uploads can't each count the same room, and a body that runs past
  its `Content-Length` is cut off.
- **Other rate limits:** sync requests (600 a minute per person, all their tabs and devices
  together; far above what the app sends), invites (50 an hour per person, emailed or resent), invite links (10 an hour
  per person), access requests (3 an hour per person and project) and the Owner's two-factor resets.
  Asking for access answers the same whether or not the project exists.
- **Access is checked when the write happens:** a request without a valid session or key is
  refused before its body is read; otherwise it is authenticated again once its whole body has
  arrived, and every write (sync batches, API writes, uploads, making API keys,
  password, email and two-factor changes, deleting an account) checks the session or API key, the
  person and their current role again inside its transaction, after any password check. A request
  held open while the person was removed, demoted, signed out or had their password changed is
  refused (`401`) or judged by the role they have now. Actions that need the current password also
  fail if it changed meanwhile, and the workspace always keeps at least one Owner. Sign-in (and
  its two-factor step) only creates a session or trusts a device if the password is still the one
  just checked, and a reset link is used up in the same transaction that sets the new password.
- **Logging:** production logs one line per request (method, path, status, time), never bodies,
  cookies, query strings or tokens; tokens in auth link paths are replaced by `…`.

## Personal API keys

- Created and revoked in Settings → API with a signed-in session (and its CSRF header); creating one
  also needs the current password, so a signed-in browser alone (say, a stolen session) can't mint a
  credential that outlives it. A key can't create or list keys, and the only key it can revoke is itself
  (`DELETE /api/v1/me/key`, allowed for read-only keys too, since it only takes access away). A key is `ssk_` + 32 random
  bytes, shown once; only its SHA-256 is stored (like session tokens it's high-entropy, so a slow
  hash adds nothing), with a 12-character prefix for the list. Each has a last-used time and an
  optional expiry (30, 90 or 365 days); at most 25 per person.
- A key acts as the person who made it, read fresh on every request: their current role, the
  projects they can open, and Guest limits. Removing someone deletes their keys, and so does
  changing or resetting their password: making a key needs the password, so anyone who knew the old
  one could have made one. "Sign out of all other sessions" and an email change keep them; revoke
  keys in Settings → API. Keys skip two-factor, as every bearer token does.
- Scopes: `read` (GET only) or `write`. A write key can do what its person's role allows, workspace
  administration included for an Owner or Admin (roles, removing people, workspace settings, bots,
  the invite link, other people's comments, workspace-wide events, admin recovery of projects). The
  role is read on every request and the sync rules check it again, so demoting someone takes those
  powers off all their keys at once. A leaked Owner's or Admin's key is therefore as strong as their
  session, minus the account actions below; revoke it in Settings → API. Writes go through the same sync rules as the app (see
  [architecture](architecture.md#public-api-mcp-and-cli)); work in projects a key can't open answers
  404, never 403, so it doesn't reveal what exists.
- Some things are never reachable with a key, whatever its scope, because a stolen key mustn't be
  able to take over the account or mint more access: changing the password, two-factor, sessions,
  the sign-in email, deleting the account, making API keys (personal or a bot's), resetting
  someone's two-factor, Web Push subscriptions, and the Owner's full workspace export. They need a
  signed-in session (and most also the current password). See [the API reference](api.md#not-reachable-with-an-api-key).
- `/api/v1` and `/api/mcp` accept only `Authorization: Bearer`, never the session cookie, so they
  need no CSRF header: a cross-site page can't make a browser attach a bearer key, and no CORS is
  offered. `/api/mcp` also refuses browser `Origin`s other than the app's.
- Each person's keys together may make `API_RATE_LIMIT` requests a minute to `/api/v1`, and as
  many MCP protocol messages to `/api/mcp`, each message in a batch counting once (`RateLimit-*`
  headers, `429` with `Retry-After`). Making more keys doesn't raise the limit. Changes show in Activity
  as "Ada via CLI" (the client's label or the key's name), set by the server; the app can't forge one.
- MCP tool results carry text other members wrote, which may try to instruct the assistant (prompt
  injection), so each result is fenced as `<untrusted-user-content>` with every `<` inside escaped
  (it can't close the fence), and read tools and the server instructions say it's data, not
  instructions. Tools carry explicit `readOnlyHint` / `destructiveHint` annotations so clients
  confirm writes; `sudo-mcp --read-only` (or `SUDO_MCP_READ_ONLY=1`) and Read only keys offer
  reads only. See the [MCP README](../packages/mcp/README.md#untrusted-content).
- `sudo-cli` strips control characters from workspace text (error messages included) before
  printing it, so a task title can't send escape sequences to someone's terminal, and `sudo-cli
open` only opens (or prints) a link on the workspace's own origin.

## Bot members

- A bot is a `users` row with `kind = 'bot'`, no password and an address on the reserved `.invalid`
  TLD (RFC 2606), plus a member record with `kind: 'bot'`. Every sign-in path refuses it by that
  column, not by accident: sign-in and password reset look up people only, verify links never mark
  one, no sign-in, reset, verify, invite or email-change link can be issued for one, a session row
  for one is ignored, and the mailer drops any `.invalid` address. Notifications (and so email and
  push) skip bots, and @mentions can't reach them.
- Only Owners and Admins, with a signed-in session and its CSRF header, create, rename, re-scope and
  remove bots and their keys (`/api/bots`); creating a key also needs the admin's current password.
  Requests carrying a bearer key are refused (`403`), even alongside a session. Bots can only be
  Members or Guests, and `kind` is server-owned: sync can't rename or promote a bot, or turn a
  person into one.
- A bot key acts as the bot (`by` is the bot, never the admin), with the bot's role and projects
  read fresh on each request, and its own `api:<bot id>` rate-limit budget.
- `api_keys.created_by` records the admin who made a bot's key, as an audit trail only:
  `ON DELETE SET NULL`, so removing that admin keeps the key. Removing the bot deletes its keys
  (cascade from its `users` row). An admin changing or resetting their password revokes the bot keys
  they made as well as their own, since whoever knew the old password may have made one.

## Content security

- Every response carries a strict CSP: scripts only from the app, `base-uri 'none'`,
  `form-action 'self'`, `object-src 'none'`, `frame-ancestors 'none'` (styles and fonts also allow
  Google Fonts), and `X-Frame-Options: DENY` to match.
- Every `/api` response, file downloads included, carries `Cache-Control: no-store`, so no data
  is kept in the browser's cache or a shared one; signing out also sends
  `Clear-Site-Data: "cache"`.
- Served files get their own CSP with `sandbox` (no scripts, no same origin), and only images, PDFs
  and plain text are shown inline; everything else downloads. Inline PDFs are the exception to the
  sandbox (Chromium won't render a sandboxed PDF) and get a CSP without scripts or other origins.
- Everything people type is escaped when rendered. Task descriptions are the one rich-text field: the
  server sanitises them on write (sanitize-html) and the client again when rendering or pasting
  (DOMPurify), both against the editor's own allowlist (`src/core/rich-text.js`: paragraphs, bold,
  italic, lists, a heading and http(s)/mailto links). A link longer than 2,048 characters loses its
  `href` before the link check runs (that check is quadratic in some long links).
  Before sanitising, a description must be text of at most 100,000 characters with elements nested
  at most 64 deep (sanitising gets superlinear with depth, so huge or deeply nested markup could
  stall the server). The depth is measured by running the sanitiser's own parser (the htmlparser2
  copy sanitize-html uses, with its options), which stops once the limit is passed, so it is the
  same depth the sanitiser will see. Content the sanitiser would re-parse (a discarded `<iframe>`'s
  fallback, `noscript`, `noembed`, `noframes`) is dropped instead. As a backstop that doesn't rely on
  any of that, one request may have at most 1,000,000 characters of descriptions checked and
  sanitised and spend at most 500 ms doing it; the rest of a batch is refused (`413`, which the app
  retries in a later request). Any synced value over 256 KB is refused before rules look at it. One
  exception, so tasks stored before the nesting limit keep working (e.g. their next repeat copies
  the description): a description nested too deeply is still accepted, as it is and unsanitised,
  when it exactly equals one already stored on a task in the same project. That holds for any create
  or update in that project, by anyone who may edit there, through the app or the API; such markup
  was sanitised when it was first stored, and the length limit still applies.
- Task keys and each project's key counter are the server's: a client can't set the counter or edit
  a key, and an optimistic key is only kept if it doesn't skip ahead of the counter, so nobody can
  run a project out of task numbers.
- Fields the UI only offers choices for are checked on write too: repeat settings, event times,
  reaction emoji, saved-view filters. File type and size come from the stored file, and attachments
  and file links only ever point at `/api/files/`.

## Project permissions

Project privacy and the Can view / comment / edit / Full access levels (see
[architecture](architecture.md#permission-model)) are enforced on the server for every write, upload,
file download, notification, digest, bootstrap and live update: nobody is notified or emailed about a
project they can't see, work can't be assigned to them, and people outside a private project get only
a stub of it (Guests get nothing).

## Push

Push subscriptions are only accepted on the browsers' push services (FCM, Mozilla, Apple, Windows),
over HTTPS on the default port, so the server never posts to arbitrary hosts. A subscription belongs
to the session that made it and is deleted when that session ends.

## Android app links

`/.well-known/assetlinks.json` is public and needs no session. It lists only the Android app's
package name and the SHA-256 fingerprints of its public signing certificates, which anyone with the
APK can read anyway; the signing key itself never touches the server.

## Your data

Settings → Account downloads your data as JSON. The Owner's export also covers the workspace, but only
the work of projects the Owner can open, never password hashes, secrets or tokens; every workspace
export is logged and appears in Activity. Deleting an account needs the password and removes its
sessions, notifications, preferences and sign-in; work it was assigned is unassigned.
