// @ts-check
/* ---------- whose clock (the app) ----------
   The time zone the app reads starts and dues in: the person's saved zone (Settings → Date and
   time), else their browser's, else the workspace's (Settings → Workspace), else UTC. The server
   decides the same way (server/lib/clock.js), without the browser: the app saves the browser's zone
   as the person's the first time they open it with none saved (actions/session.js), so both agree.
   This is the only place in the app that reads the browser's zone. */
import { modernTz, validTz } from './constants.js';

/** The browser's time zone, under its current name; null when it doesn't say or names none. */
export function browserTz() {
  try {
    return modernTz(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return null;
  }
}

/**
 * @param {{ tz?: unknown } | null | undefined} prefs  the person's preferences
 * @param {{ tz?: unknown } | null | undefined} [ws]  the workspace
 * @returns {string}
 */
export const zoneOf = (prefs, ws) => validTz(prefs?.tz) || browserTz() || validTz(ws?.tz) || 'UTC';
