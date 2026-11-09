/* Whose clock a request is read on: always the person asking, never one clock for the team.
   "Friday 5pm" from someone in Dubai is 5 PM in Dubai, and what the bot tells them is on that clock.

   The same clock the tracker uses for them (AGENTS.md "Dates and times"; server/lib/clock.js), so
   what they ask the bot and what the tracker sends them (reminders, the digest, notifications) agree:
     1. the zone they saved in the tracker, else the workspace's, else UTC: their Member's
        `timeZone`, whatever its `timeZoneSource` ('person', 'workspace' or 'default');
   and only when the tracker doesn't say (an older server, without `timeZone` on Members):
     2. their Slack profile's zone (users.info → user.tz);
     3. SLACK_BOT_TIMEZONE (config.timezone).

   The zone is resolved once per request (handlers.js), carried in the run's context (ctx.tz) and on
   the request's own tracker client, and saved with a change waiting for Confirm, so a Confirm pressed
   later still reads the change on the asker's clock. Members come from directory() (cached a minute)
   and Slack profiles, when they're needed, are cached here for PROFILE_TTL, so a changed zone is
   used within minutes. What counts as a zone (and today's name for an old one, like Slack's
   Asia/Calcutta) is @sudosapient/client/dates' modernZone, the same check the tracker makes. */
import { modernZone } from '@sudosapient/client/dates';

/** @typedef {{ tz: string, source: 'person' | 'workspace' | 'default' | 'slack' | 'fallback' }} Clock */

const SOURCES = new Set(['person', 'workspace', 'default']);
/** The zone the tracker reads `member`'s dates on, or null when it doesn't say (an older server). */
export const trackerZone = (/** @type {{ timeZone?: string } | null | undefined} */ member) => modernZone(member?.timeZone);

/**
 * A tracker member's clock; their Slack profile's zone only counts when the tracker doesn't say.
 * @param {{ timeZone?: string, timeZoneSource?: string } | null | undefined} member
 * @param {{ slackTz?: string | null, fallback: string }} o
 * @returns {Clock}
 */
export function clockOf(member, { slackTz = null, fallback }) {
  const tracker = trackerZone(member);
  if (tracker) {
    const source = /** @type {Clock['source']} */ (SOURCES.has(String(member?.timeZoneSource)) ? member?.timeZoneSource : 'default');
    return { tz: tracker, source };
  }
  const slack = modernZone(slackTz);
  if (slack) return { tz: slack, source: 'slack' };
  return { tz: fallback, source: 'fallback' };
}

export const PROFILE_TTL = 5 * 60_000;

/* Slack users' profile zones (for when the tracker doesn't say), each cached for `ttl`. `remember` takes a users.info answer someone
   else already fetched (people.js), so the profile isn't asked for twice. */
export function slackZones(slack, { ttl = PROFILE_TTL, now = () => Date.now() } = {}) {
  const seen = new Map();
  const remember = (user, profile) => {
    if (seen.size > 5000) seen.clear();
    seen.set(user, { at: now(), tz: modernZone(profile?.tz) });
  };
  return {
    remember,
    /* The zone on `user`'s Slack profile, or null (none, or Slack didn't answer). */
    async of(user) {
      if (!user) return null;
      const hit = seen.get(user);
      if (hit && now() - hit.at < ttl) return hit.tz;
      try {
        const r = await slack.users.info({ user });
        remember(user, r.user);
        return seen.get(user).tz;
      } catch {
        return null;
      }
    },
  };
}

/* "Siddharth's" for "Siddharth Rao": whose clock, in the words of the request. */
export const whose = name => {
  const first = String(name || '')
    .trim()
    .split(/\s+/)[0];
  return first ? `${first}'s` : 'their';
};
