/* ---------- subtask detail view (inside the task drawer) ---------- */
import { esc, relDate } from '../core/utils.js';
import { ic } from '../core/icons.js';
import { mem } from '../core/store.js';
import { av } from '../ui/helpers.js';

export function subtaskHtml(t, s) {
  const i = t.subtasks.indexOf(s);
  return `<div class="subview">
    <button class="pillbtn" data-a="closeSub" style="margin:-4px 0 14px -7px;font-size:12.5px;color:var(--text-2)">${ic('arrow-left', 14)}<span class="trunc" style="max-width:420px">${esc(t.title)}</span></button>
    <div class="row" style="gap:10px;align-items:flex-start">
      <input type="checkbox" class="check round" style="margin-top:9px" ${s.done ? 'checked' : ''} data-a="toggleSub" data-id="${t.id}" data-sid="${s.id}" aria-label="${s.done ? 'Mark subtask not done' : 'Mark subtask done'}">
      <textarea class="ttl-edit" id="s-title" rows="1" data-autosize data-blur="commitSubTitle" data-key-enter="blur" data-id="${t.id}" data-sid="${s.id}" aria-label="Subtask title" style="${s.done ? 'text-decoration:line-through;color:var(--text-3)' : ''}">${esc(s.title)}</textarea>
    </div>
    <div class="faint" style="font-size:12px;margin:4px 0 0 26px">Subtask ${i + 1} of ${t.subtasks.length} · ${s.done ? 'Done' : 'Open'}</div>
    <dl class="kv" style="margin-top:16px">
      <dt>${ic('user', 14)}Assignee</dt><dd><button class="pillbtn ${s.assignee ? '' : 'empty'}" data-a="pop" data-pop="subassignee" data-id="${t.id}" data-i="${i}">${av(s.assignee, 'sm', false)}<span>${s.assignee ? esc(mem(s.assignee)?.name) : 'Unassigned'}</span></button></dd>
      <dt>${ic('calendar', 14)}Due</dt><dd><button class="pillbtn ${s.due ? '' : 'empty'}" data-a="pop" data-pop="date" data-field="subdue" data-id="${t.id}" data-i="${i}">${ic('calendar', 13)}<span class="num">${s.due ? relDate(s.due) : 'Set date'}</span></button></dd>
      <dt>${ic('folder', 14)}Parent</dt><dd><button class="pillbtn" data-a="closeSub"><span class="mono faint" style="font-size:11px">${t.key}</span>${esc(t.title)}</button></dd>
    </dl>
    <div class="dsec"><div class="dsec-h"><h3 id="s-note-l">Notes</h3></div>
      <textarea class="textarea" id="s-note" data-in="subNote" data-id="${t.id}" data-sid="${s.id}" rows="4" placeholder="Add details, links, or acceptance criteria…" aria-labelledby="s-note-l">${esc(s.note || '')}</textarea></div>
    <div class="dsec row" style="gap:6px;flex-wrap:wrap">
      <button class="btn btn-secondary btn-sm" data-a="promoteSub" data-id="${t.id}" data-sid="${s.id}">${ic('arrow-up-right', 13)}Convert to task</button>
      <span class="sp"></span>
      <button class="btn btn-sm btn-ghost" data-a="subNav" data-id="${t.id}" data-d="-1" ${i === 0 ? 'disabled' : ''} aria-label="Previous subtask">${ic('chevron-left', 14)}Previous</button>
      <button class="btn btn-sm btn-ghost" data-a="subNav" data-id="${t.id}" data-d="1" ${i === t.subtasks.length - 1 ? 'disabled' : ''} aria-label="Next subtask">Next${ic('chevron-right', 14)}</button>
      <button class="btn btn-sm btn-danger-ghost" data-a="rmSub" data-id="${t.id}" data-sid="${s.id}">${ic('trash-2', 13)}Delete</button>
    </div>
  </div>`;
}
