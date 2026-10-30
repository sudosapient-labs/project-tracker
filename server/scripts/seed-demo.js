/* Development only: fill an empty database with the original demo workspace (Sudo Sapient) so the
   UI has realistic data to look at. Every active demo person can sign in with DEMO_PASSWORD.

   pnpm db:seed            seeds data/gr8r.db (or DATABASE_PATH)            */
import { TEAMS_SEED } from '../../src/core/constants.js';
import { loadConfig } from '../config.js';
import { openDb } from '../db.js';
import { createRepo } from '../repo.js';
import { hashPassword } from '../lib/crypto.js';

// The shared date helpers touch `document` when they load; give them a stub outside the browser.
globalThis.document ??= { querySelectorAll: () => [] };
const { seed } = await import('./demo-data.js');

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'gr8r-demo-123';
const config = loadConfig();
if (config.prod) {
  console.error('Refusing to seed demo data in production.');
  process.exit(1);
}
const db = openDb(config.dbPath);
const repo = createRepo(db);
if (repo.workspace()) {
  console.error(`${config.dbPath} already has a workspace. Delete it first to reseed.`);
  process.exit(1);
}

const d = seed();
const hash = await hashPassword(DEMO_PASSWORD);
const now = Date.now();
db.tx(() => {
  repo.saveWorkspace({ name: d.ws.name, c: d.ws.c, brand: !!d.ws.brand, onboarded: true });
  for (const t of TEAMS_SEED) repo.put('teams', { ...t });
  for (const m of d.members) {
    const email = m.email.toLowerCase();
    repo.put('members', { ...m, email });
    if (m.status === 'active')
      db.run('INSERT INTO users (id, email, password_hash, email_verified_at, created_at) VALUES (?, ?, ?, ?, ?)', m.id, email, hash, now, now);
  }
  for (const { fav, ...p } of d.projects) {
    repo.put('projects', { ...p, private: !!p.private, access: p.private ? 'private' : 'workspace', seq: 300 });
    if (fav) repo.setFavorite(d.me, 'projects', p.id, true);
  }
  for (const { fav, ...t } of d.tasks) {
    repo.put('tasks', t, t.project);
    if (fav) repo.setFavorite(d.me, 'tasks', t.id, true);
  }
  const taskProject = new Map(d.tasks.map(t => [t.id, t.project]));
  for (const c of d.comments) repo.put('comments', { ...c, project: taskProject.get(c.task) }, taskProject.get(c.task));
  // Inserted oldest first so newest-first queries return the original order.
  for (const a of [...d.activity].reverse()) repo.put('activity', a, a.project);
  for (const n of [...d.notifs].reverse()) repo.put('notifs', n, d.me);
  // Demo files are metadata only: there are no bytes behind them.
  for (const f of [...d.files].reverse()) repo.put('files', f, f.project);
  for (const e of d.events) repo.put('events', e, e.project);
  for (const v of d.savedViews) repo.put('savedViews', v, v.project);
  repo.saveUserState(d.me, { projOrder: d.projOrder, recentSearches: d.recentSearches, notifPrefs: d.notifPrefs });
});

console.info(`Seeded ${config.dbPath}. Sign in as ${d.members[0].email} / ${DEMO_PASSWORD}`);
