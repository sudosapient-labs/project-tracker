/* The MCP server, driven by the official MCP SDK client: over Streamable HTTP against the app's own
   /api/mcp, and over stdio against a real HTTP server. Tools act with the key's permissions and
   label activity with the client ("via Claude"). */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';
import { account, apiKey, keyClient, setup } from '../../../test/server/helpers.js';
import { TOOLS, toolsFor } from '../src/tools.js';
import { clientLabel } from '../src/protocol.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '../bin/sudo-mcp.js');
const put = (c, v) => ({ c, id: v.id, k: 'put', v });
const project = (id, key, extra = {}) => ({
  id,
  key,
  name: 'Project ' + key,
  icon: 'globe',
  color: 'indigo',
  status: 'active',
  team: '',
  lead: null,
  members: [],
  desc: '',
  milestones: [],
  ...extra,
});

async function workspace(env) {
  const t = setup(env);
  const ada = await account(t);
  await ada.c.sync([
    put('members', { id: 'mgus', name: 'Gus Guest', email: 'gus@example.com', role: 'Guest', team: '', title: '', c: '#6B7280', status: 'invited', tz: '' }),
  ]);
  const gus = await account(t, { name: 'Gus Guest', email: 'gus@example.com', invite: t.lastLink('gus@example.com').split('#invite/')[1] });
  await ada.c.sync([
    put('projects', project('pweb', 'WEB')),
    put('projects', project('psec', 'SEC', { private: true })),
    put('projects', project('pops', 'OPS', { members: ['mgus'], perms: { mgus: 'Can comment' } })),
  ]);
  return { t, ada: ada.c, adaId: ada.user.id, gus: gus.c };
}

const open = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map(x => x.close()));
});

/* An SDK client on the app's hosted endpoint, sending requests in-process. */
async function hosted(t, token, name = 'claude-ai') {
  const client = new Client({ name, version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('http://app.test/api/mcp'), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: (url, init) => t.app.request(String(url), init),
  });
  await client.connect(transport);
  open.push(client);
  return client;
}
const call = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { ...r, data: r.isError ? null : JSON.parse(r.content[0].text), text: r.content[0].text };
};

describe('MCP over Streamable HTTP (/api/mcp)', () => {
  it('finds, creates, comments on and completes tasks, attributed to the assistant', async () => {
    const { t, ada, adaId } = await workspace();
    const token = await apiKey(ada, { name: 'Claude key' });
    const mcp = await hosted(t, token);
    expect(mcp.getServerVersion()).toMatchObject({ name: 'sudo-sapient' });
    expect(mcp.getInstructions()).toMatch(/key/);

    const { tools } = await mcp.listTools();
    expect(tools.map(x => x.name).sort()).toEqual(Object.keys(TOOLS).sort());

    const made = await call(mcp, 'create_task', { project: 'WEB', title: 'Ship the MCP server', assignee: 'me', due: '2026-11-20', priority: 'high' });
    expect(made.data).toEqual({ key: 'WEB-201', url: 'http://app.test/#task/WEB-201' });
    await call(mcp, 'comment', { key: 'WEB-201', text: 'Started' });

    const found = await call(mcp, 'search', { q: 'mcp server' });
    expect(found.data.tasks).toEqual([
      { key: 'WEB-201', title: 'Ship the MCP server', status: 'todo', priority: 'high', assignee: 'Ada Owner', due: '2026-11-20' },
    ]);
    expect((await call(mcp, 'list_my_work')).data.map(x => x.key)).toEqual(['WEB-201']);

    expect((await call(mcp, 'complete_task', { key: 'web-201' })).data).toEqual({ key: 'WEB-201', status: 'done' });
    const detail = (await call(mcp, 'get_task', { key: 'WEB-201' })).data;
    expect(detail).toMatchObject({ key: 'WEB-201', status: 'done', assignee: 'Ada Owner' });
    expect(detail.comments).toEqual([expect.stringMatching(/Ada Owner: Started$/)]);
    expect(detail.activity.map(a => a.replace(/^\S+ \S+ /, ''))).toEqual([
      'Ada Owner via Claude completed',
      'Ada Owner via Claude commented on',
      'Ada Owner via Claude created',
    ]);

    // The app's own bootstrap carries the same lines, labelled for its activity log.
    const rows = (await ada.get('/api/bootstrap')).body.data.activity.filter(a => a.via === 'Claude');
    expect(rows.map(a => a.verb)).toEqual(['completed', 'commented on', 'created']);
    expect(rows.every(r => r.by === adaId)).toBe(true);

    const summary = (await call(mcp, 'summarise_project', { project: 'WEB' })).data;
    expect(summary).toMatchObject({ key: 'WEB', tasks: { done: 1 } });
    expect((await call(mcp, 'list_projects')).data.map(p => p.key)).toEqual(['WEB', 'SEC', 'OPS']);
    expect((await call(mcp, 'list_members')).data.map(p => p.name)).toEqual(['Ada Owner', 'Gus Guest']);

    const assigned = await call(mcp, 'assign', { key: 'WEB-201', to: '' });
    expect(assigned.data.assignee).toBeUndefined();
    const moved = await call(mcp, 'update_task', { key: 'WEB-201', status: 'review', due: '' });
    expect(moved.data).toMatchObject({ status: 'review' });
    expect(moved.data.due).toBeUndefined();

    const res = await mcp.listResources();
    expect(res.resources.map(r => r.uri)).toEqual(['sudo://my-work']);
    const proj = await mcp.readResource({ uri: 'sudo://project/WEB' });
    expect(JSON.parse(proj.contents[0].text)).toMatchObject({ key: 'WEB' });
  });

  it('enforces the key’s person: Guests can’t see or change what the app wouldn’t let them', async () => {
    const { t, ada, gus } = await workspace();
    const owner = keyClient(t.app, await apiKey(ada));
    await owner.post('/tasks', { project: 'SEC', title: 'Payroll' });
    const ops = (await owner.post('/tasks', { project: 'OPS', title: 'Ops runbook' })).body;
    const mcp = await hosted(t, await apiKey(gus), 'cursor-vscode');

    expect((await call(mcp, 'search', { q: 'payroll' })).data).toEqual({});
    expect((await call(mcp, 'list_projects')).data.map(p => p.key)).toEqual(['OPS']);
    const peek = await call(mcp, 'get_task', { key: 'SEC-201' });
    expect(peek.isError).toBe(true);
    expect(peek.text).toMatch(/^not_found:/);

    const edit = await call(mcp, 'complete_task', { key: ops.key });
    expect(edit).toMatchObject({ isError: true, text: 'forbidden: You can only comment in this project.' });
    const create = await call(mcp, 'create_task', { project: 'WEB', title: 'Sneaky' });
    expect(create.text).toMatch(/^not_found:/);
    // Commenting is what a "Can comment" Guest may do, labelled with their client.
    expect((await call(mcp, 'comment', { key: ops.key, text: 'Ack' })).isError).toBeFalsy();
    expect(t.db.get("SELECT json_extract(data, '$.via') v FROM activity WHERE json_extract(data, '$.verb') = 'commented on'").v).toBe('Cursor');
  });

  it('offers only read tools to a read-only key, and refuses writes anyway', async () => {
    const { t, ada } = await workspace();
    const mcp = await hosted(t, await apiKey(ada, { scope: 'read' }));
    const names = (await mcp.listTools()).tools.map(x => x.name);
    expect(names.sort()).toEqual(['get_task', 'list_members', 'list_my_work', 'list_projects', 'search', 'summarise_project']);
    const w = await call(mcp, 'create_task', { project: 'WEB', title: 'x' });
    expect(w).toMatchObject({ isError: true, text: 'insufficient_scope: this connection is read-only.' });
    expect(t.db.get('SELECT COUNT(*) n FROM tasks').n).toBe(0);
  });

  it('answers 401 without a valid key, and refuses foreign browser origins', async () => {
    const { t, ada } = await workspace();
    const init = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
    };
    const post = headers =>
      t.app.request('/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify(init),
      });
    const none = await post({});
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toMatch(/^Bearer/);
    expect((await post({ authorization: 'Bearer ssk_nope' })).status).toBe(401);
    const token = await apiKey(ada);
    expect((await post({ authorization: `Bearer ${token}`, origin: 'https://evil.example' })).status).toBe(403);
    const ok = await post({ authorization: `Bearer ${token}` });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('mcp-session-id')).toBeTruthy();
    expect((await t.app.request('/api/mcp', { headers: { authorization: `Bearer ${token}` } })).status).toBe(405);
  });
});

describe('MCP over HTTP without the SDK', () => {
  const rpc = (t, token, body, headers = {}) =>
    t.app.request('/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, ...headers },
      body: JSON.stringify(body),
    });
  const call = (id, name, args = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

  it('works for clients that send no session id, and labels any client name', async () => {
    const { t, ada } = await workspace();
    const token = await apiKey(ada);
    const bare = await (await rpc(t, token, call(1, 'create_task', { project: 'WEB', title: 'No session' }))).json();
    expect(JSON.parse(bare.result.content[0].text).key).toBe('WEB-201');

    const init = await rpc(t, token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'Клод' } } });
    const sid = init.headers.get('mcp-session-id');
    const r = await (await rpc(t, token, call(2, 'comment', { key: 'WEB-201', text: 'Привет' }), { 'mcp-session-id': sid })).json();
    expect(r.result.isError).toBeFalsy();
    const via = t.db.all("SELECT json_extract(data, '$.via') v FROM activity ORDER BY created_at").map(x => x.v);
    expect(via).toEqual(['MCP', 'Клод']);
  });

  it('limits protocol messages per person too, counting each message in a batch', async () => {
    const { t, ada } = await workspace({ DISABLE_RATE_LIMIT: 'false', API_RATE_LIMIT: '4' });
    const token = await apiKey(ada);
    const list = (id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/list' });
    // A batch bigger than the whole budget is refused before any of it runs (the request counts once).
    expect(
      (
        await rpc(
          t,
          token,
          Array.from({ length: 50 }, (_, i) => list(i + 1)),
        )
      ).status,
    ).toBe(429);
    expect((await rpc(t, token, [list(1), list(2)])).status).toBe(200);
    // 3 of 4 used, and another key of the same person shares what's left.
    expect((await rpc(t, await apiKey(ada), list())).status).toBe(200);
    const next = await rpc(t, token, list());
    expect(next.status).toBe(429);
    expect(Number(next.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});

describe('MCP over stdio (sudo-mcp)', () => {
  it('works from a client that spawns it, against a real server URL', async () => {
    const { t, ada } = await workspace();
    const token = await apiKey(ada);
    const server = await new Promise(resolve => {
      const s = serve({ fetch: t.app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
    });
    open.push({ close: () => new Promise(r => server.close(r)) });
    const url = `http://127.0.0.1:${server.address().port}`;
    const client = new Client({ name: 'claude-code', version: '2.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [BIN],
        env: { PATH: process.env.PATH, SUDO_URL: url, SUDO_API_KEY: token, XDG_CONFIG_HOME: '/nonexistent' },
        stderr: 'pipe',
      }),
    );
    open.push(client);
    const made = await client.callTool({ name: 'create_task', arguments: { project: 'WEB', title: 'From stdio' } });
    const { key } = JSON.parse(made.content[0].text);
    await client.callTool({ name: 'complete_task', arguments: { key } });
    const task = (await keyClient(t.app, token).get(`/tasks/${key}/activity`)).body.data;
    expect(task.map(a => [a.verb, a.via])).toEqual([
      ['completed', 'Claude'],
      ['created', 'Claude'],
    ]);
  });
});

describe('context budget', () => {
  it('keeps tool text small: one-line descriptions and a bounded tools/list', () => {
    for (const [name, t] of Object.entries(TOOLS)) {
      expect(t.description.length, name).toBeLessThanOrEqual(80);
      expect(t.description, name).not.toMatch(/\n/);
    }
    // The whole tools/list result an assistant loads into context, in characters (~4 per token).
    expect(JSON.stringify(toolsFor()).length).toBeLessThanOrEqual(2700);
  });

  it('names clients the way people know them', () => {
    expect(clientLabel({ name: 'claude-ai' })).toBe('Claude');
    expect(clientLabel({ name: 'cursor-vscode' })).toBe('Cursor');
    expect(clientLabel({ name: 'my <b>agent</b>' })).toBe('my bagentb');
    expect(clientLabel(undefined)).toBe('MCP');
  });
});
