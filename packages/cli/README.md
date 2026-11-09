# @sudosapient/cli (`sudo-cli`)

Sudo Sapient from the terminal: everything you can do in the app, from capturing a task to sharing a
project, uploading a file or managing people, with `--json` for scripts. It talks only to the public API (`/api/v1`) with a personal API key, so it can do exactly
what you can do in the app, and its changes show in Activity as "you via CLI".

## Install

With Node 22 or later, run it straight from npm, or install it to get the `sudo-cli` command:

```bash
npx @sudosapient/cli login --url https://sudo.example.com
npm install -g @sudosapient/cli    # then: sudo-cli …
```

Mind the scope: the unscoped `sudo-cli` package on npm is **someone else's**; don't `npx sudo-cli`.

From a checkout of this repo instead:

```bash
pnpm install
ln -s "$PWD/packages/cli/bin/sudo-cli.js" ~/.local/bin/sudo-cli   # any directory on your PATH
# or run it in place: node packages/cli/bin/sudo-cli.js …
```

## Log in

Create a key in **Settings → API** (Read and write, unless you only want to look), then:

```bash
sudo-cli login --url https://sudo.example.com   # paste the key when asked
sudo-cli whoami
```

Give the key at the prompt (it isn't echoed) or pipe it in (`printf '%s\n%s\n' "$URL" "$KEY" | sudo-cli
login`), or set `SUDO_API_KEY`. `--key` works too, but the key then lands in your shell history and
in the process list where other users of the machine can see it, so `sudo-cli` warns when it's used.

The URL and key are saved to `$XDG_CONFIG_HOME/sudo-sapient/config.json` (default `~/.config`), readable
only by you (the directory is kept owner-only too). `SUDO_URL` and `SUDO_API_KEY` override it (handy
in CI). `sudo-cli logout` deletes it and, when you answer yes (or pass `--revoke`), also revokes the
key on the server so it stops working everywhere; otherwise revoke it in Settings → API.

The key travels with every request, so `sudo-cli` refuses a plain `http://` URL unless it's this
machine (`localhost`, `127.0.0.1`). For a workspace you really reach over plain http, add
`--insecure`; `login --insecure` remembers that for the saved URL.

## Use

```bash
sudo-cli new "Fix login bug" -p WEB --due friday -a me --priority high   # quick capture
sudo-cli tasks                    # my open tasks, newest first
sudo-cli tasks -p WEB --all       # every task in WEB, done ones too
sudo-cli show WEB-212
sudo-cli comment WEB-212 "Repro'd on Safari"
sudo-cli assign WEB-212 grace@example.com   # me, a name, an email, or none
sudo-cli done WEB-212 WEB-213
sudo-cli projects
sudo-cli open WEB-212             # in the browser (--print just prints the URL)
sudo-cli tasks --json | jq '.[].key'
```

### Everything else

`sudo-cli help <command>` lists a command's subcommands and options (or `sudo-cli <command> --help`).

```bash
sudo-cli tasks edit WEB-212 --status review --label bug,frontend --repeat weekly --depends WEB-200
sudo-cli tasks archive WEB-212 · tasks restore · tasks dup · tasks fav · tasks rm · tasks undelete <id>
sudo-cli subtask add WEB-212 "Write tests" -a grace   # ids come from sudo-cli show WEB-212
sudo-cli subtask done WEB-212 <id> · subtask edit · subtask rm · subtask promote
sudo-cli comment edit <id> "…" · comment rm <id> · comment undelete <id> · react <id> 👍 · unreact <id> 👍
sudo-cli projects new "Mobile App" --prefix MOB --private --members grace --perm edit
sudo-cli projects edit MOB --status risk --due 2026-12-01 --milestone "Beta=2026-11-20"
sudo-cli projects share MOB grace@example.com --perm comment · projects unshare MOB grace
sudo-cli projects show · archive · restore · dup · rm · request-access · fav · order WEB MOB
sudo-cli teams new Platform --members grace,ada · teams edit · teams rm
sudo-cli people invite cara@example.com --role Guest · people resend · people edit · people role grace Admin · people rm
sudo-cli files upload ./spec.pdf --task WEB-212 · files download <id> [-o path|-] · files attach <id> WEB-212
sudo-cli files rename · detach · dup · rm
sudo-cli events new "Launch" --date 2026-12-01 --time 09:30 -p WEB · events --from today --to +30d
sudo-cli views new "Urgent" -p WEB --type board --filter priority=urgent,high --filter assignee!=me
sudo-cli inbox --unread · inbox read <id> · inbox read --all · activity -p WEB · search "login"
sudo-cli me edit --title Engineer · prefs set theme=dark tz=Europe/Berlin · notify-prefs set email_comment=on
sudo-cli workspace · favorites
sudo-cli api GET /tasks -f project=WEB      # any endpoint; -f sends strings, -F typed values, --data JSON
```

- **Admin commands** (`people role`, `people rm`, others' names and titles, `workspace edit`,
  `workspace invite-link`, `bots …`) work when the key's person is an Owner or Admin, as in the app.
  For anyone else they fail with "Only owners and admins can do this".
- **Deleting** a project, person, bot, team or file asks first; `--yes` (`-y`) skips the question,
  and without a terminal to ask at (a script) `--yes` is required. Tasks and comments don't ask:
  `tasks rm` and `comment rm` print how to undo them, which works for 10 minutes.
- **Downloads** go to the file's own name in the current directory (reduced to a plain file name), or
  `-o <path>`, or `-o -` for stdout. An existing file is never overwritten without `--force`.
- Bot keys are made in Settings → API → Bots only; `bots` can list, change, remove and revoke them.
- `none` clears a field: `--due none`, `--team none`, `--repeat none`, `--label none`.

Due dates: `today`, `tomorrow`, a weekday (`friday`, `fri`; today counts), `next week`, `+3d`, `+2w`, or
`2026-11-20`, each optionally with a time: `--due "friday 5pm"`, `--due "2026-11-20 17:00"`. Dates and
times are read and shown on your clock in the workspace: your time zone (Settings → Date and time, or
`prefs set tz=Asia/Dubai`), else the workspace's (`workspace edit --tz Asia/Dubai`), else UTC; `prefs`
says which. Only an older server that doesn't say makes the CLI use this computer's clock (`TZ`).
That includes what others did: `activity` shows a due someone in India set for 6:30 PM as 5:00 PM
when you're in Dubai, and `events` shows their 10:00 event at 08:30 (`events new --date --time`
is read on your clock too).
`--json` keeps the API's values, where a time is in UTC. Set `SUDO_PROJECT=WEB` to skip `-p`. Exit codes: `0` ok, `1` the API refused (the
message says why; with `--json` it's `{ error, code }` on stderr), `2` a usage error.

**Several keys at once** (`done`, `tasks rm`, `tasks archive`, `restore`, `fav`, `unfav`,
`inbox read`, `inbox unread`) make one request per key, in order, and stop at the first one that
fails. What went through is printed as it happens (deleted tasks with their undo ids); then stderr
names the key that failed and why, and what wasn't tried (`Stopped at WEB-999; 1 of 3 done (WEB-201).
Not tried: WEB-203.`), and the exit code is `1`. So fix or drop the failed key and run the command
again with the keys that weren't tried; nothing gets done twice. If the connection dropped or the
server failed, that key may have gone through, and the message says to check it first. With `--json`,
stdout is the array of what went through and stderr is
`{ error, code: "incomplete", done, failed: { ref, code, error }, notTried }`.

Your keys share one rate limit (120 requests a minute by default). When a bulk run reaches it,
`sudo-cli` waits until the server says it may go on (`rate limited; retrying in 53 s…` on stderr) and
then carries on, up to 3 times per request.

## License

UNLICENSED, all rights reserved. The package is public on npm so anyone can install and run it, but
no license to copy, modify or redistribute the code is granted.
