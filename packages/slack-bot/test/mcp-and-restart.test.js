/* Knowledge sources over MCP, through LangChain's MCP adapters (tested against the tracker's own
   hosted /api/mcp over real HTTP), and confirmations that survive a restart (SQLite checkpoints). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { FakeToolCallingModel } from 'langchain';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createSudoAgent } from '../src/agent.js';
import { loadConfig } from '../src/config.js';
import { mcpTools } from '../src/mcp.js';
import { directory } from '../src/people.js';
import { openStore } from '../src/store.js';
import { call, tracker } from './helpers.js';

const open = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map(f => f()));
});

const quiet = { info() {}, warn() {} };

describe('MCP knowledge sources', () => {
  it('loads only the allowed tools, prefixed with the server’s name, and fences their results', async () => {
    const w = await tracker();
    await w.api.post('/tasks', { project: 'WEB', title: 'Findable over MCP' });
    const server = await new Promise(resolve => {
      const s = serve({ fetch: w.t.app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
    });
    open.push(() => new Promise(r => server.close(r)));
    const url = `http://127.0.0.1:${server.address().port}/api/mcp`;
    const { tools, close } = await mcpTools({ wiki: { url, headers: { authorization: `Bearer ${w.token}` }, tools: ['search', 'get_task'] } }, { log: quiet });
    open.push(close);
    expect(tools.map(t => t.name).sort()).toEqual(['wiki_get_task', 'wiki_search']);
    const out = await tools.find(t => t.name === 'wiki_search').invoke({ q: 'Findable' });
    expect(out).toContain('<untrusted-user-content>');
    expect(out).toContain('Findable over MCP');
  });

  it('runs without a server that is down', async () => {
    const { tools, close } = await mcpTools({ down: { url: 'http://127.0.0.1:9/mcp' } }, { log: quiet });
    open.push(close);
    expect(tools).toEqual([]);
  });
});

describe('restarts', () => {
  it('a change waiting for Confirm can still be confirmed after the bot restarts', async () => {
    const w = await tracker();
    const t = await w.api.post('/tasks', { project: 'WEB', title: 'Across restarts' });
    const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sudo-bot-'));
    const config = { ...loadConfig({ SLACK_BOT_DATA_DIR: dirPath }), tracker: { url: 'http://app.test', key: w.token } };
    const store = openStore(config.db);
    open.push(async () => store.close());
    const ada = (await w.api.all('/members')).find(m => m.email === 'ada@example.com');
    const ctx = () => ({
      api: w.api,
      dir: directory(w.api, { ttl: 0 }),
      store,
      requester: ada,
      slack: { channel: 'C1', threadTs: '1.1', permalink: '' },
      touched: [],
    });

    const first = await createSudoAgent({
      config,
      store,
      model: new FakeToolCallingModel({ toolCalls: [[call('complete_task', { key: t.key })], []] }),
      checkpointer: SqliteSaver.fromConnString(config.checkpoints),
    });
    const out = await first.run({ threadId: 'C1:1.1', message: 'close it', ctx: ctx() });
    expect(out.pending.map(p => p.name)).toEqual(['complete_task']);

    // A new process: a new agent on the same checkpoint file.
    const second = await createSudoAgent({
      config,
      store,
      model: new FakeToolCallingModel({ toolCalls: [[]] }),
      checkpointer: SqliteSaver.fromConnString(config.checkpoints),
    });
    expect(await second.waiting('C1:1.1')).toHaveLength(1);
    const done = await second.resume({ threadId: 'C1:1.1', approve: true, ctx: ctx() });
    expect(done.touched).toEqual([t.key]);
    expect((await w.api.get(`/tasks/${t.key}`)).status).toBe('done');
  });
});
