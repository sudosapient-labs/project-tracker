// @ts-check
/* ---------- theme ---------- */
import { setDateFormat, setTimeFormat, setTimeZone } from './utils.js';
import { S } from './store.js';
import { zoneOf } from './clock.js';

export function applyPrefs() {
  const r = document.documentElement,
    p = S.prefs;
  setDateFormat(p.dateFmt);
  setTimeZone(zoneOf(p, S.data.ws));
  setTimeFormat(p.timeFmt);
  if (p.theme === 'system') r.removeAttribute('data-theme');
  else r.setAttribute('data-theme', p.theme);
  if (p.accent === 'indigo') r.removeAttribute('data-accent');
  else r.setAttribute('data-accent', p.accent);
  r.setAttribute('data-side', p.side);
  r.setAttribute('data-density', p.density);
  if (p.motion === 'reduce') r.setAttribute('data-motion', 'reduce');
  else r.removeAttribute('data-motion');
  themeColor();
}
/* The browser's (and the Android app's status bar) colour follows the theme chosen in Settings, not
   only the system's: it is the page background (`--bg`) of whichever theme is showing. */
let shownDark = /** @type {boolean | null} */ (null);
function themeColor() {
  const dark = effectiveDark();
  if (dark === shownDark) return;
  shownDark = dark;
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  if (bg) for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.setAttribute('content', bg);
}
export function effectiveDark() {
  if (S.prefs.theme === 'dark') return true;
  if (S.prefs.theme === 'light') return false;
  return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
}
