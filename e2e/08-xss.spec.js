import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';
import { OWNER_AFTER_RESET, signIn, synced, watchErrors } from './helpers.js';

test.describe.configure({ mode: 'serial' });

// 05-settings changes the owner's password.
const OWNER = { ...OWNER_AFTER_RESET, password: 'jacquard-loom-42' };
const P1 = '<img src=x onerror=window.__xss=1>';
const P2 = '"><svg onload=window.__xss=2>';
const P3 = '<meta http-equiv=refresh content="0;url=about:blank">';
const P4 = '<form action="https://evil.example/"><button>go</button></form>';
const HOSTILE = `${P1}${P2}${P3}${P4}`;
const JS_URL = 'javascript:window.__xss=5';

let page, errors, me;
test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext()).newPage();
  errors = watchErrors(page);
  page.on('dialog', d => d.dismiss());
  // A blocked inline handler on an element in the page means markup got in. (DOMPurify parses
  // hostile HTML in an inert document; Chromium reports those handlers too, against the document.)
  page.addInitScript(() => {
    window.__cspElements = [];
    document.addEventListener('securitypolicyviolation', e => e.target instanceof Element && window.__cspElements.push(e.target.outerHTML.slice(0, 200)));
  });
});
test.afterAll(async () => page.context().close());

const api = (method, url, data) => page.request.fetch(url, { method, headers: { 'x-requested-with': 'gr8r' }, ...(data ? { data } : {}) });
const sync = async ops => (await (await api('POST', '/api/sync', { ops })).json()).results;
const put = (c, v) => ({ c, id: v.id, k: 'put', v });
const today = new Date().toISOString().slice(0, 10);

/* Write straight to the database: values the server now refuses on write, as older versions (or a
   bug elsewhere) may have stored them. The client must still render them inertly. */
function stored(table, id, fix) {
  const db = new DatabaseSync('test-results/e2e-data/db.sqlite');
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const v = JSON.parse(db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id).data);
    fix(v);
    db.prepare(`UPDATE ${table} SET data = ? WHERE id = ?`).run(JSON.stringify(v), id);
  } finally {
    db.close();
  }
}
function insert(table, v, scope = null) {
  const db = new DatabaseSync('test-results/e2e-data/db.sqlite');
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare(`INSERT INTO ${table} (id, project_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run(
      v.id,
      scope,
      JSON.stringify(v),
      Date.now(),
      Date.now(),
    );
  } finally {
    db.close();
  }
}

/* Nothing ran, nothing was injected, and the page didn't navigate away. */
async function inert(where) {
  expect(await page.evaluate(() => window.__xss), `script ran on ${where}`).toBeUndefined();
  expect(await page.evaluate(() => window.__cspElements), `inline handlers blocked on ${where}`).toEqual([]);
  const injected = await page.evaluate(
    () =>
      document.querySelectorAll(
        '[onerror], [onload], [onclick], meta[http-equiv], form[action], base, img[src="x"], a[href^="javascript:"], img[src^="javascript:"]',
      ).length,
  );
  expect(injected, `injected elements on ${where}`).toBe(0);
  expect(new URL(page.url()).origin).toBe(new URL(test.info().project.use.baseURL).origin);
}
const visit = async hash => {
  await page.evaluate(h => (location.hash = h), hash);
  await page.waitForTimeout(250);
  await inert(hash);
};

test('hostile values in every user-controlled field render as text', async () => {
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  me = (await (await api('GET', '/api/auth/session')).json()).user.id;

  // Seeded through the API where the server still accepts them.
  const sub = { id: 'sx1', title: HOSTILE, done: false, assignee: null };
  const res = await sync([
    put('teams', { id: 'txss', name: HOSTILE.slice(0, 60), icon: 'users', c: '#5A67D8', desc: HOSTILE }),
    put('projects', {
      id: 'pxss',
      key: 'XSS',
      name: HOSTILE.slice(0, 120),
      icon: 'globe',
      color: 'rose',
      status: 'active',
      team: 'txss',
      lead: me,
      due: null,
      start: null,
      members: [me],
      desc: HOSTILE,
      milestones: [{ name: HOSTILE, date: today }],
    }),
    put('tasks', {
      id: 'txss1',
      key: 'XSS-1',
      project: 'pxss',
      title: HOSTILE,
      status: 'todo',
      assignee: me,
      priority: 'high',
      due: today,
      start: null,
      labels: ['design'],
      subtasks: [sub],
      attachments: [],
      deps: [],
      desc: `<p>Plan</p>${HOSTILE}`,
      created: Date.now(),
      updated: Date.now(),
      order: 1,
      recur: 'Weekly',
    }),
    put('tasks', {
      id: 'txss2',
      key: 'XSS-2',
      project: 'pxss',
      title: 'Paste target',
      status: 'todo',
      assignee: null,
      priority: 'none',
      labels: [],
      subtasks: [],
      attachments: [],
      deps: [],
      desc: '',
      created: Date.now(),
      updated: Date.now(),
      order: 2,
    }),
    put('comments', { id: 'cxss1', task: 'txss1', by: me, at: Date.now(), text: HOSTILE, re: {} }),
    put('events', { id: 'exss1', title: HOSTILE, date: today, time: '10:00', project: 'pxss' }),
    put('events', { id: 'exss2', title: HOSTILE, date: today, time: '', project: null }),
    put('savedViews', { id: 'vxss1', project: 'pxss', name: HOSTILE.slice(0, 80), type: 'list', filters: [] }),
    { c: 'ws', k: 'patch', v: { name: P2 } },
    { c: 'members', id: me, k: 'patch', v: { name: `${P1}${P2}`, title: HOSTILE.slice(0, 80) } },
  ]);
  expect(res.map(r => r.error || r.ok)).toEqual(Array(res.length).fill(true));
  // The server cleans the description on write (and the client would anyway).
  expect(res[2].v.desc).toBe('<p>Plan</p>"&gt;go');
  const up = await page.request.post(`/api/files?project=pxss&task=txss1&name=${encodeURIComponent(P1 + '.png')}`, {
    headers: { 'x-requested-with': 'gr8r', 'content-type': 'image/png' },
    data: Buffer.from('not really a png'),
  });
  expect(up.status()).toBe(201);
  const fileId = (await up.json()).file.id;

  // And the server refuses the ones it now checks.
  const refused = await sync([
    { c: 'tasks', id: 'txss1', k: 'patch', v: { recur: HOSTILE } },
    { c: 'events', id: 'exss1', k: 'patch', v: { time: P2 } },
    { c: 'comments', id: 'cxss1', k: 'patch', v: { re: { [P1]: [me] } } },
    { c: 'files', id: fileId, k: 'patch', v: { size: P1 } },
  ]);
  expect(refused.map(r => r.ok)).toEqual([false, false, false, false]);

  // Stored hostile values the server would refuse today: the client must still be safe.
  stored('tasks', 'txss1', t => {
    t.recur = HOSTILE;
    t.desc = `<p>Plan</p>${HOSTILE}<a href="${JS_URL}">link</a>`;
    t.attachments = [
      { ...t.attachments[0], size: P2, type: P1 },
      { id: 'fgone', name: HOSTILE, type: P2, size: P1, by: 'mgone', at: Date.now(), url: JS_URL },
    ];
  });
  stored('files', fileId, f => Object.assign(f, { type: P1, size: P2, url: JS_URL }));
  stored('comments', 'cxss1', c => (c.re = { [HOSTILE]: [me], '👍': [me, 'mgone'] }));
  stored('events', 'exss1', e => (e.time = P2));
  stored('saved_views', 'vxss1', v => (v.filters = [{ f: 'bogus', op: 'is', v: [] }, { f: 'status', op: 'is', v: [P1] }, 'nonsense']));
  // A comment by someone who has since left the workspace.
  insert('comments', { id: 'cxss2', task: 'txss1', by: 'mgone', at: Date.now(), text: 'findme from a former member', re: {}, project: 'pxss' }, 'pxss');

  await page.reload();
  await expect(page.locator('.side')).toBeVisible();
  await inert('home');

  await visit('#members');
  await page.locator('[data-k="membersTab"][data-v="teams"]').click();
  await expect(page.locator('.pcard', { hasText: '<img src=x' }).first()).toBeVisible();
  await inert('teams');
  await visit('#team/txss');
  await expect(page.locator('h1').first()).toContainText('<img src=x onerror');
  await visit('#projects');
  await page.locator('[data-k="projView"][data-v="list"]').click();
  await inert('projects list');
  for (const tab of ['overview', 'board', 'list', 'table', 'calendar', 'files', 'v:vxss1']) await visit(`#project/xss/${tab}`);

  // Project calendar: the event chip (with a hostile stored time) and its popover.
  await visit('#project/xss/calendar');
  await page.locator('.cev.event').first().click();
  await expect(page.locator('.pop')).toContainText('<img src=x onerror');
  await inert('event popover');
  await page.keyboard.press('Escape');

  // The workspace calendar has the event with no project too, in month and week view.
  await visit('#calendar');
  for (const ev of await page.locator('.cev.event').all()) {
    await ev.click();
    await inert('event popover (workspace calendar)');
    await page.keyboard.press('Escape');
  }
  await page.locator('[data-k="calMode"][data-v="week"]').first().dispatchEvent('click');
  await expect(page.locator('.week')).toBeVisible();
  await inert('calendar week');

  // Files: grid and list.
  await visit('#project/xss/files');
  await page.locator('[data-k="fileView"][data-v="list"]').click();
  await inert('files list');

  // Search: tasks, people, files and comments (one by a former member).
  await visit('#search');
  await page.fill('#search-page-q', 'onerror');
  await page.waitForTimeout(250);
  await inert('search');
  await page.fill('#search-page-q', 'findme');
  await expect(page.locator('.page')).toContainText('Former member');
  await inert('search former member');

  // The task drawer: description, repeat, attachments, comments and reactions.
  await visit('#project/xss/list');
  await page.locator('[data-task-row] [data-a="openTask"]').first().click();
  const drawer = page.locator('.drawer');
  await expect(drawer.locator('#d-desc')).toContainText('Plan');
  await expect(drawer.locator('.react').first()).toBeVisible();
  await expect(drawer.locator('#d-desc a')).not.toHaveAttribute('href', /javascript/);
  await inert('task drawer');
  for (const att of await drawer.locator('.attc').all()) {
    await att.click();
    await expect(page.locator('.modal')).toBeVisible();
    await expect(page.locator('.modal a[href^="javascript"]')).toHaveCount(0);
    await inert('file preview');
    await page.locator('.modal [data-a="closeModal"]').last().click();
  }
  await drawer.locator('[data-a="closeDrawer"]').dispatchEvent('click');

  // Pasting HTML into a description keeps only what the editor allows, and saves.
  await page.locator('[data-task-row]', { hasText: 'Paste target' }).locator('[data-a="openTask"]').click();
  await drawer.locator('#d-desc').click();
  await page.evaluate(html => {
    const dt = new DataTransfer();
    dt.setData('text/html', html);
    document.querySelector('#d-desc').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, `<b>pasted</b>${HOSTILE}`);
  await expect(drawer.locator('#d-desc b', { hasText: 'pasted' })).toBeVisible();
  await inert('pasted description');
  await synced(page);
  await drawer.locator('[data-a="closeDrawer"]').dispatchEvent('click');

  // Modals that list teams.
  await page.locator('.side [data-a="newProject"]').click();
  await expect(page.locator('#p-team option', { hasText: '<img src=x' })).toHaveCount(1);
  await inert('new project modal');
  await page.locator('.modal [data-a="closeModal"]').last().click();
  await visit('#members');
  await page.locator('[data-a="invite"]').first().click();
  await expect(page.locator('#inv-team option', { hasText: '<img src=x' })).toHaveCount(1);
  await inert('invite modal');
  await page.locator('.modal [data-a="closeModal"]').last().click();

  expect(await errors(['Executing inline event handler violates'])).toEqual([]);
});
