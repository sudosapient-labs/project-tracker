import { expect, test } from '@playwright/test';
import { OWNER, OWNER_AFTER_RESET, signIn, signOut, toastWith, watchErrors } from './helpers.js';

test.describe.configure({ mode: 'serial' });

test('the first person signs up, verifies their email and sets up the workspace', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/');
  // No workspace yet: the app opens on sign up.
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
  await page.click('#signup-btn');
  await expect(page.locator('#name-err')).toBeVisible();

  await page.fill('#s-name', OWNER.name);
  await page.fill('#s-email', OWNER.email);
  await page.fill('#s-pw', OWNER.password);
  await page.click('#signup-btn');

  await expect(page.getByRole('heading', { name: 'Verify your email' })).toBeVisible();
  await page.click('#verified-btn');
  await toastWith(page, "haven't seen the verification yet");
  await page.click('#dev-link');

  // Onboarding: workspace name is required.
  await expect(page.getByRole('heading', { name: 'What are you working on?' })).toBeVisible();
  await page.click('#onb-next');
  await page.click('#onb-next');
  await expect(page.locator('#o-ws')).toBeVisible();
  await page.fill('#o-ws', 'Analytical Engines');
  await page.click('#onb-next');
  await page.click('#onb-next');
  await page.fill('#o-proj', 'Difference Engine');
  await page.click('#onb-next');
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await page.locator('[data-a="onbFinish"]').click();

  await toastWith(page, 'Welcome to Analytical Engines');
  await expect(page.locator('.proj-h')).toContainText('Difference Engine');
  // Starter tasks from the template were saved on the server.
  await expect(page.locator('[data-drag-card], [data-task-row]').first()).toBeVisible();
  await page.reload();
  await expect(page.locator('.side')).toContainText('Difference Engine');
  await expect(page.locator('.side')).toContainText('Analytical Engines');
  expect(await errors()).toEqual([]);
});

test('signing out ends the session; wrong passwords are refused; signing in restores the workspace', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toContainText('Difference Engine');
  await signOut(page);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await expect(page.locator('.auth .sub')).toContainText('Sign in to Analytical Engines');

  await page.fill('#l-email', OWNER.email);
  await page.fill('#l-pw', 'not-the-password-1');
  await page.click('#login-btn');
  await expect(page.locator('.auth .alert.danger')).toContainText('Incorrect email or password');

  await page.fill('#l-pw', OWNER.password);
  await page.click('#login-btn');
  await toastWith(page, `Signed in as ${OWNER.email}`);
  await expect(page.locator('.side')).toContainText('Difference Engine');
  expect(await errors()).toEqual([]);
});

test('a forgotten password is reset through the emailed link', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await page.fill('#f-email', OWNER.email);
  await page.click('#forgot-btn');
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await page.click('#dev-link');

  await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
  await page.fill('#r-pw', OWNER_AFTER_RESET.password);
  await page.fill('#r-pw2', 'mismatch-pass-77');
  await page.click('#reset-btn');
  await expect(page.locator('#pw2-err')).toBeVisible();
  await page.fill('#r-pw', OWNER_AFTER_RESET.password);
  await page.fill('#r-pw2', OWNER_AFTER_RESET.password);
  await page.click('#reset-btn');
  await expect(page.getByRole('heading', { name: 'Password updated' })).toBeVisible();

  await signIn(page, OWNER_AFTER_RESET);
  await expect(page.locator('.side')).toContainText('Difference Engine');
  expect(await errors()).toEqual([]);
});
