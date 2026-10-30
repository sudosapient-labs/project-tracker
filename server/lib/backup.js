/* Backups. The database is copied with SQLite's VACUUM INTO: a consistent, compacted copy taken
   while the app keeps running, named gr8r-<UTC timestamp>.db; only the newest `keep` are kept.
   Uploaded files are mirrored into <dir>/uploads: stored files never change (each has its own random
   key), so each run copies only the ones that are new, and none are removed, so every kept database
   copy still has its files. */
import fs from 'node:fs';
import path from 'node:path';

const NAME = /^gr8r-\d{8}T\d{6}Z\.db$/;
export const listBackups = dir =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter(f => NAME.test(f))
        .sort()
    : [];

/* `db` is anything with exec(): the app's wrapped connection or a raw DatabaseSync. */
export function backup(db, dir, keep = 14, now = new Date()) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const file = path.resolve(dir, `gr8r-${stamp}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  for (const old of listBackups(dir).slice(0, -keep)) fs.rmSync(path.join(dir, old), { force: true });
  return file;
}

/* Whether the newest backup in `dir` is older than `everyMs` (or there is none). */
export function backupDue(dir, everyMs, now = Date.now()) {
  const last = listBackups(dir).at(-1);
  return !last || now - fs.statSync(path.join(dir, last)).mtimeMs >= everyMs;
}

/* Copy upload files missing from (or a different size in) <dir>/uploads. Returns how many were copied. */
export function backupUploads(uploadDir, dir) {
  if (!uploadDir || !fs.existsSync(uploadDir)) return 0;
  const out = path.join(dir, 'uploads');
  let n = 0;
  for (const rel of fs.readdirSync(uploadDir, { recursive: true })) {
    const src = path.join(uploadDir, rel);
    const st = fs.statSync(src);
    if (!st.isFile() || rel.endsWith('.part')) continue;
    const dst = path.join(out, rel);
    if (fs.existsSync(dst) && fs.statSync(dst).size === st.size) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst + '.part');
    fs.renameSync(dst + '.part', dst);
    n++;
  }
  return n;
}

/* Where backups go: BACKUP_DIR, or `backups` next to the database (writable wherever the database
   is, e.g. /data/backups in the Docker image). That default shares the database's disk, so it only
   protects against mistakes, not against losing the disk: point BACKUP_DIR at separate storage. */
export const backupDirOf = config => config.backupDir || path.join(path.dirname(path.resolve(config.dbPath)), 'backups');
