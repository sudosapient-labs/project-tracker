import { expect } from '@playwright/test';

export const OWNER = { name: 'Ada Lovelace', email: 'ada@example.com', password: 'analytical-engine-1' };
// 01-auth resets the owner's password to this; later journeys sign in with it.
export const OWNER_AFTER_RESET = { ...OWNER, password: 'new-engine-pass-7' };
export const MATE = { name: 'Grace Hopper', email: 'grace@example.com', password: 'compiler-nanosecond-2' };

/* Collect uncaught page errors and error toasts (e.g. a change the server rejected), so every
   journey also asserts the app never crashed or silently failed to save. Call `errors()` at the end. */
export function watchErrors(page) {
  const list = [];
  page.on('pageerror', e => list.push(e.message));
  page.on('console', m => m.type() === 'error' && !/Failed to load resource|ERR_|net::/.test(m.text()) && list.push(m.text()));
  page.addInitScript(() => {
    window.__errToasts = [];
    addEventListener('DOMContentLoaded', () =>
      new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => n.querySelector?.('.bad') && window.__errToasts.push(n.textContent)))).observe(
        document.getElementById('toasts'),
        { childList: true },
      ),
    );
  });
  const out = async (allow = []) => [...list, ...(await page.evaluate(() => window.__errToasts || []))].filter(e => !allow.some(a => e.includes(a)));
  return out;
}

export async function signIn(page, { email, password }) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await page.fill('#l-email', email);
  await page.fill('#l-pw', password);
  await page.click('#login-btn');
}

export async function signOut(page) {
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.locator('.pop [data-a="signOut"]').click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
}

/* Toast text appears in #toasts; wait for one containing `text`. */
export const toastWith = (page, text) => expect(page.locator('#toasts .toast', { hasText: text }).first()).toBeVisible();

/* Every local change has reached the server (see <html data-sync>). */
export async function synced(page) {
  await page.waitForTimeout(200);
  await expect(page.locator('html')).toHaveAttribute('data-sync', 'saved');
}

/* Open a project from the sidebar and switch to one of its tabs. */
export async function openProject(page, name, tab = 'list') {
  await page
    .locator('.side [data-drag-proj]')
    .filter({ has: page.getByText(name, { exact: true }) })
    .click();
  await page.locator(`.tab[data-tab="${tab}"]`).click();
}

/* The newest link emailed to `to` (the e2e server records outgoing mail in its outbox table). */
import { DatabaseSync } from 'node:sqlite';
export function emailLink(to) {
  const db = new DatabaseSync('test-results/e2e-data/db.sqlite', { readOnly: true });
  try {
    return db.prepare('SELECT link FROM outbox WHERE to_addr = ? ORDER BY id DESC').get(to)?.link;
  } finally {
    db.close();
  }
}
