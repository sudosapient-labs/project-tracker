// @ts-check
/* SQLite via Node's built-in driver. One connection per process; writes are serialised by SQLite
   and every sync batch runs inside a single IMMEDIATE transaction. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
// JS migrations (for data changes SQL can't express) load synchronously, like the .sql ones.
const require = createRequire(import.meta.url);

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  migrate(db);
  return wrap(db);
}

/* Apply each migration in `dir` not applied yet, in name order, each in its own transaction.
   Foreign keys are off while one runs (the pragma can only change outside a transaction): the
   documented way to change a table (create a new one, copy, drop the old, rename) would otherwise
   cascade-delete every row pointing at it, e.g. all sessions when `users` is rebuilt. Before
   committing, any reference the migration left broken fails it. */
export function migrate(db, dir = MIGRATIONS) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const done = new Set(
    db
      .prepare('SELECT name FROM schema_migrations')
      .all()
      .map(r => r.name),
  );
  const files = fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.sql') || f.endsWith('.js'))
    .sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const file = path.join(dir, f);
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      // A .js migration exports `default (db)` and gets the raw DatabaseSync inside the transaction.
      if (f.endsWith('.js')) require(file).default(db);
      else db.exec(fs.readFileSync(file, 'utf8'));
      const broken = db.prepare('PRAGMA foreign_key_check').all();
      if (broken.length) throw new Error(`it leaves ${broken.length} broken reference(s), first ${broken[0].table} → ${broken[0].parent}`);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, Date.now());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${f} failed: ${e.message}`);
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

/* Thin helpers over DatabaseSync: cached statements, plain-object rows, and nested-safe transactions. */
function wrap(db) {
  const cache = new Map();
  const stmt = sql => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = db.prepare(sql)));
    return s;
  };
  const plain = r => (r ? { ...r } : r);
  let depth = 0;
  return {
    raw: db,
    get: (sql, ...p) => plain(stmt(sql).get(...p)),
    all: (sql, ...p) =>
      stmt(sql)
        .all(...p)
        .map(plain),
    run: (sql, ...p) => stmt(sql).run(...p),
    exec: sql => db.exec(sql),
    tx(fn) {
      if (depth) return fn();
      db.exec('BEGIN IMMEDIATE');
      depth++;
      try {
        const out = fn();
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      } finally {
        depth--;
      }
    },
    close: () => db.close(),
  };
}
