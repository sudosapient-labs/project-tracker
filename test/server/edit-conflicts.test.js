/* Two people editing a task's description at once: a description is only written over the one its
   writer started from, so neither person's text is silently replaced. */
import { describe, expect, it } from 'vitest';
import { account, setup } from './helpers.js';

const project = id => ({
  id,
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
});
const task = (id, pid, extra = {}) => ({
  id,
  key: 'WEB-201',
  project: pid,
  title: 'Write copy',
  status: 'todo',
  assignee: null,
  priority: 'medium',
  labels: [],
  subtasks: [],
  attachments: [],
  deps: [],
  desc: '',
  created: 1,
  updated: 1,
  order: 1,
  ...extra,
});
const put = (c, v) => ({ c, id: v.id, k: 'put', v });
/* A description edit as the app sends it: with the description it started from. */
const descEdit = (id, desc, from, extra = {}) => ({ c: 'tasks', id, k: 'patch', v: { desc, updated: Date.now(), ...extra }, base: { desc: from } });

async function pair() {
  const t = setup();
  const ada = await account(t);
  await ada.c.sync([
    put('members', { id: 'mbob', name: 'Bob', email: 'bob@example.com', role: 'Member', team: '', title: '', c: '#6B7280', status: 'invited', tz: '' }),
  ]);
  const bob = await account(t, { name: 'Bob', email: 'bob@example.com', invite: t.lastLink('bob@example.com').split('#invite/')[1] });
  await ada.c.sync([put('projects', project('p1')), put('tasks', task('t1', 'p1', { desc: '<p>First draft</p>' }))]);
  return { t, ada: ada.c, bob: bob.c };
}

describe('task descriptions written from a description that has since changed', () => {
  it('are refused with desc_conflict, keeping the one saved meanwhile', async () => {
    const { t, ada, bob } = await pair();
    expect((await ada.sync([descEdit('t1', '<p>Ada’s draft</p>', '<p>First draft</p>')])).body.results[0].ok).toBe(true);
    // Bob was still editing the first draft.
    const r = (await bob.sync([descEdit('t1', '<p>Bob’s draft</p>', '<p>First draft</p>')])).body.results[0];
    expect(r).toMatchObject({ ok: false, status: 409, code: 'desc_conflict' });
    expect(r.v.desc).toBe('<p>Ada’s draft</p>');
    expect(t.repo.get('tasks', 't1').desc).toBe('<p>Ada’s draft</p>');
    // Having seen Ada's, Bob can write over it.
    expect((await bob.sync([descEdit('t1', '<p>Bob’s draft</p>', '<p>Ada’s draft</p>')])).body.results[0].ok).toBe(true);
    expect(t.repo.get('tasks', 't1').desc).toBe('<p>Bob’s draft</p>');
  });

  it('only refuse the description: other changes to the task go through', async () => {
    const { t, ada, bob } = await pair();
    await ada.sync([descEdit('t1', '<p>Ada’s draft</p>', '<p>First draft</p>')]);
    const r = await bob.sync([
      descEdit('t1', '<p>Bob’s draft</p>', '<p>First draft</p>'),
      { c: 'tasks', id: 't1', k: 'patch', v: { title: 'Write better copy' } },
    ]);
    expect(r.body.results.map(x => x.ok)).toEqual([false, true]);
    expect(t.repo.get('tasks', 't1')).toMatchObject({ desc: '<p>Ada’s draft</p>', title: 'Write better copy' });
  });

  it('are accepted when sent again after they were saved (a resend after the page went away)', async () => {
    const { t, ada } = await pair();
    const op = descEdit('t1', '<p>Ada’s draft</p>', '<p>First draft</p>');
    expect((await ada.sync([op])).body.results[0].ok).toBe(true);
    expect((await ada.sync([op])).body.results[0].ok).toBe(true);
    expect(t.repo.get('tasks', 't1').desc).toBe('<p>Ada’s draft</p>');
  });

  it('are compared as stored: a starting point the server cleaned on save still matches', async () => {
    const { t, ada } = await pair();
    // Saved as cleaned (the script goes); the next keystroke's starting point is what was sent.
    await ada.sync([descEdit('t1', '<p>Hi<script>x()</script></p>', '<p>First draft</p>')]);
    expect(t.repo.get('tasks', 't1').desc).toBe('<p>Hi</p>');
    expect((await ada.sync([descEdit('t1', '<p>Hi there</p>', '<p>Hi<script>x()</script></p>')])).body.results[0].ok).toBe(true);
  });

  it('without a starting point (the REST API, older clients) still replace it', async () => {
    const { t, ada, bob } = await pair();
    await ada.sync([descEdit('t1', '<p>Ada’s draft</p>', '<p>First draft</p>')]);
    expect((await bob.sync([{ c: 'tasks', id: 't1', k: 'patch', v: { desc: '<p>Bob’s draft</p>' } }])).body.results[0].ok).toBe(true);
    expect(t.repo.get('tasks', 't1').desc).toBe('<p>Bob’s draft</p>');
  });
});
