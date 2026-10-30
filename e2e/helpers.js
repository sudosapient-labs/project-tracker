import { expect } from '@playwright/test';

export const OWNER = { name: 'Ada Lovelace', email: 'ada@example.com', password: 'analytical-engine-1' };
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
