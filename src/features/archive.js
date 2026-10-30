/* ---------- archive ---------- */
import { ago, esc } from '../core/utils.js';
import { ic } from '../core/icons.js';
import { PSTAT } from '../core/constants.js';
import { D, S, canSee, proj } from '../core/store.js';
import { empty, pIcon, stIcon } from '../ui/helpers.js';

export function pageArchive() {
  const tab = S.ui.archTab || 'tasks';
  const ts = D()
    .tasks.filter(t => t.archived && canSee(proj(t.project)) && !proj(t.project)?.archived)
    .sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0));
  const ps = D().projects.filter(p => p.archived);
  const row = (lead, title, sub, when, restoreAct, delAct, id) =>
    `<div class="mini" style="min-height:52px;cursor:default;gap:12px">${lead}<div class="grow" style="min-width:0"><div class="trunc" style="font-weight:500">${title}</div><div class="faint trunc" style="font-size:12px">${sub}</div></div><span class="faint hide-m" style="font-size:12px;white-space:nowrap">${when}</span><button class="btn btn-secondary btn-sm" data-a="${restoreAct}" data-id="${id}">${ic('rotate-ccw', 13)}Restore</button><button class="ibtn ibtn-sm" data-a="${delAct}" data-id="${id}" data-tip="Delete permanently" aria-label="Delete permanently" style="color:var(--red)">${ic('trash-2', 15)}</button></div>`;
  const body =
    tab === 'tasks'
      ? ts.length
        ? `<div class="panel" style="overflow:hidden">${ts
            .map(t => {
              const p = proj(t.project);
              return row(
                stIcon(t.status, 15),
                esc(t.title),
                `<span class="mono">${t.key}</span> · ${esc(p.name)}`,
                t.archivedAt ? 'Archived ' + ago(t.archivedAt) : 'Archived',
                'restoreTask',
                'purgeTask',
                t.id,
              );
            })
            .join('')}</div>`
        : `<div class="panel">${empty('archive', 'No archived tasks', 'Archive finished or abandoned tasks to keep boards focused. They wait here until you restore them.', '')}</div>`
      : ps.length
        ? `<div class="panel" style="overflow:hidden">${ps.map(p => row(pIcon(p, '', 14), esc(p.name), `${D().tasks.filter(t => t.project === p.id).length} tasks · ${PSTAT[p.status]?.name || 'Restricted'}`, p.archivedAt ? 'Archived ' + ago(p.archivedAt) : 'Archived', 'restoreProject', 'delProject', p.id)).join('')}</div>`
        : `<div class="panel">${empty('archive', 'No archived projects', 'Archived projects disappear from the sidebar and project lists but keep every task, file, and comment.', '')}</div>`;
  return `<div class="page" style="max-width:900px">
    <div class="ph"><div><h1>Archive</h1><p>Archived work is hidden everywhere else. Restore it any time, or delete it for good.</p></div></div>
    <div class="tabs" style="margin-bottom:14px" role="tablist" aria-label="Archive">${[
      ['tasks', 'Tasks', ts.length],
      ['projects', 'Projects', ps.length],
    ]
      .map(
        ([k, n, c]) =>
          `<button role="tab" aria-selected="${tab === k}" class="tab ${tab === k ? 'on' : ''}" data-a="set" data-k="archTab" data-v="${k}">${n}<span class="cnt">${c}</span></button>`,
      )
      .join('')}</div>
    ${body}
  </div>`;
}
