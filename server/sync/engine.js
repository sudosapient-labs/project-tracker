/* The sync engine. Clients send batches of field-level operations against the same object graph
   they render; the engine checks each against RULES, writes it, and pushes the resulting records
   to every other connected client that is allowed to see them (Server-Sent Events).

   Operation:  { c: collection, id, k: 'put' | 'patch' | 'del', v: object, base?: object, restore?: true }
               `restore`: a put that undoes this person's recent delete of the record (rules.js `restore`).
               `base`: for list and map fields in a patch, the values the client edited from (merge.js).
   Result:     { ok: true, v: canonical } | { ok: false, error, v: canonical-or-null }
   A rejected op is rolled back alone (savepoint) and the client resets that record to `v`.
   Records the batch changed besides its own (e.g. the next occurrence of a repeating task) come
   back as `changes`, since the live stream skips the tab that sent it. */
import fs from 'node:fs';
import path from 'node:path';
import { COLLS } from '../repo.js';
import { Reject } from '../lib/http.js';
import { currentAuth } from '../auth.js';
import { DOC_SCHEMAS, MAX_RECORD_BYTES, SCHEMAS } from './schemas.js';
import { MERGED, mergeField } from './merge.js';
import { RICH_MS_PER_REQUEST, RICH_PER_REQUEST } from './budget.js';
import { RULES, canSee, isAdmin, memberFor, projectFor, removeMemberCascade } from './rules.js';

const PROJECT_SCOPED = new Set(['tasks', 'comments', 'activity', 'files', 'events', 'savedViews']);
/* How long a deleted record can be restored by Undo (see `restore` in rules.js). */
export const RESTORE_MS = 10 * 60_000;

const PERSONAL_DOCS = new Set(['projOrder', 'recentSearches', 'notifPrefs']);
const DOCS = new Set(['ws', ...PERSONAL_DOCS]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

export function createEngine({ db, repo, config, mailer, pusher = null, log = console, limit = () => true }) {
  const conns = new Set();

  /* Add the reader's own favourite flag to projects and tasks. */
  function project(c, v, favs) {
    if (!v || (c !== 'projects' && c !== 'tasks')) return v;
    return { ...v, fav: favs[c].has(v.id) };
  }

  function makeCtx(auth, via = null) {
    const ctx = {
      db,
      repo,
      config,
      mailer,
      me: auth.member,
      uid: auth.member.id,
      // What made the change when it wasn't the app (an API key, the CLI, an MCP client), for activity.
      via,
      now: Date.now(),
      // Rich text this request may still have checked and sanitised (rules.js richDesc).
      richLeft: RICH_PER_REQUEST,
      richMsLeft: RICH_MS_PER_REQUEST,
      changes: [],
      resync: new Set(),
      removedUsers: [],
      blobGc: new Set(),
      links: [],
      afterPut: [],
      // Check-and-count against a rate limit (see lib/rate-limit.js); false once it's used up.
      limit,
      /* `from`: the project a record just moved out of, so people who could only see that one drop it. */
      emit(c, v, from) {
        ctx.changes.push({ c, id: v.id, v, pid: scopeOf(c, v), ...(from ? { from } : {}) });
      },
      /* The project as it was when the record went, so a delete only reaches people who could see it
         (even when the project itself is being deleted in the same batch). */
      emitDel(c, id, pid) {
        ctx.changes.push({ c, id, v: null, pid, ...(pid ? { proj: repo.get('projects', pid) } : {}) });
      },
      /* Keep a deleted record for a while, so the person who deleted it can Undo it as it was. */
      keepDeleted(c, v) {
        if (!RULES[c]?.restore) return;
        db.run('DELETE FROM recent_deletes WHERE deleted_at < ?', ctx.now - RESTORE_MS);
        db.run(
          'INSERT OR REPLACE INTO recent_deletes (coll, id, user_id, data, deleted_at) VALUES (?, ?, ?, ?, ?)',
          c,
          v.id,
          ctx.uid,
          JSON.stringify(v),
          ctx.now,
        );
      },
    };
    return ctx;
  }
  const scopeOf = (c, v) => (c === 'notifs' ? null : (RULES[c]?.scope?.(v) ?? null));
  /* Notifications are only ever visible to (and stored under) their recipient. */
  const getFor = (c, id, uid) =>
    c === 'notifs' ? JSON.parse(db.get('SELECT data FROM notifications WHERE id = ? AND user_id = ?', id, uid)?.data || 'null') : repo.get(c, id);
  /* A record as person `m` may see it: projects may be a stub, and work in projects they can't see is null. */
  function visible(c, v, m, projects = null) {
    if (!v) return v;
    if (c === 'projects') return projectFor(v, m);
    if (c === 'members') return memberFor(v, m, projects ? projects.values() : repo.all('projects'));
    const pid = PROJECT_SCOPED.has(c) && scopeOf(c, v);
    if (pid && !canSee(projects ? projects.get(pid) : repo.get('projects', pid), m)) return null;
    return v;
  }

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
      ctx.keepDeleted(c, before);
      repo.del(c, id);
      ctx.emitDel(c, id, scopeOf(c, before));
      return null;
    }
    if (k !== 'put' && k !== 'patch') throw new Reject('Unknown operation.', 400);
    if (!isObj(op.v)) throw new Reject('Invalid value.', 400);
    // No record may be larger than this once saved, so refuse a bigger value before any rule works on it.
    if (JSON.stringify(op.v).length > MAX_RECORD_BYTES) throw new Reject('This item is too large to save.', 413);
    if (op.base != null && (!isObj(op.base) || JSON.stringify(op.base).length > MAX_RECORD_BYTES)) throw new Reject('Invalid value.', 400);

    const v = { ...op.v };
    // List and map fields sent with the value they were edited from (`base`) are merged onto the
    // current value, so a stale write only applies its own changes (see merge.js).
    if (before && k === 'patch' && op.base) for (const f of MERGED[c] || []) if (f in v && f in op.base) v[f] = mergeField(op.base[f], v[f], before[f]);
    const personal = {};
    for (const f of rule.personal || []) {
      if (f in v) personal[f] = v[f];
      delete v[f];
    }
    let after;
    let changed = true;
    if (!before) {
      if (k === 'patch') throw new Reject('This item was deleted.', 404);
      // Undo of a delete: the server's own copy comes back as it was (author, time, reactions; no
      // notifications), only for the person who deleted it and only shortly after. Once it's no
      // longer kept the Undo is refused: creating it anew would re-author a comment and notify
      // people again. (Collections without a `restore` rule are created like anything new.)
      const restoring = op.restore === true && rule.restore;
      const kept =
        restoring &&
        db.get('SELECT data FROM recent_deletes WHERE coll = ? AND id = ? AND user_id = ? AND deleted_at >= ?', c, id, ctx.uid, ctx.now - RESTORE_MS);
      if (kept) {
        db.run('DELETE FROM recent_deletes WHERE coll = ? AND id = ?', c, id);
        after = rule.restore(ctx, { ...JSON.parse(kept.data), id });
      } else if (restoring) throw new Reject('This can no longer be undone.', 410);
      else after = rule.create(ctx, { ...v, id });
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
      else ctx.emit(c, after, before && scopeOf(c, before) !== scopeOf(c, after) ? scopeOf(c, before) : null);
    }
    // A patch that changes nothing (the app re-reads a record this way) answers like a missing record
    // for one this person can't see, so it can't be used to learn that a hidden record exists.
    if (!changed && before && !visible(c, before, ctx.me)) throw new Reject('This item was deleted.', 404);
    // A favourite needs a record this person can open: for one they can't, a change of only the
    // favourite answers like a missing record, and none is stored.
    const favOk = 'fav' in personal && canSee(c === 'projects' ? after : repo.get('projects', after.project), ctx.me);
    if ('fav' in personal && !favOk && !changed) throw new Reject('This item was deleted.', 404);
    if (favOk && (c === 'projects' || c === 'tasks')) {
      const on = !!personal.fav;
      if (favs[c].has(id) !== on) {
        repo.setFavorite(ctx.uid, c, id, on);
        on ? favs[c].add(id) : favs[c].delete(id);
        if (!changed) ctx.changes.push({ c, id, v: after, pid: scopeOf(c, after), onlyUser: ctx.uid });
      }
    }
    return after;
  }

  /* Apply a batch for one signed-in person. Each op gets its own savepoint inside one transaction.
     `atomic` (the public API): the first rejected op rolls the whole batch back, so a request never
     half-applies; its result is `failed`. */
  function apply(auth, ops, clientId, { via = null, atomic = false } = {}) {
    let ctx = null;
    let favs = null;
    const results = [];
    let failed = null;
    try {
      db.tx(() => {
        // Who is writing, as they are now: the request may have been authenticated before its body
        // arrived, and the person removed, demoted or signed out since.
        const fresh = currentAuth(db, auth);
        if (!fresh) {
          failed = { ok: false, error: auth.key ? 'That API key is no longer valid.' : 'Sign in to continue.', status: 401, gone: true };
          throw failed;
        }
        ctx = makeCtx(fresh, via);
        favs = repo.favorites(ctx.uid);
        // Once an op is deferred (`retry`: over the request's budget), every later op waits for it
        // too, so the batch is never applied out of order (a delete or comment before its record).
        let deferred = null;
        ops.forEach((op, i) => {
          if (deferred) return void results.push({ ok: false, error: deferred.message, status: deferred.status, retry: true, v: current(op, favs, ctx.me) });
          const mark = ctx.changes.length;
          db.exec('SAVEPOINT op');
          try {
            const v = applyOp(ctx, op, favs);
            db.exec('RELEASE op');
            results.push({ ok: true, v: project(op.c, visible(op.c, v, ctx.me), favs) });
          } catch (e) {
            db.exec('ROLLBACK TO op');
            db.exec('RELEASE op');
            ctx.changes.length = mark;
            ctx.afterPut.length = 0;
            if (!(e instanceof Reject)) {
              log.error?.(`[sync] op ${i} (${op?.c}/${op?.k}) failed`, e);
              results.push({ ok: false, error: 'Something went wrong saving this change.', status: 500, v: current(op, favs, ctx.me) });
            } else results.push({ ok: false, error: e.message, status: e.status, ...(e.retry ? { retry: true } : {}), v: current(op, favs, ctx.me) });
            if (e instanceof Reject && e.retry) deferred = e;
            if (atomic) throw (failed = results.at(-1));
          }
        });
      });
    } catch (e) {
      if (!failed || e !== failed) throw e;
      return { results, links: [], changes: [], failed, ...(failed.gone ? { gone: true } : {}) };
    }
    afterCommit(ctx, clientId);
    return { results, links: ctx.links, changes: sideEffects(ctx, ops, favs), failed };
  }

  /* What the batch changed beyond the records its ops name, as the sender may see it (their last
     state), for the tab that sent it: publish() leaves that tab out. */
  function sideEffects(ctx, ops, favs) {
    const named = new Set(ops.map(op => `${op?.c}:${op?.id}`));
    const last = new Map();
    for (const ch of ctx.changes) {
      const k = `${ch.c}:${ch.id}`;
      if (DOCS.has(ch.c) || ch.c === 'notifs' || named.has(k) || (ch.onlyUser && ch.onlyUser !== ctx.uid)) continue;
      last.delete(k);
      last.set(k, ch);
    }
    const out = [];
    for (const ch of last.values()) {
      if (!ch.v) {
        if (!ch.pid || !PROJECT_SCOPED.has(ch.c) || canSee(repo.get('projects', ch.pid) || ch.proj, ctx.me)) out.push({ c: ch.c, id: ch.id, v: null });
        continue;
      }
      const v = visible(ch.c, ch.v, ctx.me);
      if (v) out.push({ c: ch.c, id: ch.id, v: project(ch.c, v, favs) });
    }
    return out;
  }

  function current(op, favs, me) {
    if (!op || typeof op !== 'object') return null;
    if (op.c === 'ws') return repo.workspace();
    if (PERSONAL_DOCS.has(op.c)) return repo.userState(me.id)[op.c];
    if (!COLLS[op.c] || typeof op.id !== 'string') return null;
    return project(op.c, visible(op.c, getFor(op.c, op.id, me.id), me), favs);
  }

  /* Someone deleting their own account: the same cascade as an admin removing them. */
  /* Returns false (and removes nothing) when the account is no longer the caller's to remove: their
     session ended meanwhile, or they've since become an Owner. */
  function removeAccount(auth) {
    let ctx = null;
    db.tx(() => {
      const fresh = currentAuth(db, auth);
      if (!fresh || (auth.session && fresh.member.role === 'Owner')) return;
      ctx = makeCtx(fresh);
      removeMemberCascade(ctx, fresh.member);
      repo.del('members', fresh.member.id);
      ctx.emitDel('members', fresh.member.id, null);
    });
    if (!ctx) return false;
    afterCommit(ctx, null);
    return true;
  }

  /* The batch is saved: a failure fanning it out (a broken stream, mail) mustn't report it unsaved,
     and each step runs on its own, so one failing can't stop e.g. people just removed from being
     disconnected. */
  function afterCommit(ctx, clientId) {
    const steps = [
      () => mailer.drain(),
      () => publish(ctx.changes, { exceptClient: clientId }),
      () => {
        for (const uid of ctx.removedUsers) for (const k of conns) if (k.uid === uid) k.close();
      },
      () => {
        for (const k of conns) if (ctx.resync.has('*') || ctx.resync.has(k.uid)) k.send('resync', {});
      },
      () => {
        for (const key of ctx.blobGc) {
          if (db.get('SELECT 1 FROM files WHERE storage_key = ?', key)) continue;
          fs.rm(path.join(config.uploadDir, key), { force: true }, () => {});
        }
      },
    ];
    for (const step of steps)
      try {
        step();
      } catch (e) {
        log.error?.('[sync] after-commit work failed', e);
      }
  }

  /* ---------- fan-out ---------- */
  function publish(changes, { exceptClient } = {}) {
    // Web Push goes to every subscribed browser, whether or not the app is open.
    if (pusher) for (const ch of changes) if (ch.push && ch.uid) pusher.notify(ch.uid, ch.push);
    if (!changes.length || !conns.size) return;
    // One batch can touch a record several times (e.g. a project's key counter); send its last state,
    // remembering the project it first moved out of.
    const last = new Map();
    for (const ch of changes) {
      const k = `${ch.c}:${ch.id ?? ''}:${ch.onlyUser ?? ''}:${ch.uid ?? ''}`;
      const prev = last.get(k);
      last.delete(k);
      last.set(k, prev?.from && !ch.from ? { ...ch, from: prev.from } : ch);
    }
    changes = [...last.values()];
    const projects = new Map(repo.all('projects').map(p => [p.id, p]));
    const members = new Map(repo.all('members').map(m => [m.id, m]));
    const favCache = new Map();
    for (const k of conns) {
      if (k.clientId && k.clientId === exceptClient) continue;
      const out = [];
      for (const ch of changes) {
        if (ch.onlyUser && ch.onlyUser !== k.uid) continue;
        if (ch.c === 'notifs' && ch.uid !== k.uid) continue;
        const m = members.get(k.uid);
        // Deletes in a project only go to people who could see that project.
        if (!ch.v && ch.pid && PROJECT_SCOPED.has(ch.c) && !canSee(projects.get(ch.pid) || ch.proj, m)) continue;
        let v = visible(ch.c, ch.v, m, projects);
        if (ch.v && !v) {
          // Gone from their view: moved into a project they can't see. Otherwise it was never theirs.
          if (!(ch.from && canSee(projects.get(ch.from), m))) continue;
          v = null;
        }
        if (v && (ch.c === 'projects' || ch.c === 'tasks')) {
          if (!favCache.has(k.uid)) favCache.set(k.uid, repo.favorites(k.uid));
          v = project(ch.c, v, favCache.get(k.uid));
        }
        out.push(DOCS.has(ch.c) ? { c: ch.c, v } : { c: ch.c, id: ch.id, v });
      }
      try {
        if (out.length) k.send('changes', out);
      } catch (e) {
        // One broken stream mustn't keep the changes from everyone after it.
        log.error?.('[sync] sending changes failed', e);
      }
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
  /* Shutting down: end every live-update stream so the HTTP server can close. */
  const closeAll = () => [...conns].forEach(k => k.close());

  return { apply, removeAccount, publish, connect, disconnect, disconnectSession, closeAll, connections: () => conns.size };
}
