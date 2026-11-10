// @ts-check
/* Whose clock: the one place the server decides which time zone to read a start, due or moment on
   for someone (activity, notifications, reminders, digests, repeats, sorting, the API's effective
   zone). The person's saved zone (Settings → Date and time), else the workspace's (Settings →
   Workspace), else UTC. Never the machine's zone: on a server that is UTC, not the person's. The
   values themselves are read through packages/client/dates.js. */
import { validTz } from '../../src/core/constants.js';

/** @typedef {'person' | 'workspace' | 'default'} ClockSource */

/**
 * The workspace's clock, for people with no zone of their own (and for work no one person reads).
 * @param {{ workspace(): Record<string, any> | null }} repo
 * @returns {{ tz: string, source: 'workspace' | 'default' }}
 */
export function workspaceClock(repo) {
  const tz = validTz(repo.workspace()?.tz);
  return tz ? { tz, source: 'workspace' } : { tz: 'UTC', source: 'default' };
}

/**
 * A member's clock: their time zone, where it comes from, and their time format.
 * @param {{ userState(uid: string): { prefs?: Record<string, any> }, workspace(): Record<string, any> | null }} repo
 * @param {string | null | undefined} uid
 * @returns {{ tz: string, time: '12' | '24', source: ClockSource }}
 */
export function clockOf(repo, uid) {
  const p = (uid && repo.userState(uid).prefs) || {};
  const own = validTz(p.tz);
  const { tz, source } = own ? { tz: own, source: /** @type {ClockSource} */ ('person') } : workspaceClock(repo);
  return { tz, time: p.timeFmt === '24' ? '24' : '12', source };
}
