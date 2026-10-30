import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { PW, setup } from './helpers.js';
import { loadConfig } from '../../server/config.js';
import { openDb } from '../../server/db.js';
import { createApp } from '../../server/app.js';
import { backup, backupDirOf, backupDue, backupUploads, listBackups } from '../../server/lib/backup.js';

describe('D21 health check', () => {
  it('answers 200 while the database works and 503 when it does not', async () => {
    const t = setup();
    expect((await t.client().get('/api/health')).body).toEqual({ ok: true });
    t.db.close();
    const r = await t.client().get('/api/health');
    expect(r.status).toBe(503);
    expect(r.body.ok).toBe(false);
  });
});

describe('D22 backups', () => {
  it('writes a consistent copy of the database and keeps only the newest N', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-bk-'));
    const db = openDb(path.join(dir, 'live.db'));
    db.run('INSERT INTO teams (id, data, created_at, updated_at) VALUES (\'t1\', \'{"name":"Ops"}\', 0, 0)');
    const out = path.join(dir, 'backups');
    expect(backupDue(out, 86_400_000)).toBe(true);
    const file = backup(db, out, 2, new Date('2026-10-01T03:00:00Z'));
    expect(path.basename(file)).toBe('sudo-sapient-20261001T030000Z.db');
    const copy = new DatabaseSync(file, { readOnly: true });
    expect(copy.prepare('SELECT data FROM teams').get().data).toBe('{"name":"Ops"}');
    copy.close();
    expect(backupDue(out, 86_400_000)).toBe(false);
    backup(db, out, 2, new Date('2026-10-02T03:00:00Z'));
    backup(db, out, 2, new Date('2026-10-03T03:00:00Z'));
    expect(listBackups(out)).toEqual(['sudo-sapient-20261002T030000Z.db', 'sudo-sapient-20261003T030000Z.db']);
    db.close();
  });
});

describe('D23 request logging', () => {
  it('logs method, path, status and time in production, without tokens, bodies or cookies', async () => {
    const lines = [];
    const config = loadConfig({ NODE_ENV: 'production', SERVE_STATIC: 'false', SETUP_TOKEN: 'x', DISABLE_RATE_LIMIT: 'true' });
    const { app } = createApp({ db: openDb(':memory:'), config, log: { info: l => lines.push(l), error() {} }, pushSend: async () => {} });
    await app.request('/api/health?secret=1', { headers: { cookie: 'ss_sid=abc' } });
    await app.request('/api/auth/reset/very-secret-token');
    await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'x-requested-with': 'sudo-sapient', 'content-type': 'application/json' },
      body: '{"password":"hunter22"}',
    });
    expect(lines[0]).toMatch(/^\[http\] GET \/api\/health 200 \d+ms$/);
    expect(lines[1]).toMatch(/^\[http\] GET \/api\/auth\/reset\/… 404 \d+ms$/);
    expect(lines.join('\n')).not.toMatch(/very-secret|hunter22|abc|secret=1/);
  });

  it('stays quiet outside production', async () => {
    const lines = [];
    const config = loadConfig({ NODE_ENV: 'test' });
    const { app } = createApp({ db: openDb(':memory:'), config, log: { info: l => lines.push(l), error() {} }, pushSend: async () => {} });
    await app.request('/api/health');
    expect(lines).toEqual([]);
  });
});

describe('D20 Dockerfile', () => {
  it('runs as node via the entrypoint, declares no VOLUME (Railway rejects it), and has a health check', () => {
    const f = fs.readFileSync('Dockerfile', 'utf8');
    expect(f).toMatch(/chown -R node:node \/data/);
    expect(f).not.toMatch(/^VOLUME/m);
    expect(f).toMatch(/ENTRYPOINT \["docker-entrypoint.sh"\]/);
    expect(fs.readFileSync('docker-entrypoint.sh', 'utf8')).toMatch(/setpriv --reuid=node/);
    expect(f).toMatch(/HEALTHCHECK[\s\S]*\/api\/health/);
  });
});

describe('Ops: backups include uploads and work without pnpm', () => {
  it('mirrors new uploaded files into the backup set and skips ones already copied', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-bku-'));
    const up = path.join(root, 'uploads');
    fs.mkdirSync(path.join(up, 'ab'), { recursive: true });
    fs.writeFileSync(path.join(up, 'ab', 'babc1'), 'one');
    fs.writeFileSync(path.join(up, 'ab', 'babc2.part'), 'half-written');
    const out = path.join(root, 'backups');
    expect(backupUploads(up, out)).toBe(1);
    expect(fs.readFileSync(path.join(out, 'uploads', 'ab', 'babc1'), 'utf8')).toBe('one');
    expect(fs.existsSync(path.join(out, 'uploads', 'ab', 'babc2.part'))).toBe(false);
    fs.writeFileSync(path.join(up, 'ab', 'babc3'), 'three');
    expect(backupUploads(up, out)).toBe(1);
    expect(backupUploads(up, out)).toBe(0);
  });

  it('`node server/scripts/backup.js` defaults to `backups` next to the database, and copies uploads', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-bks-'));
    const dbPath = path.join(root, 'data', 'sudo-sapient.db');
    openDb(dbPath).close();
    fs.mkdirSync(path.join(root, 'up', 'cd'), { recursive: true });
    fs.writeFileSync(path.join(root, 'up', 'cd', 'bcd1'), 'file');
    const out = execFileSync(process.execPath, ['server/scripts/backup.js'], {
      env: { PATH: process.env.PATH, DATABASE_PATH: dbPath, UPLOAD_DIR: path.join(root, 'up') },
      encoding: 'utf8',
    });
    const dir = path.join(root, 'data', 'backups');
    expect(out).toContain(dir);
    expect(listBackups(dir)).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, 'uploads', 'cd', 'bcd1'), 'utf8')).toBe('file');
    expect(backupDirOf(loadConfig({ BACKUP_DIR: '/backups', DATABASE_PATH: dbPath }))).toBe('/backups');
  });

  it('the image has a node-owned /backups for a separate mount, and keeps .env files out of the build', () => {
    expect(fs.readFileSync('Dockerfile', 'utf8')).toMatch(/mkdir -p [^\n]*\/backups && chown -R node:node [^\n]*\/backups/);
    const ignore = fs.readFileSync('.dockerignore', 'utf8').split('\n');
    expect(ignore).toEqual(expect.arrayContaining(['.env', '.env.*']));
  });
});

describe('L12 shutdown', () => {
  it('closes live-update streams, stops, and closes the database instead of being forced out', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-stop-'));
    const port = 20000 + Math.floor(Math.random() * 20000);
    const proc = spawn(process.execPath, ['server/index.js'], {
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        PORT: String(port),
        DATABASE_PATH: path.join(root, 'db.sqlite'),
        UPLOAD_DIR: path.join(root, 'up'),
        DISABLE_RATE_LIMIT: 'true',
      },
    });
    let out = '';
    proc.stdout.on('data', d => (out += d));
    proc.stderr.on('data', d => (out += d));
    try {
      await waitFor(() => out.includes('listening'));
      const base = `http://127.0.0.1:${port}`;
      const signup = await fetch(`${base}/api/auth/signup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'sudo-sapient' },
        body: JSON.stringify({ name: 'Ada', email: 'ada@example.com', password: PW }),
      });
      const cookie = signup.headers
        .getSetCookie()
        .find(c => c.startsWith('ss_sid='))
        .split(';')[0];
      const verify = new DatabaseSync(path.join(root, 'db.sqlite'));
      verify.exec('UPDATE users SET email_verified_at = 1');
      verify.close();
      const sse = await fetch(`${base}/api/events`, { headers: { cookie } });
      const reader = sse.body.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('hello');

      const started = Date.now();
      const exited = new Promise(r => proc.on('exit', code => r(code)));
      proc.kill('SIGTERM');
      expect(await exited).toBe(0);
      expect(Date.now() - started).toBeLessThan(2500);
      expect(out).toContain('[api] stopped');
      expect(out).not.toContain('timed out');
    } finally {
      if (proc.exitCode == null) proc.kill('SIGKILL');
    }
  }, 20_000);
});

async function waitFor(fn, ms = 10_000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise(r => setTimeout(r, 50));
  }
}
