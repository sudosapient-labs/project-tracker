/* /api/files: upload bytes for a project (optionally attached to a task) and serve them back to
   people who can see that project. Bytes live under UPLOAD_DIR keyed by a random storage key. */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
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

  r.post('/', requireAuth(), async c => {
    const { db, repo, config, engine } = c.var;
    const { member } = c.var.auth;
    const len = Number(c.req.header('content-length') || 0);
    if (len > config.maxUploadBytes + 64 * 1024) return c.json({ error: `Files can be up to ${fsize(config.maxUploadBytes)}.` }, 413);
    let body;
    try {
      body = await c.req.parseBody();
    } catch {
      return c.json({ error: 'Upload a file as multipart form data.' }, 400);
    }
    const file = body.file;
    if (!file || typeof file === 'string') return c.json({ error: 'Choose a file to upload.' }, 400);
    if (file.size > config.maxUploadBytes) return c.json({ error: `Files can be up to ${fsize(config.maxUploadBytes)}.` }, 413);
    const p = repo.get('projects', String(body.project || ''));
    if (!p || !canSee(p, member.id)) return c.json({ error: "You don't have access to that project." }, 403);
    const t = body.task ? repo.get('tasks', String(body.task)) : null;
    if (body.task && (!t || t.project !== p.id)) return c.json({ error: 'That task no longer exists.' }, 404);

    const key = newId('b');
    const dir = path.join(config.uploadDir, key.slice(1, 3));
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, key), Buffer.from(await file.arrayBuffer()));

    const name = safeName(file.name);
    const id = newId('f');
    const now = Date.now();
    const rec = { id, name, type: fileType(name), size: fsize(file.size), by: member.id, at: now, url: `/api/files/${id}/${encodeURIComponent(name)}` };
    const fileRow = { ...rec, project: p.id, task: t?.id || null };
    const changes = [];
    db.tx(() => {
      repo.put('files', fileRow, p.id);
      db.run(
        'UPDATE files SET storage_key = ?, mime = ?, bytes = ? WHERE id = ?',
        path.join(key.slice(1, 3), key),
        file.type || 'application/octet-stream',
        file.size,
        id,
      );
      changes.push({ c: 'files', id, v: fileRow, pid: p.id });
      if (t) {
        t.attachments = [...(t.attachments || []), rec];
        t.updated = now;
        repo.put('tasks', t, p.id);
        changes.push({ c: 'tasks', id: t.id, v: t, pid: p.id });
        const a = { id: newId('a'), by: member.id, verb: 'added a file to', task: t.id, project: p.id, at: now, extra: name };
        repo.put('activity', a, p.id);
        changes.push({ c: 'activity', id: a.id, v: a, pid: p.id });
      }
    });
    engine.publish(changes, { exceptClient: c.req.header('x-client-id') });
    return c.json(
      { file: fileRow, task: t ? { ...t, fav: repo.favorites(member.id).tasks.has(t.id) } : null, activity: changes.find(x => x.c === 'activity')?.v || null },
      201,
    );
  });

  r.get('/:id/:name?', requireAuth(), c => {
    const { db, repo, config } = c.var;
    const row = db.get('SELECT project_id, storage_key, mime, bytes, data FROM files WHERE id = ?', c.req.param('id'));
    if (!row?.storage_key || !canSee(repo.get('projects', row.project_id), c.var.auth.member.id)) return c.json({ error: 'File not found.' }, 404);
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
