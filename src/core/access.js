/* Project permissions, shared by the server (which enforces them) and the client (which hides what
   the server would refuse). Levels match the share dialog's choices. */
export const PERMS = ['Can view', 'Can comment', 'Can edit', 'Full access'];
export const VIEW = 1;
export const COMMENT = 2;
export const EDIT = 3;
export const FULL = 4;
const RANK = { Owner: 4, Admin: 3, Member: 2, Guest: 1 };
export const isAdminRole = m => RANK[m?.role] >= RANK.Admin;

/* 0 (no access) to FULL for person `m` in project `p`. The lead has full access; listed people get
   their share-dialog permission (by default Guests comment and everyone else edits); on a project
   open to the workspace every non-Guest can edit. Private projects are for listed people only. */
export function projectLevel(p, m) {
  if (!p || !m) return 0;
  if (p.lead && p.lead === m.id) return FULL;
  if ((p.members || []).includes(m.id)) return PERMS.indexOf(p.perms?.[m.id]) + 1 || (m.role === 'Guest' ? COMMENT : EDIT);
  return !p.private && m.role !== 'Guest' ? EDIT : 0;
}
export const canSeeProject = (p, m) => projectLevel(p, m) >= VIEW;
/* Settings (members, privacy, permissions, lead, archive, delete) need full access. Owners and
   Admins always hold them, even on a private project whose work they can't open. */
export const canManageProject = (p, m) => !!p && !!m && (isAdminRole(m) || projectLevel(p, m) === FULL);
