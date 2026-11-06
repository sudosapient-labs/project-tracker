// @ts-check
/* Bot members (Settings → API → Bots): automation that acts through its own API keys, with its own
   role (Member or Guest) and project access, so every rule in sync/rules.js applies to it as to a
   person. A bot is a `users` row with kind 'bot' (no password, an undeliverable `.invalid` address)
   plus a member record with kind 'bot'; it can never sign in or be emailed (see routes/auth.js,
   auth.js, notify.js and lib/mailer.js, which each refuse it explicitly). */
import { newId } from '../lib/crypto.js';
import { avatarColor } from '../routes/auth.js';
import { listKeys } from './keys.js';

export const BOT_ROLES = ['Member', 'Guest'];
export const MAX_BOTS = 50;
/* RFC 2606 reserves `.invalid`: no address on it can ever receive mail. */
export const BOT_DOMAIN = 'bot.invalid';
export const isBotAddress = addr => /@bot\.invalid$/i.test(String(addr || ''));
export const isBot = m => m?.kind === 'bot';

const botRows = db =>
  db.all("SELECT u.id, u.created_at, m.data FROM users u JOIN members m ON m.id = u.id WHERE u.kind = 'bot' ORDER BY u.created_at, u.rowid");

/* A bot as Settings → API → Bots shows it: its projects and keys, each key with the admin who made it. */
function view(db, repo, row, projects = repo.all('projects')) {
  const m = JSON.parse(row.data);
  return {
    id: m.id,
    name: m.name,
    role: m.role,
    createdAt: row.created_at,
    projects: projects.filter(p => (p.members || []).includes(m.id)).map(p => p.id),
    keys: listKeys(db, m.id),
  };
}
export const listBots = (db, repo) => {
  const projects = repo.all('projects');
  return botRows(db).map(r => view(db, repo, r, projects));
};
export const getBot = (db, repo, id) => {
  const row = db.get("SELECT u.id, u.created_at, m.data FROM users u JOIN members m ON m.id = u.id WHERE u.kind = 'bot' AND u.id = ?", id);
  return row ? view(db, repo, row) : null;
};

/* Put the bot on exactly the projects in `ids`, the way the share dialog lists a person: added with
   the default level for its role, removed along with any level set for it. Returns changed projects. */
function setProjects(repo, botId, ids) {
  const want = new Set(ids);
  const changed = [];
  for (const p of repo.all('projects')) {
    const on = (p.members || []).includes(botId) || p.lead === botId;
    if (on === want.has(p.id)) continue;
    if (want.has(p.id)) p.members = [...(p.members || []), botId];
    else {
      p.members = (p.members || []).filter(x => x !== botId);
      if (p.perms) delete p.perms[botId];
      if (p.lead === botId) p.lead = null;
    }
    repo.put('projects', p);
    changed.push(p);
  }
  return changed;
}

/* Create a bot. Call inside a transaction; returns the changes to publish to open apps. */
export function createBot(db, repo, { name, role, projects = [] }, now = Date.now()) {
  const id = newId('m');
  const email = `${id}@${BOT_DOMAIN}`;
  const member = { id, name, email, role, team: '', title: '', c: avatarColor(id), status: 'active', last: null, tz: '', kind: 'bot' };
  repo.put('members', member);
  db.run("INSERT INTO users (id, email, password_hash, email_verified_at, created_at, kind) VALUES (?, ?, NULL, NULL, ?, 'bot')", id, email, now);
  const changed = setProjects(repo, id, projects);
  return { member, changes: [{ c: 'members', id, v: member }, ...changed.map(p => ({ c: 'projects', id: p.id, v: p }))] };
}

/* Rename, change role or projects. Call inside a transaction; returns the changes to publish. */
export function updateBot(repo, member, { name, role, projects }) {
  const out = [];
  if ((name != null && name !== member.name) || (role != null && role !== member.role)) {
    if (name != null) member.name = name;
    if (role != null) member.role = role;
    repo.put('members', member);
    out.push({ c: 'members', id: member.id, v: member });
  }
  if (projects) for (const p of setProjects(repo, member.id, projects)) out.push({ c: 'projects', id: p.id, v: p });
  return out;
}
