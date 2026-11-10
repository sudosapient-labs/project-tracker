/* =====================================================================
   ACTIONS · TEAMS: create, edit, delete
   ===================================================================== */
import { $, uid } from '../core/utils.js';
import { PCOLORS } from '../core/constants.js';
import { D, S, mem, team, teamsList } from '../core/store.js';
import { mutate, toast } from '../ui/toast.js';
import { go, render } from '../shell/render.js';
import { openModal } from '../overlays/modals.js';
import { A, IN, confirmDlg, restore, snapshot } from './actions.js';

A.newTeam = () => {
  S.ui.pop = null;
  S.ui.errors = {};
  S.ui.tform = { name: '', desc: '', icon: 'users', color: 'teal', members: [] };
  openModal({ type: 'team' });
};
A.editTeam = el => {
  const t = team(el.dataset.id);
  if (!t) return;
  S.ui.pop = null;
  S.ui.errors = {};
  S.ui.tform = {
    name: t.name,
    desc: t.desc,
    icon: t.icon,
    color: Object.keys(PCOLORS).find(k => PCOLORS[k] === t.c) || 'slate',
    members: D()
      .members.filter(m => m.team === t.id)
      .map(m => m.id),
  };
  // What the window opened with: saving changes only what was changed here (see submitTeam).
  S.ui.tform.opened = JSON.parse(JSON.stringify(S.ui.tform));
  openModal({ type: 'team', edit: t.id });
};
IN.tform = el => {
  S.ui.tform[el.dataset.f] = el.value;
  if (el.dataset.f === 'name' && S.ui.errors.tname && el.value.trim()) {
    S.ui.errors.tname = null;
    render();
  }
};
A.tformSet = el => {
  S.ui.tform[el.dataset.f] = el.dataset.v;
  render();
};
A.tformMember = el => {
  const l = S.ui.tform.members;
  const id = el.dataset.id;
  S.ui.tform.members = l.includes(id) ? l.filter(x => x !== id) : [...l, id];
  render();
};
A.submitTeam = () => {
  const m = S.ui.modals[S.ui.modals.length - 1];
  const f = S.ui.tform;
  f.name = ($('#tm-name')?.value || '').trim();
  f.desc = ($('#tm-desc')?.value || '').trim();
  if (!f.name) {
    S.ui.errors.tname = 'Give the team a name';
    render();
    $('#tm-name')?.focus();
    return;
  }
  if (teamsList().some(t => t.name.toLowerCase() === f.name.toLowerCase() && t.id !== m.edit)) {
    S.ui.errors.tname = `A team called “${f.name}” already exists`;
    render();
    $('#tm-name')?.focus();
    return;
  }
  let t;
  const ok = mutate(() => {
    if (m.edit) {
      // Only what was changed in this window since it opened: someone else's change saved
      // meanwhile stays, and so does anyone they added to the team.
      const was = f.opened;
      t = team(m.edit);
      if (f.name !== was.name) t.name = f.name;
      if (f.desc !== (was.desc || '').trim()) t.desc = f.desc;
      if (f.icon !== was.icon) t.icon = f.icon;
      if (f.color !== was.color) t.c = PCOLORS[f.color];
      D().members.forEach(x => {
        if (x.team === t.id && was.members.includes(x.id) && !f.members.includes(x.id)) x.team = '';
        if (f.members.includes(x.id) && !was.members.includes(x.id)) x.team = t.id;
      });
      return;
    }
    t = { id: uid('tm'), name: f.name, desc: f.desc || 'No description yet.', icon: f.icon, c: PCOLORS[f.color] };
    teamsList().push(t);
    f.members.forEach(id => {
      const x = mem(id);
      if (x) x.team = t.id;
    });
  });
  if (!ok) return;
  S.ui.modals.pop();
  if (m.edit) {
    render();
    toast(`Saved ${t.name}`);
  } else {
    go('team', { id: t.id });
    toast(`Created ${t.name}`);
  }
};
A.delTeam = el => {
  const t = team(el.dataset.id);
  const n = D().members.filter(x => x.team === t.id).length;
  const np = D().projects.filter(p => p.team === t.id).length;
  S.ui.modals.pop();
  confirmDlg({
    title: `Delete ${t.name}?`,
    body: `${n ? `<b>${n} member${n > 1 ? 's' : ''}</b> will have no team` : 'The team has no members'}${np ? ` and <b>${np} project${np > 1 ? 's' : ''}</b> will need a new team` : ''}. People and projects are not deleted.`,
    ok: 'Delete team',
    danger: true,
    icon: 'users',
    run: () => {
      const snap = snapshot();
      if (
        mutate(() => {
          D().teams = teamsList().filter(x => x !== t);
          D().members.forEach(x => {
            if (x.team === t.id) x.team = '';
          });
          D().projects.forEach(p => {
            if (p.team === t.id) p.team = '';
          });
        })
      ) {
        if (S.ui.route === 'team') go('teams');
        toast(`Deleted ${t.name}`, { action: 'Undo', onAction: () => restore(snap) });
      }
    },
  });
};
