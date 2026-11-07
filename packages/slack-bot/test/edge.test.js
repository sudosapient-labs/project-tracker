/* Edge cases around the Slack surface: failures, concurrency, odd payloads, Slack's limits and
   escaping. Same harness as bot.test.js (real tracker, fake Slack, scripted model). */
import { describe, expect, it } from 'vitest';
import { call, fakeSlack, harness, tracker } from './helpers.js';

const mention = (h, { user = 'UADA', channel = 'C1', ts = '100.000001', thread_ts, text = '<@UBOT> hi' } = {}) =>
  h.handlers.onMention({ event: { type: 'app_mention', user, channel, ts, thread_ts, text } });
const updates = h => h.slack.of('chat.update');

describe('failures', () => {
  it('when the agent fails, the placeholder says so and the thread keeps working', async () => {
    const w = await tracker();
    const h = await harness(w, { turns: [[]] });
    const run = h.agent.run.bind(h.agent);
    let fail = true;
    h.agent.run = async args => {
      if (fail) {
        fail = false;
        throw new Error('model unavailable');
      }
      return run(args);
    };
    await mention(h, { ts: '1.1' });
    await h.handlers.idle();
    expect(updates(h).at(-1).text).toContain('Sorry, something went wrong');
    expect(updates(h).at(-1).text).toContain('model unavailable');
    await mention(h, { ts: '1.2', thread_ts: '1.1' });
    await h.handlers.idle();
    expect(updates(h)).toHaveLength(2);
    expect(updates(h).at(-1).text).not.toContain('Sorry');
  });

  it('a confirmation whose conversation is gone (checkpoints lost) changes nothing and says so', async () => {
    const w = await tracker();
    const h = await harness(w);
    const id = h.store.saveConfirmation({
      threadId: 'C1:9.9:UADA#0',
      interrupts: ['gone'],
      requester: 'UADA',
      channel: 'C1',
      threadTs: '9.9',
      messageTs: '9.10',
      data: { pending: [{ name: 'complete_task', args: { key: 'WEB-1' } }], titles: {}, slack: { channel: 'C1' } },
    });
    await h.handlers.onAction({ action: { action_id: 'pending_confirm', value: id }, body: { user: { id: 'UADA' }, channel: { id: 'C1' } } });
    await h.handlers.idle();
    expect(updates(h).at(-1)).toMatchObject({ channel: 'C1', ts: '9.10', text: 'Out of date' });
    expect(h.store.confirmation(id)).toBeNull();
  });
});

describe('broken conversations', () => {
  it('a conversation left with a tool call and no result (a run cut off) starts a fresh round', async () => {
    const { AIMessage } = await import('@langchain/core/messages');
    const w = await tracker();
    const h = await harness(w, { turns: [[], []] });
    await mention(h, { ts: '11.1' });
    await h.handlers.idle();
    const base = 'C1:11.1:UADA';
    const first = h.store.conversation(base).threadId;
    // What a crash or timeout mid-step leaves behind.
    await h.agent.graph.updateState(
      { configurable: { thread_id: first } },
      { messages: [new AIMessage({ content: '', tool_calls: [{ id: 'cut', name: 'search', args: { q: 'x' } }] })] },
    );
    expect(await h.agent.ready(first)).toBe(false);
    await mention(h, { ts: '11.2', thread_ts: '11.1' });
    await h.handlers.idle();
    expect(h.store.conversation(base).threadId).toBe(`${base}#1`);
    expect(updates(h).at(-1).text).not.toContain('Sorry');
  });
});

describe('concurrency', () => {
  it('two mentions in one thread at once run one after the other, each answering in its own message', async () => {
    const w = await tracker();
    const h = await harness(w, {
      turns: [[call('create_task', { project: 'WEB', title: 'First' })], [], [call('create_task', { project: 'WEB', title: 'Second' })], []],
    });
    await Promise.all([mention(h, { ts: '2.1' }), mention(h, { ts: '2.2', thread_ts: '2.1' })]);
    await h.handlers.idle();
    const posted = h.slack.of('chat.postMessage').map(m => m.text);
    expect(posted).toEqual(['_Working on it…_', '_Working on it…_']);
    const targets = updates(h).map(u => u.ts);
    expect(new Set(targets).size).toBe(2);
    expect((await w.api.get('/tasks')).data.map(t => t.title).sort()).toEqual(['First', 'Second']);
  });
});

describe('odd payloads', () => {
  it('ignores edits, deletions and bot messages in DMs, and messages from bots everywhere', async () => {
    const w = await tracker();
    const h = await harness(w, { turns: [[]] });
    await h.handlers.onDirectMessage({
      event: { channel_type: 'im', subtype: 'message_changed', channel: 'D1', ts: '3.1', message: { user: 'UADA', text: 'x' } },
    });
    await h.handlers.onDirectMessage({ event: { channel_type: 'im', subtype: 'message_deleted', channel: 'D1', ts: '3.2' } });
    await h.handlers.onDirectMessage({ event: { channel_type: 'im', bot_id: 'B1', user: 'UBOT', channel: 'D1', ts: '3.3', text: 'echo' } });
    await h.handlers.onDirectMessage({ event: { channel_type: 'channel', user: 'UADA', channel: 'C1', ts: '3.4', text: 'not a DM' } });
    await h.handlers.onMention({ event: { bot_id: 'B2', channel: 'C1', ts: '3.5', text: '<@UBOT> from a bot' } });
    expect(h.slack.calls).toHaveLength(0);
  });

  it('a flat DM is answered flat, and DMs on the same day share one conversation', async () => {
    const w = await tracker();
    const h = await harness(w, { turns: [[], []] });
    const ids = [];
    const run = h.agent.run.bind(h.agent);
    h.agent.run = async a => (ids.push(a.threadId), run(a));
    await h.handlers.onDirectMessage({ event: { channel_type: 'im', user: 'UADA', channel: 'D1', ts: '4.1', text: 'hello' } });
    await h.handlers.onDirectMessage({ event: { channel_type: 'im', user: 'UADA', channel: 'D1', ts: '4.2', text: 'again' } });
    await h.handlers.idle();
    expect(h.slack.of('chat.postMessage').every(m => !m.thread_ts)).toBe(true);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).toMatch(/^D1:dm:\d{4}-\d{2}-\d{2}#0$/);
  });

  it('an unmatched person gets no preview, and an explanation when they click a card', async () => {
    const w = await tracker();
    const t = await w.api.post('/tasks', { project: 'WEB', title: 'Public' });
    const h = await harness(w);
    await h.handlers.onLinkShared({ event: { user: 'UOUT', channel: 'C1', message_ts: '5.1', links: [{ url: t.url }] } });
    expect(h.slack.of('chat.unfurl')).toHaveLength(0);
    const said = [];
    await h.handlers.onAction({
      action: { action_id: 'task_complete', value: t.key },
      body: { user: { id: 'UOUT' }, channel: { id: 'C1' } },
      respond: async m => said.push(m),
    });
    expect(said[0].text).toContain('out@elsewhere.com');
    expect((await w.api.get(`/tasks/${t.key}`)).status).not.toBe('done');
  });
});

describe('Slack limits and escaping', () => {
  it('a long reply with many touched tasks stays within Block Kit limits', async () => {
    const w = await tracker();
    const keys = [];
    for (let i = 0; i < 8; i++) keys.push((await w.api.post('/tasks', { project: 'WEB', title: `Task ${i}` })).key);
    const h = await harness(w, { confirm: 'none', turns: [keys.map(k => call('update_task', { key: k, priority: 'low' })), []] });
    const run = h.agent.run.bind(h.agent);
    h.agent.run = async a => ({ ...(await run(a)), text: 'x'.repeat(5000) });
    await mention(h, { ts: '6.1' });
    await h.handlers.idle();
    const u = updates(h).at(-1);
    expect(u.blocks.length).toBeLessThanOrEqual(50);
    for (const b of u.blocks) if (b.text?.text) expect(b.text.text.length).toBeLessThanOrEqual(3000);
    expect(u.text.length).toBeLessThanOrEqual(3000);
    expect(u.blocks.filter(b => b.block_id?.startsWith('task:'))).toHaveLength(5);
  });

  it('task titles can’t ping the channel or forge links in cards', async () => {
    const w = await tracker();
    const t = await w.api.post('/tasks', { project: 'WEB', title: '<!channel> look at <https://evil.test|this> & <@UADA>' });
    const h = await harness(w, { confirm: 'none', turns: [[call('update_task', { key: t.key, priority: 'high' })], []] });
    await mention(h, { ts: '7.1' });
    await h.handlers.idle();
    const card = JSON.stringify(
      updates(h)
        .at(-1)
        .blocks.find(b => b.text?.text?.includes(t.key)),
    );
    expect(card).toContain('&lt;!channel&gt;');
    expect(card).not.toMatch(/<!channel>|<https:\/\/evil|<@UADA>/);
  });
});

describe('confirmations land where they were asked', () => {
  it('Confirm updates the original card in its own channel and resumes there', async () => {
    const w = await tracker();
    const t = await w.api.post('/tasks', { project: 'WEB', title: 'Close me' });
    const slack = fakeSlack();
    const h = await harness(w, { slack, turns: [[call('complete_task', { key: t.key })], []] });
    await mention(h, { channel: 'C1', ts: '8.1' });
    await h.handlers.idle();
    const card = updates(h).at(-1);
    const id = card.blocks.find(b => b.block_id === 'pending').elements[0].value;
    expect(h.store.confirmation(id).channel).toBe('C1');
    // The click arrives with another channel on its body (e.g. the card was shared elsewhere).
    await h.handlers.onAction({ action: { action_id: 'pending_confirm', value: id }, body: { user: { id: 'UADA' }, channel: { id: 'C2' } } });
    await h.handlers.idle();
    expect((await w.api.get(`/tasks/${t.key}`)).status).toBe('done');
    expect(
      updates(h)
        .filter(u => u.ts === card.ts)
        .every(u => u.channel === 'C1'),
    ).toBe(true);
  });
});
