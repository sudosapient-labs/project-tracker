/* Whose clock a request is read on: always the person asking, never one clock for the whole team.
   "Friday 5pm" from someone in Dubai is 5 PM in Dubai, and what the bot tells them is on that clock.

   In this order (AGENTS.md "Dates and times"):
     1. the zone they saved in the tracker (a Member's `timeZone` when `timeZoneSource` is 'person');
     2. their Slack profile's zone (users.info → user.tz), which Slack keeps for everyone;
     3. the tracker's zone for them (the workspace's, else UTC: the Member's `timeZone` otherwise);
     4. SLACK_BOT_TIMEZONE (config.timezone), only when the tracker doesn't say (an older server).

   The zone is resolved once per request (handlers.js), carried in the run's context (ctx.tz) and on
   the request's own tracker client, and saved with a change waiting for Confirm, so a Confirm pressed
   later still reads the change on the asker's clock. Members come from directory() (cached a minute)
   and Slack profiles are cached here for PROFILE_TTL, so a changed zone is used within minutes.
   What counts as a zone (and today's name for an old one, like Slack's Asia/Calcutta) is
   @sudosapient/client/dates' modernZone, the same check the tracker makes. */
import { modernZone } from '@sudosapient/client/dates';

/** @typedef {{ tz: string, source: 'person' | 'slack' | 'workspace' | 'default' | 'fallback' }} Clock */

/**
 * A tracker member's clock, given their Slack profile's zone if any.
 * @param {{ timeZone?: string, timeZoneSource?: string } | null | undefined} member
 * @param {{ slackTz?: string | null, fallback: string }} o
 * @returns {Clock}
 */
export function clockOf(member, { slackTz = null, fallback }) {
  const own = member?.timeZoneSource === 'person' ? modernZone(member.timeZone) : null;
  if (own) return { tz: own, source: 'person' };
  const slack = modernZone(slackTz);
  if (slack) return { tz: slack, source: 'slack' };
  const tracker = modernZone(member?.timeZone);
  if (tracker) return { tz: tracker, source: member?.timeZoneSource === 'workspace' ? 'workspace' : 'default' };
  return { tz: fallback, source: 'fallback' };
}

export const PROFILE_TTL = 5 * 60_000;

/* Slack users' profile zones, each cached for `ttl`. `remember` takes a users.info answer someone
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
