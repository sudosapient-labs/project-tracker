import { expect, test } from '@playwright/test';
import { OWNER_AFTER_RESET, openProject, signIn, synced, toastWith, watchErrors } from './helpers.js';

test.describe.configure({ mode: 'serial' });

// 05-settings changes the owner's password; 03-team signs Charles up as a Member.
const OWNER = { ...OWNER_AFTER_RESET, password: 'jacquard-loom-42' };
const CHARLES = { email: 'charles@example.com', password: 'difference-engine-3' };

let ada, charles, adaErrors, charlesErrors;
test.beforeAll(async ({ browser }) => {
  ada = await (await browser.newContext()).newPage();
  charles = await (await browser.newContext()).newPage();
  adaErrors = watchErrors(ada);
  charlesErrors = watchErrors(charles);
});
test.afterAll(async () => {
  await ada.context().close();
  await charles.context().close();
});

/* Choose an option from a design-system dropdown (ui/select.js) by its accessible name. */
async function pick(page, label, option) {
  await page.locator(`button.select-btn[aria-label="${label}"]`).first().click();
  await page.locator('[role="listbox"] [role="option"]', { hasText: option }).first().click();
}
const share = page => page.locator('.proj-h [data-a="share"]').last().click();
const closeModal = page => page.locator('.modal .modal-f [data-a="closeModal"]').click();

test('the share dialog makes a project private, and people outside it get the locked page', async () => {
  await signIn(ada, OWNER);
  await openProject(ada, 'Analytical Engine');
  await share(ada);
  await expect(ada.locator('.modal')).toContainText('Anyone in the workspace can view and edit.');
  // Listing someone restricts them to exactly the permission shown (L10).
  await expect(ada.locator('.modal')).toContainText('People listed here get exactly the permission shown');
  await pick(ada, 'General access', 'Only people invited');
  await expect(ada.locator('.modal')).toContainText('Only people listed above can open this project.');
  await synced(ada);
  await closeModal(ada);

  await signIn(charles, CHARLES);
  // Only Owners and Admins can make (and so rotate) the workspace invite link (L4).
  await charles.locator('.side [data-r="members"]').click();
  await charles.locator('[data-a="invite"]').first().click();
  await expect(charles.locator('.modal [data-a="submitInvite"]')).toBeVisible();
  await expect(charles.locator('.modal [data-a="copyInviteLink"]')).toHaveCount(0);
  await closeModal(charles);
  await charles.locator('.side [data-r="projects"]').click();
  const card = charles.locator('.pcard', { hasText: 'Analytical Engine' });
  await expect(card).toContainText('Restricted');
  await expect(card).not.toContainText('Mill, store and punched cards.');
  await expect(card.locator('[data-a="share"]')).toHaveCount(0);
  await card.click();
  await expect(charles.getByRole('heading', { name: "You don't have access" })).toBeVisible();
  await expect(charles.locator('.fullstate [data-a="share"]')).toHaveCount(0);
  await charles.locator('[data-a="requestAccess"]').click();
  await toastWith(charles, 'Access requested');
  expect(await adaErrors()).toEqual([]);
  expect(await charlesErrors()).toEqual([]);
});

test('someone who can only view gets the project without editing controls', async () => {
  await share(ada);
  await ada.fill('#share-in', 'Charles');
  await ada.locator('.modal [data-a="shareAdd"]', { hasText: 'Charles Babbage' }).click();
  await pick(ada, 'Permission for Charles Babbage', 'Can view');
  await synced(ada);
  await closeModal(ada);

  // Charles is still on the locked page; it opens up without a reload.
  await expect(charles.locator('.ro-note')).toContainText('You can view this project.', { timeout: 15000 });
  await charles.locator('.tab[data-tab="list"]').click();
  await expect(charles.locator('[data-task-row]').first()).toBeVisible();
  await expect(charles.locator('.pbody [data-a="newTask"]:visible, .pbody [data-a="startComposer"]:visible')).toHaveCount(0);
  await charles.locator('[data-task-row] [data-a="openTask"]').first().click();
  await expect(charles.locator('.drawer #d-title')).toHaveAttribute('readonly', '');
  await expect(charles.locator('.drawer .cbox')).toBeHidden();
  await charles.locator('.drawer [data-a="closeDrawer"]').click();
  expect(await charlesErrors()).toEqual([]);
});

test('an owner can recover access to a private project they are not in', async () => {
  await charles.locator('.side [data-a="newProject"]').click();
  await charles.fill('#p-name', 'Babbage Notes');
  await charles.locator('[data-a="submitProject"]').click();
  await toastWith(charles, 'Created Babbage Notes');
  await share(charles);
  await pick(charles, 'General access', 'Only people invited');
  await synced(charles);
  await closeModal(charles);

  await ada.locator('.side [data-r="projects"]').click();
  const card = ada.locator('.pcard', { hasText: 'Babbage Notes' });
  await expect(card).toContainText('Restricted', { timeout: 15000 });
  await card.locator('[data-a="share"]', { hasText: 'Manage access' }).click();
  await ada.fill('#share-in', 'ada@example.com');
  await ada.locator('.modal [data-a="shareAdd"]', { hasText: 'ada@example.com' }).click();
  await synced(ada);
  await closeModal(ada);
  await ada.locator('.pcard', { hasText: 'Babbage Notes' }).click();
  await expect(ada.locator('.proj-h')).toContainText('Babbage Notes', { timeout: 15000 });
  await expect(ada.locator('.ro-note')).toHaveCount(0);
  expect(await adaErrors()).toEqual([]);
  expect(await charlesErrors()).toEqual([]);
});

test('account settings: download your data, change your email, delete your account', async () => {
  await charles.locator('.side [data-r="settings"]').first().click();
  await charles.locator('.set-nav [data-sec="account"]').click();
  await expect(charles.locator('#export-btn')).toHaveAttribute('href', '/api/me/export');
  const exp = await charles.request.get('/api/me/export');
  expect(exp.headers()['content-disposition']).toMatch(/^attachment/);
  expect((await exp.json()).profile.email).toBe(CHARLES.email);

  await charles.fill('#em-new', 'babbage@example.com');
  await charles.fill('#em-pw', 'wrong-password-0');
  await charles.click('#em-save');
  await expect(charles.locator('.set-body .err')).toContainText('password is incorrect');
  await charles.fill('#em-pw', CHARLES.password);
  await charles.click('#em-save');
  await expect(charles.locator('.set-body .alert')).toContainText('babbage@example.com');
  await charles.click('#dev-link');
  await toastWith(charles, 'You now sign in with babbage@example.com');

  await charles.locator('.side [data-r="settings"]').first().click();
  await charles.locator('.set-nav [data-sec="account"]').click();
  await charles.fill('#del-pw', CHARLES.password);
  await charles.click('#del-btn');
  await charles.locator('[data-a="confirmOk"]').click();
  await toastWith(charles, 'Your account was deleted.');
  await expect(charles.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await signIn(charles, { email: 'babbage@example.com', password: CHARLES.password });
  await expect(charles.locator('.auth .alert.danger')).toContainText('Incorrect email or password');
  expect(await charlesErrors(['password is incorrect'])).toEqual([]);
});
