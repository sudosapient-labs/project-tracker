// @ts-check
/* A member's clock: the time zone and time format from their settings, used whenever the server
   turns a start or due into words or a day for them (activity, notifications, reminders, sorting).
   The values themselves are read through packages/client/dates.js. */
import { validTz } from '../../src/core/constants.js';

/**
 * @param {{ userState(uid: string): { prefs?: Record<string, any> } }} repo
 * @param {string} uid
 * @returns {{ tz: string, time: '12' | '24' }}
 */
export function clockOf(repo, uid) {
  const p = repo.userState(uid).prefs || {};
  return { tz: validTz(p.tz), time: p.timeFmt === '24' ? '24' : '12' };
}
