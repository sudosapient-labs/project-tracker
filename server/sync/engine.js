/* The sync engine. Clients send batches of field-level operations against the same object graph
   they render; the engine checks each against RULES, writes it, and pushes the resulting records
   to every other connected client that is allowed to see them (Server-Sent Events).

   Operation:  { c: collection, id, k: 'put' | 'patch' | 'del', v: object }
   Result:     { ok: true, v: canonical } | { ok: false, error, v: canonical-or-null }
   A rejected op is rolled back alone (savepoint) and the client resets that record to `v`. */
import fs from 'node:fs';
import path from 'node:path';
import { COLLS } from '../repo.js';
import { Reject } from '../lib/http.js';
import { DOC_SCHEMAS, MAX_RECORD_BYTES, SCHEMAS } from './schemas.js';
import { RULES, canSee, isAdmin } from './rules.js';

const PROJECT_SCOPED = new Set(['tasks', 'comments', 'activity', 'files', 'events', 'savedViews']);
const PERSONAL_DOCS = new Set(['projOrder', 'recentSearches', 'notifPrefs']);
const DOCS = new Set(['ws', ...PERSONAL_DOCS]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

export function createEngine({ db, repo, config, mailer, pusher = null, log = console }) {
  const conns = new Set();

  /* Add the reader's own favourite flag to projects and tasks. */
  function project(c, v, favs) {
    if (!v || (c !== 'projects' && c !== 'tasks')) return v;
    return { ...v, fav: favs[c].has(v.id) };
  }

  function makeCtx(auth) {
    const ctx = {
      db,
      repo,
      config,
      mailer,
      me: auth.member,
      uid: auth.member.id,
      now: Date.now(),
      changes: [],
      resync: new Set(),
      removedUsers: [],
      blobGc: new Set(),
      links: [],
      afterPut: [],
      emit(c, v) {
        ctx.changes.push({ c, id: v.id, v, pid: scopeOf(c, v) });
      },
      emitDel(c, id, pid) {
        ctx.changes.push({ c, id, v: null, pid });
      },
    };
    return ctx;
  }
  const scopeOf = (c, v) => (c === 'notifs' ? null : (RULES[c]?.scope?.(v) ?? null));
  /* Notifications are only ever visible to (and stored under) their recipient. */
  const getFor = (c, id, uid) =>
    c === 'notifs' ? JSON.parse(db.get('SELECT data FROM notifications WHERE id = ? AND user_id = ?', id, uid)?.data || 'null') : repo.get(c, id);

  function applyDoc(ctx, op) {
    const { c, k, v } = op;
    if (k === 'del') throw new Reject('Not supported.', 400);
    if (c === 'ws') {
      if (!isAdmin(ctx)) throw new Reject('Only admins can change workspace settings.');
      const cur = repo.workspace();
      const { onboarded, ...base } = cur;
      const next = k === 'patch' ? { ...base, ...v } : { ...v };
      const r = DOC_SCHEMAS.ws.safeParse(next);
      if (!r.success) throw new Reject(r.error.issues[0].message, 400);
      repo.saveWorkspace({ ...r.data, onboarded });
      ctx.changes.push({ c: 'ws', v: r.data });
      return r.data;
    }
    const field = c;
    const cur = repo.userState(ctx.uid)[field];
    const next = k === 'patch' && isObj(cur) ? { ...cur, ...v } : v;
    const r = DOC_SCHEMAS[c].safeParse(next);
    if (!r.success) throw new Reject(r.error.issues[0].message, 400);
    repo.saveUserState(ctx.uid, { [field]: r.data });
    ctx.changes.push({ c, v: r.data, onlyUser: ctx.uid });
    return r.data;
  }

  function applyOp(ctx, op, favs) {
    const { c, id, k } = op;
    if (DOCS.has(c)) return applyDoc(ctx, op);
    const rule = RULES[c];
    if (!rule || !COLLS[c]) throw new Reject(`Unknown collection ${c}.`, 400);
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Reject('Invalid id.', 400);
    const before = getFor(c, id, ctx.uid);

    if (k === 'del') {
      if (!before) return null;
      rule.remove(ctx, before);
      repo.del(c, id);
      ctx.emitDel(c, id, scopeOf(c, before));
      return null;
    }
    if (k !== 'put' && k !== 'patch') throw new Reject('Unknown operation.', 400);
    if (!isObj(op.v)) throw new Reject('Invalid value.', 400);

    const v = { ...op.v };
    const personal = {};
    for (const f of rule.personal || []) {
      if (f in v) personal[f] = v[f];
      delete v[f];
    }
    let after;
    let changed = true;
    if (!before) {
      if (k === 'patch') throw new Reject('This item was deleted.', 404);
      after = rule.create(ctx, { ...v, id });
    } else {
      after = k === 'put' ? { ...v, id } : { ...before, ...v, id };
      for (const f of rule.serverOwned || []) {
        if (f in before) after[f] = before[f];
        else delete after[f];
      }
      const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(f => !same(before[f], after[f]));
      changed = keys.length > 0;
      if (changed) after = rule.update(ctx, before, after, keys);
    }
    if (changed) {
      const schema = SCHEMAS[c];
      const r = schema.safeParse(after);
      if (!r.success) {
        const i = r.error.issues[0];
        throw new Reject(`${i.path.join('.') || c}: ${i.message}`, 400);
      }
      if (JSON.stringify(after).length > MAX_RECORD_BYTES) throw new Reject('This item is too large to save.', 413);
      repo.put(c, after, c === 'notifs' ? ctx.uid : scopeOf(c, after));
      ctx.afterPut.splice(0).forEach(f => f());
      if (c === 'notifs') ctx.changes.push({ c, id, v: after, uid: ctx.uid });
      else ctx.emit(c, after);
    }
    if ('fav' in personal && (c === 'projects' || c === 'tasks')) {
      const on = !!personal.fav;
      if (favs[c].has(id) !== on) {
        repo.setFavorite(ctx.uid, c, id, on);
        on ? favs[c].add(id) : favs[c].delete(id);
        if (!changed) ctx.changes.push({ c, id, v: after, pid: scopeOf(c, after), onlyUser: ctx.uid });
      }
    }
    return after;
  }

  /* Apply a batch for one signed-in person. Each op gets its own savepoint inside one transaction. */
  function apply(auth, ops, clientId) {
    const ctx = makeCtx(auth);
    const favs = repo.favorites(ctx.uid);
    const results = [];
    db.tx(() => {
      ops.forEach((op, i) => {
        const mark = ctx.changes.length;
        db.exec('SAVEPOINT op');
        try {
          const v = applyOp(ctx, op, favs);
          db.exec('RELEASE op');
          results.push({ ok: true, v: project(op.c, v, favs) });
        } catch (e) {
          db.exec('ROLLBACK TO op');
          db.exec('RELEASE op');
          ctx.changes.length = mark;
          ctx.afterPut.length = 0;
          if (!(e instanceof Reject)) {
            log.error?.(`[sync] op ${i} (${op?.c}/${op?.k}) failed`, e);
            results.push({ ok: false, error: 'Something went wrong saving this change.', v: current(op, favs, ctx.uid) });
          } else results.push({ ok: false, error: e.message, status: e.status, v: current(op, favs, ctx.uid) });
        }
      });
    });
    afterCommit(ctx, clientId);
    return { results, links: ctx.links };
  }

  function current(op, favs, uid) {
    if (!op || typeof op !== 'object') return null;
    if (op.c === 'ws') return repo.workspace();
    if (PERSONAL_DOCS.has(op.c)) return repo.userState(uid)[op.c];
    if (!COLLS[op.c] || typeof op.id !== 'string') return null;
    return project(op.c, getFor(op.c, op.id, uid), favs);
  }

  function afterCommit(ctx, clientId) {
    mailer.drain();
    publish(ctx.changes, { exceptClient: clientId });
    for (const uid of ctx.removedUsers) for (const k of conns) if (k.uid === uid) k.close();
    if (ctx.resync.has('*')) conns.forEach(k => k.send('resync', {}));
    else for (const k of conns) if (ctx.resync.has(k.uid)) k.send('resync', {});
    for (const key of ctx.blobGc) {
      if (db.get('SELECT 1 FROM files WHERE storage_key = ?', key)) continue;
      fs.rm(path.join(config.uploadDir, key), { force: true }, () => {});
    }
  }

  /* ---------- fan-out ---------- */
  function publish(changes, { exceptClient } = {}) {
    // Web Push goes to every subscribed browser, whether or not the app is open.
    if (pusher) for (const ch of changes) if (ch.push && ch.uid) pusher.notify(ch.uid, ch.push);
    if (!changes.length || !conns.size) return;
    // One batch can touch a record several times (e.g. a project's key counter); send its last state.
    const last = new Map();
    changes.forEach((ch, i) => last.set(`${ch.c}:${ch.id ?? ''}:${ch.onlyUser ?? ''}:${ch.uid ?? ''}`, i));
    changes = changes.filter((ch, i) => last.get(`${ch.c}:${ch.id ?? ''}:${ch.onlyUser ?? ''}:${ch.uid ?? ''}`) === i);
    const projects = new Map(repo.all('projects').map(p => [p.id, p]));
    const members = new Map(repo.all('members').map(m => [m.id, m]));
    const favCache = new Map();
    for (const k of conns) {
      if (k.clientId && k.clientId === exceptClient) continue;
      const out = [];
      for (const ch of changes) {
        if (ch.onlyUser && ch.onlyUser !== k.uid) continue;
        if (ch.c === 'notifs' && ch.uid !== k.uid) continue;
        if (PROJECT_SCOPED.has(ch.c) && ch.v && ch.pid && !canSee(projects.get(ch.pid), members.get(k.uid))) continue;
        let v = ch.v;
        if (v && (ch.c === 'projects' || ch.c === 'tasks')) {
          if (!favCache.has(k.uid)) favCache.set(k.uid, repo.favorites(k.uid));
          v = project(ch.c, v, favCache.get(k.uid));
        }
        out.push(DOCS.has(ch.c) ? { c: ch.c, v } : { c: ch.c, id: ch.id, v });
      }
      if (out.length) k.send('changes', out);
    }
  }

  /* ---------- connections ---------- */
  function connect({ uid, sessionId, clientId }, send, close) {
    const k = { uid, sessionId, clientId, send, close: () => conns.delete(k) && close() };
    conns.add(k);
    return k;
  }
  const disconnect = k => conns.delete(k);
  const disconnectSession = sid => [...conns].filter(k => k.sessionId === sid).forEach(k => k.close());

  return { apply, publish, connect, disconnect, disconnectSession, connections: () => conns.size };
}
