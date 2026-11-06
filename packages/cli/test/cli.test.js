/* sudo-cli: argument parsing, everyday dates, and a happy path against the app in-process. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { account, apiKey, bot, setup } from '../../../test/server/helpers.js';
import { parseDue, run, sameOrigin } from '../src/cli.js';
import { plainHttpRemote } from '@sudosapient/client';

/* Runs the CLI with captured output and its own config directory. */
function cli(t, env = {}) {
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
