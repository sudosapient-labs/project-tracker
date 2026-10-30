/* /api/files: upload bytes for a project (optionally attached to a task) and serve them back to
   people who can see that project. Bytes live under UPLOAD_DIR keyed by a random storage key. */
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Hono } from 'hono';
import { requireAuth } from '../auth.js';
import { newId } from '../lib/crypto.js';
import { fileType, fsize } from '../../src/core/file-types.js';
import { canSee } from '../sync/rules.js';

const INLINE = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain)$/;
const safeName = n =>
  String(n || 'file')
    .replace(/[\\/\0\r\n"]/g, '_')
    .slice(0, 255) || 'file';

export function fileRoutes() {
  const r = new Hono();

  /* POST /api/files?project=&task=&name=  with the raw file as the body (streamed to disk). */
  r.post('/', requireAuth(), async c => {
    const { db, repo, config, engine } = c.var;
    const { member } = c.var.auth;
    const q = c.req.query();
    const max = config.maxUploadBytes;
    if (Number(c.req.header('content-length') || 0) > max) return c.json({ error: `Files can be up to ${fsize(max)}.` }, 413);
    const p = repo.get('projects', String(q.project || ''));
    if (!p || !canSee(p, member)) return c.json({ error: "You don't have access to that project." }, 403);
    if (q.task && repo.get('tasks', String(q.task))?.project !== p.id) return c.json({ error: 'That task no longer exists.' }, 404);
    if (!q.name || !c.req.raw.body) return c.json({ error: 'Choose a file to upload.' }, 400);

    const key = newId('b');
    const rel = path.join(key.slice(1, 3), key);
    const full = path.join(config.uploadDir, rel);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    let bytes = 0;
    const limit = new Transform({
      transform(chunk, _enc, cb) {
        bytes += chunk.length;
        cb(bytes > max ? Object.assign(new Error('too large'), { tooLarge: true }) : null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(c.req.raw.body), limit, fs.createWriteStream(full + '.part'));
      await fs.promises.rename(full + '.part', full);
    } catch (e) {
      await fs.promises.rm(full + '.part', { force: true });
      if (e.tooLarge) return c.json({ error: `Files can be up to ${fsize(max)}.` }, 413);
      return c.json({ error: 'The upload was interrupted. Try again.' }, 400);
    }

    const name = safeName(q.name);
    const mime = (c.req.header('content-type') || 'application/octet-stream').split(';')[0].slice(0, 100);
    const id = newId('f');
    const now = Date.now();
    const rec = { id, name, type: fileType(name), size: fsize(bytes), by: member.id, at: now, url: `/api/files/${id}/${encodeURIComponent(name)}` };
    const fileRow = { ...rec, project: p.id, task: q.task || null };
    const changes = [];
    // Re-read the task inside the transaction so attachments added concurrently aren't lost.
    const t = db.tx(() => {
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
    engine.publish(changes, { exceptClient: c.req.header('x-client-id') });
    return c.json(
      {
        file: fileRow,
        task: t ? { ...t, fav: repo.favorites(member.id).tasks.has(t.id) } : null,
        activity: changes.find(x => x.c === 'activity')?.v || null,
      },
      201,
    );
  });

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
    c.header('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    c.header('Cache-Control', 'private, max-age=3600');
    return c.body(Readable.toWeb(fs.createReadStream(full)));
  });

  return r;
}
