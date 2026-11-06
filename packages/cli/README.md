# @sudosapient/cli (`sudo-cli`)

Sudo Sapient from the terminal: capture, list, assign, comment on and complete tasks, with `--json`
for scripts. It talks only to the public API (`/api/v1`) with a personal API key, so it can do exactly
what you can do in the app, and its changes show in Activity as "you via CLI".

## Install

With Node 20 or later, run it straight from npm, or install it to get the `sudo-cli` command:

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

The URL and key are saved to `$XDG_CONFIG_HOME/sudo-sapient/config.json` (default `~/.config`), readable
only by you. `SUDO_URL` and `SUDO_API_KEY` override it (handy in CI), and `sudo-cli logout` deletes
it. Revoke the key itself in Settings → API.

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

Due dates: `today`, `tomorrow`, a weekday (`friday`, `fri`; today counts), `next week`, `+3d`, `+2w`, or
`2026-11-20`. Set `SUDO_PROJECT=WEB` to skip `-p`. Exit codes: `0` ok, `1` the API refused (the
message says why; with `--json` it's `{ error, code }` on stderr), `2` a usage error.

## License

UNLICENSED, all rights reserved. The package is public on npm so anyone can install and run it, but
no license to copy, modify or redistribute the code is granted.
