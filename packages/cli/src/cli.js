/* sudo-cli: Sudo Sapient from the terminal, over the public API (/api/v1) with a personal key.
   `run(argv, io)` returns the exit code; io carries env, output streams and fetch, so tests can run
   it without a terminal or a network. */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { ApiError, createClient, plainHttpRemote, seg } from '@sudosapient/client';
import { clearConfig, configPath, loadConfig, saveConfig } from '@sudosapient/client/config';
import { ALIASES, NOUNS, PRIORITIES, STATUSES, nounHelp, rawApi, reaction, several } from './commands.js';

// Kept equal to package.json by release-please (extra-files in release-please-config.json).
export const VERSION = '0.2.0'; // x-release-please-version

export const HELP = `sudo-cli: Sudo Sapient from the terminal

Usage
  sudo-cli login [--url <workspace url>]       asks for the key (or pipe it in)
  sudo-cli logout [--revoke]                   --revoke: also revoke the key on the server
  sudo-cli whoami
  sudo-cli tasks [list] [--mine] [-p <project>] [-s <status>] [--all] [-n <limit>]
  sudo-cli tasks new "<title>" -p <project> [--due <date>] [-a <who>] [--priority <p>] [-d <text>]
  sudo-cli tasks done <KEY>...
  sudo-cli tasks assign <KEY> <who>          who: me, a name, an email, or "none"
  sudo-cli tasks show <KEY>
  sudo-cli comment <KEY> "<text>"
  sudo-cli projects [list]
  sudo-cli open <KEY>                        opens a task or project in the browser (--print: just the URL)
  sudo-cli search "<text>"

More (sudo-cli help <command> lists each one's subcommands)
  tasks       edit, rm, undelete, archive, restore, dup, fav, unfav
  subtask     add, done, undo, edit, rm, promote
  comment     edit, rm, undelete;  react / unreact <comment id> <emoji>
  projects    show, new, edit, archive, restore, dup, rm, share, unshare, request-access, fav, unfav, order
  teams, people, bots, files, events, views, inbox, activity, workspace, me, prefs, notify-prefs, favorites
  api <METHOD> <path> [--data <json>] [-f key=value]... [-F key=value]...   any endpoint, JSON out

Shortcuts: new, done, assign, show (= tasks …). Dates: today, tomorrow, friday, +3d, +2w, 2026-11-20.
Deleting a project, person, bot, team or file asks first (--yes to skip; required without a
terminal). Deleted tasks and comments can be undeleted for 10 minutes, so they don't ask.
Options: --json (machine-readable output), --url, --insecure (allow a plain http:// URL to another
machine; login remembers it). The key comes from login, else SUDO_API_KEY; --key works too, but it
lands in your shell history and the process list, so prefer the prompt or the variable.
Create a key in Settings → API. Config: ${'$'}XDG_CONFIG_HOME/sudo-sapient/config.json.`;

const OPTIONS = {
  json: { type: 'boolean' },
  url: { type: 'string' },
  key: { type: 'string' },
  insecure: { type: 'boolean' },
  revoke: { type: 'boolean' },
  project: { type: 'string', short: 'p' },
  status: { type: 'string', short: 's' },
  assignee: { type: 'string', short: 'a' },
  due: { type: 'string' },
  priority: { type: 'string' },
  desc: { type: 'string', short: 'd' },
  limit: { type: 'string', short: 'n' },
  mine: { type: 'boolean' },
  all: { type: 'boolean' },
  print: { type: 'boolean' },
  archived: { type: 'boolean' },
  title: { type: 'string' },
  start: { type: 'string' },
  label: { type: 'string', multiple: true },
  repeat: { type: 'string' },
  estimate: { type: 'string' },
  depends: { type: 'string' },
  order: { type: 'string' },
  yes: { type: 'boolean', short: 'y' },
  force: { type: 'boolean' },
  output: { type: 'string', short: 'o' },
  task: { type: 'string' },
  perm: { type: 'string' },
  name: { type: 'string' },
  lead: { type: 'string' },
  team: { type: 'string' },
  private: { type: 'boolean' },
  public: { type: 'boolean' },
  milestone: { type: 'string', multiple: true },
  members: { type: 'string' },
  projects: { type: 'string' },
  role: { type: 'string' },
  color: { type: 'string' },
  icon: { type: 'string' },
  prefix: { type: 'string' },
  unread: { type: 'boolean' },
  from: { type: 'string' },
  to: { type: 'string' },
  date: { type: 'string' },
  time: { type: 'string' },
  type: { type: 'string' },
  filter: { type: 'string', multiple: true },
  brand: { type: 'string' },
  data: { type: 'string' },
  field: { type: 'string', short: 'F', multiple: true },
  'raw-field': { type: 'string', short: 'f', multiple: true },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

/* Everyday dates to YYYY-MM-DD, in local time. A weekday is its next occurrence (today counts). */
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
export function parseDue(s, now = new Date()) {
  const v = String(s).trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const inDays = n => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  if (v === 'today') return inDays(0);
  if (v === 'tomorrow') return inDays(1);
  const rel = /^\+?(\d{1,3})\s*(d|w)$/.exec(v);
  if (rel) return inDays(Number(rel[1]) * (rel[2] === 'w' ? 7 : 1));
  if (v === 'next week') return inDays((8 - now.getDay()) % 7 || 7);
  const day = DAYS.findIndex(n => n === v || n.slice(0, 3) === v);
  if (day >= 0) return inDays((day - now.getDay() + 7) % 7);
  throw new UsageError(`Can't read the date “${s}”. Try today, tomorrow, friday, +3d or 2026-11-20.`);
}

class UsageError extends Error {}

/* `link` is on the same site as the workspace (scheme, host and port), so nothing the server sends
   can make the CLI open some other page or program. */
export function sameOrigin(link, workspace) {
  try {
    return new URL(link).origin === new URL(workspace).origin;
  } catch {
    return false;
  }
}

/* Text from the workspace is printed to a terminal: drop control characters (escape sequences could
   rewrite the screen or the clipboard), keeping newlines and tabs. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
export const clean = v =>
  typeof v === 'string'
    ? v.replace(CONTROL, '')
    : Array.isArray(v)
      ? v.map(clean)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)]))
        : v;

export async function run(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const print = s => out.write(s + '\n');
  const color = !env.NO_COLOR && out.isTTY;
  const dim = s => (color ? `\x1b[2m${s}\x1b[0m` : s);
  const bold = s => (color ? `\x1b[1m${s}\x1b[0m` : s);

  let o, pos;
  try {
    ({ values: o, positionals: pos } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }));
  } catch (e) {
    err.write(`sudo-cli: ${e.message}\nRun sudo-cli --help for usage.\n`);
    return 2;
  }
  const noun = n => (NOUNS[n] ? n : ALIASES[n]);
  // `sudo-cli help tasks` and `sudo-cli tasks --help` list a command's subcommands.
  if (pos[0] === 'help' || (o.help && noun(pos[0]))) {
    const n = noun(pos[0] === 'help' ? pos[1] : pos[0]);
    print(n ? nounHelp(n) : HELP);
    return 0;
  }
  if (o.version || o.help || !pos.length) {
    print(o.version ? VERSION : HELP);
    return o.version || o.help ? 0 : 2;
  }

  // `tasks new …` and `new …` are the same command. Subcommands with a handler in commands.js
  // (`tasks edit`, `projects share`, `teams`, …) run from its table.
  let [cmd, ...args] = pos;
  let table = null;
  const verbOf = (n, v) => (NOUNS[n].verbs[v]?.run ? NOUNS[n].verbs[v] : null);
  const n0 = noun(cmd);
  if (n0 === 'tasks') {
    const sub = args[0];
    if (verbOf('tasks', sub)) table = { noun: 'tasks', verb: sub, args: args.slice(1) };
    else [cmd, ...args] = ['new', 'done', 'assign', 'show', 'list'].includes(sub) ? [sub === 'list' ? 'ls' : sub, ...args.slice(1)] : ['ls', ...args];
  } else if (n0 === 'projects') {
    if (verbOf('projects', args[0])) table = { noun: 'projects', verb: args[0], args: args.slice(1) };
    else [cmd, args] = ['projects', args[0] === 'list' ? args.slice(1) : args];
  } else if (n0 === 'comment') {
    if (verbOf('comment', args[0])) table = { noun: 'comment', verb: args[0], args: args.slice(1) };
    else cmd = 'comment';
  } else if (n0 === 'me' && !args.length) cmd = 'whoami';
  else if (n0) {
    const v = verbOf(n0, args[0]) ? args[0] : !args.length || args[0].startsWith('-') ? NOUNS[n0].default : null;
    if (!v || !verbOf(n0, v)) {
      err.write(`sudo-cli: Unknown command “${[cmd, args[0]].filter(Boolean).join(' ')}”. Run sudo-cli help ${n0}.\n`);
      return 2;
    }
    table = { noun: n0, verb: v, args: v === args[0] ? args.slice(1) : args };
  }

  const cfg = loadConfig(env);
  const url = (o.url || cfg.url || '').replace(/\/+$/, '');
  const key = o.key || cfg.key;
  if (o.key)
    err.write('sudo-cli: warning: --key leaves the key in your shell history and the process list. Prefer the prompt (sudo-cli login) or SUDO_API_KEY.\n');
  // The key goes in a header on every request: never in the clear to another machine unless asked.
  const insecureOk = o.insecure || (!o.url && cfg.insecure);
  const needSecure = (u, ok = insecureOk) => {
    if (plainHttpRemote(u) && !ok)
      throw new UsageError(`${u} is plain http, so your API key would cross the network unencrypted. Use https, or add --insecure if you mean it.`);
  };
  // The client waits out rate limits (Retry-After) by itself; say so, or a bulk run looks stuck.
  const rateLimited = ({ delay }) => err.write(`sudo-cli: rate limited; retrying in ${Math.ceil(delay / 1000)} s…\n`);
  const api = () => {
    if (!url || !key) throw new UsageError('Not logged in. Run: sudo-cli login --url https://your-workspace');
    needSecure(url);
    const a = createClient({ url, key, client: 'CLI', fetch: io.fetch, sleep: io.sleep, onRetry: rateLimited });
    // JSON output escapes control characters itself; human output gets them stripped.
    if (o.json) return a;
    const wrap =
      f =>
      async (...args) =>
        clean(await f(...args));
    return { ...a, get: wrap(a.get), post: wrap(a.post), patch: wrap(a.patch), put: wrap(a.put), del: wrap(a.del), upload: wrap(a.upload), all: wrap(a.all) };
  };
  const json = v => print(JSON.stringify(v, null, 2));
  const who = async a => new Map((await a.all('/members')).map(m => [m.id, m.name]));
  const pad = (s, n) => String(s ?? '').padEnd(n);
  const row = (t, names) =>
    `${bold(pad(t.key, 9))} ${pad(t.status, 8)} ${pad(t.priority === 'none' ? '' : t.priority, 6)} ${pad(names.get(t.assignee) || dim('—'), 14)} ${pad(t.due ? t.due.slice(0, 10) : '', 10)} ${t.title}`;
  const need = (v, msg) => {
    if (!v) throw new UsageError(msg);
    return v;
  };

  /* What commands.js handlers get. */
  const x = {
    o,
    io: { ...io, stdout: out },
    url,
    api,
    print,
    json,
    /* A line on stderr, and the same as one JSON object for --json. */
    warn: s => err.write(`sudo-cli: ${s}\n`),
    warnJson: v => err.write(JSON.stringify(clean(v)) + '\n'),
    clean,
    bold,
    dim,
    pad,
    need,
    names: who,
    usage: msg => {
      throw new UsageError(msg);
    },
    date: v => (/^none$/i.test(String(v)) ? null : parseDue(v)),
    emit: (data, human) => (o.json ? json(data) : human(data)),
    cancelled: () => (err.write('sudo-cli: cancelled.\n'), 1),
    /* A yes at the terminal, or --yes. Without a terminal to ask at, --yes is required. */
    async confirm(question) {
      if (o.yes) return true;
      if (!(io.stdin || process.stdin).isTTY) throw new UsageError(`${question} Pass --yes to go ahead (there's no terminal to ask at).`);
      return /^y(es)?$/i.test((await ask(io, `${question} [y/N] `)).trim());
    },
  };

  try {
    if (table) {
      x.args = table.args;
      return (await NOUNS[table.noun].verbs[table.verb].run(x)) || 0;
    }
    switch (cmd) {
      case 'login': {
        const u = (o.url || (await ask(io, `Workspace URL${cfg.url ? ` (${cfg.url})` : ''}: `)) || cfg.url || '').trim().replace(/\/+$/, '');
        need(/^https?:\/\//.test(u), 'Give the workspace URL, e.g. https://sudo.example.com');
        // Logging in again asks again: the saved consent was for the saved URL.
        needSecure(u, o.insecure);
        const k = (o.key || (await ask(io, 'API key (Settings → API): ', { hidden: true }))).trim();
        need(k, 'Paste an API key from Settings → API.');
        const me = clean(await createClient({ url: u, key: k, client: 'CLI', fetch: io.fetch, sleep: io.sleep, onRetry: rateLimited }).get('/me'));
        const file = saveConfig({ url: u, key: k, ...(o.insecure && plainHttpRemote(u) ? { insecure: true } : {}) }, env);
        if (o.json) json({ ok: true, user: me, config: file });
        else print(`Logged in to ${me.workspace || u} as ${me.name} (${me.key.scope} key “${me.key.name}”). Saved to ${file}`);
        return 0;
      }
      case 'logout': {
        // Revoke the key on the server too: when asked (--revoke), or after a yes at the terminal.
        const tty = (io.stdin || process.stdin).isTTY;
        const revoke =
          !!(url && key) &&
          (o.revoke ||
            (tty && !o.json && /^y(es)?$/i.test((await ask(io, 'Also revoke this key on the server, so it stops working everywhere? [y/N] ')).trim())));
        let revoked = false;
        if (revoke)
          try {
            await api().request('DELETE', '/me/key');
            revoked = true;
          } catch (e) {
            // Already revoked or expired: nothing left to do on the server.
            if (!(e instanceof ApiError && e.status === 401)) throw e;
            revoked = true;
          }
        clearConfig(env);
        if (o.json) json({ ok: true, revoked });
        else
          print(
            `Removed ${configPath(env)}.${revoked ? ' The key is revoked.' : ' The key still works until you revoke it in Settings → API (logout --revoke does both).'}`,
          );
        return 0;
      }
      case 'whoami': {
        const me = await api().get('/me');
        if (o.json) json(me);
        else
          print(`${me.name}${me.kind === 'bot' ? ' (bot)' : ` <${me.email}>`} · ${me.role} in ${me.workspace || url} · ${me.key.scope} key “${me.key.name}”`);
        return 0;
      }
      case 'ls': {
        const a = api();
        const project = o.project || env.SUDO_PROJECT;
        const mine = o.mine || !project;
        const status = o.status || (o.all ? undefined : 'open');
        const n = Math.min(Math.max(Number(o.limit) || 50, 1), 500);
        const query = { project, status, assignee: mine ? 'me' : undefined, ...(o.archived ? { includeArchived: 'true' } : {}) };
        const [tasks, names] = await Promise.all([a.all('/tasks', query, n), who(a)]);
        if (o.json) {
          json(tasks);
          return 0;
        }
        if (!tasks.length) print(dim(mine ? 'Nothing assigned to you here.' : 'No tasks.'));
        for (const t of tasks) print(row(t, names));
        return 0;
      }
      case 'new': {
        const title = need(args.join(' ').trim(), 'Give the task a title: sudo-cli new "Fix login bug" -p WEB');
        const project = need(o.project || env.SUDO_PROJECT, 'Say which project: -p <project key> (or set SUDO_PROJECT).');
        if (o.priority && !PRIORITIES.includes(o.priority)) throw new UsageError(`Priority is one of ${PRIORITIES.join(', ')}.`);
        if (o.status && !STATUSES.includes(o.status)) throw new UsageError(`Status is one of ${STATUSES.join(', ')}.`);
        const body = {
          project,
          title,
          ...(o.due ? { due: parseDue(o.due) } : {}),
          ...(o.assignee ? { assignee: o.assignee } : {}),
          ...(o.priority ? { priority: o.priority } : {}),
          ...(o.status ? { status: o.status } : {}),
          ...(o.desc ? { description: o.desc } : {}),
        };
        // Safe to retry: the server replays the first response for the same Idempotency-Key.
        const t = await api().post('/tasks', body, { idempotencyKey: randomUUID() });
        if (o.json) json(t);
        else print(`Created ${bold(t.key)} ${t.title}${t.due ? dim(` · due ${t.due.slice(0, 10)}`) : ''}\n${dim(t.url)}`);
        return 0;
      }
      case 'done': {
        need(args.length, 'Which task? sudo-cli done WEB-12');
        const a = api();
        return await several(
          x,
          args,
          k => a.post(`/tasks/${seg(k)}/complete`),
          t => `Done ${bold(t.key)} ${t.title}`,
        );
      }
      case 'assign': {
        const [k, ...rest] = args;
        const to = rest.join(' ').trim();
        need(k && to, 'sudo-cli assign WEB-12 <me | name | email | none>');
        const a = api();
        const t = await a.patch(`/tasks/${seg(k)}`, { assignee: to === 'none' ? null : to });
        if (o.json) {
          json(t);
          return 0;
        }
        const names = await who(a);
        print(t.assignee ? `Assigned ${bold(t.key)} to ${names.get(t.assignee)}` : `Unassigned ${bold(t.key)}`);
        return 0;
      }
      case 'show': {
        const k = need(args[0], 'Which task? sudo-cli show WEB-12');
        const a = api();
        const [t, comments, names] = await Promise.all([a.get(`/tasks/${seg(k)}`), a.get(`/tasks/${seg(k)}/comments`), who(a)]);
        if (o.json) {
          json({ ...t, comments: comments.data });
          return 0;
        }
        print(`${bold(t.key)} ${t.title}`);
        print(dim(`${t.status} · ${t.priority} · ${names.get(t.assignee) || 'unassigned'}${t.due ? ` · due ${t.due.slice(0, 10)}` : ''}`));
        if (t.description) print('\n' + t.description);
        for (const s of t.subtasks)
          print(
            `  [${s.done ? 'x' : ' '}] ${s.title}${s.assignee ? ` · ${names.get(s.assignee) || '?'}` : ''}${s.due ? ` · ${s.due.slice(0, 10)}` : ''}  ${dim(s.id)}`,
          );
        for (const c of comments.data)
          print(
            `\n${bold(names.get(c.author) || '?')} ${dim(new Date(c.createdAt).toLocaleString())}  ${dim(c.id)}\n${c.text}${Object.entries(c.reactions || {})
              .map(([e, w]) => ` ${e}${w.length}`)
              .join('')
              .replace(/^ /, '\n')}`,
          );
        print('\n' + dim(t.url));
        return 0;
      }
      case 'comment': {
        const [k, ...rest] = args;
        const text = rest.join(' ').trim();
        need(k && text, 'sudo-cli comment WEB-12 "Looks good"');
        const c = await api().post(`/tasks/${seg(k)}/comments`, { text }, { idempotencyKey: randomUUID() });
        if (o.json) json(c);
        else print(`Commented on ${bold(k.toUpperCase())}`);
        return 0;
      }
      case 'projects': {
        const ps = await api().all('/projects', o.archived ? { includeArchived: 'true' } : {});
        if (o.json) {
          json(ps);
          return 0;
        }
        for (const p of ps)
          print(
            `${bold(pad(p.key, 8))} ${pad(p.name, 28)} ${dim(`${p.openTasks} open · ${p.doneTasks} done${p.private ? ' · private' : ''}${p.archived ? ' · archived' : ''}`)}`,
          );
        return 0;
      }
      case 'open': {
        const k = need(args[0], 'What to open? sudo-cli open WEB-12');
        need(url, 'Not logged in. Run: sudo-cli login');
        // Keys look like WEB-12 (a task) or WEB (a project); resolve through the API so typos fail here.
        const target = /-\d+$/.test(k) ? (await api().get(`/tasks/${seg(k)}`)).url : (await api().get(`/projects/${seg(k)}`)).url;
        // The link comes from the server and goes to xdg-open / open / explorer, which would run or
        // open anything: only a page of the workspace itself is opened (or printed).
        if (!sameOrigin(target, url)) {
          err.write(`sudo-cli: the workspace answered with a link outside ${new URL(url).origin}; not opening it.\n`);
          return 1;
        }
        if (o.json) {
          json({ url: target });
          return 0;
        }
        if (o.print || !out.isTTY) {
          print(target);
          return 0;
        }
        const bin = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
        spawn(bin, [target], { stdio: 'ignore', detached: true })
          .on('error', () => print(target))
          .unref();
        return 0;
      }
      case 'react':
      case 'unreact': {
        const [id, e] = args;
        need(id && e, `sudo-cli ${cmd} <comment id> 👍  (comment ids are in sudo-cli show <KEY>)`);
        const path = `/comments/${seg(id)}/reactions/${seg(reaction(x, e))}`;
        const c = cmd === 'react' ? await api().put(path) : await api().del(path);
        x.emit(c, () => print(`${cmd === 'react' ? 'Reacted' : 'Took back'} ${reaction(x, e)}`));
        return 0;
      }
      case 'search': {
        const q = need(args.join(' ').trim(), 'What to search for? sudo-cli search "login bug"');
        const a = api();
        const [r, names] = await Promise.all([a.get('/search', { q }), who(a)]);
        if (o.json) {
          json(r);
          return 0;
        }
        for (const t of r.tasks) print(row(t, names));
        for (const p of r.projects) print(`${bold(pad(p.key, 9))} ${dim('project')}  ${p.name}`);
        for (const m of r.members) print(`${bold(pad(m.name, 22))} ${dim(m.email || m.kind)}`);
        if (!r.tasks.length && !r.projects.length && !r.members.length) print(dim('No matches.'));
        return 0;
      }
      case 'api':
        x.args = args;
        await rawApi(x);
        return 0;
      default:
        throw new UsageError(`Unknown command “${cmd}”. Run sudo-cli --help.`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      err.write(`sudo-cli: ${e.message}\n`);
      return 2;
    }
    if (e instanceof ApiError) {
      // The message is the server's text: stripped of control characters like everything else it sends.
      const msg = clean(e.message);
      if (o.json) err.write(JSON.stringify(clean({ error: msg, code: e.code, ...(e.field ? { field: e.field } : {}) })) + '\n');
      else err.write(`sudo-cli: ${msg}${e.status === 401 ? ' Run sudo-cli login.' : ''}\n`);
      return 1;
    }
    throw e;
  }
}

/* A line from the terminal (hidden for keys), or the next line of stdin when it's piped (read once,
   so `printf 'url\nkey' | sudo-cli login` answers both questions). */
const piped = new WeakMap();
async function ask(io, question, { hidden = false } = {}) {
  const input = io.stdin || process.stdin;
  const output = io.stderr || process.stderr;
  if (!input.isTTY) {
    if (!piped.has(input)) {
      let s = '';
      for await (const ch of input) s += ch;
      piped.set(input, s.split(/\r?\n/));
    }
    return piped.get(input).shift() || '';
  }
  const rl = readline.createInterface({ input, output, terminal: true });
  if (hidden) rl._writeToOutput = s => output.write(s.startsWith(question) ? question : s.includes('\n') ? '\n' : '');
  try {
    return await new Promise(resolve => rl.question(question, resolve));
  } finally {
    rl.close();
  }
}
