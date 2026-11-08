/* sudo-cli: argument parsing, everyday dates, and a happy path against the app in-process. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { account, apiKey, bot, setup } from '../../../test/server/helpers.js';
import { parseDue, run, sameOrigin } from '../src/cli.js';
import { safeFileName } from '../src/commands.js';
import { plainHttpRemote } from '@sudosapient/client';
import { saveConfig } from '@sudosapient/client/config';

/* Runs the CLI with captured output and its own config directory. */
function cli(t, env = {}, extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sudo-cli-'));
  return async (...argv) => {
    let out = '',
      err = '';
    // A trailing { stdin: '…' } is piped in.
    const input = typeof argv.at(-1) === 'object' ? argv.pop().stdin : '';
    const code = await run(argv, {
      env: { XDG_CONFIG_HOME: home, NO_COLOR: '1', ...env },
      stdout: { write: s => (out += s) },
      stderr: { write: s => (err += s) },
      stdin: {
        isTTY: false,
        async *[Symbol.asyncIterator]() {
          if (input) yield input;
        },
      },
      fetch: t ? (url, init) => t.app.request(url, init) : undefined,
      ...extra,
    });
    return { code, out, err, home };
  };
}

describe('arguments', () => {
  it('prints help, and refuses unknown commands, options and missing pieces with exit code 2', async () => {
    const c = cli();
    expect((await c('--help')).out).toMatch(/^sudo-cli: Sudo Sapient from the terminal/);
    expect((await c()).code).toBe(2);
    expect(await c('frobnicate')).toMatchObject({ code: 2, err: expect.stringContaining('Unknown command “frobnicate”') });
    expect(await c('tasks', '--bogus')).toMatchObject({ code: 2, err: expect.stringContaining("Unknown option '--bogus'") });
    expect(await c('new', 'Title', '-p', 'WEB')).toMatchObject({ code: 2, err: expect.stringContaining('Not logged in') });
    const logged = cli(null, { SUDO_URL: 'http://x.test', SUDO_API_KEY: 'ssk_x' });
    expect((await logged('new', 'Title')).err).toContain('-p <project key>');
    expect((await logged('new', '-p', 'WEB')).err).toContain('Give the task a title');
    expect((await logged('new', 'x', '-p', 'WEB', '--priority', 'meh')).err).toContain('Priority is one of');
    expect((await logged('new', 'x', '-p', 'WEB', '--due', 'someday')).err).toContain("Can't read the date “someday”");
    expect((await logged('assign', 'WEB-1')).code).toBe(2);
    expect((await c('--version')).out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('reads everyday due dates in local time', () => {
    const fri = new Date(2026, 10, 6, 15, 0); // Friday 6 November 2026
    expect(parseDue('today', fri)).toBe('2026-11-06');
    expect(parseDue('tomorrow', fri)).toBe('2026-11-07');
    expect(parseDue('friday', fri)).toBe('2026-11-06');
    expect(parseDue('mon', fri)).toBe('2026-11-09');
    expect(parseDue('+3d', fri)).toBe('2026-11-09');
    expect(parseDue('2w', fri)).toBe('2026-11-20');
    expect(parseDue('next week', fri)).toBe('2026-11-09');
    expect(parseDue('2027-01-31', fri)).toBe('2027-01-31');
  });

  it('treats only plain http to another machine as insecure', () => {
    for (const u of ['http://app.test', 'http://10.0.0.5:8787', 'http://sudo.example.com/']) expect(plainHttpRemote(u), u).toBe(true);
    for (const u of ['https://sudo.example.com', 'http://localhost:5173', 'http://127.0.0.1:8787', 'http://[::1]:8787', 'http://app.localhost'])
      expect(plainHttpRemote(u), u).toBe(false);
  });
});

describe('against a workspace', () => {
  it('logs in, captures, lists, comments, assigns, completes and opens, with --json for scripts', async () => {
    const t = setup();
    const ada = await account(t);
    await ada.c.sync([
      {
        c: 'projects',
        id: 'pweb',
        k: 'put',
        v: {
          id: 'pweb',
          key: 'WEB',
          name: 'Website',
          icon: 'globe',
          color: 'indigo',
          status: 'active',
          team: '',
          lead: null,
          members: [],
          desc: '',
          milestones: [],
        },
      },
    ]);
    const token = await apiKey(ada.c, { name: 'Laptop' });
    const c = cli(t);

    // Plain http to another machine would send the key in the clear: refused unless asked for.
    const refused = await c('login', { stdin: `http://app.test/\n${token}\n` });
    expect(refused).toMatchObject({ code: 2, err: expect.stringContaining('plain http') });
    expect(fs.existsSync(path.join(refused.home, 'sudo-sapient', 'config.json'))).toBe(false);
    expect((await cli(t, { SUDO_URL: 'http://app.test', SUDO_API_KEY: token })('whoami')).err).toContain('--insecure');

    // Both answers piped in, so the key stays out of argv and shell history.
    const login = await c('login', '--insecure', { stdin: `http://app.test/\n${token}\n` });
    expect(login).toMatchObject({ code: 0, out: expect.stringContaining('as Ada Owner (write key “Laptop”)') });
    const file = path.join(login.home, 'sudo-sapient', 'config.json');
    // The consent is saved with the URL, so later commands don't need --insecure.
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ url: 'http://app.test', key: token, insecure: true });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    const made = await c('new', 'Fix', 'login', 'bug', '-p', 'web', '--due', '2026-11-20', '-a', 'me', '--priority', 'high');
    expect(made.out).toMatch(/^Created WEB-201 Fix login bug · due 2026-11-20\nhttp:\/\/app\.test\/#task\/WEB-201/);
    await c('tasks', 'new', 'Second', '-p', 'WEB');

    const mine = await c('tasks');
    expect(mine.out.trim().split('\n')).toEqual([expect.stringMatching(/^WEB-201\s+todo\s+high\s+Ada Owner\s+2026-11-20 Fix login bug$/)]);
    const all = JSON.parse((await c('tasks', 'list', '-p', 'WEB', '--json')).out);
    expect(all.map(x => x.key)).toEqual(['WEB-202', 'WEB-201']);

    expect((await c('comment', 'WEB-201', 'On', 'it')).out).toBe('Commented on WEB-201\n');
    expect((await c('assign', 'WEB-202', 'ada@example.com')).out).toBe('Assigned WEB-202 to Ada Owner\n');
    expect((await c('tasks', 'assign', 'WEB-202', 'none')).out).toBe('Unassigned WEB-202\n');
    expect((await c('done', 'WEB-201')).out).toBe('Done WEB-201 Fix login bug\n');
    const shown = await c('show', 'WEB-201');
    expect(shown.out).toContain('WEB-201 Fix login bug\ndone · high · Ada Owner · due 2026-11-20');
    expect(shown.out).toContain('Ada Owner');
    expect((await c('open', 'WEB-201', '--print')).out).toBe('http://app.test/#task/WEB-201\n');
    expect((await c('open', 'web', '--print')).out).toBe('http://app.test/#project/web\n');
    expect((await c('projects')).out).toMatch(/^WEB\s+Website\s+1 open · 1 done/);

    // Every step is in the activity log as "Ada via CLI".
    const log = t.db
      .all("SELECT json_extract(data, '$.verb') verb, json_extract(data, '$.via') via FROM activity ORDER BY created_at")
      .map(r => `${r.verb}/${r.via}`);
    expect(log).toEqual(['created/CLI', 'created/CLI', 'commented on/CLI', 'assigned/CLI', 'assigned/CLI', 'completed/CLI']);

    // Text from the workspace can't drive the terminal (an OSC 52 clipboard write, a colour reset).
    await c('new', 'Evil\x1b]52;c;cHduZWQ=\x07 title\x1b[2J', '-p', 'WEB');
    const listed = (await c('tasks', '-p', 'WEB')).out;
    expect(listed).toContain('Evil]52;c;cHduZWQ= title[2J');
    expect(listed).not.toContain('\x1b');
    expect(listed).not.toContain('\x07');
    expect(JSON.parse((await c('show', 'WEB-203', '--json')).out).title).toContain('\x1b');
    // The same goes for comments, which `show` reads through the client's newest-first helper.
    await c('comment', 'WEB-203', 'Sneaky\x1b]52;c;cHduZWQ=\x07 note\x1b[2J');
    const commented = (await c('show', 'WEB-203')).out;
    expect(commented).toContain('Sneaky]52;c;cHduZWQ= note[2J');
    expect(commented).not.toContain('\x1b');
    expect(commented).not.toContain('\x07');

    const missing = await c('done', 'WEB-999', '--json');
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.err)).toMatchObject({ code: 'not_found' });

    expect((await c('logout')).code).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
    expect((await c('whoami')).err).toContain('Not logged in');
  });

  it('works unchanged with a bot’s key, as the bot', async () => {
    const t = setup();
    const ada = await account(t);
    const b = await bot(ada.c, { role: 'Member' });
    await ada.c.sync([
      {
        c: 'projects',
        id: 'pweb',
        k: 'put',
        v: {
          id: 'pweb',
          key: 'WEB',
          name: 'Website',
          icon: 'globe',
          color: 'indigo',
          status: 'active',
          team: '',
          lead: null,
          members: [],
          desc: '',
          milestones: [],
        },
      },
    ]);
    const c = cli(t, { SUDO_URL: 'http://localhost', SUDO_API_KEY: b.token });
    expect((await c('whoami')).out).toBe('Release Bot (bot) · Member in http://localhost · write key “GitHub Actions”\n');
    expect((await c('new', 'Release', '1.4', '-p', 'WEB')).out).toMatch(/^Created WEB-201 Release 1\.4/);
    expect(t.db.get("SELECT json_extract(data, '$.by') by, json_extract(data, '$.via') via FROM activity")).toEqual({ by: b.id, via: 'CLI' });
  });
});

describe('rate limits', () => {
  afterEach(() => vi.useRealTimers());

  it('waits out the rate limit in a bulk run instead of failing part of it', async () => {
    const t = setup({ DISABLE_RATE_LIMIT: 'false', API_RATE_LIMIT: '4' });
    const ada = await account(t);
    const project = { id: 'pweb', key: 'WEB', name: 'Website', icon: 'globe', color: 'indigo', status: 'active', team: '', lead: null, members: [], desc: '' };
    const tasks = Array.from({ length: 6 }, (_, i) => ({
      id: `t${i}`,
      key: `WEB-${201 + i}`,
      project: 'pweb',
      title: `Task ${i}`,
      status: 'todo',
      priority: 'none',
      labels: [],
      subtasks: [],
      attachments: [],
      deps: [],
      desc: '',
      created: 1,
      updated: 1,
      order: i,
    }));
    await ada.c.sync([{ c: 'projects', id: 'pweb', k: 'put', v: { ...project, milestones: [] } }, ...tasks.map(v => ({ c: 'tasks', id: v.id, k: 'put', v }))]);
    const token = await apiKey(ada.c);
    // The limiter counts per minute of wall time: "waiting" moves the clock on instead.
    vi.useFakeTimers({ toFake: ['Date'] });
    const waited = [];
    const sleep = async ms => {
      waited.push(ms);
      vi.setSystemTime(Date.now() + ms);
    };
    const c = cli(t, { SUDO_URL: 'http://localhost', SUDO_API_KEY: token }, { sleep });
    const r = await c('done', ...tasks.map(x => x.key));
    expect(r.code).toBe(0);
    expect(r.out.trim().split('\n')).toHaveLength(6);
    expect(r.err).toMatch(/^sudo-cli: rate limited; retrying in \d+ s…$/m);
    expect(waited.length).toBeGreaterThan(0);
    expect(t.db.get("SELECT COUNT(*) n FROM tasks WHERE json_extract(data, '$.status') = 'done'").n).toBe(6);
  });
});

describe('version', () => {
  it('matches package.json (release-please bumps both)', async () => {
    const { VERSION } = await import('../src/cli.js');
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(VERSION).toBe(pkg.version);
    const config = JSON.parse(fs.readFileSync(new URL('../../../release-please-config.json', import.meta.url), 'utf8'));
    expect(config.packages['packages/cli']['extra-files']).toContain('src/cli.js');
    expect(fs.readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8')).toMatch(/VERSION = '[^']+'; \/\/ x-release-please-version/);
  });
});

describe('output the server controls', () => {
  /* run() against a fake workspace that answers every request with `body` (and `status`). */
  async function against(body, status = 200, ...argv) {
    let out = '',
      err = '';
    const fetch = async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const code = await run(argv, {
      env: { SUDO_URL: 'https://sudo.example.com', SUDO_API_KEY: 'ssk_x', NO_COLOR: '1', XDG_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'sudo-cli-')) },
      stdout: { write: s => (out += s), isTTY: true },
      stderr: { write: s => (err += s) },
      fetch,
    });
    return { code, out, err };
  }

  it('opens only links on the workspace’s own origin', async () => {
    for (const url of [
      'https://evil.example/#task/WEB-1',
      'file:///etc/passwd',
      'http://sudo.example.com/#task/WEB-1',
      'https://sudo.example.com.evil.example/',
      '--help',
      'calc.exe',
    ]) {
      for (const flags of [['--print'], ['--json'], []]) {
        const r = await against({ key: 'WEB-1', url }, 200, 'open', 'WEB-1', ...flags);
        expect(r.code).toBe(1);
        expect(r.out).toBe('');
        expect(r.err).toContain('not opening it');
      }
    }
    expect(sameOrigin('https://sudo.example.com/#task/WEB-1', 'https://sudo.example.com')).toBe(true);
    expect((await against({ key: 'WEB-1', url: 'https://sudo.example.com/#task/WEB-1' }, 200, 'open', 'WEB-1', '--print')).out).toBe(
      'https://sudo.example.com/#task/WEB-1\n',
    );
  });

  it('strips control characters from error messages', async () => {
    const evil = { error: 'Nope\x1b]52;c;cm0gLXJmIH4=\x07\x1b[2J', code: 'forbidden\x1b[31m' };
    const plain = await against(evil, 403, 'whoami');
    expect(plain.code).toBe(1);
    expect(plain.err).toBe('sudo-cli: Nope]52;c;cm0gLXJmIH4=[2J\n');
    const json = await against(evil, 403, 'whoami', '--json');
    for (const bad of ['\x1b', '\\u001b', '\\u0007']) expect(json.err).not.toContain(bad);
    expect(JSON.parse(json.err)).toMatchObject({ error: 'Nope]52;c;cm0gLXJmIH4=[2J', code: 'forbidden[31m' });
  });
});

describe('credentials', () => {
  it('writes the config owner-only, through a fresh file, and tightens an existing directory', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sudo-cli-'));
    const dir = path.join(home, 'sudo-sapient');
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    // A config left world-readable by something else is replaced, not rewritten in place.
    fs.writeFileSync(path.join(dir, 'config.json'), '{}', { mode: 0o644 });
    fs.chmodSync(path.join(dir, 'config.json'), 0o644);
    const file = saveConfig({ url: 'https://sudo.example.com', key: 'ssk_secret' }, { XDG_CONFIG_HOME: home });
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).key).toBe('ssk_secret');
    expect(fs.readdirSync(dir)).toEqual(['config.json']);
  });

  it('warns when the key is given with --key', async () => {
    const r = await cli(null, { SUDO_URL: 'https://x.test' })('whoami', '--key', 'ssk_x', '--help');
    expect(r.err).toBe('');
    const used = await cli(null, { SUDO_URL: 'https://x.test' })('new', '--key', 'ssk_x', '-p', 'WEB');
    expect(used.err).toContain('--key leaves the key in your shell history');
  });

  it('logout --revoke revokes the key on the server too', async () => {
    const t = setup();
    const ada = await account(t);
    const token = await apiKey(ada.c, { name: 'Laptop' });
    const keep = await apiKey(ada.c, { name: 'Other' });
    const c = cli(t);
    await c('login', '--insecure', { stdin: `http://app.test/\n${token}\n` });
    const r = await c('logout', '--revoke');
    expect(r).toMatchObject({ code: 0, out: expect.stringContaining('The key is revoked.') });
    expect((await ada.c.get('/api/keys')).body.map(k => k.name)).toEqual(['Other']);
    expect((await cli(t, { SUDO_URL: 'http://app.test', SUDO_API_KEY: token })('whoami', '--insecure')).code).toBe(1);
    // Without --revoke (and with no terminal to ask at), the key is kept.
    await c('login', '--insecure', { stdin: `http://app.test/\n${keep}\n` });
    expect((await c('logout')).out).toContain('The key still works');
    expect((await ada.c.get('/api/keys')).body.map(k => k.name)).toEqual(['Other']);
  });
});

/* Ada (Owner) and Bob (Member), the project WEB, and a CLI for each with a write key. `stdin` is
   never a terminal here. */
async function team() {
  const t = setup();
  const ada = await account(t);
  await ada.c.sync([
    {
      c: 'members',
      id: 'mbob',
      k: 'put',
      v: { id: 'mbob', name: 'Bob Lee', email: 'bob@example.com', role: 'Member', team: '', title: '', c: '#6B7280', status: 'invited', tz: '' },
    },
  ]);
  const bob = await account(t, { name: 'Bob Lee', email: 'bob@example.com', invite: t.lastLink('bob@example.com').split('#invite/')[1] });
  const project = {
    id: 'pweb',
    key: 'WEB',
    name: 'Website',
    icon: 'globe',
    color: 'indigo',
    status: 'active',
    team: '',
    lead: null,
    members: [],
    desc: '',
    milestones: [],
  };
  await ada.c.sync([{ c: 'projects', id: 'pweb', k: 'put', v: project }]);
  const as = token => cli(t, { SUDO_URL: 'http://localhost', SUDO_API_KEY: token });
  const adaToken = await apiKey(ada.c);
  return {
    t,
    ada: as(adaToken),
    adaToken,
    bob: as(await apiKey(bob.c)),
    adaId: ada.user.id,
    adaSession: ada.c,
    adaReadOnly: as(await apiKey(ada.c, { scope: 'read' })),
  };
}
const J = r => JSON.parse(r.out);

describe('every noun', () => {
  it('tasks: edit, subtasks, comments and reactions, archive, duplicate, delete and undelete', async () => {
    const { t, ada } = await team();
    await ada('new', 'Design', '-p', 'WEB');
    await ada('new', 'Build', '-p', 'WEB');
    const ed = await ada(
      'tasks',
      'edit',
      'WEB-202',
      '--title',
      'Build it',
      '-s',
      'progress',
      '--label',
      'frontend',
      '--label',
      'bug,qa',
      '--repeat',
      'weekly',
      '--due',
      '2026-11-20',
      '--depends',
      'WEB-201',
      '--estimate',
      '3h',
    );
    expect(ed).toMatchObject({ code: 0, out: 'Updated WEB-202 Build it\n' });
    expect(J(await ada('show', 'WEB-202', '--json'))).toMatchObject({
      status: 'progress',
      labels: ['frontend', 'bug', 'qa'],
      recurrence: 'Weekly',
      estimate: '3h',
      due: '2026-11-20',
    });
    expect(J(await ada('tasks', 'edit', 'WEB-202', '--repeat', 'none', '--due', 'none', '--depends', 'none', '--json'))).toMatchObject({
      recurrence: null,
      due: null,
      dependsOn: [],
    });
    expect(await ada('tasks', 'edit', 'WEB-202')).toMatchObject({ code: 2, err: expect.stringContaining('Nothing to change') });
    expect((await ada('tasks', 'edit', 'WEB-202', '-s', 'finished')).code).toBe(2);

    const added = await ada('subtask', 'add', 'WEB-202', 'Write', 'tests', '-a', 'Bob Lee');
    const sid = /\((s[^)]+)\)/.exec(added.out)[1];
    expect(added.out).toMatch(/^Added “Write tests” to WEB-202/);
    expect((await ada('subtask', 'done', 'WEB-202', sid)).out).toBe('Done “Write tests” on WEB-202\n');
    const shown = (await ada('show', 'WEB-202')).out;
    expect(shown).toContain(`  [x] Write tests · Bob Lee  ${sid}`);
    expect((await ada('subtask', 'promote', 'WEB-202', sid)).out).toMatch(/^Converted to WEB-203 Write tests/);

    await ada('comment', 'WEB-202', 'First');
    const cid = J(await ada('show', 'WEB-202', '--json')).comments[0].id;
    expect((await ada('show', 'WEB-202')).out).toContain(cid);
    expect((await ada('comment', 'edit', cid, 'First!')).out).toBe('Comment updated\n');
    expect((await ada('react', cid, 'thumbsup')).out).toBe('Reacted 👍\n');
    expect((await ada('show', 'WEB-202')).out).toContain('First!\n👍1');
    expect((await ada('unreact', cid, '👍')).code).toBe(0);
    expect((await ada('react', cid, 'clown')).code).toBe(2);
    expect((await ada('comment', 'rm', cid)).out).toContain(`sudo-cli comment undelete ${cid}`);
    expect((await ada('comment', 'undelete', cid)).out).toBe('Comment restored\n');

    expect((await ada('tasks', 'archive', 'WEB-201')).out).toBe('Archived WEB-201 Design\n');
    expect(J(await ada('tasks', '-p', 'WEB', '--all', '--json')).map(x => x.key)).not.toContain('WEB-201');
    expect(J(await ada('tasks', 'list', '-p', 'WEB', '--all', '--archived', '--json')).map(x => x.key)).toContain('WEB-201');
    expect((await ada('tasks', 'restore', 'WEB-201')).out).toBe('Restored WEB-201 Design\n');
    expect((await ada('tasks', 'dup', 'WEB-201')).out).toMatch(/^Created WEB-204 Design \(copy\)/);
    expect((await ada('tasks', 'fav', 'WEB-201')).out).toBe('Starred WEB-201 Design\n');
    expect(J(await ada('favorites', '--json')).tasks).toHaveLength(1);
    expect((await ada('favorites')).out).toContain('WEB-201 Design');

    // Deleting a task doesn't ask (it can be undone for 10 minutes) and says how.
    const rm = await ada('tasks', 'rm', 'WEB-204');
    const id = /undelete (\S+)/.exec(rm.out)[1];
    expect(rm.out).toMatch(/^Deleted WEB-204\. Undo within 10 minutes: sudo-cli tasks undelete t/);
    expect((await ada('tasks', 'undelete', id)).out).toBe('Restored WEB-204 Design (copy)\n');
    expect(t.db.all("SELECT json_extract(data, '$.via') v FROM activity").every(r => r.v === 'CLI')).toBe(true);
  });

  it('show: the newest comments in time order, saying how many older ones it left out', async () => {
    const { ada, adaId, adaSession } = await team();
    await ada('new', 'Long', 'thread', '-p', 'WEB');
    const task = J(await ada('show', 'WEB-201', '--json'));
    const at = Date.now() - 60 * 60_000;
    const comments = (from, to) =>
      adaSession.sync(
        Array.from({ length: to - from + 1 }, (_, i) => {
          const n = from + i;
          return {
            c: 'comments',
            id: `clong${n}`,
            k: 'put',
            v: { id: `clong${n}`, task: task.id, by: adaId, at: at + n * 60_000, text: `Comment ${n}`, re: {} },
          };
        }),
      );
    await comments(1, 50);
    expect((await ada('show', 'WEB-201')).out).not.toContain('not shown');
    expect(J(await ada('show', 'WEB-201', '--json')).olderComments).toBe(0);
    await comments(51, 51);
    expect((await ada('show', 'WEB-201')).out).toContain('1 older comment not shown\n');

    await comments(52, 55);
    const out = (await ada('show', 'WEB-201')).out;
    expect(out).toContain('5 older comments not shown');
    expect(out).toContain('Comment 55');
    expect(out).not.toMatch(/Comment 5\n/);
    expect(out.indexOf('Comment 6\n')).toBeLessThan(out.indexOf('Comment 55'));
    const json = J(await ada('show', 'WEB-201', '--json'));
    expect(json.comments.map(c => c.text)).toEqual(Array.from({ length: 50 }, (_, i) => `Comment ${i + 6}`));
    expect(json.olderComments).toBe(5);
  });

  it('projects: new, show, edit, share, archive, duplicate, order; deleting asks first', async () => {
    const { t, ada, bob, adaId } = await team();
    const made = await bob(
      'projects',
      'new',
      'Mobile',
      'App',
      '--prefix',
      'MOB',
      '-d',
      'Apps',
      '--milestone',
      'Beta=2026-12-01',
      '--members',
      'ada@example.com',
      '--perm',
      'view',
    );
    expect(made.out).toMatch(/^Created MOB Mobile App\nhttp:\/\/app\.test\/#project\/mob/);
    expect((await bob('projects', 'edit', 'MOB', '-s', 'risk', '--private')).out).toBe('Updated MOB      Mobile App\n');
    const show = (await bob('projects', 'show', 'MOB')).out;
    expect(show).toContain('risk · lead Bob Lee · private · you: full');
    expect(show).toContain('People: Bob Lee (Full access), Ada Owner (Can view)');
    expect(show).toContain('◆ Beta 2026-12-01');
    expect((await bob('projects', 'share', 'MOB', 'ada@example.com', '--perm', 'edit')).out).toBe('Shared MOB with ada@example.com (Can edit)\n');
    expect(J(await bob('projects', 'show', 'MOB', '--json')).permissions).toMatchObject({ [adaId]: 'Can edit' });
    expect((await bob('projects', 'unshare', 'MOB', 'ada@example.com')).code).toBe(0);
    expect((await bob('projects', 'share', 'MOB', 'ada', '--perm', 'owner')).code).toBe(2);
    expect((await bob('projects', 'archive', 'MOB')).out).toMatch(/^Archived MOB/);
    expect((await bob('projects')).out).not.toContain('MOB');
    expect((await bob('projects', '--archived')).out).toContain('· archived');
    expect((await bob('projects', 'restore', 'MOB')).code).toBe(0);
    expect((await bob('projects', 'dup', 'MOB')).out).toMatch(/^Created MAC/);
    expect((await bob('projects', 'order', 'WEB', 'MOB')).out).toBe('Sidebar order saved\n');
    expect((await bob('projects', 'fav', 'WEB')).code).toBe(0);
    expect((await ada('projects', 'request-access', 'MOB')).out).toContain('Asked for access');

    // No terminal to ask at: --yes is required, and nothing is deleted without it.
    const refused = await bob('projects', 'rm', 'MOB');
    expect(refused).toMatchObject({ code: 2, err: expect.stringContaining('Pass --yes') });
    expect(t.db.get("SELECT COUNT(*) n FROM projects WHERE json_extract(data, '$.key') = 'MOB'").n).toBe(1);
    expect((await bob('projects', 'rm', 'MOB', '--yes')).out).toBe('Deleted MOB Mobile App\n');
    expect(t.db.get("SELECT COUNT(*) n FROM projects WHERE json_extract(data, '$.key') = 'MOB'").n).toBe(0);
  });

  it('teams, people, me, prefs, inbox, activity, events, views and search', async () => {
    const { ada, bob } = await team();
    expect((await ada('teams', 'new', 'Platform', '--members', 'Bob Lee')).out).toMatch(/^Created team Platform/);
    expect((await ada('teams')).out).toMatch(/^Platform\s+tm\S+\s+Bob Lee$/m);
    expect((await ada('teams', 'edit', 'platform', '-d', 'APIs', '--members', 'me,Bob Lee')).out).toBe('Updated team Platform\n');
    expect((await ada('teams', 'rm', 'Platform')).code).toBe(2);
    expect((await ada('teams', 'rm', 'Platform', '-y')).out).toBe('Deleted team Platform\n');

    const inv = await bob('people', 'invite', 'cara.diaz@example.com', '--title', 'Designer');
    expect(inv.out).toMatch(/^Invited Cara Diaz <cara\.diaz@example\.com> as Member/);
    expect(J(await bob('people', 'show', 'cara.diaz@example.com', '--json'))).toMatchObject({ status: 'invited', title: 'Designer' });
    expect((await bob('people', 'resend', 'cara.diaz@example.com')).out).toBe('Sent cara.diaz@example.com a new invite\n');
    expect((await bob('people')).out).toMatch(/Cara Diaz\s+cara\.diaz@example\.com\s+Member\s+Designer · invited/);
    expect((await bob('me', 'edit', '--title', 'Engineer')).out).toBe('Updated your profile: Bob Lee · Engineer\n');
    expect((await bob('me')).out).toContain('Bob Lee <bob@example.com> · Member');

    expect((await bob('prefs', 'set', 'theme=dark', 'weekStart=0', 'spell=off')).out).toBe('Preferences saved\n');
    expect(J(await bob('prefs', '--json'))).toMatchObject({ theme: 'dark', weekStart: 0, spell: false });
    expect((await bob('prefs', 'set', 'theme')).code).toBe(2);
    expect((await bob('notify-prefs', 'set', 'email_comment=on')).code).toBe(0);
    expect((await bob('notify-prefs')).out).toMatch(/^email_comment\s+on$/m);

    await ada('new', 'For Bob', '-p', 'WEB', '-a', 'bob@example.com');
    const inbox = await bob('inbox', '--unread');
    expect(inbox.out).toMatch(/^• .* Ada Owner assigned you/);
    const nid = J(await bob('inbox', '--json'))[0].id;
    expect((await bob('inbox', 'read', nid)).out).toBe('Marked read\n');
    expect((await bob('inbox', '--unread')).out).toBe('Nothing unread.\n');
    expect((await bob('inbox', 'read', '--all', '--json')).out).toContain('"updated": 0');
    expect((await bob('activity', '-p', 'WEB')).out).toMatch(/WEB\s+Ada Owner via CLI created/);

    expect((await bob('events', 'new', 'Launch', '--date', '2026-12-01', '--time', '09:30', '-p', 'WEB')).out).toMatch(/^Added Launch on 2026-12-01 at 09:30/);
    expect((await bob('events', 'new', 'All hands', '--date', '2026-12-02')).code).toBe(1);
    const eid = J(await bob('events', '--json'))[0].id;
    expect((await bob('events', 'edit', eid, '--time', 'none')).out).toBe('Updated Launch (2026-12-01)\n');
    expect((await bob('events', '--from', '2026-12-01', '--to', '2026-12-31')).out).toMatch(/^2026-12-01 all day Launch/);
    expect((await bob('events', 'rm', eid)).code).toBe(0);

    expect((await bob('views', 'new', 'Urgent', '-p', 'WEB', '--type', 'board', '--filter', 'priority=urgent,high', '--filter', 'assignee!=mbob')).out).toMatch(
      /^Saved view Urgent/,
    );
    expect((await bob('views')).out).toMatch(/^Urgent\s+board\s+priority=urgent,high assignee!=mbob/);
    const vid = J(await bob('views', '--json'))[0].id;
    expect((await bob('views', 'edit', vid, '--filter', 'none')).code).toBe(0);
    expect((await bob('views', 'new', 'Bad', '-p', 'WEB', '--filter', 'colour=red')).code).toBe(2);
    expect((await bob('views', 'rm', vid)).code).toBe(0);
    expect((await bob('search', 'For', 'Bob')).out).toMatch(/^WEB-201/);
    expect((await bob('teams', 'frobnicate')).code).toBe(2);
  });

  it('admin commands follow the key’s person: an Owner’s key may, a Member’s is refused', async () => {
    const { ada, bob } = await team();
    const w = await bob('workspace', 'edit', '--name', 'Renamed');
    expect(w).toMatchObject({ code: 1, err: expect.stringContaining('Only owners and admins can do this') });
    expect((await ada('workspace', 'edit', '--name', 'Renamed', '--brand', 'on')).out).toBe('Updated the workspace: Renamed\n');
    expect((await bob('workspace')).out).toMatch(/^Renamed · #\w+ · logo in the sidebar/);
    expect((await ada('workspace', 'invite-link')).out).toMatch(/#join\//);
    expect((await bob('people', 'role', 'Ada Owner', 'Member')).code).toBe(1);
    expect((await ada('people', 'role', 'Bob Lee', 'Admin')).out).toBe('Bob Lee is now Admin\n');
    expect((await ada('people', 'role', 'Bob Lee', 'Boss')).code).toBe(2);
    expect((await ada('people', 'role', 'Bob Lee', 'Member')).out).toBe('Bob Lee is now Member\n');

    expect((await bob('bots')).err).toContain('Only owners and admins');
    expect((await ada('bots', 'new', 'Release', 'Bot', '--projects', 'WEB')).out).toMatch(/^Created bot Release Bot/);
    expect((await ada('bots', 'edit', 'release bot', '--role', 'Guest')).code).toBe(0);
    expect((await ada('bots')).out).toMatch(/^Release Bot\s+Guest\s+1 projects · 0 keys/);
    expect((await ada('bots', 'rm', 'Release Bot')).code).toBe(2);
    expect((await ada('bots', 'rm', 'Release Bot', '--yes')).out).toBe('Removed bot Release Bot\n');

    expect((await ada('people', 'rm', 'bob@example.com')).code).toBe(2);
    expect((await ada('people', 'rm', 'bob@example.com', '--yes')).out).toBe('Removed Bob Lee\n');
    expect((await bob('whoami')).code).toBe(1);
  });

  it('files: upload, download (never overwriting without --force), attach, copy, delete', async () => {
    const { ada } = await team();
    await ada('new', 'Spec', '-p', 'WEB');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sudo-cli-files-'));
    const bytes = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 251));
    fs.writeFileSync(path.join(dir, 'spec.pdf'), bytes);
    const up = await ada('files', 'upload', path.join(dir, 'spec.pdf'), '--task', 'WEB-201');
    expect(up.out).toMatch(/^Uploaded spec\.pdf \(293 KB\) f/);
    const f = J(await ada('files', '--task', 'WEB-201', '--json'))[0];
    expect(f).toMatchObject({ name: 'spec.pdf', type: 'pdf' });

    const out = path.join(dir, 'copy.pdf');
    expect((await ada('files', 'download', f.id, '-o', out)).out).toBe(`Saved ${out} (300000 bytes)\n`);
    expect(Buffer.compare(fs.readFileSync(out), bytes)).toBe(0);
    expect(await ada('files', 'download', f.id, '-o', out)).toMatchObject({ code: 2, err: expect.stringContaining('already exists. Pass --force') });
    fs.writeFileSync(out, 'changed');
    expect((await ada('files', 'download', f.id, '-o', out, '--force')).code).toBe(0);
    expect(Buffer.compare(fs.readFileSync(out), bytes)).toBe(0);

    expect((await ada('files', 'rename', f.id, 'spec', 'v2.pdf')).out).toBe('Renamed to spec v2.pdf\n');
    expect((await ada('files', 'detach', f.id)).out).toBe('Detached spec v2.pdf\n');
    expect((await ada('files', 'attach', f.id, 'web-201')).out).toBe('Attached spec v2.pdf to WEB-201\n');
    expect((await ada('files', 'dup', f.id)).out).toMatch(/^Copied to spec v2 copy\.pdf/);
    expect((await ada('files', 'upload', path.join(dir, 'missing.txt'), '-p', 'WEB')).code).toBe(2);
    expect((await ada('files', 'upload', path.join(dir, 'spec.pdf'))).code).toBe(2);
    expect((await ada('files', 'rm', f.id)).code).toBe(2);
    expect((await ada('files', 'rm', f.id, '--yes')).out).toBe('Deleted spec v2.pdf\n');
    expect(J(await ada('files', '--json'))).toHaveLength(1);
  });

  it('downloads to the file’s own name, made safe, in the working directory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sudo-cli-dl-'));
    const fetch = async () =>
      new Response(Buffer.from('payload'), {
        status: 200,
        headers: { 'content-type': 'text/plain', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent('../../etc/\x1bpasswd')}` },
      });
    const io = {
      env: { SUDO_URL: 'https://sudo.example.com', SUDO_API_KEY: 'ssk_x', NO_COLOR: '1', XDG_CONFIG_HOME: dir },
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      fetch,
      cwd: dir,
    };
    expect(await run(['files', 'download', 'f1'], io)).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'passwd'), 'utf8')).toBe('payload');
    expect(safeFileName('..')).toBe('download');
    expect(safeFileName('a\\b\\c.txt')).toBe('c.txt');
    expect(safeFileName('')).toBe('download');
  });

  it('api: any endpoint, with fields or a JSON body', async () => {
    const { ada } = await team();
    expect(J(await ada('api', 'GET', '/me')).name).toBe('Ada Owner');
    const made = J(await ada('api', 'post', '/tasks', '-f', 'project=WEB', '-f', 'title=Raw', '-F', 'labels=["bug"]'));
    expect(made).toMatchObject({ key: 'WEB-201', labels: ['bug'] });
    expect(J(await ada('api', 'PATCH', '/api/v1/tasks/WEB-201', '--data', '{"priority":"high"}')).priority).toBe('high');
    expect(J(await ada('api', 'GET', '/tasks?project=WEB', '-f', 'status=todo')).data).toHaveLength(1);
    expect(J(await ada('api', 'DELETE', '/tasks/WEB-201')).deleted).toBe(true);
    expect((await ada('api', 'FETCH', '/me')).code).toBe(2);
    expect((await ada('api', 'POST', '/tasks', '--data', '{nope')).code).toBe(2);
    expect((await ada('api', 'GET', '/nope')).code).toBe(1);
  });

  it('documents every subcommand under help <noun>', async () => {
    const c = cli();
    expect((await c('help', 'tasks')).out).toContain('sudo-cli tasks edit <KEY>');
    expect((await c('files', '--help')).out).toContain('files download <id>');
    expect((await c('help')).out).toMatch(/^sudo-cli: Sudo Sapient from the terminal/);
    expect((await c('--help')).out).toContain('api <METHOD> <path>');
  });
});

/* Several keys in one command: one request each, in order. The first failure stops the run, and the
   output says exactly what went through and what wasn't tried, so a retry doesn't redo any of it. */
describe('several keys at once', () => {
  const status = (t, key) => t.db.get("SELECT json_extract(data, '$.status') s FROM tasks WHERE json_extract(data, '$.key') = ?", key)?.s;
  const NO_TASK = 'No task with that id or key, or you can’t open it.';

  it('done: stops at a bad key, says what was done and what wasn’t tried, and exits 1', async () => {
    const { t, ada } = await team();
    for (const title of ['One', 'Two', 'Three']) await ada('new', title, '-p', 'WEB');
    const r = await ada('done', 'WEB-201', 'WEB-999', 'WEB-203');
    expect(r).toEqual(
      expect.objectContaining({
        code: 1,
        out: 'Done WEB-201 One\n',
        err: `sudo-cli: WEB-999: ${NO_TASK}\nsudo-cli: Stopped at WEB-999; 1 of 3 done (WEB-201). Not tried: WEB-203.\n`,
      }),
    );
    expect([status(t, 'WEB-201'), status(t, 'WEB-202'), status(t, 'WEB-203')]).toEqual(['done', 'todo', 'todo']);

    // --json: stdout is what went through, stderr one object saying the rest.
    const j = await ada('done', 'WEB-202', 'WEB-998', 'WEB-203', '--json');
    expect(j.code).toBe(1);
    expect(J(j).map(x => x.key)).toEqual(['WEB-202']);
    expect(JSON.parse(j.err)).toEqual({
      error: 'Stopped at WEB-998; 1 of 3 done (WEB-202). Not tried: WEB-203.',
      code: 'incomplete',
      done: ['WEB-202'],
      failed: { ref: 'WEB-998', code: 'not_found', error: NO_TASK },
      notTried: ['WEB-203'],
    });
    // All good is unchanged: exit 0, nothing on stderr.
    expect(await ada('done', 'WEB-201', 'WEB-203')).toMatchObject({ code: 0, out: 'Done WEB-201 One\nDone WEB-203 Three\n', err: '' });
  });

  it('tasks rm: prints the undo id of every task it deleted before the bad key', async () => {
    const { t, ada } = await team();
    for (const title of ['One', 'Two', 'Three']) await ada('new', title, '-p', 'WEB');
    const r = await ada('tasks', 'rm', 'WEB-201', 'WEB-202', 'WEB-999', 'WEB-203');
    expect(r.code).toBe(1);
    const ids = [...r.out.matchAll(/^Deleted (WEB-\d+)\. Undo within 10 minutes: sudo-cli tasks undelete (\S+)$/gm)].map(m => [m[1], m[2]]);
    expect(ids.map(([k]) => k)).toEqual(['WEB-201', 'WEB-202']);
    expect(r.err).toContain('sudo-cli: Stopped at WEB-999; 2 of 4 done (WEB-201, WEB-202). Not tried: WEB-203.');
    expect(status(t, 'WEB-203')).toBe('todo');
    for (const [k, id] of ids) expect((await ada('tasks', 'undelete', id)).out).toMatch(new RegExp(`^Restored ${k} `));

    const j = await ada('tasks', 'rm', 'WEB-201', 'WEB-998', '--json');
    expect(J(j)).toEqual([expect.objectContaining({ key: 'WEB-201', id: expect.any(String) })]);
    expect(JSON.parse(j.err)).toMatchObject({ done: ['WEB-201'], failed: { ref: 'WEB-998' } });
  });

  it('archive, restore, fav and inbox read: the same, through one helper', async () => {
    const { t, ada } = await team();
    for (const title of ['One', 'Two']) await ada('new', title, '-p', 'WEB');
    const a = await ada('tasks', 'archive', 'WEB-201', 'WEB-999', 'WEB-202');
    expect(a).toMatchObject({ code: 1, out: 'Archived WEB-201 One\n' });
    expect(a.err).toContain('Stopped at WEB-999; 1 of 3 done (WEB-201). Not tried: WEB-202.');
    expect(t.db.get("SELECT COUNT(*) n FROM tasks WHERE json_extract(data, '$.archived') = 1").n).toBe(1);
    const re = await ada('tasks', 'restore', 'WEB-201', 'WEB-999');
    expect(re).toMatchObject({ code: 1, out: 'Restored WEB-201 One\n', err: expect.stringContaining('Stopped at WEB-999; 1 of 2 done (WEB-201).') });
    const fav = await ada('tasks', 'fav', 'WEB-999', 'WEB-201');
    expect(fav).toMatchObject({ code: 1, out: '', err: expect.stringContaining('Stopped at WEB-999; 0 of 2 done. Not tried: WEB-201.') });
    const r = await ada('inbox', 'read', 'n_missing_1', 'n_missing_2');
    expect(r).toMatchObject({ code: 1, out: '', err: expect.stringContaining('Stopped at n_missing_1; 0 of 2 done. Not tried: n_missing_2.') });
  });

  it('a read-only key stops at the first key; not logged in is still a usage error', async () => {
    const { t, ada, adaReadOnly } = await team();
    for (const title of ['One', 'Two', 'Three']) await ada('new', title, '-p', 'WEB');
    const r = await adaReadOnly('done', 'WEB-201', 'WEB-202', 'WEB-203');
    expect(r).toMatchObject({ code: 1, out: '' });
    expect(r.err).toMatch(/^sudo-cli: WEB-201: This API key is read-only\./);
    expect(r.err).toContain('Stopped at WEB-201; 0 of 3 done. Not tried: WEB-202, WEB-203.');
    expect(await cli(t)('tasks', 'rm', 'WEB-201', 'WEB-202')).toMatchObject({ code: 2, err: expect.stringContaining('Not logged in') });
  });

  it('says a key may have gone through when the connection dropped', async () => {
    const { t, ada, adaToken } = await team();
    for (const title of ['One', 'Two']) await ada('new', title, '-p', 'WEB');
    // The connection drops on the second request: the server may or may not have done it.
    let n = 0;
    const flaky = cli(
      t,
      { SUDO_URL: 'http://localhost', SUDO_API_KEY: adaToken },
      {
        fetch: (url, init) => {
          if (++n === 2) return Promise.reject(new TypeError('fetch failed'));
          return t.app.request(url, init);
        },
      },
    );
    const r = await flaky('done', 'WEB-201', 'WEB-202');
    expect(r).toMatchObject({ code: 1, out: 'Done WEB-201 One\n' });
    expect(r.err).toContain('WEB-202: Couldn’t reach Sudo Sapient. Check the URL and your connection. It may have gone through: check before retrying it.');
  });
});
