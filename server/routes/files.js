/* /api/files: upload bytes for a project (optionally attached to a task) and serve them back to
   people who can see that project. Bytes live under UPLOAD_DIR keyed by a random storage key. */
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Hono } from 'hono';
import { GONE, currentAuth, requireAuth } from '../auth.js';
import { newId } from '../lib/crypto.js';
import { fileType, fsize } from '../../src/core/file-types.js';
import { EDIT } from '../../src/core/access.js';
import { canSee, projectLevel } from '../sync/rules.js';

const INLINE = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain)$/;
const safeName = n =>
  String(n || 'file')
    .replace(/[\\/\0\r\n"]/g, '_')
    .slice(0, 255) || 'file';

const HOUR = 3_600_000;
/* Bytes stored for the whole workspace; copies of a file share one stored blob. */
const storedBytes = db => db.get('SELECT COALESCE(SUM(bytes), 0) n FROM (SELECT DISTINCT storage_key, bytes FROM files WHERE storage_key IS NOT NULL)').n;
/* Free bytes on the volume holding the uploads (and, on Railway, the database), or Infinity if unknown. */
async function freeBytes(dir) {
  try {
    const s = await fs.promises.statfs(dir);
    return s.bavail * s.bsize;
  } catch {
    return Infinity;
  }
}
const FULL = 'There’s no room for more files in this workspace. Delete some files, or ask an admin to make room.';

export function fileRoutes({ limit }) {
  const r = new Hono();
  // Bytes reserved by uploads still streaming in (this process serves one workspace, so this is
  // both the workspace's and the disk's).
  let reserved = 0;

  /* POST /api/files?project=&task=&name=  with the raw file as the body (streamed to disk). */
  // The body streams to disk, so it's checked again in the transaction that records the file.
  r.post('/', requireAuth('member', { stream: true }), async c => {
    const { db, repo, config } = c.var;
    const { member } = c.var.auth;
    const q = c.req.query();
    const sent = Number(c.req.header('content-length') || 0);
    if (sent > config.maxUploadBytes) return c.json({ error: `Files can be up to ${fsize(config.maxUploadBytes)}.` }, 413);
    const p = repo.get('projects', String(q.project || ''));
    if (!p || !canSee(p, member)) return c.json({ error: "You don't have access to that project." }, 403);
    if (projectLevel(p, member) < EDIT) return c.json({ error: 'You can’t add files to this project.' }, 403);
    if (q.task && repo.get('tasks', String(q.task))?.project !== p.id) return c.json({ error: 'That task no longer exists.' }, 404);
    if (!q.name || !c.req.raw.body) return c.json({ error: 'Choose a file to upload.' }, 400);
    if (!limit.hit(`upload:${member.id}`, config.uploadsPerHour, HOUR)) {
      c.header('Retry-After', String(limit.blocked(`upload:${member.id}`, config.uploadsPerHour)));
      return c.json({ error: 'You’ve uploaded a lot of files. Try again in an hour.' }, 429);
    }
    // Whatever is smallest bounds this upload: the per-file limit, what's left of the workspace's
    // quota, and the disk space above the reserve kept free for the database, both less what
    // uploads still streaming in have reserved (so parallel uploads can't each count the same room).
    // An upload reserves its Content-Length (or, without one, as much as it may take) until it's done.
    await fs.promises.mkdir(config.uploadDir, { recursive: true });
    const room = Math.min(config.uploadQuotaBytes - storedBytes(db), (await freeBytes(config.uploadDir)) - config.minFreeDiskBytes) - reserved;
    if (room <= 0 || sent > room) return c.json({ error: FULL }, 507);
    const max = sent || Math.min(config.maxUploadBytes, room);
    reserved += max;
    try {
      return await receive(c, { p, q, max, sent });
    } finally {
      reserved -= max;
    }
  });

  /* Stream the body to disk (at most `max` bytes, the reservation) and record the file. */
  async function receive(c, { p, q, max, sent }) {
    const { db, repo, config, engine } = c.var;
    const { member } = c.var.auth;

    const key = newId('b');
    const rel = path.join(key.slice(1, 3), key);
    const full = path.join(config.uploadDir, rel);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    let bytes = 0;
    const cap = new Transform({
      transform(chunk, _enc, cb) {
        bytes += chunk.length;
        cb(bytes > max ? Object.assign(new Error('too large'), { tooLarge: true }) : null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(c.req.raw.body), cap, fs.createWriteStream(full + '.part'));
      await fs.promises.rename(full + '.part', full);
    } catch (e) {
      await fs.promises.rm(full + '.part', { force: true });
      if (e.tooLarge && sent) return c.json({ error: 'The upload was larger than its Content-Length.' }, 400);
      if (e.tooLarge) return max < config.maxUploadBytes ? c.json({ error: FULL }, 507) : c.json({ error: `Files can be up to ${fsize(max)}.` }, 413);
      return c.json({ error: 'The upload was interrupted. Try again.' }, 400);
    }

    const name = safeName(q.name);
    const mime = (c.req.header('content-type') || 'application/octet-stream').split(';')[0].slice(0, 100);
    const id = newId('f');
    const now = Date.now();
    const rec = { id, name, type: fileType(name), size: fsize(bytes), by: member.id, at: now, url: `/api/files/${id}/${encodeURIComponent(name)}` };
    const fileRow = { ...rec, project: p.id, task: q.task || null };
    const changes = [];
    // Re-read the uploader, project and task inside the transaction: the session may have ended,
    // the person lost edit access, or the project or task been deleted while the bytes streamed in
    // (then nothing is recorded and the bytes go), and attachments added concurrently mustn't be lost.
    let t;
    try {
      t = db.tx(() => {
        const a = currentAuth(db, c.var.auth);
        if (!a) throw Object.assign(new Error('gone'), { status: 401, body: GONE });
        const fp = repo.get('projects', p.id);
        if (!fp) throw Object.assign(new Error('gone'), { gone: 'That project no longer exists.' });
        if (projectLevel(fp, a.member) < EDIT) throw Object.assign(new Error('gone'), { status: 403, body: { error: 'You can’t add files to this project.' } });
        // Uploads that streamed in at the same time count against the quota too.
        if (storedBytes(db) + bytes > config.uploadQuotaBytes) throw Object.assign(new Error('full'), { status: 507, body: { error: FULL } });
        if (q.task && repo.get('tasks', String(q.task))?.project !== p.id) throw Object.assign(new Error('gone'), { gone: 'That task no longer exists.' });
        repo.put('files', fileRow, p.id);
        db.run('UPDATE files SET storage_key = ?, mime = ?, bytes = ? WHERE id = ?', rel, mime, bytes, id);
        changes.push({ c: 'files', id, v: fileRow, pid: p.id });
        const task = q.task ? repo.get('tasks', q.task) : null;
        if (task) {
          task.attachments = [...(task.attachments || []), rec];
          task.updated = now;
          repo.put('tasks', task, p.id);
          changes.push({ c: 'tasks', id: task.id, v: task, pid: p.id });
          const a = { id: newId('a'), by: member.id, verb: 'added a file to', task: task.id, project: p.id, at: now, extra: name };
          repo.put('activity', a, p.id);
          changes.push({ c: 'activity', id: a.id, v: a, pid: p.id });
        }
        return task;
      });
    } catch (e) {
      await fs.promises.rm(full, { force: true });
      if (e.body) return c.json(e.body, e.status);
      if (!e.gone) throw e;
      return c.json({ error: e.gone }, 404);
    }
    engine.publish(changes, { exceptClient: c.req.header('x-client-id') });
    return c.json(
      {
        file: fileRow,
        task: t ? { ...t, fav: repo.favorites(member.id).tasks.has(t.id) } : null,
        activity: changes.find(x => x.c === 'activity')?.v || null,
      },
      201,
    );
  }

  r.get('/:id/:name?', requireAuth(), c => {
    const { db, repo, config } = c.var;
    const row = db.get('SELECT project_id, storage_key, mime, bytes, data FROM files WHERE id = ?', c.req.param('id'));
    if (!row?.storage_key || !canSee(repo.get('projects', row.project_id), c.var.auth.member)) return c.json({ error: 'File not found.' }, 404);
    const full = path.join(config.uploadDir, row.storage_key);
    if (!fs.existsSync(full)) return c.json({ error: 'File not found.' }, 404);
    const name = safeName(JSON.parse(row.data).name);
    const inline = INLINE.test(row.mime) && c.req.query('download') == null;
    c.header('Content-Type', inline ? row.mime : 'application/octet-stream');
    c.header('Content-Length', String(row.bytes));
    c.header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`);
    // Everything is sandboxed (no script, no same origin), except PDFs: Chromium refuses to render a
    // PDF in a sandboxed document, so those get a CSP that still blocks scripts and other origins.
    c.header(
      'Content-Security-Policy',
      inline && row.mime === 'application/pdf'
        ? "default-src 'none'; object-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'"
        : "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    );
    c.header('Cache-Control', 'no-store');
    return c.body(Readable.toWeb(fs.createReadStream(full)));
  });

  return r;
}
