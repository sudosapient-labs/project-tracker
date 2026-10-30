import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { account, setup } from './helpers.js';

const project = {
  id: 'p1',
  key: 'WEB',
  name: 'Web',
  icon: 'globe',
  color: 'indigo',
  status: 'active',
  team: '',
  lead: null,
  members: [],
  desc: '',
  milestones: [],
};
const task = {
  id: 't1',
  key: 'WEB-201',
  project: 'p1',
  title: 'Hero',
  status: 'todo',
  assignee: null,
  priority: 'none',
  labels: [],
  subtasks: [],
  attachments: [],
  deps: [],
  desc: '',
  created: 1,
  updated: 1,
  order: 1,
};

async function withProject(env) {
  const t = setup(env);
  const { c } = await account(t);
  await c.sync([
    { c: 'projects', id: 'p1', k: 'put', v: project },
    { c: 'tasks', id: 't1', k: 'put', v: task },
  ]);
  return { t, c };
}

/* The JSON client helper sends JSON; uploads need the raw bytes as the body. */
async function rawUpload(t, c, q, bytes, type = 'image/png') {
  const res = await t.app.request(`/api/files?${new URLSearchParams(q)}`, {
    method: 'POST',
    headers: { 'x-requested-with': 'gr8r', 'content-type': type, cookie: c.cookie },
    body: bytes,
  });
  return { status: res.status, body: await res.json() };
}

describe('files', () => {
  it('uploads bytes, attaches them to a task, and serves them back to people with access', async () => {
    const { t, c } = await withProject();
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const r = await rawUpload(t, c, { project: 'p1', task: 't1', name: 'hero.png' }, png);
    expect(r.status).toBe(201);
    expect(r.body.file).toMatchObject({ name: 'hero.png', type: 'img', size: '16 B', project: 'p1', task: 't1' });
    expect(r.body.task.attachments).toEqual([expect.objectContaining({ id: r.body.file.id, name: 'hero.png', url: r.body.file.url })]);
    expect(r.body.activity).toMatchObject({ verb: 'added a file to', extra: 'hero.png' });

    const get = await t.app.request(r.body.file.url, { headers: { cookie: c.cookie } });
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toBe('image/png');
    expect(get.headers.get('content-disposition')).toMatch(/^inline/);
    expect(Buffer.from(await get.arrayBuffer())).toEqual(png);
    expect((await t.app.request(r.body.file.url)).status).toBe(401);

    const b = (await c.get('/api/bootstrap')).body.data;
    expect(b.files.map(f => f.id)).toEqual([r.body.file.id]);
    expect(b.tasks[0].attachments).toHaveLength(1);
  });

  it('downloads unknown types as attachments and rejects files over the limit', async () => {
    const { t, c } = await withProject({ MAX_UPLOAD_MB: '0.001' });
    const ok = await rawUpload(t, c, { project: 'p1', name: 'notes.html' }, Buffer.from('<script>alert(1)</script>'), 'text/html');
    const get = await t.app.request(ok.body.file.url, { headers: { cookie: c.cookie } });
    expect(get.headers.get('content-type')).toBe('application/octet-stream');
    expect(get.headers.get('content-disposition')).toMatch(/^attachment/);
    const big = await rawUpload(t, c, { project: 'p1', name: 'big.bin' }, Buffer.alloc(2048));
    expect(big.status).toBe(413);
  });

  it('copies share the stored bytes; renaming and deleting go through sync; bytes go when the last copy does', async () => {
    const { t, c } = await withProject();
    const r = await rawUpload(t, c, { project: 'p1', name: 'spec.pdf' }, Buffer.from('%PDF-1.4'), 'application/pdf');
    const f = r.body.file;
    const dup = await c.sync([{ c: 'files', id: 'fcopy', k: 'put', v: { ...f, id: 'fcopy', name: 'spec copy.pdf' } }]);
    expect(dup.body.results[0].v.url).toBe('/api/files/fcopy/spec%20copy.pdf');
    const ren = await c.sync([{ c: 'files', id: f.id, k: 'patch', v: { name: 'final.pdf', type: 'pdf' } }]);
    expect(ren.body.results[0].v.url).toBe(`/api/files/${f.id}/final.pdf`);
    // A file record can't be conjured without bytes behind it.
    expect((await c.sync([{ c: 'files', id: 'fake', k: 'put', v: { ...f, id: 'fake', url: '/api/files/nope/x' } }])).body.results[0].ok).toBe(false);

    const key = t.db.get('SELECT storage_key FROM files WHERE id = ?', f.id).storage_key;
    const disk = path.join(t.config.uploadDir, key);
    await c.sync([{ c: 'files', id: f.id, k: 'del' }]);
    expect(fs.existsSync(disk)).toBe(true);
    expect((await t.app.request('/api/files/fcopy/x', { headers: { cookie: c.cookie } })).status).toBe(200);
    await c.sync([{ c: 'files', id: 'fcopy', k: 'del' }]);
    await new Promise(r => setTimeout(r, 50));
    expect(fs.existsSync(disk)).toBe(false);
  });

  it('refuses uploads and downloads in projects the person cannot see', async () => {
    const { t, c } = await withProject();
    const f = (await rawUpload(t, c, { project: 'p1', name: 'a.txt' }, Buffer.from('x'), 'text/plain')).body.file;
    await c.sync([
      { c: 'projects', id: 'p1', k: 'patch', v: { private: true } },
      {
        c: 'members',
        id: 'mbob',
        k: 'put',
        v: { id: 'mbob', name: 'Bob', email: 'bob@example.com', role: 'Member', team: '', title: '', c: '#6B7280', status: 'invited', tz: '' },
      },
    ]);
    const bob = await account(t, { name: 'Bob', email: 'bob@example.com', invite: t.lastLink('bob@example.com').split('#invite/')[1] });
    expect((await rawUpload(t, bob.c, { project: 'p1', name: 'b.txt' }, Buffer.from('y'), 'text/plain')).status).toBe(403);
    expect((await t.app.request(f.url, { headers: { cookie: bob.c.cookie } })).status).toBe(404);
    expect((await t.app.request(f.url, { headers: { cookie: c.cookie } })).status).toBe(200);
  });
});
