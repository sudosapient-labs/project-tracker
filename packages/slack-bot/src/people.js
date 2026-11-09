/* Who is asking, and what they may see and change.

   The bot acts in the tracker as its own bot member ("Sudo Tracker", created in Settings → API →
   Bots), so the tracker's permission rules apply to the bot. Many people share it, though, and the
   bot may be on projects they aren't, so every request is also checked against the requester:
   their Slack account is mapped to a tracker member, and the bot only reads or changes projects
   that member could open in the app (and only edits where they could edit).

   Mapping: a Slack user's verified Slack email is matched to an active tracker member's email.
   When the two differ, a tracker Owner or Admin can link them by hand (`/sudo link @user email`).
   Unmatched people can only ask for help.

   Project access mirrors the app's rule (src/core/access.js projectLevel): the lead has full
   access, listed people can edit (Guests comment), and every non-Guest can edit a project open to
   the workspace; private projects are for listed people only. One difference: /api/v1 doesn't
   expose per-person levels set in the share dialog ("Can view", "Can comment"), so a listed
   person counts as an editor here. The tracker still enforces the bot's own access; see ROADMAP.md
   for closing this with delegated access. */
import { clockOf, slackZones, trackerZone } from './clock.js';

export const VIEW = 1;
export const COMMENT = 2;
export const EDIT = 3;
export const FULL = 4;
const ADMIN = new Set(['Owner', 'Admin']);
export const isAdmin = m => ADMIN.has(m?.role);

export function level(project, member) {
  if (!project || !member) return 0;
  if (project.lead && project.lead === member.id) return FULL;
  if ((project.members || []).includes(member.id)) return member.role === 'Guest' ? COMMENT : EDIT;
  return !project.private && member.role !== 'Guest' ? EDIT : 0;
}

/* Whether a project's work may be shown where the conversation is. Replies, cards and previews in
   a channel are seen by everyone in it, not just the person who asked, so a private project's work
   is shown only in a DM, or in a private channel linked to that project (`/sudo project KEY`).
   `where`: { dm, private, project } (ctx.slack). */
export const shownHere = (project, where = {}) => !project.private || !!where.dm || (!!where.private && where.project === project.key);

const TTL = 60_000;

/* Members and projects as the bot sees them, cached for a minute (they change rarely, and every
   request needs them). `refresh()` after a write that changes them. */
export function directory(api, { ttl = TTL, now = () => Date.now() } = {}) {
  let cache = null;
  async function load() {
    if (cache && now() - cache.at < ttl) return cache;
    // Archived projects too, so their tasks can still be looked up.
    const [members, projects] = await Promise.all([api.all('/members', {}, 1000), api.all('/projects', { includeArchived: 'true' }, 1000)]);
    cache = { at: now(), members, projects };
    return cache;
  }
  const norm = s =>
    String(s || '')
      .trim()
      .toLowerCase();
  return {
    refresh: () => {
      cache = null;
    },
    members: async () => (await load()).members,
    projects: async () => (await load()).projects,
    member: async id => (await load()).members.find(m => m.id === id) || null,
    byEmail: async email => (await load()).members.find(m => m.kind !== 'bot' && m.status === 'active' && norm(m.email) === norm(email)) || null,
    project: async ref => {
      const up = String(ref || '').toUpperCase();
      return (await load()).projects.find(p => p.id === ref || p.key === up) || null;
    },
    projectById: async id => (await load()).projects.find(p => p.id === id) || null,
    /* Projects the member can open, among those the bot can. */
    visible: async member => (await load()).projects.filter(p => level(p, member) >= VIEW),
  };
}

const RECHECK = 60 * 60_000;

/* Slack user → tracker member, or a reason they can't be matched; and whose clock they read on
   (clock.js). `fallbackTz`: SLACK_BOT_TIMEZONE, for when neither the tracker nor Slack says. */
export function people({ slack, store, dir, fallbackTz = 'UTC', now = () => Date.now() }) {
  const zones = slackZones(slack, { now });
  async function slackEmail(slackUser) {
    try {
      const r = await slack.users.info({ user: slackUser });
      zones.remember(slackUser, r.user);
      if (r.user?.is_bot || r.user?.deleted) return { error: 'bot' };
      return { email: r.user?.profile?.email || '', name: r.user?.real_name || r.user?.profile?.display_name || r.user?.name || '' };
    } catch {
      return { error: 'lookup' };
    }
  }

  return {
    /* { member } when matched, else { reason, email } (reason: no_email, no_member, bot, lookup). */
    async resolve(slackUser) {
      const saved = store.person(slackUser);
      if (saved?.member_id && (saved.manual || now() - saved.checked_at < RECHECK)) {
        const member = await dir.member(saved.member_id);
        // A link made by hand holds only while the admin who made it still is one, and while the
        // linked member isn't an Owner or Admin: `link` refuses those, and a member promoted since
        // must not be reachable through a link either.
        const linker = saved.manual ? await dir.member(saved.linked_by) : null;
        const linkOk = !saved.manual || (linker && linker.status === 'active' && isAdmin(linker) && !isAdmin(member));
        if (member && member.status === 'active' && member.kind !== 'bot' && linkOk) return { member };
        store.forgetPerson(slackUser);
      }
      const s = await slackEmail(slackUser);
      if (s.error) return { reason: s.error };
      if (!s.email) return { reason: 'no_email' };
      const member = await dir.byEmail(s.email);
      if (!member) return { reason: 'no_member', email: s.email };
      store.savePerson({ slackUser, memberId: member.id, email: s.email }, now());
      return { member };
    },
    /* A tracker Owner/Admin links someone whose Slack email isn't their tracker email. Never to an
       Owner or Admin, never to themselves, and never to a member another Slack account already
       maps to, so a link can't be used to take over someone's identity. Returns { member } or
       { error } (no_member, privileged, self, taken). */
    async link(slackUser, email, by) {
      const member = await dir.byEmail(email);
      if (!member) return { error: 'no_member' };
      if (isAdmin(member)) return { error: 'privileged' };
      if (member.id === by.id || store.person(slackUser)?.member_id === by.id) return { error: 'self' };
      const other = store.slackUserOf(member.id);
      if (other && other !== slackUser) return { error: 'taken' };
      store.savePerson({ slackUser, memberId: member.id, email, manual: true, linkedBy: by.id }, now());
      return { member };
    },
    unlink: slackUser => store.forgetPerson(slackUser),
    /* The clock `member` (resolved for `slackUser`) reads and writes dates on: { tz, source }. The
       Slack profile is asked only when the tracker doesn't say. */
    clock: async (slackUser, member) => clockOf(member, { slackTz: trackerZone(member) ? null : await zones.of(slackUser), fallback: fallbackTz }),
  };
}

/* Why someone couldn't be matched, in words for Slack. */
export function unmatchedText(r, botName) {
  if (r.reason === 'no_member')
    return `I couldn’t find a Sudo Sapient member with your Slack email (${r.email}). Ask a workspace admin to invite that address, or to link you with \`/sudo link @you your-tracker-email\`.`;
  if (r.reason === 'no_email')
    return `Your Slack profile doesn’t share an email address, so I can’t match you to a Sudo Sapient member. Ask an admin to link you with \`/sudo link\`.`;
  if (r.reason === 'bot') return `${botName} only takes requests from people.`;
  return `I couldn’t look up your Slack profile just now. Try again in a moment.`;
}
