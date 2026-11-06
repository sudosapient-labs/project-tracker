#!/usr/bin/env node
/* Development only: how much context tool results take, against the raw REST responses a generic
   API-to-MCP bridge would hand the model. Seeds the demo workspace into an in-memory database,
   calls each read tool as the demo Owner, and compares sizes. Usage:
     node packages/mcp/scripts/results.js */
import { createClient } from '@sudosapient/client';
import { TOOLS, fence } from '../src/tools.js';
import { TEAMS_SEED } from '../../../src/core/constants.js';
import { loadConfig } from '../../../server/config.js';
import { openDb } from '../../../server/db.js';
import { createApp } from '../../../server/app.js';
import { createKey } from '../../../server/api/keys.js';

globalThis.document ??= { querySelectorAll: () => [] };
const { seed } = await import('../../../server/scripts/demo-data.js');

const config = loadConfig({ NODE_ENV: 'test', DISABLE_RATE_LIMIT: 'true', APP_URL: 'http://demo.test' });
const db = openDb(':memory:');
const { app, repo } = createApp({ db, config, log: { info() {}, error() {} }, pushSend: async () => {} });
const d = seed();
db.tx(() => {
  repo.saveWorkspace({ name: d.ws.name, c: d.ws.c, onboarded: true });
  for (const t of TEAMS_SEED) repo.put('teams', { ...t });
  for (const m of d.members) {
    repo.put('members', { ...m, email: m.email.toLowerCase() });
    if (m.status === 'active') db.run('INSERT INTO users (id, email, email_verified_at, created_at) VALUES (?, ?, 1, 1)', m.id, m.email.toLowerCase());
  }
  for (const { fav, ...p } of d.projects) repo.put('projects', { ...p, private: !!p.private, seq: 300 });
  for (const { fav, ...t } of d.tasks) repo.put('tasks', t, t.project);
  const pid = new Map(d.tasks.map(t => [t.id, t.project]));
  for (const c of d.comments) repo.put('comments', { ...c, project: pid.get(c.task) }, pid.get(c.task));
  for (const a of [...d.activity].reverse()) repo.put('activity', a, a.project);
});
const { token } = createKey(db, d.me, { name: 'eval', scope: 'read', expiresInDays: null });
const api = createClient({ url: 'http://demo.test', key: token, fetch: (u, i) => app.request(u, i) });

// The busiest task (most comments) and its project, so get_task has something to compress.
const busiest = [...d.tasks].sort((a, b) => d.comments.filter(c => c.task === b.id).length - d.comments.filter(c => c.task === a.id).length)[0];
const proj = d.projects.find(p => p.id === busiest.project).key;
const word = busiest.title.split(/\s+/).find(w => w.length > 4) || busiest.title;
const raw = async (...paths) => (await Promise.all(paths.map(p => api.get(p)))).reduce((n, r) => n + JSON.stringify(r).length, 0);
const cases = [
  ['list_my_work', {}, () => raw('/tasks?assignee=me&status=open&limit=100', '/members?limit=100')],
  ['search', { q: word }, () => raw(`/search?q=${encodeURIComponent(word)}`)],
  [
    'get_task',
    { key: busiest.key },
    () => raw(`/tasks/${busiest.key}`, `/tasks/${busiest.key}/comments`, `/tasks/${busiest.key}/activity`, '/members?limit=100'),
  ],
  ['summarise_project', { project: proj }, () => raw(`/projects/${proj}`, `/tasks?project=${proj}&limit=100`, '/members?limit=100')],
  ['list_projects', {}, () => raw('/projects?limit=100')],
];
console.log(`Demo workspace: ${d.tasks.length} tasks, ${d.comments.length} comments, ${d.members.length} people\n`);
console.log('| Tool (args) | Raw REST chars | Tool result chars | Saved |\n|---|---:|---:|---:|');
for (const [name, args, rest] of cases) {
  const out = fence(await TOOLS[name].run(api, args)).length;
  const r = await rest();
  console.log(`| \`${name}\` ${JSON.stringify(args)} | ${r} | ${out} | ${Math.round((1 - out / r) * 100)}% |`);
}
