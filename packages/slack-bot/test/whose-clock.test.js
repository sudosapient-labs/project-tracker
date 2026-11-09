/* Whose clock (src/clock.js): each request is read on the clock of the person asking, never one clock
   for the team. Ada saved India's zone and Bea saved Dubai's (like Siddharth): "5pm" is 5 PM for each
   of them. Without a saved zone, the Slack profile's; without either, the workspace's. A Confirm
   pressed later, even after a restart, uses the clock the change was asked on. Cards carry Slack date
   tokens, so everyone in the channel sees their own time. */
import { describe, expect, it, vi } from 'vitest';
import { apiKey, keyClient } from '../../../test/server/helpers.js';
import { PerPerson, SLACK_USERS, call, fakeSlack, harness, saveZone, tracker, workspaceZone } from './helpers.js';

const unix = iso => Date.parse(iso) / 1000;
const token = (iso, fallback) => `<!date^${unix(iso)}^{date_short_pretty} {time}|${fallback}>`;
const INDIA = '2026-11-10T11:30:00.000Z'; // 17:00 on Nov 10 in India
const DUBAI = '2026-11-10T13:00:00.000Z'; // 17:00 on Nov 10 in Dubai

const mention = (h, user, ts) => h.handlers.onMention({ event: { type: 'app_mention', user, channel: 'C1', ts, text: '<@UBOT> due tomorrow 5pm' } });
const toolResults = h => {
  const out = [];
  const orig = h.agent.graph.invoke.bind(h.agent.graph);
  h.agent.graph.invoke = async (...a) => {
    const r = await orig(...a);
    out.push(...r.messages.filter(m => m.getType() === 'tool').map(m => `${m.name}: ${m.content}`));
    return r;
  };
  return out;
};
/* The text of the last task card shown for `key`. */
const cardText = (h, key) =>
  h.slack
    .of('chat.update')
    .flatMap(u => u.blocks || [])
    .map(b => b.text?.text || '')
    .findLast(t => t.includes(`|${key} `));
const blocksOf = (h, ts) => JSON.stringify(h.slack.message(ts)?.blocks || []);

/* Ada (India) and Bea (Dubai), each with a task of their own. */
async function team() {
  const w = await tracker();
  await saveZone(w, 'ada', 'Asia/Kolkata');
  await saveZone(w, 'bea', 'Asia/Dubai');
  const ada = await w.api.post('/tasks', { project: 'WEB', title: 'Ada’s task' });
  const bea = await w.api.post('/tasks', { project: 'WEB', title: 'Bea’s task' });
  return { w, ada, bea };
}
/* Each person sets their own task due "2026-11-10 17:00". */
const setsFive =
  ({ ada, bea }) =>
  name => [call('update_task', { key: name.startsWith('Ada') ? ada.key : bea.key, due: '2026-11-10 17:00' })];

describe('each person’s own clock', () => {
  it('“5pm” is 5 PM for whoever asks: India and Dubai store different moments', async () => {
    const { w, ada, bea } = await team();
    const model = new PerPerson(setsFive({ ada, bea }));
    const h = await harness(w, { confirm: 'none', model });
    const results = toolResults(h);
    await mention(h, 'UADA', '1.1');
    await h.handlers.idle();
    await mention(h, 'UBEA', '2.1');
    await h.handlers.idle();

    expect((await w.api.get(`/tasks/${ada.key}`)).due).toBe(INDIA);
    expect((await w.api.get(`/tasks/${bea.key}`)).due).toBe(DUBAI);
    // The prompt names whose clock it is, and the tool results the model reads are on it.
    expect(model.seen[0]).toMatch(/now on Ada's clock \(Asia\/Kolkata\)\./);
    expect(model.seen[1]).toMatch(/now on Bea's clock \(Asia\/Dubai\)\./);
    expect(results.filter(r => r.startsWith('update_task'))).toHaveLength(2);
    expect(results.find(r => r.startsWith('update_task'))).toContain('"due":"2026-11-10 17:00 GMT+5:30"');
    expect(results.findLast(r => r.startsWith('update_task'))).toContain('"due":"2026-11-10 17:00 GMT+4"');
    // Each card: a token for every viewer's clock, with the asker's as the fallback.
    expect(cardText(h, ada.key)).toContain(`📅 ${token(INDIA, '2026-11-10 5:00 PM GMT+5:30')}`);
    expect(cardText(h, bea.key)).toContain(`📅 ${token(DUBAI, '2026-11-10 5:00 PM GMT+4')}`);
  });

  it('a task someone else set reads on the asker’s clock', async () => {
    const { w, ada } = await team();
    await w.api.patch(`/tasks/${ada.key}`, { due: INDIA });
    const h = await harness(w, { confirm: 'none', model: new PerPerson(() => [call('get_task', { key: ada.key }), call('list_tasks', {})]) });
    const results = toolResults(h);
    await mention(h, 'UBEA', '3.1');
    await h.handlers.idle();
    // 17:00 in India is 15:30 in Dubai: in the bot's own tool and in the one shared with MCP.
    expect(results.find(r => r.startsWith('list_tasks'))).toContain('"due":"2026-11-10 15:30 GMT+4"');
    expect(results.find(r => r.startsWith('get_task'))).toContain('"due":"2026-11-10 15:30 GMT+4"');
    expect(results.join('\n')).not.toContain('17:00');
  });

  it('history the tracker words itself reads on the asker’s clock, not the bot’s', async () => {
    const { w, ada } = await team();
    // The bot member has no zone of its own: the workspace's, India's. Ada sets 18:30 in India herself.
    await workspaceZone(w, 'Asia/Kolkata');
    expect((await keyClient(w.t.app, await apiKey(w.ada)).patch(`/tasks/${ada.key}`, { due: '2026-11-10T18:30:00+05:30' })).status).toBe(200);
    const historyFor = async (user, slack) => {
      const h = await harness(w, { confirm: 'none', slack, model: new PerPerson(() => [call('get_task', { key: ada.key })]) });
      const results = toolResults(h);
      await mention(h, user, `${user}.1`);
      await h.handlers.idle();
      // The tool result the model reads (fenced as workspace data): the due change's line.
      return /"[^"]*changed due date of[^"]*"/.exec(results.find(r => r.startsWith('get_task')))?.[0];
    };
    // Bea saved Dubai.
    expect(await historyFor('UBEA')).toMatch(/changed due date of to Nov 10, 5:00 PM"$/);
    // Like Siddharth: nothing saved, Dubai only on his Slack profile.
    await saveZone(w, 'bea', '');
    const dubaiOnSlack = fakeSlack({ users: { ...SLACK_USERS, UBEA: { ...SLACK_USERS.UBEA, tz: 'Asia/Dubai' } } });
    expect(await historyFor('UBEA', dubaiOnSlack)).toMatch(/changed due date of to Nov 10, 5:00 PM"$/);
    // Ada, in India, reads her own words.
    expect(await historyFor('UADA')).toMatch(/changed due date of to Nov 10, 6:30 PM"$/);
  });

  it('requests from India and Dubai at the same time keep their own clocks', async () => {
    const { w, ada, bea } = await team();
    // Neither run's model turn goes ahead until both runs have reached it.
    let arrived = 0;
    let release;
    const both = new Promise(r => (release = r));
    const gate = async () => {
      if (++arrived === 2) release();
      await both;
    };
    const h = await harness(w, { confirm: 'none', model: new PerPerson(setsFive({ ada, bea }), { gate }) });
    await Promise.all([mention(h, 'UBEA', '4.1'), mention(h, 'UADA', '5.1')]);
    await h.handlers.idle();
    expect(arrived).toBe(2);
    expect((await w.api.get(`/tasks/${ada.key}`)).due).toBe(INDIA);
    expect((await w.api.get(`/tasks/${bea.key}`)).due).toBe(DUBAI);
    expect(cardText(h, ada.key)).toContain(token(INDIA, '2026-11-10 5:00 PM GMT+5:30'));
    expect(cardText(h, bea.key)).toContain(token(DUBAI, '2026-11-10 5:00 PM GMT+4'));
  });
});

describe('without a saved zone', () => {
  it('uses the Slack profile’s zone, else the workspace’s; a saved zone beats both', async () => {
    const w = await tracker();
    await workspaceZone(w, 'Asia/Kolkata');
    const t = await w.api.post('/tasks', { project: 'WEB', title: 'Whose 5pm' });
    const set = () => [call('update_task', { key: t.key, due: '2026-11-10 17:00' })];

    // Bea saved nothing; her Slack profile says Dubai.
    const dubaiOnSlack = fakeSlack({ users: { ...SLACK_USERS, UBEA: { ...SLACK_USERS.UBEA, tz: 'Asia/Dubai' } } });
    let model = new PerPerson(set);
    let h = await harness(w, { confirm: 'none', model, slack: dubaiOnSlack });
    await mention(h, 'UBEA', '6.1');
    await h.handlers.idle();
    expect((await w.api.get(`/tasks/${t.key}`)).due).toBe(DUBAI);
    expect(model.seen[0]).toContain("on Bea's clock (Asia/Dubai)");

    // Neither: the workspace's (India).
    model = new PerPerson(set);
    h = await harness(w, { confirm: 'none', model });
    await mention(h, 'UBEA', '7.1');
    await h.handlers.idle();
    expect((await w.api.get(`/tasks/${t.key}`)).due).toBe(INDIA);
    expect(model.seen[0]).toContain("on Bea's clock (Asia/Kolkata)");

    // Her own saved zone wins over Slack's (and the workspace's).
    await saveZone(w, 'bea', 'Europe/London');
    model = new PerPerson(set);
    h = await harness(w, { confirm: 'none', model, slack: fakeSlack({ users: { ...SLACK_USERS, UBEA: { ...SLACK_USERS.UBEA, tz: 'Asia/Dubai' } } }) });
    await mention(h, 'UBEA', '8.1');
    await h.handlers.idle();
    expect((await w.api.get(`/tasks/${t.key}`)).due).toBe('2026-11-10T17:00:00.000Z');
  });

  it('a Slack profile zone that changes is used within minutes, not fetched on every request', async () => {
    const w = await tracker();
    const users = { ...SLACK_USERS, UBEA: { ...SLACK_USERS.UBEA, tz: 'Asia/Dubai' } };
    const slack = fakeSlack({ users });
    const model = new PerPerson(() => []);
    const h = await harness(w, { model, slack });
    await mention(h, 'UBEA', '9.1');
    await h.handlers.idle();
    const asked = h.slack.of('users.info').length;
    users.UBEA = { ...users.UBEA, tz: 'Asia/Kolkata' };
    await mention(h, 'UBEA', '9.2');
    await h.handlers.idle();
    // Cached: no new lookup, the same clock.
    expect(h.slack.of('users.info').length).toBe(asked);
    expect(model.seen[1]).toContain('(Asia/Dubai)');
    // Five minutes later, the new one.
    vi.useFakeTimers({ now: Date.now() + 5 * 60_000 + 1, toFake: ['Date'] });
    try {
      await mention(h, 'UBEA', '9.3');
      await h.handlers.idle();
    } finally {
      vi.useRealTimers();
    }
    expect(model.seen[2]).toContain('(Asia/Kolkata)');
  });
});

describe('confirmations keep the asker’s clock', () => {
  const press = (h, user, id) =>
    h.handlers
      .onAction({ action: { action_id: 'pending_confirm', value: id }, body: { user: { id: user }, channel: { id: 'C1' } }, respond: async () => {} })
      .then(() => h.handlers.idle());
  const cardId = blocks => blocks?.find(b => b.block_id === 'pending')?.elements[0].value;

  it('a Confirm pressed later makes the change on the clock it was asked on, and the card shows it with a date token', async () => {
    const { w, bea } = await team();
    const h = await harness(w, {
      model: new PerPerson(name => (name.startsWith('Bea') ? [call('update_task', { key: bea.key, due: '2026-11-10 17:00' })] : [])),
    });
    await mention(h, 'UBEA', '10.1');
    await h.handlers.idle();
    const card = h.slack.of('chat.update').at(-1);
    expect(JSON.stringify(card.blocks)).toContain(`due → ${token(DUBAI, '2026-11-10 5:00 PM GMT+4')}`);
    // She flies to India before pressing Confirm.
    await saveZone(w, 'bea', 'Asia/Kolkata');
    await press(h, 'UBEA', cardId(card.blocks));
    expect((await w.api.get(`/tasks/${bea.key}`)).due).toBe(DUBAI);
    expect(blocksOf(h, card.ts)).toContain('Confirmed by <@UBEA>');
    expect(blocksOf(h, card.ts)).toContain(token(DUBAI, '2026-11-10 5:00 PM GMT+4'));
  });

  it('after a restart, the Confirm asked again still uses the asker’s clock', async () => {
    const { w, bea } = await team();
    const h = await harness(w, { model: new PerPerson(() => [call('update_task', { key: bea.key, due: '2026-11-10 17:00' })]) });
    await mention(h, 'UBEA', '11.1');
    await h.handlers.idle();
    const card = h.slack.of('chat.update').at(-1);
    const id = cardId(card.blocks);
    // The process stops while the card is being marked Confirmed, before the change is made.
    h.slack.chat.update = () => new Promise(() => {});
    h.handlers.onAction({
      action: { action_id: 'pending_confirm', value: id },
      body: { user: { id: 'UBEA' }, channel: { id: 'C1' } },
      respond: async () => {},
    });
    await vi.waitFor(() => expect(h.store.confirmation(id)).toBeNull());

    await saveZone(w, 'bea', 'Asia/Kolkata');
    const h2 = await harness(w, { store: h.store, checkpointer: h.checkpointer, model: new PerPerson(() => []) });
    await h2.handlers.recover();
    const asked = h2.slack.of('chat.update').at(-1);
    expect(cardId(asked.blocks)).toBe(id);
    expect(JSON.stringify(asked.blocks)).toContain(token(DUBAI, '2026-11-10 5:00 PM GMT+4'));
    await press(h2, 'UBEA', id);
    expect((await w.api.get(`/tasks/${bea.key}`)).due).toBe(DUBAI);
  });
});

describe('a waiting change keeps the moment it was asked for', () => {
  const press = (h, user, id) =>
    h.handlers
      .onAction({ action: { action_id: 'pending_confirm', value: id }, body: { user: { id: user }, channel: { id: 'C1' } }, respond: async () => {} })
      .then(() => h.handlers.idle());
  const cardId = blocks => blocks?.find(b => b.block_id === 'pending')?.elements[0].value;
  // Monday Nov 9, 10:00 in Dubai; "tomorrow 5pm" is Tuesday Nov 10, 17:00 there.
  const ASKED = Date.parse('2026-11-09T06:00:00Z');
  const at = async (ms, fn) => {
    vi.useFakeTimers({ now: ms, toFake: ['Date'] });
    try {
      return await fn();
    } finally {
      vi.useRealTimers();
    }
  };

  it('“tomorrow 5pm” confirmed the next day is still the day it was asked about, on the card and in the change', async () => {
    const { w, bea } = await team();
    const h = await harness(w, { model: new PerPerson(() => [call('update_task', { key: bea.key, due: 'tomorrow 17:00' })]) });
    await at(ASKED, async () => {
      await mention(h, 'UBEA', '20.1');
      await h.handlers.idle();
    });
    const card = h.slack.of('chat.update').at(-1);
    const id = cardId(card.blocks);
    expect(JSON.stringify(card.blocks)).toContain(`due → ${token(DUBAI, '2026-11-10 5:00 PM GMT+4')}`);
    // Saved with the card as the value, not the words.
    expect(h.store.confirmation(id).data.pending[0].args.due).toBe(DUBAI);
    // Pressed the next morning (Tuesday 06:00 in Dubai, within the card's day): still Nov 10.
    await at(ASKED + 20 * 3_600_000, () => press(h, 'UBEA', id));
    expect((await w.api.get(`/tasks/${bea.key}`)).due).toBe(DUBAI);
    expect(blocksOf(h, card.ts)).toContain(token(DUBAI, '2026-11-10 5:00 PM GMT+4'));
  });

  it('and after a restart', async () => {
    const { w } = await team();
    const h = await harness(w, {
      model: new PerPerson(() => [call('create_task', { project: 'WEB', title: 'Later', due: 'tomorrow 17:00' })]),
      confirm: 'all',
    });
    await at(ASKED, async () => {
      await mention(h, 'UBEA', '21.1');
      await h.handlers.idle();
    });
    const id = cardId(h.slack.of('chat.update').at(-1).blocks);
    const h2 = await harness(w, { store: h.store, checkpointer: h.checkpointer, model: new PerPerson(() => []), confirm: 'all' });
    await h2.handlers.recover();
    await at(ASKED + 20 * 3_600_000, () => press(h2, 'UBEA', id));
    expect((await w.api.get('/tasks')).data.find(t => t.title === 'Later').due).toBe(DUBAI);
  });
});

describe('cards for everyone in the channel', () => {
  it('a link preview shows a timed due as a date token and an all-day due as a plain date', async () => {
    const { w, ada, bea } = await team();
    await w.api.patch(`/tasks/${ada.key}`, { due: INDIA });
    await w.api.patch(`/tasks/${bea.key}`, { due: '2026-11-12' });
    const h = await harness(w);
    await h.handlers.onLinkShared({
      event: {
        user: 'UBEA',
        channel: 'C1',
        message_ts: '12.1',
        links: [{ url: `http://app.test/#task/${ada.key}` }, { url: `http://app.test/#task/${bea.key}` }],
      },
    });
    const { unfurls } = h.slack.of('chat.unfurl').at(-1);
    // Posted by Bea: the fallback is on her clock (15:30 in Dubai).
    expect(JSON.stringify(unfurls[`http://app.test/#task/${ada.key}`])).toContain(`📅 ${token(INDIA, '2026-11-10 3:30 PM GMT+4')}`);
    const allDay = JSON.stringify(unfurls[`http://app.test/#task/${bea.key}`]);
    expect(allDay).toContain('📅 2026-11-12');
    expect(allDay).not.toContain('<!date');
  });

  it('the create modal shows a Dubai submitter’s zone and reads the time on it', async () => {
    const { w } = await team();
    const h = await harness(w);
    h.store.setChannelProject('C1', 'WEB', 'x');
    await h.handlers.onCommand({ command: { text: 'new From Dubai', user_id: 'UBEA', channel_id: 'C1', trigger_id: 'trig' }, respond: async () => {} });
    const { view } = h.slack.of('views.update').at(-1);
    expect(view.blocks.find(b => b.block_id === 'due_time').element.timezone).toBe('Asia/Dubai');
    const state = {
      values: {
        title: { v: { value: 'From Dubai' } },
        project: { v: { selected_option: { value: 'WEB' } } },
        assignee: { v: {} },
        priority: { v: {} },
        due: { v: { selected_date: '2026-11-10' } },
        due_time: { v: { selected_time: '17:00' } },
        description: { v: { value: '' } },
      },
    };
    const done = await h.handlers.onCreateSubmit({ view: { id: 'V9', private_metadata: view.private_metadata, state }, user: 'UBEA' });
    expect(done.errors).toBeUndefined();
    await done.after();
    const task = (await w.api.get('/tasks')).data.find(t => t.title === 'From Dubai');
    expect(task.due).toBe(DUBAI);
    expect(JSON.stringify(h.slack.of('chat.postMessage').at(-1).blocks)).toContain(token(DUBAI, '2026-11-10 5:00 PM GMT+4'));
  });
});
