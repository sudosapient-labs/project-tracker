/* =====================================================================
   COMPLETION: teams (create / edit / delete), subtask detail view, archive
   ===================================================================== */
import { esc } from '../core/utils.js';
import { ic } from '../core/icons.js';
import { PCOLORS, PICONS } from '../core/constants.js';
import { D, S, TM } from '../core/store.js';
import { av } from '../ui/helpers.js';

export function teamModal(m, H) {
  const f = S.ui.tform;
  const err = S.ui.errors.tname;
  const people = D().members.filter(x => x.status !== 'deactivated');
  return `${H(m.edit ? 'Edit team' : 'New team', m.edit ? '' : 'Teams group the people who work on projects together.')}
  <form class="modal-b" data-submit="submitTeam">
    <div class="row" style="gap:10px;align-items:flex-start">
      <span class="picon lg" style="--c:${PCOLORS[f.color]};margin-top:22px" aria-hidden="true">${ic(f.icon, 18)}</span>
      <div class="field grow"><label class="label" for="tm-name">Team name</label><input class="input ${err ? 'is-error' : ''}" id="tm-name" data-in="tform" data-f="name" value="${esc(f.name)}" placeholder="e.g. Growth" autofocus aria-invalid="${!!err}" aria-describedby="tm-name-err">${err ? `<span class="err" id="tm-name-err" role="alert">${ic('circle-alert', 12)}${esc(err)}</span>` : ''}</div>
    </div>
    <div class="field"><label class="label" for="tm-desc">What does this team own?</label><input class="input" id="tm-desc" data-in="tform" data-f="desc" value="${esc(f.desc)}" placeholder="e.g. Acquisition experiments and lifecycle email"></div>
    <div class="row" style="gap:16px;align-items:flex-start;flex-wrap:wrap">
      <div class="field" style="flex:1;min-width:220px"><span class="label" id="tm-icon-l">Icon</span><div class="iconpick" role="radiogroup" aria-labelledby="tm-icon-l">${PICONS.map(i => `<button type="button" role="radio" aria-checked="${f.icon === i}" class="${f.icon === i ? 'on' : ''}" data-a="tformSet" data-f="icon" data-v="${i}" aria-label="${i}">${ic(i, 15)}</button>`).join('')}</div></div>
      <div class="field"><span class="label" id="tm-color-l">Color</span><div class="swatches" role="radiogroup" aria-labelledby="tm-color-l" style="max-width:140px">${Object.entries(
        PCOLORS,
      )
        .map(
          ([k, v]) =>
            `<button type="button" role="radio" aria-checked="${f.color === k}" class="sw ${f.color === k ? 'on' : ''}" style="--c:${v};width:22px;height:22px" data-a="tformSet" data-f="color" data-v="${k}" aria-label="${k}">${f.color === k ? ic('check', 12) : ''}</button>`,
        )
        .join('')}</div></div>
    </div>
    <fieldset class="field" style="border:0;padding:0;margin:0"><legend class="label" style="margin-bottom:6px">Members <span class="faint" style="font-weight:400">· ${f.members.length} selected</span></legend>
      <div class="panel" style="max-height:220px;overflow-y:auto;padding:4px">${people.map(x => `<label class="mi" style="cursor:pointer;min-height:36px"><input type="checkbox" class="check" data-a="tformMember" data-id="${x.id}" ${f.members.includes(x.id) ? 'checked' : ''}>${av(x.id, 'sm', false)}<span class="grow trunc">${esc(x.name)}</span><span class="r">${x.team && x.team !== m.edit ? esc(TM[x.team].name) : ''}</span></label>`).join('')}</div>
      <span class="hint">Everyone belongs to one primary team. Adding someone here moves them from their current team.</span></fieldset>
  </form>
  <div class="modal-f">${m.edit ? `<button class="btn btn-danger-ghost" data-a="delTeam" data-id="${m.edit}">${ic('trash-2', 14)}Delete team</button>` : ''}<span class="sp"></span><button class="btn btn-secondary" data-a="closeModal">Cancel</button><button class="btn btn-primary" data-a="submitTeam">${m.edit ? 'Save changes' : 'Create team'}</button></div>`;
}
