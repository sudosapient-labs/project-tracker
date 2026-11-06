/* Regressions for the platform audit's high and medium findings (H1–M8). */
import { describe, expect, it } from 'vitest';
import { account, apiKey, keyClient, setup } from './helpers.js';
import { cleanRich } from '../../server/lib/rich-text.js';

const project = (id, key = 'WEB', extra = {}) => ({
  id,
  key,
  name: 'Project ' + key,
  icon: 'globe',
  color: 'indigo',
  status: 'active',
  team: '',
  lead: null,
  due: null,
  start: null,
  members: [],
  desc: '',
  milestones: [],
  ...extra,
});
const task = (id, pid, extra = {}) => ({
  id,
  key: 'WEB-201',
  project: pid,
  title: 'Write copy',
  status: 'todo',
  assignee: null,
  priority: 'medium',
  due: null,
  start: null,
  labels: [],
  subtasks: [],
  attachments: [],
  deps: [],
  desc: '',
  estimate: null,
  created: Date.now(),
  updated: Date.now(),
  order: 1,
  recur: null,
  ...extra,
});
const put = (c, v) => ({ c, id: v.id, k: 'put', v });
const patch = (c, id, v) => ({ c, id, k: 'patch', v });

/* Ada (Owner) plus invited teammates, each signed in: { t, ada, [name]: client }. */
async function workspace(people = [], env) {
  const t = setup(env);
  const ada = await account(t);
  const out = { t, ada: ada.c };
  for (const [id, name, role] of people) {
    const email = `${name.toLowerCase()}@example.com`;
    await ada.c.sync([put('members', { id, name, email, role, team: '', title: '', c: '#6B7280', status: 'invited', tz: '' })]);
    out[name.toLowerCase()] = (await account(t, { name, email, invite: t.lastLink(email).split('#invite/')[1] })).c;
  }
  return out;
}

const nested = n => '<div>'.repeat(n) + 'x' + '</div>'.repeat(n);
const timed = async f => {
  const t0 = performance.now();
  const r = await f();
  return { r, ms: performance.now() - t0 };
};

describe('H1 rich text is bounded before it is sanitised', () => {
  it('refuses an oversized description quickly, on create and on update', async () => {
    const { t, ada } = await workspace();
    await ada.sync([put('projects', project('p1'))]);
    // 2 MB of nested tags used to block the server for tens of seconds.
    const huge = nested(170_000);
    const create = await timed(() => ada.sync([put('tasks', task('t1', 'p1', { desc: huge }))]));
    expect(create.r.body.results[0]).toMatchObject({ ok: false, status: 413 });
    expect(create.ms).toBeLessThan(1000);
    expect(t.repo.get('tasks', 't1')).toBeNull();

    // Just over the character limit, but under the record size: refused by the description check.
    const long = 'a'.repeat(100_001);
    const r = await ada.sync([put('tasks', task('t2', 'p1', { desc: long }))]);
    expect(r.body.results[0]).toMatchObject({ ok: false, status: 400, error: 'desc: Keep it under 100,000 characters.' });

    await ada.sync([put('tasks', task('t3', 'p1'))]);
    const deep = await timed(() => ada.sync([patch('tasks', 't3', { desc: nested(9_000) })]));
    expect(deep.r.body.results[0]).toMatchObject({ ok: false, status: 400, error: 'desc: Its formatting is nested too deeply.' });
    expect(deep.ms).toBeLessThan(1000);
    expect(t.repo.get('tasks', 't3').desc).toBe('');

    const notText = await ada.sync([patch('tasks', 't3', { desc: { html: '<p>x</p>' } })]);
    expect(notText.body.results[0]).toMatchObject({ ok: false, status: 400, error: 'desc: Expected text.' });
  });

  it('keeps ordinary formatting and lists nested a few levels', async () => {
    const { t, ada } = await workspace();
    await ada.sync([put('projects', project('p1'))]);
    const desc = '<p>Hi <b>there</b></p><ul><li>one<ul><li>two<ul><li>three</li></ul></li></ul></li></ul>';
    const r = await ada.sync([put('tasks', task('t1', 'p1', { desc }))]);
    expect(r.body.results[0].ok).toBe(true);
    expect(t.repo.get('tasks', 't1').desc).toBe(desc);
  });

  it('applies the same bound to descriptionHtml through the API', async () => {
    const { t, ada } = await workspace();
    await ada.sync([put('projects', project('p1'))]);
    const api = keyClient(t.app, await apiKey(ada));
    const { r, ms } = await timed(() => api.post('/tasks', { project: 'WEB', title: 'Deep', descriptionHtml: nested(9_000) }));
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'invalid_request', field: 'descriptionHtml' });
    expect(ms).toBeLessThan(1000);
  });

  it('cleanRich itself refuses what it cannot sanitise cheaply', () => {
    expect(() => cleanRich(nested(1_000))).toThrow(RangeError);
    expect(() => cleanRich('x'.repeat(100_001))).toThrow(RangeError);
    expect(cleanRich('<p>a<script>x</script></p>')).toBe('<p>a</p>');
  });
});
