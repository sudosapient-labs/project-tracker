import { expect, test } from '@playwright/test';
import { MATE, OWNER_AFTER_RESET as OWNER, emailLink, openProject, signIn, synced, toastWith, watchErrors } from './helpers.js';

test.describe.configure({ mode: 'serial' });

let ada, grace, adaErrors, graceErrors;
test.beforeAll(async ({ browser }) => {
  ada = await (await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })).newPage();
  grace = await (await browser.newContext()).newPage();
  adaErrors = watchErrors(ada);
  graceErrors = watchErrors(grace);
});
test.afterAll(async () => {
  await ada.context().close();
  await grace.context().close();
});

const row = (page, title) => page.locator('[data-task-row]', { hasText: title }).first();

test('an admin invites a teammate, who joins through the emailed link', async () => {
  await signIn(ada, OWNER);
  await ada.locator('.side [data-r="members"]').click();
  await ada.locator('[data-a="invite"]').first().click();
  await ada.fill('#inv-emails', MATE.email);
  await ada.click('#inv-submit');
  await toastWith(ada, '1 invitation sent');
  const invited = ada.locator('tr', { hasText: MATE.email });
  await expect(invited).toContainText('Invited');

  const link = emailLink(MATE.email);
  expect(link).toMatch(/#invite\//);
  await grace.goto(link);
  await expect(grace.getByRole('heading', { name: 'Join Analytical Engines' })).toBeVisible();
  await expect(grace.locator('#s-email')).toHaveValue(MATE.email);
  await grace.fill('#s-name', MATE.name);
  await grace.fill('#s-pw', MATE.password);
  await grace.click('#signup-btn');
  // The invite proves the email address, so there's no verification step.
  await toastWith(grace, 'Welcome, Grace');
  await expect(grace.locator('.side')).toContainText('Analytical Engine');

  // Ada's member list updates live as Grace joins.
  await expect(invited).toContainText('Active');
  expect(await adaErrors()).toEqual([]);
  expect(await graceErrors()).toEqual([]);
});

test('work done by one person appears live for the other, with notifications', async () => {
  await openProject(ada, 'Analytical Engine');
  await openProject(grace, 'Analytical Engine');

  // Grace adds a task; it appears on Ada's screen without a reload.
  await grace.locator('[data-a="startComposer"]').first().click();
  await grace.fill('#composer-in', 'Build the printer');
  await grace.press('#composer-in', 'Enter');
  await grace.press('#composer-in', 'Escape');
  await expect(row(ada, 'Build the printer')).toBeVisible();

  // Ada assigns it to Grace; Grace is notified live.
  await row(ada, 'Build the printer').locator('[data-a="openTask"]').first().click();
  await ada.locator('.drawer [data-pop="assignee"]').first().click();
  await ada.locator('.pop [data-a="popPick"]', { hasText: MATE.name }).click();
  await synced(ada);
  await expect(row(grace, 'Build the printer')).toContainText('GH');
  await grace.locator('.side [data-r="inbox"]').click();
  await expect(grace.locator('[data-a="selNotif"]', { hasText: 'assigned you' })).toBeVisible();

  // Grace replies from her inbox, mentioning Ada; Ada gets the mention.
  await grace.locator('[data-a="selNotif"]', { hasText: 'assigned you' }).click();
  await row(grace, 'Build the printer')
    .waitFor({ state: 'detached' })
    .catch(() => {});
  await grace.locator('.side [data-r="mytasks"]').click();
  await row(grace, 'Build the printer').locator('[data-a="openTask"]').first().click();
  await grace.fill('#d-cmt', 'On it, @Ada Lovelace. Needs a stereotype mould.');
  await grace.locator('.drawer [data-a="postComment"]').click();
  await expect(ada.locator('.drawer')).toContainText('Needs a stereotype mould.');
  await ada.locator('.side [data-r="inbox"]').click();
  const mention = ada.locator('[data-a="selNotif"]', { hasText: 'mentioned you in' });
  await expect(mention).toBeVisible();
  await mention.click();
  await synced(ada);
  await ada.reload();
  await expect(ada.locator('[data-a="selNotif"]', { hasText: 'mentioned you in' }).locator('[aria-label="Unread"]')).toHaveCount(0);

  expect(await adaErrors()).toEqual([]);
  expect(await graceErrors()).toEqual([]);
});

test('roles and removal: an admin changes a role and removes a member, who is signed out', async () => {
  await ada.locator('.side [data-r="members"]').click();
  const gRow = ada.locator('tr', { hasText: MATE.email });
  await gRow.locator('[data-pop="role"]').click();
  await ada.locator('.pop [data-a="popPick"]', { hasText: 'Admin' }).click();
  await synced(ada);
  await expect(gRow).toContainText('Admin');
  await ada.reload();
  await expect(ada.locator('tr', { hasText: MATE.email })).toContainText('Admin');

  await ada.locator('tr', { hasText: MATE.email }).locator('[data-a="ctxBtn"]').click();
  await ada.locator('.pop [data-a="removeMember"]').click();
  await ada.locator('[data-a="confirmOk"]').click();
  await expect(ada.locator('tr', { hasText: MATE.email })).toHaveCount(0);
  await synced(ada);
  // Grace's open session ends.
  await expect(grace.getByRole('heading', { name: 'Welcome back' })).toBeVisible({ timeout: 15000 });
  expect(await adaErrors()).toEqual([]);
});

test('a copied invite link lets someone join as a member after verifying their email', async () => {
  await ada.locator('[data-a="invite"]').first().click();
  await ada.locator('.modal [data-a="copyInviteLink"]').click();
  await toastWith(ada, 'Invite link copied');
  const link = await ada.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(/#join\//);

  await grace.goto(link);
  await expect(grace.getByRole('heading', { name: 'Join Analytical Engines' })).toBeVisible();
  await grace.fill('#s-name', 'Charles Babbage');
  await grace.fill('#s-email', 'charles@example.com');
  await grace.fill('#s-pw', 'difference-engine-3');
  await grace.click('#signup-btn');
  await expect(grace.getByRole('heading', { name: 'Verify your email' })).toBeVisible();
  await grace.goto(emailLink('charles@example.com'));
  await toastWith(grace, 'Email verified');
  await expect(grace.locator('.side')).toContainText('Analytical Engine');
  expect(await graceErrors()).toEqual([]);
});
