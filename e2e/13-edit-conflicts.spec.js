import { expect, test } from '@playwright/test';
import { OWNER_AFTER_RESET, emailLink, synced } from './helpers.js';

/* Two people working on the same task at once: neither one's save may silently undo the other's.
   Runs on its own (it then creates the workspace) or after the other journeys. */

// 05-settings changes the owner's password to this; on its own, this journey signs up with it.
const OWNER = { ...OWNER_AFTER_RESET, password: 'jacquard-loom-42' };
const KIT = { name: 'Kit Marlowe', email: 'kit@example.com', password: 'quill-and-ink-2026' };
const headers = { 'x-requested-with': 'sudo-sapient' };
test.describe.configure({ mode: 'serial' });

let ada, kit, adaId, kitId;
const day = n => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const sync = async (page, ops) => {
  const r = await page.request.post('/api/sync', { headers, data: { ops } });
  expect(r.ok()).toBe(true);
  const { results } = await r.json();
  expect(results.filter(x => !x.ok)).toEqual([]);
  return results;
};
const serverData = async page => (await (await page.request.get('/api/bootstrap')).json()).data;
const serverTask = async (page, id) => (await serverData(page)).tasks.find(t => t.id === id);
const project = (id, key, extra = {}) => ({
  c: 'projects',
  id,
  k: 'put',
  v: {
    id,
    key,
    name: `Edits ${key}`,
    icon: 'code',
    color: 'teal',
    status: 'active',
    team: '',
    lead: null,
    members: [adaId, kitId],
    desc: '',
    milestones: [],
    ...extra,
  },
});
const task = (id, pid, key, title, extra = {}) => {
  const now = Date.now();
  return {
    c: 'tasks',
    id,
    k: 'put',
    v: {
      id,
      key,
      project: pid,
      title,
      status: 'todo',
      assignee: null,
      priority: 'none',
      labels: [],
      subtasks: [],
      attachments: [],
      deps: [],
      desc: '',
      created: now,
      updated: now,
      order: 1,
      ...extra,
    },
  };
};
/* Open a page fresh (a reload: no drawer or dialog left over from the previous test). */
const visit = async (page, hash) => {
  await page.goto('/' + hash);
  await page.reload();
  await expect(page.locator('.side')).toBeVisible();
};
/* Give a change time to reach the other person's tab over the live stream. */
const arrive = page => page.waitForTimeout(1500);
const openTask = async (page, title) => {
  await page.locator('[data-a="openTask"]', { hasText: title }).first().click();
  await expect(page.locator('#d-title')).toHaveValue(title);
};

test.beforeAll(async ({ browser }) => {
  ada = await (await browser.newContext()).newPage();
  kit = await (await browser.newContext()).newPage();
  const session = await (await ada.request.get('/api/auth/session')).json();
  if (!session.workspace) {
    // On its own: the first account owns the workspace.
    const r = await (await ada.request.post('/api/auth/signup', { headers, data: OWNER })).json();
    if (r.devLink) await ada.request.post('/api/auth/verify', { headers, data: { token: r.devLink.split('#verify/')[1] } });
    await ada.request.post('/api/workspace/onboarded', { headers });
  } else expect((await ada.request.post('/api/auth/login', { headers, data: { email: OWNER.email, password: OWNER.password } })).ok()).toBe(true);
  adaId = (await serverData(ada)).me;
  kitId = 'mkit';
  await sync(ada, [
    {
      c: 'members',
      id: kitId,
      k: 'put',
      v: { id: kitId, name: KIT.name, email: KIT.email, role: 'Member', team: '', title: '', c: '#6B7280', status: 'invited', last: null, tz: '' },
    },
  ]);
  const token = emailLink(KIT.email).split('#invite/')[1];
  expect((await kit.request.post('/api/auth/signup', { headers, data: { ...KIT, invite: token } })).status()).toBe(201);
  await sync(ada, [project('pedit', 'EDT')]);
});

test('saving the Edit window sends only what was changed there, so a change made meanwhile survives', async () => {
  await sync(ada, [
    task('tedit1', 'pedit', 'EDT-201', 'Draft the brief', { due: day(5), start: day(1), subtasks: [{ id: 's1', title: 'Outline', done: false }] }),
  ]);
  await visit(ada, '#project/edt/list');
  await visit(kit, '#project/edt/board');
  // Kit opens the Edit window from the board card (right-click → Edit).
  await kit.locator('[data-drag-card="tedit1"]').click({ button: 'right' });
  await kit.locator('.mi[data-a="editTask"]').click();
  await expect(kit.locator('#f-title')).toHaveValue('Draft the brief');

  // Meanwhile Ada moves the due date and adds a subtask in the task view.
  await openTask(ada, 'Draft the brief');
  await ada.locator('.drawer [data-pop="date"][data-field="due"]').click();
  await ada.locator('.pop [data-a="popPick"]', { hasText: 'Tomorrow' }).click();
  await ada.locator('.pop [data-a="popDateSave"]').click();
  await ada.locator('#d-sub').fill('Get sign-off');
  await ada.locator('#d-sub').press('Enter');
  await synced(ada);
  const adas = await serverTask(ada, 'tedit1');
  expect(adas.due).not.toBe(day(5));
  expect(adas.subtasks.map(s => s.title)).toEqual(['Outline', 'Get sign-off']);
  await arrive(kit);

  // Kit, from the window opened before, only moves it to In Progress.
  await kit.locator('.modal [data-pop="status"]').click();
  await kit.locator('.pop [data-a="popPick"][data-v="progress"]').click();
  await kit.locator('#f-submit').click();
  await synced(kit);

  const t = await serverTask(ada, 'tedit1');
  expect(t.status).toBe('progress');
  expect(t.due).toBe(adas.due);
  expect(t.subtasks.map(s => s.title)).toEqual(['Outline', 'Get sign-off']);
  // Kit is only credited with what Kit changed.
  const kits = (await serverData(ada)).activity.filter(a => a.task === 'tedit1' && a.by === kitId).map(a => a.verb);
  expect(kits).toEqual(['moved']);
});

/* Replace the drawer's description as typing would (an input event on the editor). */
const setDesc = (page, html) =>
  page.evaluate(h => {
    const ed = document.querySelector('#d-desc');
    ed.innerHTML = h;
    ed.dispatchEvent(new Event('input', { bubbles: true }));
  }, html);

test('typing in a description someone else just changed keeps both texts and lets me choose', async () => {
  await sync(ada, [task('tdesc1', 'pedit', 'EDT-202', 'Write the intro', { desc: '<p>First draft</p>' })]);
  await visit(ada, '#project/edt/list');
  await visit(kit, '#project/edt/list');
  await openTask(ada, 'Write the intro');
  await openTask(kit, 'Write the intro');
  // Kit is in the editor when Ada saves a new description.
  await kit.locator('#d-desc').click();
  await setDesc(ada, '<p>Ada rewrote the intro</p>');
  await synced(ada);
  await arrive(kit);
  await kit.locator('#d-desc').press('End');
  await kit.keyboard.type('!');
  // Ada's text wasn't written over, and Kit's isn't lost: Kit is asked which one to keep.
  const dlg = kit.locator('.modal', { hasText: 'changed this description' });
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText('Ada rewrote the intro');
  await expect(dlg).toContainText('First draft!');
  // Keys still being typed choose nothing and reach no editor.
  await kit.keyboard.type(' and more ');
  await synced(kit);
  await expect(dlg).toBeVisible();
  expect((await serverTask(ada, 'tdesc1')).desc).toBe('<p>Ada rewrote the intro</p>');
  await dlg.locator('[data-a="confirmOk"]').click();
  await synced(kit);
  expect((await serverTask(ada, 'tdesc1')).desc).toBe('<p>First draft!</p>');
  await expect(kit.locator('#d-desc')).toHaveText('First draft!');
});

test('the Edit window does not write over a description someone else changed after it opened', async () => {
  await sync(ada, [task('tdesc2', 'pedit', 'EDT-203', 'Plan the launch', { desc: '<p>Old plan</p>' })]);
  // This time Kit opens the Edit window from the list's right-click menu.
  await visit(kit, '#project/edt/list');
  await kit.locator('[data-task-row="tdesc2"]').click({ button: 'right' });
  await kit.locator('.mi[data-a="editTask"]').click();
  await expect(kit.locator('#f-desc')).toHaveValue('Old plan');
  await sync(ada, [{ c: 'tasks', id: 'tdesc2', k: 'patch', v: { desc: '<p>Ada’s new plan</p>', updated: Date.now() } }]);
  await arrive(kit);
  await kit.locator('#f-desc').fill('Kit’s plan');
  await kit.locator('#f-title').fill('Plan the launch party');
  await kit.locator('#f-submit').click();
  await synced(kit);
  // The title went through; the description waits for Kit to choose.
  const t = await serverTask(ada, 'tdesc2');
  expect(t.title).toBe('Plan the launch party');
  expect(t.desc).toBe('<p>Ada’s new plan</p>');
  const dlg = kit.locator('.modal', { hasText: 'changed this description' });
  await expect(dlg).toContainText('Kit’s plan');
  // Keeping theirs leaves Ada's.
  await dlg.locator('[data-a="closeModal"]').click();
  await synced(kit);
  expect((await serverTask(ada, 'tdesc2')).desc).toBe('<p>Ada’s new plan</p>');
});

test('Undo puts back only the fields the action changed, keeping someone else’s later edit', async () => {
  await sync(ada, [task('tundo1', 'pedit', 'EDT-204', 'Book the venue', { priority: 'low' })]);
  await visit(ada, '#project/edt/list');
  const row = ada.locator('[data-task-row="tundo1"]');
  await row.click({ button: 'right' });
  await ada.locator('.mi[data-a="archiveTask"]').click();
  await synced(ada);
  // Kit renames it and raises its priority before Ada clicks Undo.
  await sync(kit, [{ c: 'tasks', id: 'tundo1', k: 'patch', v: { title: 'Book the bigger venue', priority: 'high', updated: Date.now() } }]);
  await arrive(ada);
  await ada.locator('#toasts .toast', { hasText: 'Archived' }).getByRole('button', { name: 'Undo' }).click();
  await synced(ada);
  const t = await serverTask(ada, 'tundo1');
  expect(t.archived).toBe(false);
  expect(t.title).toBe('Book the bigger venue');
  expect(t.priority).toBe('high');
});

test('a description that crosses someone else’s on its way to the server is kept and offered too', async () => {
  await sync(ada, [task('tdesc3', 'pedit', 'EDT-205', 'Pick a caterer', { desc: '<p>Shortlist</p>' })]);
  await visit(kit, '#project/edt/list');
  await openTask(kit, 'Pick a caterer');
  // Kit's edit is held back until Ada's has been saved, as on a slow connection.
  let release;
  const held = new Promise(r => (release = r));
  await kit.route('**/api/sync', async route => {
    await held;
    await route.continue();
  });
  await setDesc(kit, '<p>Shortlist: Kit’s picks</p>');
  await kit.waitForTimeout(800);
  await sync(ada, [{ c: 'tasks', id: 'tdesc3', k: 'patch', v: { desc: '<p>Shortlist: Ada’s picks</p>', updated: Date.now() } }]);
  await arrive(kit);
  release();
  const dlg = kit.locator('.modal', { hasText: 'changed this description' });
  await expect(dlg).toContainText('Ada’s picks');
  await expect(dlg).toContainText('Kit’s picks');
  await kit.unroute('**/api/sync');
  expect((await serverTask(ada, 'tdesc3')).desc).toBe('<p>Shortlist: Ada’s picks</p>');
  await dlg.locator('[data-a="closeModal"]').click();
  await expect(kit.locator('#d-desc')).toHaveText('Shortlist: Ada’s picks');
});

test('the project and team windows also send only what was changed in them', async () => {
  await sync(ada, [{ c: 'teams', id: 'tmedt', k: 'put', v: { id: 'tmedt', name: 'Editors', icon: 'users', c: '#5A67D8', desc: 'Words' } }]);
  await sync(ada, [{ c: 'members', id: adaId, k: 'patch', v: { team: 'tmedt' } }]);

  // Project: Ada renames it from the window; Kit moved its due date after it opened.
  await visit(ada, '#project/edt/overview');
  await ada.locator('[data-a="editProject"]').first().click();
  await expect(ada.locator('#p-name')).toHaveValue('Edits EDT');
  await sync(kit, [{ c: 'projects', id: 'pedit', k: 'patch', v: { due: day(40) } }]);
  await arrive(ada);
  await ada.locator('#p-name').fill('Edits EDT 2');
  await ada.locator('[data-a="submitProject"]').click();
  await synced(ada);
  let p = (await serverData(ada)).projects.find(x => x.id === 'pedit');
  expect(p.name).toBe('Edits EDT 2');
  expect(p.due).toBe(day(40));
  await sync(ada, [{ c: 'projects', id: 'pedit', k: 'patch', v: { name: 'Edits EDT' } }]);

  // Team: Ada renames it from the window; someone added Kit to it after it opened.
  await visit(ada, '#team/tmedt');
  await ada.locator('[data-a="editTeam"]').first().click();
  await expect(ada.locator('#tm-name')).toHaveValue('Editors');
  await sync(kit, [{ c: 'members', id: kitId, k: 'patch', v: { team: 'tmedt' } }]);
  await arrive(ada);
  await ada.locator('#tm-name').fill('Editors guild');
  await ada.locator('[data-a="submitTeam"]').click();
  await synced(ada);
  const d = await serverData(ada);
  expect(d.teams.find(x => x.id === 'tmedt').name).toBe('Editors guild');
  expect(d.members.find(x => x.id === kitId).team).toBe('tmedt');
  expect(d.members.find(x => x.id === adaId).team).toBe('tmedt');
});

test('Undo is not offered for what can’t be restored, and the dialogs say so', async () => {
  // A file.
  const up = await ada.request.post('/api/files?project=pedit&name=notes.txt', { headers: { ...headers, 'content-type': 'text/plain' }, data: 'hello' });
  expect(up.ok()).toBe(true);
  await visit(ada, '#project/edt/files');
  await ada.locator('.fcard, tr[data-ctx="file"]', { hasText: 'notes.txt' }).locator('[data-a="ctxBtn"]').first().click();
  await ada.locator('[data-a="delFile"]').click();
  await expect(ada.locator('.modal')).toContainText("can't be undone");
  await ada.locator('.modal [data-a="confirmOk"]').click();
  await expect(ada.locator('#toasts .toast', { hasText: 'Deleted notes.txt' })).toBeVisible();
  await expect(ada.locator('#toasts .toast', { hasText: 'Deleted notes.txt' }).getByRole('button', { name: 'Undo' })).toHaveCount(0);

  // A workspace member.
  await visit(ada, '#members');
  await ada.locator('[data-ctx="member"]', { hasText: KIT.name }).first().click({ button: 'right' });
  await ada.locator('[data-a="removeMember"]').click();
  await expect(ada.locator('.modal')).toContainText("can't be undone");
  await ada.locator('.modal [data-a="confirmOk"]').click();
  await expect(ada.locator('#toasts .toast', { hasText: `Removed ${KIT.name}` })).toBeVisible();
  await expect(ada.locator('#toasts .toast', { hasText: `Removed ${KIT.name}` }).getByRole('button', { name: 'Undo' })).toHaveCount(0);

  // A project.
  await visit(ada, '#projects');
  await ada.locator('.side [data-ctx="project"]', { hasText: 'Edits EDT' }).first().click({ button: 'right' });
  await ada.locator('[data-a="delProject"]').click();
  await expect(ada.locator('.modal')).toContainText("can't be undone");
  await ada.locator('#confirm-in').fill('Edits EDT');
  await ada.locator('.modal [data-a="confirmOk"]').click();
  await expect(ada.locator('#toasts .toast', { hasText: 'Deleted Edits EDT' })).toBeVisible();
  await expect(ada.locator('#toasts .toast', { hasText: 'Deleted Edits EDT' }).getByRole('button', { name: 'Undo' })).toHaveCount(0);
  await synced(ada);
});
