/* Due times through the Slack bot, on the team's clock (SLACK_BOT_TIMEZONE, India here): what the
   model sends ("2026-11-09 23:59") is stored as the UTC moment, cards and lists show it back on the
   same clock, an unreadable due is refused before anyone confirms, the create modal takes a time,
   and each request tells the model the time now. Same harness as bot.test.js. */
import { describe, expect, it } from 'vitest';
import { call, harness, tracker } from './helpers.js';
import { requestMessage } from '../src/prompt.js';

const IST = { SLACK_BOT_TIMEZONE: 'Asia/Kolkata' };
const mention = (h, { user = 'UADA', ts = '300.000001' } = {}) =>
  h.handlers.onMention({ event: { type: 'app_mention', user, channel: 'C1', ts, text: '<@UBOT> due today 11:59pm' } });
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

describe('due times in the Slack bot', () => {
  it('sets a due with a time on the team’s clock and shows it back on the card', async () => {
    const w = await tracker();
    const t = await w.api.post('/tasks', { project: 'WEB', title: 'Add date filter' });
    const h = await harness(w, { env: IST, confirm: 'none', turns: [[call('update_task', { key: t.key, due: '2026-11-09 23:59' })], []] });
    const results = toolResults(h);
    await mention(h);
    await h.handlers.idle();
    expect((await w.api.get(`/tasks/${t.key}`)).due).toBe('2026-11-09T18:29:00.000Z');
    // The model reads it back on the same clock.
    expect(results.join('\n')).toContain('"due":"2026-11-09 23:59"');
    const card = JSON.stringify(h.slack.of('chat.update').at(-1).blocks);
    expect(card).toContain('📅 2026-11-09 11:59 PM');
  });

  it('creates a task due just after midnight on the right day', async () => {
    const w = await tracker();
    const h = await harness(w, {
      env: IST,
      confirm: 'none',
      turns: [[call('create_task', { project: 'WEB', title: 'Night deploy', due: '2026-11-10 02:00' })], []],
    });
    await mention(h);
    await h.handlers.idle();
    const [task] = (await w.api.get('/tasks')).data;
    expect(task.due).toBe('2026-11-09T20:30:00.000Z');
    expect(JSON.stringify(h.slack.of('chat.update').at(-1).blocks)).toContain('📅 2026-11-10 2:00 AM');
  });

  it('refuses a due it can’t read before anyone is asked to confirm', async () => {
    const w = await tracker();
    const t = await w.api.post('/tasks', { project: 'WEB', title: 'Add date filter' });
    const h = await harness(w, { env: IST, turns: [[call('update_task', { key: t.key, due: 'someday soon' })], []] });
    const results = toolResults(h);
    await mention(h);
    await h.handlers.idle();
    expect(results.join('\n')).toContain('update_task: Not allowed: "someday soon" isn\'t a date.');
    expect(JSON.stringify(h.slack.of('chat.update'))).not.toContain('"block_id":"pending"');
    expect((await w.api.get(`/tasks/${t.key}`)).due).toBe(null);
  });

  it('the create modal takes a time with the date', async () => {
    const w = await tracker();
    const h = await harness(w, { env: IST });
    h.store.setChannelProject('C1', 'WEB', 'x');
    await h.handlers.onCommand({ command: { text: 'new Ship it', user_id: 'UBEA', channel_id: 'C1', trigger_id: 'trig' }, respond: async () => {} });
    const { view } = h.slack.of('views.update').at(-1);
    expect(view.blocks.find(b => b.block_id === 'due_time').element.type).toBe('timepicker');
    const state = {
      values: {
        title: { v: { value: 'Ship it' } },
        project: { v: { selected_option: { value: 'WEB' } } },
        assignee: { v: {} },
        priority: { v: {} },
        due: { v: { selected_date: '2026-11-20' } },
        due_time: { v: { selected_time: '17:30' } },
        description: { v: { value: '' } },
      },
    };
    const done = await h.handlers.onCreateSubmit({ view: { id: 'V1', private_metadata: view.private_metadata, state }, user: 'UBEA' });
    expect(done.errors).toBeUndefined();
    await done.after();
    const [task] = (await w.api.get('/tasks')).data;
    expect(task.due).toBe('2026-11-20T12:00:00.000Z');
  });

  it('lists my work on the team’s clock, soonest first', async () => {
    const w = await tracker();
    // 02:00 on Nov 10 in India (still Nov 9 in UTC), and all of Nov 10.
    await w.api.post('/tasks', { project: 'WEB', title: 'All day', assignee: 'mbea', due: '2026-11-10' });
    await w.api.post('/tasks', { project: 'WEB', title: 'Early', assignee: 'mbea', due: '2026-11-09T20:30:00Z' });
    const h = await harness(w, { env: IST });
    const out = [];
    await h.handlers.onCommand({ command: { text: 'my', user_id: 'UBEA', channel_id: 'C1', trigger_id: 'trig' }, respond: async m => out.push(m) });
    const text = out.at(-1).text;
    expect(text).toContain('📅 2026-11-10 2:00 AM');
    expect(text.indexOf('Early')).toBeLessThan(text.indexOf('All day'));
  });

  it('tells the model the day and the time now on the team’s clock', () => {
    const msg = requestMessage({
      now: new Date('2026-11-09T18:00:00Z'),
      timezone: 'Asia/Kolkata',
      requester: { name: 'Deepak', role: 'Member' },
      channel: { dm: true },
      text: 'due today 11:59pm',
    });
    expect(msg).toContain('Today is 2026-11-09 (Monday), 23:30 now, time zone Asia/Kolkata.');
  });
});
