# Security

How Sudo Sapient protects accounts and data. Production behaviour applies whenever `NODE_ENV` isn't
`development` or `test` (see [configuration](configuration.md#node_env)).

## Accounts and setup

- The first account creates the workspace and becomes its Owner. In production it needs the setup
  token (`SETUP_TOKEN`, or the one-off link printed to the log), so whoever reaches a fresh deployment
  first can't claim it.
- After that the workspace is invite-only unless `ALLOW_OPEN_SIGNUP=true`. An invited address (and the
  role it was invited with) can only be claimed through its own invite link; the reusable join link
  makes Members. Making a new join link retires the previous one, and only Owners and Admins can.
- New accounts verify their email (`REQUIRE_EMAIL_VERIFICATION`), except those who signed up through
  an emailed invite, which already proves the address.
- Passwords: at least 10 characters including a number or symbol, hashed with scrypt.

## Sessions

- A session is a random token in an `HttpOnly`, `SameSite=Lax` cookie (`ss_sid`, `Secure` in
  production); only its SHA-256 is stored, so a database leak doesn't hand out live sessions. "Remember
  me" sessions last 30 days, others one day (and end with the browser).
- Settings → Sessions lists sessions and can end any of them, or all others.
- Changing the password or email signs out every other session; resetting the password signs out all
  of them. Live-update streams close when their session ends, and push subscriptions are deleted with
  it.
- A pending email change is cancelled by a password change or reset, revoking sessions, turning
  two-factor on or off, or deleting the account. Links sent to an old address stop working once the
  email changes.

## Sign-in throttling and device cookies

- Auth endpoints are rate-limited per client IP (see `TRUST_PROXY`), e.g. 10 sign-ins a minute, 10
  sign-ups and 5 password-reset requests per 10 minutes.
- Each email is locked for 15 minutes after 10 failed sign-ins from anywhere.
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
  elsewhere. Uploads stream to disk under their own `MAX_UPLOAD_MB`.
- **Other rate limits:** invites (50 an hour per person, emailed or resent), invite links (10 an hour
  per person), access requests (3 an hour per person and project) and the Owner's two-factor resets.
  Asking for access answers the same whether or not the project exists.
- **Logging:** production logs one line per request (method, path, status, time), never bodies,
  cookies, query strings or tokens; tokens in auth link paths are replaced by `…`.

## Content security

- Every response carries a strict CSP: scripts only from the app, `base-uri 'none'`,
  `form-action 'self'`, `object-src 'none'`, `frame-ancestors 'none'` (styles and fonts also allow
  Google Fonts).
- Served files get their own CSP with `sandbox` (no scripts, no same origin), and only images, PDFs
  and plain text are shown inline; everything else downloads. Inline PDFs are the exception to the
  sandbox (Chromium won't render a sandboxed PDF) and get a CSP without scripts or other origins.
- Everything people type is escaped when rendered. Task descriptions are the one rich-text field: the
  server sanitises them on write (sanitize-html) and the client again when rendering or pasting
  (DOMPurify), both against the editor's own allowlist (`src/core/rich-text.js`: paragraphs, bold,
  italic, lists, a heading and http(s)/mailto links).
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

## Your data

Settings → Account downloads your data as JSON. The Owner's export also covers the workspace, but only
the work of projects the Owner can open, never password hashes, secrets or tokens; every workspace
export is logged and appears in Activity. Deleting an account needs the password and removes its
sessions, notifications, preferences and sign-in; work it was assigned is unassigned.
