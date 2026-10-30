/* ---------------- CONTEXT MENUS ---------------- */
import { ic } from '../core/icons.js';
import { ST } from '../core/constants.js';
import { D, canEdit, canManage, canSee, me, mem, proj, task, visibleProjects } from '../core/store.js';

export function ctxMenu(p) {
  const I = (act, icon, label, extra = '', r = '') =>
    `<button class="mi ${extra}" data-a="${act}" data-id="${p.id}" data-key="${p.key || ''}">${ic(icon, 15)}${label}${r ? `<span class="r">${r}</span>` : ''}</button>`;
  const sep = '<div class="msep"></div>';
  if (p.ctx === 'task') {
    const t = task(p.id);
    if (!t) return '';
    if (!canEdit(proj(t.project)))
      return (
        I('openTask', 'panel-right-open', 'Open') +
        I('toggleFavTask', 'star', t.fav ? 'Remove from favorites' : 'Add to favorites') +
        I('copyLink', 'link', 'Copy link')
      );
    return (
      I('openTask', 'panel-right-open', 'Open') +
      I('editTask', 'pencil', 'Edit', '', 'E') +
      I('toggleDone', t.status === 'done' ? 'rotate-ccw' : 'circle-check', t.status === 'done' ? 'Reopen' : 'Mark complete') +
      sep +
      I('ctxStatus', 'circle-dot', 'Status…') +
      I('ctxAssign', 'user', 'Assign to…') +
      I('ctxPrio', 'signal-high', 'Priority…') +
      I('ctxMove', 'folder-input', 'Move to project…') +
      sep +
      I('toggleFavTask', 'star', t.fav ? 'Remove from favorites' : 'Add to favorites') +
      I('copyLink', 'link', 'Copy link') +
      I('dupTask', 'copy', 'Duplicate') +
      I('archiveTask', 'archive', 'Archive') +
      sep +
      I('delTask', 'trash-2', 'Delete', 'danger', 'Del')
    );
  }
  if (p.ctx === 'project') {
    const pr = proj(p.id);
    if (!pr) return '';
    const see = canSee(pr);
    return (
      I('openProject', 'arrow-up-right', 'Open') +
      I('toggleFavProj', 'star', pr.fav ? 'Remove from favorites' : 'Add to favorites') +
      (canEdit(pr) ? I('editProject', 'pencil', 'Rename & edit') : '') +
      (see || canManage(pr) ? I('share', 'share-2', see ? 'Share' : 'Manage access') : '') +
      I('copyLink', 'link', 'Copy link') +
      (see && me()?.role !== 'Guest' ? I('dupProject', 'copy', 'Duplicate') : '') +
      sep +
      (visibleProjects().indexOf(pr) > 0 ? I('projUp', 'arrow-up', 'Move up in sidebar') : '') +
      (visibleProjects().indexOf(pr) < visibleProjects().length - 1 ? I('projDown', 'arrow-down', 'Move down in sidebar') : '') +
      sep +
      (canManage(pr)
        ? I('archiveProject', 'archive', pr.status === 'complete' ? 'Archive' : 'Archive project') + I('delProject', 'trash-2', 'Delete project', 'danger')
        : '')
    );
  }
  if (p.ctx === 'column') {
    return (
      `<div class="mh">${ST[p.id].name}</div>` +
      I('colAdd', 'plus', 'Add task') +
      I('colCollapse', 'fold-horizontal', 'Collapse column') +
      (p.id !== 'done' ? I('colDoneAll', 'check-check', 'Mark all as done') : I('colArchive', 'archive', 'Archive completed')) +
      I('colSortPrio', 'arrow-down-wide-narrow', 'Sort by priority')
    );
  }
  if (p.ctx === 'member') {
    const m = mem(p.id);
    if (!m) return '';
    const canRm = m.role !== 'Owner' && m.id !== D().me;
    return (
      I('viewProfile', 'user', 'View profile') +
      I('assignToMember', 'plus', 'Assign a task') +
      (m.email ? I('copyEmail', 'mail', 'Copy email') : '') +
      (canRm
        ? I('ctxRole', 'shield', 'Change role…') +
          (m.status === 'invited' ? I('resendInvite', 'send', 'Resend invite') : '') +
          (me()?.role === 'Owner' && m.status === 'active' ? I('reset2fa', 'shield-off', 'Reset two-factor…') : '') +
          sep +
          I('removeMember', 'user-minus', 'Remove from workspace', 'danger')
        : '')
    );
  }
  if (p.ctx === 'file') {
    return (
      I('previewFile', 'eye', 'Preview') +
      I('renameFile', 'pencil', 'Rename') +
      I('copyLink', 'link', 'Copy link') +
      I('dupFile', 'copy', 'Duplicate') +
      sep +
      I('delFile', 'trash-2', 'Delete', 'danger')
    );
  }
  if (p.ctx === 'savedview') {
    return `<button class="mi" data-a="renameView" data-id="${p.vid}">${ic('pencil', 15)}Rename view</button><button class="mi danger" data-a="delView" data-id="${p.vid}">${ic('trash-2', 15)}Delete view</button>`;
  }
  return '';
}
