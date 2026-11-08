/* sudo-cli's commands beyond the everyday ones in cli.js: one table of noun → verb → handler, so
   every endpoint of /api/v1 has a command and `sudo-cli help <noun>` can list them. Each handler
   gets `x` (built in cli.js): the API client, parsed options, positionals after the verb, and
   output helpers. It returns an exit code (0 when it returns nothing). */
import fs from 'node:fs';
import path from 'node:path';
import { ApiError, seg } from '@sudosapient/client';

export const STATUSES = ['backlog', 'todo', 'progress', 'review', 'done'];
export const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'];
const PROJECT_STATUSES = ['planning', 'active', 'risk', 'hold', 'complete'];
const RECUR = ['Daily', 'Weekly', 'Every 2 weeks', 'Monthly'];
const PERMS = { view: 'Can view', comment: 'Can comment', edit: 'Can edit', full: 'Full access' };
const ROLES = ['Owner', 'Admin', 'Member', 'Guest'];
const REACTIONS = { thumbsup: '👍', '+1': '👍', tada: '🎉', heart: '❤️', eyes: '👀', rocket: '🚀', check: '✅' };
const FILTER_FIELDS = ['status', 'assignee', 'priority', 'due', 'project', 'labels', 'created', 'updated'];
const TYPES = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
export const contentType = file => TYPES[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream';

/* A file name the server sent, made safe to create in a directory: its last path part, without
   control characters, never "", "." or "..". */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\x00-\x1f\x7f]/g;
export const safeFileName = name =>
  path
    .basename(
      String(name || '')
        .replace(CONTROL, '')
        .replace(/\\/g, '/'),
    )
    .replace(/^\.+$/, '') || 'download';

const list = v =>
  v == null
    ? []
    : []
        .concat(v)
        .flatMap(s => String(s).split(','))
        .map(s => s.trim())
        .filter(Boolean);
const when = ms => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '');
const onOff = (k, v) => {
  if (/^(on|true|yes)$/i.test(v)) return true;
  if (/^(off|false|no)$/i.test(v)) return false;
  return k === 'weekStart' && /^\d+$/.test(v) ? Number(v) : v;
};
/* key=value pairs for `prefs set`. */
const pairs = (x, args, usage) => {
  if (!args.length) x.usage(usage);
  return Object.fromEntries(
    args.map(a => {
      const m = /^([A-Za-z_]+)=(.*)$/.exec(a);
      if (!m) x.usage(`Expected key=value, not “${a}”. ${usage}`);
      return [m[1], onOff(m[1], m[2])];
    }),
  );
};
const notFound = what => new ApiError(404, { error: `No ${what}.`, code: 'not_found' });

/* ---------- shared pieces ---------- */
const nonEmpty = (x, body, what) => {
  if (!Object.keys(body).length) x.usage(`Nothing to change. ${what}`);
  return body;
};
const choice = (x, v, opts, what) => {
  if (v == null) return undefined;
  if (!opts.includes(v)) x.usage(`${what} is one of ${opts.join(', ')}.`);
  return v;
};
const perm = (x, v) => {
  if (v == null) return undefined;
  const p =
    PERMS[
      v
        .toLowerCase()
        .replace(/^can /, '')
        .replace(/ access$/, '')
    ] || Object.values(PERMS).find(p => p.toLowerCase() === v.toLowerCase());
  if (!p) x.usage('Permission is one of view, comment, edit, full (or "Can view", …).');
  return p;
};
const repeat = (x, v) => {
  if (v == null) return undefined;
  if (/^(none|off)$/i.test(v)) return null;
  const r = RECUR.find(r => r.toLowerCase() === v.toLowerCase().replace(/-/g, ' '));
  if (!r) x.usage(`Repeat is one of ${RECUR.join(', ')}, or none.`);
  return r;
};
const orNone = v => (v == null ? undefined : /^none$/i.test(v) ? null : v);
async function teamId(x, a, ref) {
  const teams = (await a.get('/teams')).data;
  const t = teams.find(t => t.id === ref) || teams.find(t => t.name.toLowerCase() === String(ref).toLowerCase());
  if (!t) throw notFound(`team matches “${ref}”`);
  return t;
}
async function botOf(x, a, ref) {
  const bots = (await a.get('/bots')).data;
  const b = bots.find(b => b.id === ref) || bots.find(b => b.name.toLowerCase() === String(ref).toLowerCase());
  if (!b) throw notFound(`bot matches “${ref}”`);
  return b;
}
const filterOf = (x, s) => {
  const m = /^([a-z]+)(!=|=)(.*)$/.exec(s);
  if (!m || !FILTER_FIELDS.includes(m[1])) x.usage(`A filter is field=value[,value] or field!=value, with field one of ${FILTER_FIELDS.join(', ')}.`);
  return { field: m[1], op: m[2] === '=' ? 'is' : 'not', values: list(m[3]) };
};

/* Task fields from options, for edit (and the subset new uses in cli.js). */
function taskBody(x) {
  const o = x.o;
  const b = {};
  if (o.title != null) b.title = o.title;
  if (o.status != null) b.status = choice(x, o.status, STATUSES, 'Status');
  if (o.priority != null) b.priority = choice(x, o.priority, PRIORITIES, 'Priority');
  if (o.assignee != null) b.assignee = orNone(o.assignee);
  if (o.due != null) b.due = x.date(o.due);
  if (o.start != null) b.start = x.date(o.start);
  if (o.label != null) b.labels = o.label.some(l => /^none$/i.test(l)) ? [] : list(o.label);
  if (o.repeat != null) b.recurrence = repeat(x, o.repeat);
  if (o.estimate != null) b.estimate = orNone(o.estimate);
  if (o.project != null) b.project = o.project;
  if (o.desc != null) b.description = o.desc;
  if (o.depends != null) b.dependsOn = /^none$/i.test(o.depends) ? [] : list(o.depends);
  if (o.order != null) {
    b.order = Number(o.order);
    if (!Number.isFinite(b.order)) x.usage('--order is a number.');
  }
  return b;
}
function projectBody(x) {
  const o = x.o;
  const b = {};
  if (o.name != null) b.name = o.name;
  if (o.desc != null) b.description = o.desc;
  if (o.status != null) b.status = choice(x, o.status, PROJECT_STATUSES, 'Project status');
  if (o.lead != null) b.lead = orNone(o.lead);
  if (o.team != null) b.team = orNone(o.team);
  if (o.start != null) b.start = x.date(o.start);
  if (o.due != null) b.due = x.date(o.due);
  if (o.icon != null) b.icon = o.icon;
  if (o.color != null) b.color = o.color;
  if (o.private && o.public) x.usage('Pick one of --private and --public.');
  if (o.private) b.private = true;
  if (o.public) b.private = false;
  if (o.milestone != null)
    b.milestones = o.milestone.some(m => /^none$/i.test(m))
      ? []
      : o.milestone.map(m => {
          const [name, date] = m.split(/=(.*)/s);
          return { name: name.trim(), date: date ? x.date(date) : null };
        });
  return b;
}
const taskLine = (x, t) => `${x.bold(t.key)} ${t.title}`;
const projLine = (x, p) => `${x.bold(x.pad(p.key, 8))} ${p.name}${p.archived ? x.dim(' · archived') : ''}`;

/* ---------- the table ---------- */
/* noun → { about, verbs: { verb: { usage, run } }, default? } */
export const NOUNS = {
  tasks: {
    about: 'Tasks: list, create, edit, complete, assign, archive, delete',
    verbs: {
      list: { usage: 'tasks [list] [--mine] [-p <project>] [-s <status>] [--all] [--archived] [-n <limit>]' },
      new: { usage: 'tasks new "<title>" -p <project> [--due <date>] [-a <who>] [--priority <p>] [-s <status>] [-d <text>]' },
      show: { usage: 'tasks show <KEY>                  details, subtasks and comments (with their ids)' },
      done: { usage: 'tasks done <KEY>...' },
      assign: { usage: 'tasks assign <KEY> <who|none>' },
      edit: {
        usage:
          'tasks edit <KEY> [--title <t>] [-s <status>] [--priority <p>] [-a <who|none>] [--due <date|none>] [--start <date|none>]\n' +
          '        [--label <a,b> (repeatable; replaces; none clears)] [--repeat <Daily|Weekly|"Every 2 weeks"|Monthly|none>]\n' +
          '        [--estimate <e|none>] [-p <move to project>] [-d <description>] [--depends <KEY,…|none>] [--order <n>]',
        async run(x) {
          const k = x.need(x.args[0], 'Which task? sudo-cli tasks edit WEB-12 --title "…"');
          const t = await x.api().patch(`/tasks/${seg(k)}`, nonEmpty(x, taskBody(x), 'Pass a field, e.g. --title or --due.'));
          x.emit(t, () => x.print(`Updated ${taskLine(x, t)}`));
        },
      },
      rm: {
        usage: 'tasks rm <KEY>...                   delete (with comments); undo with tasks undelete <id> within 10 minutes',
        async run(x) {
          x.need(x.args.length, 'Which task? sudo-cli tasks rm WEB-12');
          return several(
            x,
            x.args,
            async k => ({ key: k.toUpperCase(), ...(await x.api().del(`/tasks/${seg(k)}`)) }),
            d => `Deleted ${x.bold(d.key)}. Undo within 10 minutes: sudo-cli tasks undelete ${d.id}`,
          );
        },
      },
      undelete: {
        usage: 'tasks undelete <id>                 put back a task you deleted (with its key and comments)',
        async run(x) {
          const t = await x.api().post(`/tasks/${seg(x.need(x.args[0], 'Which task id? It was printed by tasks rm.'))}/undelete`);
          x.emit(t, () => x.print(`Restored ${taskLine(x, t)}`));
        },
      },
      archive: {
        usage: 'tasks archive <KEY>...',
        run: x =>
          each(
            x,
            k => x.api().post(`/tasks/${seg(k)}/archive`),
            t => `Archived ${taskLine(x, t)}`,
          ),
      },
      restore: {
        usage: 'tasks restore <KEY>...',
        run: x =>
          each(
            x,
            k => x.api().post(`/tasks/${seg(k)}/restore`),
            t => `Restored ${taskLine(x, t)}`,
          ),
      },
      dup: {
        usage: 'tasks dup <KEY>                     copy it (title + " (copy)")',
        async run(x) {
          const t = await x.api().post(`/tasks/${seg(x.need(x.args[0], 'Which task? sudo-cli tasks dup WEB-12'))}/duplicate`);
          x.emit(t, () => x.print(`Created ${taskLine(x, t)}`));
        },
      },
      fav: {
        usage: 'tasks fav <KEY>...',
        run: x =>
          each(
            x,
            k => x.api().put(`/tasks/${seg(k)}/favorite`),
            t => `Starred ${taskLine(x, t)}`,
          ),
      },
      unfav: {
        usage: 'tasks unfav <KEY>...',
        run: x =>
          each(
            x,
            k => x.api().del(`/tasks/${seg(k)}/favorite`),
            t => `Unstarred ${taskLine(x, t)}`,
          ),
      },
    },
  },

  subtask: {
    about: 'Subtasks of a task (ids are shown by tasks show)',
    verbs: {
      add: {
        usage: 'subtask add <KEY> "<title>" [-a <who>] [--due <date>]',
        async run(x) {
          const [k, ...rest] = x.args;
          const title = rest.join(' ').trim();
          x.need(k && title, 'sudo-cli subtask add WEB-12 "Write the tests"');
          const body = { title, ...(x.o.assignee ? { assignee: orNone(x.o.assignee) } : {}), ...(x.o.due ? { due: x.date(x.o.due) } : {}) };
          const t = await x.api().post(`/tasks/${seg(k)}/subtasks`, body);
          const s = t.subtasks.at(-1);
          x.emit(t, () => x.print(`Added “${s.title}” to ${x.bold(t.key)} ${x.dim(`(${s.id})`)}`));
        },
      },
      done: { usage: 'subtask done <KEY> <id>', run: x => subPatch(x, { done: true }, 'Done') },
      undo: { usage: 'subtask undo <KEY> <id>             mark not done', run: x => subPatch(x, { done: false }, 'Reopened') },
      edit: {
        usage: 'subtask edit <KEY> <id> [--title <t>] [-a <who|none>] [--due <date|none>]',
        run: x => {
          const b = {};
          if (x.o.title != null) b.title = x.o.title;
          if (x.o.assignee != null) b.assignee = orNone(x.o.assignee);
          if (x.o.due != null) b.due = x.date(x.o.due);
          return subPatch(x, nonEmpty(x, b, 'Pass --title, -a or --due.'), 'Updated');
        },
      },
      rm: {
        usage: 'subtask rm <KEY> <id>',
        async run(x) {
          const [k, id] = x.args;
          x.need(k && id, 'sudo-cli subtask rm WEB-12 <subtask id>');
          const t = await x.api().del(`/tasks/${seg(k)}/subtasks/${seg(id)}`);
          x.emit(t, () => x.print(`Removed a subtask from ${x.bold(t.key)}`));
        },
      },
      promote: {
        usage: 'subtask promote <KEY> <id>          turn it into a task of its own',
        async run(x) {
          const [k, id] = x.args;
          x.need(k && id, 'sudo-cli subtask promote WEB-12 <subtask id>');
          const t = await x.api().post(`/tasks/${seg(k)}/subtasks/${seg(id)}/promote`);
          x.emit(t, () => x.print(`Converted to ${taskLine(x, t)}`));
        },
      },
    },
  },

  comment: {
    about: 'Comments: add, edit, delete, react',
    verbs: {
      add: { usage: 'comment <KEY> "<text>"               @Name mentions notify' },
      edit: {
        usage: 'comment edit <id> "<text>"           your own comments',
        async run(x) {
          const [id, ...rest] = x.args;
          const text = rest.join(' ').trim();
          x.need(id && text, 'sudo-cli comment edit <comment id> "New text"');
          const c = await x.api().patch(`/comments/${seg(id)}`, { text });
          x.emit(c, () => x.print('Comment updated'));
        },
      },
      rm: {
        usage: 'comment rm <id>                      undo with comment undelete <id> within 10 minutes',
        async run(x) {
          const id = x.need(x.args[0], 'sudo-cli comment rm <comment id>');
          const d = await x.api().del(`/comments/${seg(id)}`);
          x.emit(d, () => x.print(`Deleted the comment. Undo within 10 minutes: sudo-cli comment undelete ${d.id}`));
        },
      },
      undelete: {
        usage: 'comment undelete <id>',
        async run(x) {
          const c = await x.api().post(`/comments/${seg(x.need(x.args[0], 'sudo-cli comment undelete <comment id>'))}/undelete`);
          x.emit(c, () => x.print('Comment restored'));
        },
      },
      react: { usage: 'react <comment id> <emoji>           👍 🎉 ❤️ 👀 🚀 ✅ (or thumbsup, tada, heart, eyes, rocket, check)' },
      unreact: { usage: 'unreact <comment id> <emoji>' },
    },
  },

  projects: {
    about: 'Projects: create, edit, share, archive, duplicate, delete',
    verbs: {
      list: { usage: 'projects [list] [--archived]' },
      show: {
        usage: 'projects show <KEY>',
        async run(x) {
          const a = x.api();
          const [p, names] = await Promise.all([a.get(`/projects/${seg(x.need(x.args[0], 'Which project? sudo-cli projects show WEB'))}`), x.names(a)]);
          x.emit(p, () => {
            x.print(`${x.bold(p.key)} ${p.name}`);
            x.print(
              x.dim(
                [
                  p.status,
                  p.lead ? `lead ${names.get(p.lead) || '?'}` : 'no lead',
                  p.private ? 'private' : 'open to the workspace',
                  `you: ${p.access}`,
                  p.archived ? 'archived' : '',
                ]
                  .filter(Boolean)
                  .join(' · '),
              ),
            );
            if (p.description) x.print('\n' + p.description);
            x.print(`\n${p.openTasks} open · ${p.doneTasks} done${p.start ? ` · ${p.start}` : ''}${p.due ? ` → ${p.due}` : ''}`);
            if (p.members.length)
              x.print('\nPeople: ' + p.members.map(m => `${names.get(m) || m}${p.permissions[m] ? ` (${p.permissions[m]})` : ''}`).join(', '));
            for (const m of p.milestones) x.print(`  ◆ ${m.name}${m.date ? ` ${m.date.slice(0, 10)}` : ''}`);
            x.print('\n' + x.dim(p.url));
          });
        },
      },
      new: {
        usage:
          'projects new "<name>" [--prefix <KEY>] [-d <text>] [-s <status>] [--lead <who>] [--team <team>] [--start <date>] [--due <date>]\n' +
          '        [--private] [--icon <icon>] [--color <colour>] [--milestone "Name=date"]... [--members <who,…>] [--perm <level>]',
        async run(x) {
          const name = x.need(x.args.join(' ').trim(), 'Name the project: sudo-cli projects new "Mobile App"');
          const p = perm(x, x.o.perm);
          const body = {
            ...projectBody(x),
            name,
            ...(x.o.prefix ? { key: x.o.prefix } : {}),
            ...(x.o.members ? { members: list(x.o.members).map(m => ({ member: m, ...(p ? { permission: p } : {}) })) } : {}),
          };
          const r = await x.api().post('/projects', body);
          x.emit(r, () => x.print(`Created ${x.bold(r.key)} ${r.name}\n${x.dim(r.url)}`));
        },
      },
      edit: {
        usage:
          'projects edit <KEY> [--name <n>] [-d <text>] [-s <status>] [--lead <who|none>] [--team <team|none>] [--start <date|none>]\n' +
          '        [--due <date|none>] [--private | --public] [--icon <i>] [--color <c>] [--milestone "Name=date"]... (replaces; none clears)',
        async run(x) {
          const k = x.need(x.args[0], 'Which project? sudo-cli projects edit WEB --status risk');
          const p = await x.api().patch(`/projects/${seg(k)}`, nonEmpty(x, projectBody(x), 'Pass a field, e.g. --status or --due.'));
          x.emit(p, () => x.print(`Updated ${projLine(x, p)}`));
        },
      },
      archive: {
        usage: 'projects archive <KEY>',
        run: x =>
          one(
            x,
            k => x.api().post(`/projects/${seg(k)}/archive`),
            p => `Archived ${projLine(x, p)}`,
          ),
      },
      restore: {
        usage: 'projects restore <KEY>',
        run: x =>
          one(
            x,
            k => x.api().post(`/projects/${seg(k)}/restore`),
            p => `Restored ${projLine(x, p)}`,
          ),
      },
      dup: {
        usage: 'projects dup <KEY>                 copy it with its tasks (as To Do)',
        run: x =>
          one(
            x,
            k => x.api().post(`/projects/${seg(k)}/duplicate`),
            p => `Created ${projLine(x, p)}`,
          ),
      },
      rm: {
        usage: 'projects rm <KEY> [--yes]            delete it with all its work, for everyone (asks first)',
        async run(x) {
          const k = x.need(x.args[0], 'Which project? sudo-cli projects rm WEB');
          const a = x.api();
          const p = await a
            .get(`/projects/${seg(k)}`)
            .catch(e => (e.status === 404 ? { key: k.toUpperCase(), name: k, openTasks: 0, doneTasks: 0 } : Promise.reject(e)));
          if (
            !(await x.confirm(`Delete ${p.key} ${p.name} and its ${p.openTasks + p.doneTasks} tasks, files and comments for everyone? This can't be undone.`))
          )
            return x.cancelled();
          const d = await a.del(`/projects/${seg(k)}`);
          x.emit(d, () => x.print(`Deleted ${x.bold(p.key)} ${p.name}`));
        },
      },
      share: {
        usage: 'projects share <KEY> <who> [--perm view|comment|edit|full]   list someone, or change their permission',
        async run(x) {
          const [k, ...w] = x.args;
          const who = w.join(' ').trim();
          x.need(k && who, 'sudo-cli projects share WEB grace@example.com --perm edit');
          const p = await x.api().put(`/projects/${seg(k)}/members/${seg(who)}`, x.o.perm ? { permission: perm(x, x.o.perm) } : {});
          x.emit(p, () => x.print(`Shared ${x.bold(p.key)} with ${who}${x.o.perm ? ` (${perm(x, x.o.perm)})` : ''}`));
        },
      },
      unshare: {
        usage: 'projects unshare <KEY> <who>',
        async run(x) {
          const [k, ...w] = x.args;
          const who = w.join(' ').trim();
          x.need(k && who, 'sudo-cli projects unshare WEB grace@example.com');
          const p = await x.api().del(`/projects/${seg(k)}/members/${seg(who)}`);
          x.emit(p, () => x.print(`Took ${who} off ${x.bold(p.key)}`));
        },
      },
      'request-access': {
        usage: 'projects request-access <KEY>        ask the lead of a project you can’t open',
        async run(x) {
          const r = await x.api().post(`/projects/${seg(x.need(x.args[0], 'Which project?'))}/request-access`);
          x.emit(r, () => x.print('Asked for access. The lead gets a notification.'));
        },
      },
      fav: {
        usage: 'projects fav <KEY>',
        run: x =>
          one(
            x,
            k => x.api().put(`/projects/${seg(k)}/favorite`),
            p => `Starred ${projLine(x, p)}`,
          ),
      },
      unfav: {
        usage: 'projects unfav <KEY>',
        run: x =>
          one(
            x,
            k => x.api().del(`/projects/${seg(k)}/favorite`),
            p => `Unstarred ${projLine(x, p)}`,
          ),
      },
      order: {
        usage: 'projects order <KEY>...              your sidebar order, top first',
        async run(x) {
          x.need(x.args.length, 'sudo-cli projects order WEB OPS SEC');
          const r = await x.api().put('/me/project-order', { projects: x.args });
          x.emit(r, () => x.print('Sidebar order saved'));
        },
      },
    },
  },

  teams: {
    about: 'Teams',
    default: 'list',
    verbs: {
      list: {
        usage: 'teams [list]',
        async run(x) {
          const a = x.api();
          const [r, names] = await Promise.all([a.get('/teams'), x.names(a)]);
          x.emit(r.data, () => {
            if (!r.data.length) x.print(x.dim('No teams.'));
            for (const t of r.data) x.print(`${x.bold(x.pad(t.name, 20))} ${x.dim(x.pad(t.id, 16))} ${t.members.map(m => names.get(m) || m).join(', ')}`);
          });
        },
      },
      new: {
        usage: 'teams new "<name>" [-d <text>] [--icon <i>] [--color <#RRGGBB>] [--members <who,…>]',
        async run(x) {
          const name = x.need(x.args.join(' ').trim(), 'Name the team: sudo-cli teams new Platform');
          const t = await x.api().post('/teams', { name, ...teamBody(x) });
          x.emit(t, () => x.print(`Created team ${x.bold(t.name)} ${x.dim(`(${t.id})`)}`));
        },
      },
      edit: {
        usage: 'teams edit <team> [--name <n>] [-d <text>] [--icon <i>] [--color <c>] [--members <who,…> (replaces)]',
        async run(x) {
          const a = x.api();
          const t = await teamId(x, a, x.need(x.args.join(' ').trim(), 'Which team? sudo-cli teams edit Platform --members ada,grace'));
          const r = await a.patch(
            `/teams/${seg(t.id)}`,
            nonEmpty(x, { ...(x.o.name ? { name: x.o.name } : {}), ...teamBody(x) }, 'Pass --name, -d, --members, …'),
          );
          x.emit(r, () => x.print(`Updated team ${x.bold(r.name)}`));
        },
      },
      rm: {
        usage: 'teams rm <team> [--yes]              its people and projects are kept, with no team',
        async run(x) {
          const a = x.api();
          const t = await teamId(x, a, x.need(x.args.join(' ').trim(), 'Which team?'));
          if (!(await x.confirm(`Delete the team ${t.name}? Its ${t.members.length} people and its projects are kept, with no team.`))) return x.cancelled();
          const d = await a.del(`/teams/${seg(t.id)}`);
          x.emit(d, () => x.print(`Deleted team ${x.bold(t.name)}`));
        },
      },
    },
  },

  people: {
    about: 'People: invite, resend, roles, teams, titles, remove',
    default: 'list',
    verbs: {
      list: {
        usage: 'people [list]',
        async run(x) {
          const ms = await x.api().all('/members');
          x.emit(ms, () => {
            for (const m of ms)
              x.print(
                `${x.bold(x.pad(m.name, 22))} ${x.pad(m.kind === 'bot' ? '(bot)' : m.email, 30)} ${x.pad(m.role, 7)} ${x.dim([m.title, m.status === 'invited' ? 'invited' : ''].filter(Boolean).join(' · '))}`,
              );
          });
        },
      },
      show: {
        usage: 'people show <who>',
        async run(x) {
          const m = await x.api().get(`/members/${seg(x.need(x.args.join(' ').trim(), 'Who? sudo-cli people show grace@example.com'))}`);
          x.emit(m, () =>
            x.print(
              `${x.bold(m.name)}${m.kind === 'bot' ? ' (bot)' : ` <${m.email}>`} · ${m.role}${m.title ? ` · ${m.title}` : ''}${m.status === 'invited' ? ' · invited' : ''}${x.dim(` (${m.id})`)}`,
            ),
          );
        },
      },
      invite: {
        usage: 'people invite <email> [--name <n>] [--role Member|Guest|Admin] [--team <team>] [--title <t>]   (only Owners and Admins invite Admins)',
        async run(x) {
          const email = x.need(x.args[0], 'sudo-cli people invite grace@example.com');
          const body = {
            email,
            ...(x.o.name ? { name: x.o.name } : {}),
            ...(x.o.role ? { role: choice(x, x.o.role, ['Admin', 'Member', 'Guest'], 'Role') } : {}),
            ...(x.o.team ? { team: x.o.team } : {}),
            ...(x.o.title != null ? { title: x.o.title } : {}),
          };
          const r = await x.api().post('/members', body);
          x.emit(r, () =>
            x.print(`Invited ${r.member.name} <${r.member.email}> as ${r.member.role}. They’ll get an email to join.${r.link ? `\n${x.dim(r.link)}` : ''}`),
          );
        },
      },
      resend: {
        usage: 'people resend <who>                  a fresh invite for someone who hasn’t joined',
        async run(x) {
          const who = x.need(x.args.join(' ').trim(), 'Who? sudo-cli people resend grace@example.com');
          const r = await x.api().post(`/members/${seg(who)}/resend-invite`);
          x.emit(r, () => x.print(`Sent ${who} a new invite`));
        },
      },
      edit: {
        usage: 'people edit <who> [--name <n>] [--title <t>] [--team <team|none>]   (others’ name and title: Owners and Admins)',
        async run(x) {
          const who = x.need(x.args.join(' ').trim(), 'Who? sudo-cli people edit grace --team Platform');
          const b = {};
          if (x.o.name != null) b.name = x.o.name;
          if (x.o.title != null) b.title = x.o.title;
          if (x.o.team != null) b.team = orNone(x.o.team);
          const m = await x.api().patch(`/members/${seg(who)}`, nonEmpty(x, b, 'Pass --name, --title or --team.'));
          x.emit(m, () => x.print(`Updated ${m.name}`));
        },
      },
      role: {
        usage: 'people role <who> <Owner|Admin|Member|Guest>   (Owners and Admins)',
        async run(x) {
          const role = x.args.at(-1);
          const who = x.args.slice(0, -1).join(' ').trim();
          x.need(who && role, 'sudo-cli people role grace Admin');
          const m = await x.api().patch(`/members/${seg(who)}`, { role: choice(x, role, ROLES, 'Role') });
          x.emit(m, () => x.print(`${m.name} is now ${m.role}`));
        },
      },
      rm: {
        usage: 'people rm <who> [--yes]              remove from the workspace (Owners and Admins; asks first)',
        async run(x) {
          const a = x.api();
          const m = await a.get(`/members/${seg(x.need(x.args.join(' ').trim(), 'Who? sudo-cli people rm grace@example.com'))}`);
          if (!(await x.confirm(`Remove ${m.name} from the workspace? Their tasks are unassigned and they’re signed out everywhere.`))) return x.cancelled();
          const d = await a.del(`/members/${seg(m.id)}`);
          x.emit(d, () => x.print(`Removed ${m.name}`));
        },
      },
    },
  },

  me: {
    about: 'Your profile',
    default: 'show',
    verbs: {
      show: { usage: 'me                                   = whoami' },
      edit: {
        usage: 'me edit [--name <n>] [--title <t>] [--team <team|none>] [--color <#RRGGBB>]',
        async run(x) {
          const b = {};
          if (x.o.name != null) b.name = x.o.name;
          if (x.o.title != null) b.title = x.o.title;
          if (x.o.team != null) b.team = orNone(x.o.team);
          if (x.o.color != null) b.color = x.o.color;
          const m = await x.api().patch('/me', nonEmpty(x, b, 'Pass --name, --title, --team or --color.'));
          x.emit(m, () => x.print(`Updated your profile: ${m.name}${m.title ? ` · ${m.title}` : ''}`));
        },
      },
    },
  },

  bots: {
    about: 'Bots (Owners and Admins; their keys are made in Settings → API → Bots)',
    default: 'list',
    verbs: {
      list: {
        usage: 'bots [list]',
        async run(x) {
          const r = await x.api().get('/bots');
          x.emit(r.data, () => {
            if (!r.data.length) x.print(x.dim('No bots.'));
            for (const b of r.data) {
              x.print(`${x.bold(x.pad(b.name, 22))} ${x.pad(b.role, 7)} ${x.dim(`${b.projects.length} projects · ${b.keys.length} keys · ${b.id}`)}`);
              for (const k of b.keys) x.print(x.dim(`    key ${k.name} ${k.prefix}… ${k.scope} (${k.id})`));
            }
          });
        },
      },
      new: {
        usage: 'bots new "<name>" [--role Member|Guest] [--projects <KEY,…>]',
        async run(x) {
          const name = x.need(x.args.join(' ').trim(), 'Name the bot: sudo-cli bots new "Release Bot"');
          const b = await x.api().post('/bots', { name, ...botBody(x) });
          x.emit(b, () => x.print(`Created bot ${x.bold(b.name)} ${x.dim(`(${b.id})`)}. Make its key in Settings → API → Bots.`));
        },
      },
      edit: {
        usage: 'bots edit <bot> [--name <n>] [--role Member|Guest] [--projects <KEY,…|none> (exactly these)]',
        async run(x) {
          const a = x.api();
          const b = await botOf(x, a, x.need(x.args.join(' ').trim(), 'Which bot?'));
          const r = await a.patch(
            `/bots/${seg(b.id)}`,
            nonEmpty(x, { ...(x.o.name ? { name: x.o.name } : {}), ...botBody(x) }, 'Pass --name, --role or --projects.'),
          );
          x.emit(r, () => x.print(`Updated bot ${x.bold(r.name)}`));
        },
      },
      rm: {
        usage: 'bots rm <bot> [--yes]                its keys stop working (asks first)',
        async run(x) {
          const a = x.api();
          const b = await botOf(x, a, x.need(x.args.join(' ').trim(), 'Which bot?'));
          if (!(await x.confirm(`Remove the bot ${b.name}? Its ${b.keys.length} keys stop working.`))) return x.cancelled();
          const d = await a.del(`/bots/${seg(b.id)}`);
          x.emit(d, () => x.print(`Removed bot ${b.name}`));
        },
      },
      'revoke-key': {
        usage: 'bots revoke-key <bot> <key id>',
        async run(x) {
          const [ref, keyId] = x.args;
          x.need(ref && keyId, 'sudo-cli bots revoke-key "Release Bot" <key id>');
          const a = x.api();
          const b = await botOf(x, a, ref);
          const r = await a.del(`/bots/${seg(b.id)}/keys/${seg(keyId)}`);
          x.emit(r, () => x.print(`Revoked the key; ${r.name} has ${r.keys.length} left`));
        },
      },
    },
  },

  files: {
    about: 'Files: upload, download, attach, rename, copy, delete',
    default: 'list',
    verbs: {
      list: {
        usage: 'files [list] [-p <project>] [--task <KEY>]',
        async run(x) {
          const fs_ = await x.api().all('/files', { project: x.o.project, task: x.o.task });
          x.emit(fs_, () => {
            if (!fs_.length) x.print(x.dim('No files.'));
            for (const f of fs_) x.print(`${x.dim(x.pad(f.id, 16))} ${x.pad(f.size, 8)} ${f.name}`);
          });
        },
      },
      show: {
        usage: 'files show <id>',
        async run(x) {
          const f = await x.api().get(`/files/${seg(x.need(x.args[0], 'Which file id?'))}`);
          x.emit(f, () => x.print(`${x.bold(f.name)} · ${f.size} · ${f.type}${f.task ? ' · attached to a task' : ''}\n${x.dim(f.id)}`));
        },
      },
      upload: {
        usage: 'files upload <path> (-p <project> | --task <KEY>) [--name <name>]',
        async run(x) {
          const file = x.need(x.args[0], 'sudo-cli files upload ./spec.pdf --task WEB-12');
          x.need(x.o.project || x.o.task, 'Say where it goes: -p <project> or --task <KEY>.');
          let bytes;
          try {
            bytes = fs.readFileSync(path.resolve(x.io.cwd || process.cwd(), file));
          } catch (e) {
            x.usage(`Can't read ${file}: ${e.code === 'ENOENT' ? 'no such file' : e.message}.`);
          }
          const name = x.o.name || path.basename(file);
          const f = await x.api().upload('/files', { project: x.o.project, task: x.o.task, name }, bytes, contentType(name));
          x.emit(f, () => x.print(`Uploaded ${x.bold(f.name)} (${f.size}) ${x.dim(f.id)}`));
        },
      },
      download: {
        usage: 'files download <id> [-o <path>|-] [--force]   default: the file’s own name here; never overwrites without --force',
        async run(x) {
          const id = x.need(x.args[0], 'Which file id? sudo-cli files download <id>');
          const a = x.api();
          const got = await a.download(`/files/${seg(id)}/content`, { download: 'true' });
          if (x.o.output === '-') {
            x.io.stdout.write(got.bytes);
            return 0;
          }
          const shown = x.o.output || safeFileName(got.name || (await a.get(`/files/${seg(id)}`)).name);
          const to = path.resolve(x.io.cwd || process.cwd(), shown);
          try {
            fs.writeFileSync(to, got.bytes, { flag: x.o.force ? 'w' : 'wx' });
          } catch (e) {
            if (e.code === 'EEXIST') x.usage(`${shown} already exists. Pass --force to overwrite it, or -o another path.`);
            throw e;
          }
          x.emit({ path: path.resolve(to), bytes: got.bytes.length, type: got.type }, () => x.print(`Saved ${shown} (${got.bytes.length} bytes)`));
        },
      },
      rename: {
        usage: 'files rename <id> "<new name>"',
        async run(x) {
          const [id, ...n] = x.args;
          const name = n.join(' ').trim();
          x.need(id && name, 'sudo-cli files rename <id> "spec v2.pdf"');
          const f = await x.api().patch(`/files/${seg(id)}`, { name });
          x.emit(f, () => x.print(`Renamed to ${f.name}`));
        },
      },
      attach: {
        usage: 'files attach <id> <KEY>              attach to a task in its project',
        async run(x) {
          const [id, k] = x.args;
          x.need(id && k, 'sudo-cli files attach <id> WEB-12');
          const f = await x.api().patch(`/files/${seg(id)}`, { task: k });
          x.emit(f, () => x.print(`Attached ${f.name} to ${k.toUpperCase()}`));
        },
      },
      detach: {
        usage: 'files detach <id>',
        async run(x) {
          const f = await x.api().patch(`/files/${seg(x.need(x.args[0], 'Which file id?'))}`, { task: null });
          x.emit(f, () => x.print(`Detached ${f.name}`));
        },
      },
      dup: {
        usage: 'files dup <id>',
        async run(x) {
          const f = await x.api().post(`/files/${seg(x.need(x.args[0], 'Which file id?'))}/duplicate`);
          x.emit(f, () => x.print(`Copied to ${f.name} ${x.dim(f.id)}`));
        },
      },
      rm: {
        usage: 'files rm <id> [--yes]                (asks first)',
        async run(x) {
          const a = x.api();
          const f = await a.get(`/files/${seg(x.need(x.args[0], 'Which file id?'))}`);
          if (!(await x.confirm(`Delete ${f.name}${f.task ? ' (and take it off its task)' : ''}?`))) return x.cancelled();
          const d = await a.del(`/files/${seg(f.id)}`);
          x.emit(d, () => x.print(`Deleted ${f.name}`));
        },
      },
    },
  },

  events: {
    about: 'Calendar events',
    default: 'list',
    verbs: {
      list: {
        usage: 'events [list] [-p <project>] [--from <date>] [--to <date>]',
        async run(x) {
          const es = await x.api().all('/events', { project: x.o.project, from: x.o.from && x.date(x.o.from), to: x.o.to && x.date(x.o.to) });
          x.emit(es, () => {
            if (!es.length) x.print(x.dim('No events.'));
            for (const e of es) x.print(`${x.pad(e.date, 10)} ${x.pad(e.time || 'all day', 7)} ${e.title} ${x.dim(e.id)}`);
          });
        },
      },
      new: {
        usage: 'events new "<title>" --date <date> [--time HH:MM] [-p <project>]   (no -p: workspace-wide, Owners and Admins)',
        async run(x) {
          const title = x.need(x.args.join(' ').trim(), 'sudo-cli events new "Launch" --date 2026-12-01 -p WEB');
          const date = x.date(x.need(x.o.date, 'Give a --date.'));
          const e = await x.api().post('/events', { title, date, ...(x.o.time ? { time: x.o.time } : {}), ...(x.o.project ? { project: x.o.project } : {}) });
          x.emit(e, () => x.print(`Added ${e.title} on ${e.date}${e.time ? ` at ${e.time}` : ''} ${x.dim(e.id)}`));
        },
      },
      edit: {
        usage: 'events edit <id> [--title <t>] [--date <date>] [--time HH:MM|none] [-p <project|none>]',
        async run(x) {
          const id = x.need(x.args[0], 'Which event id?');
          const b = {};
          if (x.o.title != null) b.title = x.o.title;
          if (x.o.date != null) b.date = x.date(x.o.date);
          if (x.o.time != null) b.time = /^none$/i.test(x.o.time) ? '' : x.o.time;
          if (x.o.project != null) b.project = orNone(x.o.project);
          const e = await x.api().patch(`/events/${seg(id)}`, nonEmpty(x, b, 'Pass --title, --date, --time or -p.'));
          x.emit(e, () => x.print(`Updated ${e.title} (${e.date})`));
        },
      },
      rm: {
        usage: 'events rm <id>',
        async run(x) {
          const d = await x.api().del(`/events/${seg(x.need(x.args[0], 'Which event id?'))}`);
          x.emit(d, () => x.print('Deleted the event'));
        },
      },
    },
  },

  views: {
    about: 'Saved views (a project’s extra tabs)',
    default: 'list',
    verbs: {
      list: {
        usage: 'views [list] [-p <project>]',
        async run(x) {
          const vs = await x.api().all('/views', { project: x.o.project });
          x.emit(vs, () => {
            if (!vs.length) x.print(x.dim('No saved views.'));
            for (const v of vs)
              x.print(
                `${x.bold(x.pad(v.name, 20))} ${x.pad(v.type, 6)} ${v.filters.map(f => `${f.field}${f.op === 'is' ? '=' : '!='}${f.values.join(',')}`).join(' ')} ${x.dim(v.id)}`,
              );
          });
        },
      },
      new: {
        usage: 'views new "<name>" -p <project> [--type list|board|table] [--filter field=a,b | field!=a]...',
        async run(x) {
          const name = x.need(x.args.join(' ').trim(), 'sudo-cli views new "Urgent" -p WEB --filter priority=urgent');
          const project = x.need(x.o.project, 'Say which project: -p <project>.');
          const v = await x.api().post('/views', {
            project,
            name,
            ...(x.o.type ? { type: choice(x, x.o.type, ['list', 'board', 'table'], 'Type') } : {}),
            filters: (x.o.filter || []).map(f => filterOf(x, f)),
          });
          x.emit(v, () => x.print(`Saved view ${x.bold(v.name)} ${x.dim(v.id)}`));
        },
      },
      edit: {
        usage: 'views edit <id> [--name <n>] [--type list|board|table] [--filter …]... (replaces; --filter none clears)',
        async run(x) {
          const id = x.need(x.args[0], 'Which view id?');
          const b = {};
          if (x.o.name != null) b.name = x.o.name;
          if (x.o.type != null) b.type = choice(x, x.o.type, ['list', 'board', 'table'], 'Type');
          if (x.o.filter != null) b.filters = x.o.filter.some(f => /^none$/i.test(f)) ? [] : x.o.filter.map(f => filterOf(x, f));
          const v = await x.api().patch(`/views/${seg(id)}`, nonEmpty(x, b, 'Pass --name, --type or --filter.'));
          x.emit(v, () => x.print(`Updated view ${x.bold(v.name)}`));
        },
      },
      rm: {
        usage: 'views rm <id>',
        async run(x) {
          const d = await x.api().del(`/views/${seg(x.need(x.args[0], 'Which view id?'))}`);
          x.emit(d, () => x.print('Deleted the view'));
        },
      },
    },
  },

  inbox: {
    about: 'Your notifications',
    default: 'list',
    verbs: {
      list: {
        usage: 'inbox [list] [--unread] [-n <limit>]',
        async run(x) {
          const a = x.api();
          const n = Math.min(Math.max(Number(x.o.limit) || 30, 1), 500);
          const [ns, names] = await Promise.all([a.all('/notifications', { unread: x.o.unread ? 'true' : undefined }, n), x.names(a)]);
          x.emit(ns, () => {
            if (!ns.length) x.print(x.dim(x.o.unread ? 'Nothing unread.' : 'Your inbox is empty.'));
            for (const v of ns)
              x.print(
                `${v.read ? ' ' : x.bold('•')} ${x.dim(when(v.at))} ${names.get(v.by) || 'Sudo Sapient'} ${v.text}${v.snippet ? x.dim(` — ${v.snippet}`) : ''} ${x.dim(v.id)}`,
              );
          });
        },
      },
      read: {
        usage: 'inbox read <id>... | inbox read --all',
        async run(x) {
          if (x.o.all) {
            const r = await x.api().post('/notifications/read-all');
            return x.emit(r, () => x.print(`Marked ${r.updated} read`));
          }
          x.need(x.args.length, 'Which notification? sudo-cli inbox read <id> (or --all)');
          return each(
            x,
            id => x.api().patch(`/notifications/${seg(id)}`, { read: true }),
            () => 'Marked read',
          );
        },
      },
      unread: {
        usage: 'inbox unread <id>...',
        run: x =>
          each(
            x,
            id => x.api().patch(`/notifications/${seg(id)}`, { read: false }),
            () => 'Marked unread',
          ),
      },
    },
  },

  activity: {
    about: 'The workspace’s activity feed',
    default: 'list',
    verbs: {
      list: {
        usage: 'activity [-p <project>] [-n <limit>]',
        async run(x) {
          const a = x.api();
          const n = Math.min(Math.max(Number(x.o.limit) || 30, 1), 500);
          const [as, names, ps] = await Promise.all([
            a.all('/activity', { project: x.o.project }, n),
            x.names(a),
            a.all('/projects', { includeArchived: 'true' }),
          ]);
          const keys = new Map(ps.map(p => [p.id, p.key]));
          x.emit(as, () => {
            if (!as.length) x.print(x.dim('Nothing yet.'));
            for (const e of as)
              x.print(
                `${x.dim(when(e.at))} ${x.pad(keys.get(e.project) || '', 6)} ${names.get(e.by) || '?'}${e.via ? x.dim(` via ${e.via}`) : ''} ${e.verb}${e.extra ? ` ${e.extra}` : ''}`,
              );
          });
        },
      },
    },
  },

  workspace: {
    about: 'Workspace settings and the invite link (changes: Owners and Admins)',
    default: 'show',
    verbs: {
      show: {
        usage: 'workspace [show]',
        async run(x) {
          const w = await x.api().get('/workspace');
          x.emit(w, () => x.print(`${x.bold(w.name || '(no name)')} · ${w.color}${w.brand ? ' · logo in the sidebar' : ''}`));
        },
      },
      edit: {
        usage: 'workspace edit [--name <n>] [--color <#RRGGBB>] [--brand on|off]   (Owners and Admins)',
        async run(x) {
          const b = {};
          if (x.o.name != null) b.name = x.o.name;
          if (x.o.color != null) b.color = x.o.color;
          if (x.o.brand != null) b.brand = onOff('', x.o.brand) === true;
          const w = await x.api().patch('/workspace', nonEmpty(x, b, 'Pass --name, --color or --brand.'));
          x.emit(w, () => x.print(`Updated the workspace: ${w.name}`));
        },
      },
      'invite-link': {
        usage: 'workspace invite-link                a new link to join as a Member; the old one stops working (Owners and Admins)',
        async run(x) {
          const r = await x.api().post('/workspace/invite-link');
          x.emit(r, () => x.print(r.link));
        },
      },
    },
  },

  prefs: {
    about: 'Your display preferences',
    default: 'show',
    verbs: {
      show: {
        usage: 'prefs [show]',
        async run(x) {
          const p = await x.api().get('/me/preferences');
          x.emit(p.preferences, () => {
            for (const [k, v] of Object.entries(p.preferences)) x.print(`${x.pad(k, 14)} ${v}`);
          });
        },
      },
      set: {
        usage: 'prefs set key=value...              e.g. theme=dark tz=Europe/Berlin weekStart=1 spell=off',
        async run(x) {
          const p = await x.api().patch('/me/preferences', { preferences: pairs(x, x.args, 'sudo-cli prefs set theme=dark') });
          x.emit(p.preferences, () => x.print('Preferences saved'));
        },
      },
    },
  },

  'notify-prefs': {
    about: 'Your notification preferences',
    default: 'show',
    verbs: {
      show: {
        usage: 'notify-prefs [show]',
        async run(x) {
          const p = await x.api().get('/me/preferences');
          x.emit(p.notifications, () => {
            for (const [k, v] of Object.entries(p.notifications)) x.print(`${x.pad(k, 16)} ${v ? 'on' : 'off'}`);
          });
        },
      },
      set: {
        usage: 'notify-prefs set key=on|off...       e.g. email_comment=on push_due=off',
        async run(x) {
          const p = await x.api().patch('/me/preferences', { notifications: pairs(x, x.args, 'sudo-cli notify-prefs set email_comment=on') });
          x.emit(p.notifications, () => x.print('Notification preferences saved'));
        },
      },
    },
  },

  favorites: {
    about: 'What you starred',
    default: 'list',
    verbs: {
      list: {
        usage: 'favorites                            (star with tasks fav / projects fav)',
        async run(x) {
          const a = x.api();
          const f = await a.get('/me/favorites');
          if (x.o.json) return x.json(f);
          const [ps, ts] = await Promise.all([a.all('/projects', { includeArchived: 'true' }), Promise.all(f.tasks.map(id => a.get(`/tasks/${seg(id)}`)))]);
          for (const p of ps.filter(p => f.projects.includes(p.id))) x.print(projLine(x, p));
          for (const t of ts) x.print(taskLine(x, t));
          if (!f.projects.length && !f.tasks.length) x.print(x.dim('Nothing starred.'));
        },
      },
    },
  },
};

/* The other names a noun goes by. */
export const ALIASES = {
  task: 'tasks',
  project: 'projects',
  subtasks: 'subtask',
  comments: 'comment',
  team: 'teams',
  person: 'people',
  member: 'people',
  members: 'people',
  bot: 'bots',
  file: 'files',
  event: 'events',
  calendar: 'events',
  view: 'views',
  notifications: 'inbox',
  pref: 'prefs',
  preferences: 'prefs',
  favourites: 'favorites',
  favs: 'favorites',
};

export function nounHelp(noun) {
  const n = NOUNS[noun];
  return `sudo-cli ${noun}: ${n.about}\n\n${Object.values(n.verbs)
    .map(v => '  sudo-cli ' + v.usage)
    .join('\n')}\n\nAll take --json.${noun === 'subtask' || noun === 'tasks' ? ' Dates: today, tomorrow, friday, +3d, 2026-11-20 (none clears).' : ''}`;
}

/* ---------- several keys or ids in one command ---------- */
/* `done WEB-1 WEB-2 WEB-3`, `tasks rm …`, `inbox read …`: one request per key or id, in order. The
   first one that fails stops the run, and the output says which went through (stdout, as they
   happen; deleted tasks with their undo ids), which failed and why, and which weren't tried (stderr),
   so nothing is done twice and nothing runs on after a mistake. Exit code 1. With --json, stdout is
   the array of what went through and stderr one { error, code: "incomplete", done, failed, notTried }
   object. A single key fails like any other command. Returns the exit code. */
export async function several(x, refs, call, line) {
  if (refs.length === 1) {
    const r = await call(refs[0]);
    x.emit(r, () => x.print(line(r)));
    return 0;
  }
  // Not logged in, or a plain-http URL: a usage error (exit 2) before anything is tried.
  x.api();
  const done = [];
  const results = [];
  for (const [i, ref] of refs.entries()) {
    let r;
    try {
      r = await call(ref);
    } catch (e) {
      const notTried = refs.slice(i + 1);
      // Offline, a server error or a bug may come after the change was made.
      const unsure = !(e instanceof ApiError) || e.status === 0 || e.status >= 500;
      const msg = `${x.clean(e.message)}${unsure ? ' It may have gone through: check before retrying it.' : ''}`;
      const summary =
        `Stopped at ${x.clean(ref)}; ${done.length} of ${refs.length} done${done.length ? ` (${done.map(x.clean).join(', ')})` : ''}.` +
        (notTried.length ? ` Not tried: ${notTried.map(x.clean).join(', ')}.` : '');
      if (x.o.json) {
        x.json(results);
        x.warnJson({
          error: summary,
          code: 'incomplete',
          done,
          failed: { ref, code: e.code || 'internal_error', error: msg },
          notTried,
        });
      } else {
        x.warn(`${x.clean(ref)}: ${msg}${e.status === 401 ? ' Run sudo-cli login.' : ''}`);
        x.warn(summary);
      }
      // Anything but the API's refusal (a bug) is still raised, once what happened has been said.
      if (!(e instanceof ApiError)) throw e;
      return 1;
    }
    done.push(ref);
    results.push(r);
    if (!x.o.json) x.print(line(r));
  }
  if (x.o.json) x.json(results);
  return 0;
}

/* ---------- helpers for handlers ---------- */
function each(x, call, line) {
  x.need(x.args.length, 'Which one? Give at least one key or id.');
  return several(x, x.args, call, line);
}
async function one(x, call, line) {
  const r = await call(x.need(x.args[0], 'Which one? Give a key, e.g. WEB.'));
  x.emit(r, () => x.print(line(r)));
}
async function subPatch(x, body, verb) {
  const [k, id] = x.args;
  x.need(k && id, `sudo-cli subtask ${verb.toLowerCase()} WEB-12 <subtask id>  (ids are in sudo-cli show WEB-12)`);
  const t = await x.api().patch(`/tasks/${seg(k)}/subtasks/${seg(id)}`, body);
  const s = t.subtasks.find(s => s.id === id);
  x.emit(t, () => x.print(`${verb} “${s?.title ?? id}” on ${x.bold(t.key)}`));
}
function teamBody(x) {
  const b = {};
  if (x.o.desc != null) b.description = x.o.desc;
  if (x.o.icon != null) b.icon = x.o.icon;
  if (x.o.color != null) b.color = x.o.color;
  if (x.o.members != null) b.members = /^none$/i.test(x.o.members) ? [] : list(x.o.members);
  return b;
}
function botBody(x) {
  const b = {};
  if (x.o.role != null) b.role = choice(x, x.o.role, ['Member', 'Guest'], 'A bot’s role');
  if (x.o.projects != null) b.projects = /^none$/i.test(x.o.projects) ? [] : list(x.o.projects);
  return b;
}

/* `react` / `unreact`: emoji or its name. */
export function reaction(x, v) {
  const e = REACTIONS[String(v).toLowerCase()] || v;
  if (!Object.values(REACTIONS).includes(e)) x.usage('Reactions are 👍 🎉 ❤️ 👀 🚀 ✅ (or thumbsup, tada, heart, eyes, rocket, check).');
  return e;
}

/* `sudo-cli api <METHOD> <path>`: any endpoint, JSON in and out. -f key=value sends a string,
   -F key=value a typed value (true, 3, null, [..], {..}); on GET they go in the query. */
export async function rawApi(x) {
  const [m, p] = x.args;
  const method = String(m || '').toUpperCase();
  if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method) || !p)
    x.usage('sudo-cli api <GET|POST|PATCH|PUT|DELETE> </path> [--data <json>] [-f key=value]... [-F key=value]...');
  const u = new URL(p.replace(/^\/?(api\/v1)?\/?/, '/'), 'http://x');
  const fields = {};
  for (const [list_, typed] of [
    [x.o['raw-field'], false],
    [x.o.field, true],
  ])
    for (const f of list_ || []) {
      const i = f.indexOf('=');
      if (i < 1) x.usage(`A field is key=value, not “${f}”.`);
      const v = f.slice(i + 1);
      let val = v;
      if (typed)
        try {
          val = JSON.parse(v);
        } catch {
          /* not JSON: the string */
        }
      fields[f.slice(0, i)] = val;
    }
  let body;
  if (x.o.data != null) {
    try {
      body = JSON.parse(x.o.data);
    } catch {
      x.usage('--data must be JSON.');
    }
  }
  const query = Object.fromEntries(u.searchParams);
  if (method === 'GET' || method === 'DELETE') Object.assign(query, fields);
  else if (Object.keys(fields).length) body = { ...(body || {}), ...fields };
  const r = await x
    .api()
    .request(method, u.pathname, { query, ...(body !== undefined ? { body } : method === 'GET' || method === 'DELETE' ? {} : { body: {} }) });
  x.json(r);
}
