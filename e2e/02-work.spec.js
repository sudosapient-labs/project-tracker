import { expect, test } from '@playwright/test';
import { OWNER_AFTER_RESET as OWNER, openProject, signIn, synced, toastWith, watchErrors } from './helpers.js';

test.describe.configure({ mode: 'serial' });

const drawer = page => page.locator('.drawer');
const row = (page, title) => page.locator('[data-task-row]', { hasText: title }).first();

test('create a project and tasks, and everything survives a reload', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page, OWNER);
  await page.locator('.side [data-a="newProject"]').click();
  await page.fill('#p-name', 'Analytical Engine');
  await page.fill('#p-desc', 'Mill, store and punched cards.');
  await page.locator('[data-a="submitProject"]').click();
  await toastWith(page, 'Created Analytical Engine');
  await expect(page.locator('.proj-h')).toContainText('Analytical Engine');

  // Task through the modal.
  await page.locator('.tab[data-tab="list"]').click();
  await page.locator('[data-a="newTask"]').first().click();
  await page.fill('#f-title', 'Design the mill');
  await page.fill('#f-desc', 'The arithmetic unit.');
  await page.click('#f-submit');
  await toastWith(page, 'Created AE-');

  // Task through the inline composer on the list.
  await page.locator('[data-a="startComposer"]').first().click();
  await page.fill('#composer-in', 'Punch the cards');
  await page.press('#composer-in', 'Enter');
  await page.press('#composer-in', 'Escape');
  await synced(page);

  await page.reload();
  await expect(row(page, 'Design the mill')).toBeVisible();
  await expect(row(page, 'Punch the cards')).toBeVisible();
  await expect(page.locator('.side')).toContainText('Analytical Engine');
  expect(await errors()).toEqual([]);
});

test('edit a task in the drawer: title, subtasks, comments, completion', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page, OWNER);
  await openProject(page, 'Analytical Engine');
  await row(page, 'Design the mill').locator('[data-a="openTask"]').first().click();
  await expect(drawer(page)).toBeVisible();

  await page.fill('#d-title', 'Design the mill and store');
  await page.locator('#d-title').blur();
  await page.fill('#d-sub', 'Carry mechanism');
  await page.press('#d-sub', 'Enter');
  await page.fill('#d-sub', 'Anticipating carriage');
  await page.press('#d-sub', 'Enter');
  await drawer(page).locator('.subt', { hasText: 'Carry mechanism' }).locator('input[type="checkbox"]').check();
  await page.fill('#d-cmt', 'Babbage suggests base ten.');
  await drawer(page).locator('[data-a="postComment"]').click();
  await expect(drawer(page)).toContainText('Babbage suggests base ten.');
  await synced(page);

  await page.reload();
  await row(page, 'Design the mill and store').locator('[data-a="openTask"]').first().click();
  await expect(drawer(page).locator('#d-title')).toHaveValue('Design the mill and store');
  await expect(drawer(page).locator('.subt.done', { hasText: 'Carry mechanism' })).toBeVisible();
  await expect(drawer(page).locator('.subt', { hasText: 'Anticipating carriage' })).toBeVisible();
  await expect(drawer(page)).toContainText('Babbage suggests base ten.');

  await drawer(page).locator('.drawer-h [data-a="toggleDone"]').click();
  await expect(drawer(page).locator('.drawer-h')).toContainText('Completed');
  await synced(page);
  await page.reload();
  await row(page, 'Design the mill and store').locator('[data-a="openTask"]').first().click();
  await expect(drawer(page).locator('.drawer-h')).toContainText('Completed');
  // The activity tab lists what happened, as recorded on the server.
  await drawer(page).locator('[data-k="drawerTab"][data-v="activity"]').click();
  await expect(drawer(page)).toContainText('completed');
  expect(await errors()).toEqual([]);
});

test('delete a task, undo it, then delete it for good', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page, OWNER);
  await openProject(page, 'Analytical Engine');

  await row(page, 'Punch the cards').click({ button: 'right' });
  await page.locator('.pop [data-a="delTask"]').click();
  await page.locator('[data-a="confirmOk"]').click();
  await page.locator('#toasts .toast', { hasText: 'Deleted' }).getByRole('button', { name: 'Undo' }).click();
  await expect(row(page, 'Punch the cards')).toBeVisible();
  await synced(page);
  await page.reload();
  await expect(row(page, 'Punch the cards')).toBeVisible();

  await row(page, 'Punch the cards').click({ button: 'right' });
  await page.locator('.pop [data-a="delTask"]').click();
  await page.locator('[data-a="confirmOk"]').click();
  await expect(row(page, 'Punch the cards')).toHaveCount(0);
  await synced(page);
  await page.reload();
  await expect(row(page, 'Design the mill and store')).toBeVisible();
  await expect(row(page, 'Punch the cards')).toHaveCount(0);
  expect(await errors()).toEqual([]);
});

test('quick edit keeps descriptions intact: plain text decoded, formatting left alone', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  const headers = { 'x-requested-with': 'sudo-sapient' };
  const now = Date.now();
  const taskOp = (id, n, title, desc) => ({
    c: 'tasks',
    id,
    k: 'put',
    v: {
      id,
      key: `QE-${n}`,
      project: 'pqe',
      title,
      status: 'todo',
      assignee: null,
      priority: 'none',
      labels: [],
      subtasks: [],
      attachments: [],
      deps: [],
      desc,
      created: now,
      updated: now,
      order: n,
    },
  });
  const RICH = '<ul><li>Gears</li><li>Levers &amp; <a href="https://example.com/cams">cams</a></li></ul>';
  const ops = [
    {
      c: 'projects',
      id: 'pqe',
      k: 'put',
      v: {
        id: 'pqe',
        key: 'QE',
        name: 'Quick edits',
        icon: 'code',
        color: 'teal',
        status: 'active',
        team: '',
        lead: null,
        members: [],
        desc: '',
        milestones: [],
      },
    },
    taskOp('tqe1', 1, 'Plain ampersand', '<p>a &amp; b</p>'),
    taskOp('tqe2', 2, 'Formatted list', RICH),
  ];
  expect((await page.request.post('/api/sync', { headers, data: { ops } })).ok()).toBe(true);
  const descOf = async id => (await (await page.request.get('/api/bootstrap')).json()).data.tasks.find(t => t.id === id).desc;
  const richStored = await descOf('tqe2');
  expect(richStored).toContain('<li>Gears</li>');

  const quickEdit = async title => {
    await row(page, title).click({ button: 'right' });
    await page.locator('.pop [data-a="editTask"]').click();
    await expect(page.locator('#f-title')).toHaveValue(title);
  };
  const save = async () => {
    await page.click('#f-submit');
    await toastWith(page, 'Changes saved');
    await synced(page);
  };
  await page.goto('/#project/qe/list');

  // Plain text shows decoded, and an unrelated change leaves the stored description byte for byte.
  await quickEdit('Plain ampersand');
  await expect(page.locator('#f-desc')).toHaveValue('a & b');
  await page.fill('#f-title', 'Plain ampersand, renamed');
  await save();
  expect(await descOf('tqe1')).toBe('<p>a &amp; b</p>');

  // Editing the text escapes it once.
  await quickEdit('Plain ampersand, renamed');
  await page.fill('#f-desc', 'c & d < e');
  await save();
  expect(await descOf('tqe1')).toBe('<p>c &amp; d &lt; e</p>');
  await quickEdit('Plain ampersand, renamed');
  await expect(page.locator('#f-desc')).toHaveValue('c & d < e');
  await page.locator('.modal [data-a="closeModal"]').last().click();

  // A formatted description isn't offered as plain text, and saving other changes leaves it alone.
  await quickEdit('Formatted list');
  await expect(page.locator('#f-desc')).toHaveCount(0);
  await expect(page.locator('#f-desc-rich')).toContainText('This description has formatting');
  await page.fill('#f-title', 'Formatted list, renamed');
  await save();
  expect(await descOf('tqe2')).toBe(richStored);

  // The note's link opens the task in the drawer, where the formatting can be edited.
  await quickEdit('Formatted list, renamed');
  await page.locator('#f-desc-rich [data-a="openTask"]').click();
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(drawer(page).locator('#d-desc li', { hasText: 'Gears' })).toBeVisible();
  expect(await errors()).toEqual([]);
});

test('a field picked as a dialog opens keeps the focus, so typing goes where it was aimed', async ({ page }) => {
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  // Pick the description in the same moment the dialog opens, before its first field takes focus.
  await page.evaluate(() => {
    document.querySelector('.side [data-a="newProject"]').click();
    document.getElementById('p-desc').focus();
  });
  await page.keyboard.type('Typed straight away', { delay: 15 });
  await page.waitForTimeout(100);
  // Past the dialog's own focus step, whenever it ran: the description still has the focus.
  await expect(page.locator('#p-desc')).toBeFocused();
  await expect(page.locator('#p-desc')).toHaveValue('Typed straight away');
  await expect(page.locator('#p-name')).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(page.locator('.modal')).toHaveCount(0);
});
