/* Cards under replies: a json-render spec from the agent → Block Kit with Slack's native table and
   chart blocks. Model-written text is escaped like replies, nothing that acts or loads gets through,
   Slack's per-message limits go back to the model as problems to fix, and a card that can't be shown
   leaves a plain-text reply. */
import { describe, expect, it } from 'vitest';
import { call, harness, tracker } from './helpers.js';
import { MAX_CARD_BLOCKS, cardSpec, renderCard, unsafeIn } from '../src/slack/cards.js';

const HOSTS = ['app.test', 'slack.com', '*.slack.com'];
const leaf = (type, props) => ({ type, props, children: [] });
const card = (props, children) => ({ root: 'card', elements: { card: { type: 'Card', props, children: Object.keys(children) }, ...children } });
const pie = (title = 'By status') =>
  leaf('Chart', {
    title,
    chart: {
      type: 'pie',
      segments: [
        { label: 'To do', value: 3 },
        { label: 'Done', value: 5 },
      ],
    },
  });
const issuesOf = spec => {
  try {
    renderCard(spec, { hosts: HOSTS });
  } catch (e) {
    return e.issues;
  }
  throw new Error('expected the card to be refused');
};
const json = v => JSON.stringify(v);
/* show_card's arguments for a spec: its elements as a list. */
const args = spec => ({ root: spec.root, elements: Object.entries(spec.elements).map(([key, el]) => ({ key, ...el })) });

/* "What's on my plate?" as the agent would answer it. */
const PLATE = card(
  { title: "Bea's open work", subtitle: '4 open tasks, 1 overdue' },
  {
    tasks: leaf('Table', {
      headers: ['Task', 'Title', 'Status', 'Due'],
      rows: [
        ['WEB-12', 'Fix login loop on Safari', 'In progress', 'Nov 3 (overdue)'],
        ['WEB-15', 'Pricing page copy', 'To do', 'Nov 12'],
        ['OPS-4', 'Rotate staging keys', 'In review', 'Nov 14'],
        ['WEB-19', 'Cookie banner', 'Backlog', ''],
      ],
    }),
    note: leaf('Text', { content: 'Open them in [the tracker](http://app.test/#/my-work).', style: 'muted' }),
  },
);

/* "Status of WEB?" */
const STATUS = card(
  { title: 'WEB · Website relaunch', subtitle: 'Due Dec 1 · lead Ada Owner' },
  {
    counts: { type: 'Fields', props: {}, children: ['open', 'overdue', 'unassigned', 'done'] },
    open: leaf('Field', { label: 'Open', value: 14 }),
    overdue: leaf('Field', { label: 'Overdue', value: 2 }),
    unassigned: leaf('Field', { label: 'Unassigned', value: 3 }),
    done: leaf('Field', { label: 'Done', value: 21 }),
    split: leaf('Chart', {
      title: 'Tasks by status',
      chart: {
        type: 'pie',
        segments: [
          { label: 'Backlog', value: 4 },
          { label: 'To do', value: 5 },
          { label: 'In progress', value: 3 },
          { label: 'In review', value: 2 },
          { label: 'Done', value: 21 },
        ],
      },
    }),
    load: leaf('Chart', {
      title: 'Open tasks per person',
      chart: { type: 'bar', categories: ['Ada', 'Bea', 'Unassigned'], series: [{ name: 'Open', values: [6, 5, 3] }] },
    }),
    rule: leaf('Divider', {}),
    attention: leaf('Table', {
      headers: ['Task', 'Needs', 'Due'],
      rows: [
        ['WEB-12', 'Overdue', 'Nov 3'],
        ['WEB-21', 'Unassigned', 'Nov 20'],
      ],
    }),
  },
);

describe('spec → Block Kit', () => {
  it('turns "what’s on my plate" into a header, a native data table and a footnote', () => {
    const { blocks, text } = renderCard(PLATE, { hosts: HOSTS });
    expect(blocks.map(b => b.type)).toEqual(['header', 'context', 'data_table', 'context']);
    expect(blocks[0].text).toEqual({ type: 'plain_text', text: "Bea's open work", emoji: true });
    const table = blocks[2];
    expect(table.page_size).toBe(10);
    expect(table.rows).toHaveLength(5);
    expect(table.rows[1][0]).toEqual({ type: 'raw_text', text: 'WEB-12' });
    // An empty cell is a space: Slack refuses empty text.
    expect(table.rows[4][3]).toEqual({ type: 'raw_text', text: ' ' });
    // Links to the tracker stay links.
    expect(blocks[3].elements[0].text).toBe('Open them in <http://app.test/#/my-work|the tracker>.');
    expect(text).toContain("*Bea's open work*");
    expect(text).toContain('WEB-12 | Fix login loop on Safari');
  });

  it('turns "status of WEB" into fields, two native charts and a table', () => {
    const { blocks } = renderCard(STATUS, { hosts: HOSTS });
    expect(blocks.map(b => b.type)).toEqual(['header', 'context', 'section', 'data_visualization', 'data_visualization', 'divider', 'data_table']);
    expect(blocks[2].fields.map(f => f.text)).toEqual(['*Open*\n14', '*Overdue*\n2', '*Unassigned*\n3', '*Done*\n21']);
    expect(blocks[3]).toMatchObject({ type: 'data_visualization', title: 'Tasks by status', chart: { type: 'pie' } });
    expect(blocks[4].chart).toEqual({
      type: 'bar',
      axis_config: { categories: ['Ada', 'Bea', 'Unassigned'] },
      series: [
        {
          name: 'Open',
          data: [
            { label: 'Ada', value: 6 },
            { label: 'Bea', value: 5 },
            { label: 'Unassigned', value: 3 },
          ],
        },
      ],
    });
  });

  it('gives a plain-text version: title, text, and tables and charts as code blocks', () => {
    const { plain } = renderCard(STATUS, { hosts: HOSTS });
    expect(plain.every(b => b.type === 'section' && b.text.type === 'mrkdwn')).toBe(true);
    const texts = plain.map(b => b.text.text);
    expect(texts[0]).toBe('*WEB · Website relaunch*\nDue Dec 1 · lead Ada Owner');
    expect(texts).toContain('Open: 14\nOverdue: 2\nUnassigned: 3\nDone: 21');
    expect(texts.find(t => t.includes('Tasks by status'))).toMatch(/^```\nTasks by status\nLabel {7}\| Value\nBacklog {5}\| 4/);
    expect(texts.at(-1)).toMatch(/^```\nTask {3}\| Needs {6}\| Due\nWEB-12 \| Overdue/);
  });
});

describe('escaping what the model wrote', () => {
  const HOSTILE = card(
    { title: 'Plate <!channel>', subtitle: 'for <@U0ADA> <!subteam^S1>' },
    {
      text: leaf('Text', {
        content:
          '**Heads up** <!here> see [the doc](https://evil.example/phish) or <https://evil.example/x|http://app.test/WEB-1> and [WEB-1](http://app.test/#/t/WEB-1)',
      }),
      kpis: { type: 'Fields', props: {}, children: ['f'] },
      f: leaf('Field', { label: '<!everyone>', value: '<#C0GENERAL> & co' }),
      table: leaf('Table', { headers: ['Task', '<!channel>'], rows: [['WEB-1', '<@U0ADA> <https://evil.example|click>']], caption: '<!here>' }),
      chart: leaf('Chart', { title: '<!here> chart', chart: { type: 'bar', categories: ['<!here>', 'b'], series: [{ name: '<@U1>', values: [1, 2] }] } }),
    },
  );

  it('leaves no mention, broadcast or disguised link anywhere: blocks, notification text or plain version', () => {
    const { blocks, text, plain } = renderCard(HOSTILE, { hosts: HOSTS });
    for (const out of [json(blocks), json(text), json(plain)]) {
      expect(out).not.toMatch(/<[!@#]/);
      expect(out).not.toContain('<https://evil');
    }
    expect(unsafeIn(blocks, text, HOSTS)).toEqual([]);
  });

  it('escapes mrkdwn text like replies: links only to the tracker, others spelled out', () => {
    const { blocks } = renderCard(HOSTILE, { hosts: HOSTS });
    const body = blocks.find(b => b.type === 'section' && b.text).text.text;
    expect(body).toBe(
      '*Heads up* &lt;!here&gt; see the doc (https://evil.example/phish) or http://app.test/WEB-1 (https://evil.example/x) and <http://app.test/#/t/WEB-1|WEB-1>',
    );
    expect(blocks.find(b => b.type === 'context').elements[0].text).toBe('for &lt;@U0ADA&gt; &lt;!subteam^S1&gt;');
    expect(blocks.find(b => b.fields).fields[0].text).toBe('*&lt;!everyone&gt;*\n&lt;#C0GENERAL&gt; &amp; co');
  });

  it('shows plain text (header, cells, chart labels) with look-alike brackets', () => {
    const { blocks } = renderCard(HOSTILE, { hosts: HOSTS });
    expect(blocks[0].text.text).toBe('Plate ‹!channel›');
    const table = blocks.find(b => b.type === 'data_table');
    expect(table.caption).toBe('‹!here›');
    expect(table.rows[0][1].text).toBe('‹!channel›');
    expect(table.rows[1][1].text).toBe('‹@U0ADA› ‹https://evil.example|click›');
    const chart = blocks.find(b => b.type === 'data_visualization');
    expect(chart.title).toBe('‹!here› chart');
    expect(chart.chart.axis_config.categories).toEqual(['‹!here›', 'b']);
    expect(chart.chart.series[0]).toMatchObject({
      name: '‹@U1›',
      data: [
        { label: '‹!here›', value: 1 },
        { label: 'b', value: 2 },
      ],
    });
  });

  it('the last check refuses blocks that act, load or ping, whatever made them', () => {
    expect(unsafeIn([{ type: 'actions', elements: [{ type: 'button', action_id: 'task_complete', value: 'WEB-1' }] }], '', HOSTS)).toEqual(
      expect.arrayContaining(['block type actions', 'field action_id']),
    );
    expect(unsafeIn([{ type: 'image', image_url: 'https://evil.example/p.png' }], '', HOSTS)).toContain('field image_url');
    expect(unsafeIn([{ type: 'section', text: { type: 'mrkdwn', text: 'hi <!channel>' } }], '', HOSTS)).toContain('markup in text');
    expect(unsafeIn([{ type: 'section', text: { type: 'mrkdwn', text: '<https://evil.example|app.test>' } }], '', HOSTS)).toContain('markup in text');
    expect(unsafeIn([{ type: 'section', text: { type: 'mrkdwn', text: '<http://app.test/#/t/WEB-1|WEB-1>' } }], 'x <@U1>', HOSTS)).toEqual(['markup in text']);
  });
});

describe('what a card can’t have', () => {
  it.each([
    [
      'Actions with a Button',
      { a: { type: 'Actions', props: {}, children: ['b'] }, b: leaf('Button', { id: 'task_complete', label: 'Done', value: 'WEB-1' }) },
      'unknown component "Button"',
    ],
    [
      'Actions with a LinkButton',
      { a: { type: 'Actions', props: {}, children: ['b'] }, b: leaf('LinkButton', { label: 'Open', url: 'https://evil.example' }) },
      'unknown component "LinkButton"',
    ],
    ['an Image', { i: leaf('Image', { url: 'https://evil.example/p.png', alt: 'x' }) }, 'unknown component "Image"'],
    ['a made-up component', { m: leaf('Mention', { user: 'U1' }) }, 'unknown component "Mention"'],
  ])('refuses %s', (_, children, issue) => {
    expect(issuesOf(card({ title: 'x' }, children))).toContain(`${Object.keys(children).at(-1)}: ${issue}`);
  });

  it('drops a Card image instead of loading it', () => {
    const { blocks } = renderCard({
      root: 'c',
      elements: { c: { type: 'Card', props: { title: 'x', imageUrl: 'https://evil.example/p.png' }, children: [] } },
    });
    expect(blocks).toEqual([{ type: 'header', text: { type: 'plain_text', text: 'x', emoji: true } }]);
  });

  it('allows two charts, not three', () => {
    expect(renderCard(card({}, { a: pie(), b: pie() })).blocks.filter(b => b.type === 'data_visualization')).toHaveLength(2);
    expect(issuesOf(card({}, { a: pie(), b: pie(), c: pie() }))).toEqual(['at most 2 Chart per message']);
  });

  it('sends Slack’s chart limits back instead of drawing an ASCII chart', () => {
    expect(issuesOf(card({}, { a: pie('A title that is much longer than the fifty characters Slack allows') }))).toEqual([
      'a: title longer than 50 characters',
    ]);
    const bar = (categories, names = ['Open']) =>
      leaf('Chart', { title: 't', chart: { type: 'bar', categories, series: names.map(name => ({ name, values: categories.map(() => 1) })) } });
    expect(issuesOf(card({}, { a: bar(['A label longer than twenty']) }))).toEqual(['a: label "A label longer than twenty" longer than 20 characters']);
    expect(issuesOf(card({}, { a: bar(Array.from({ length: 21 }, (_, i) => `d${i}`)) }))).toEqual(['a: at most 20 categories']);
    expect(issuesOf(card({}, { a: bar(['Mon', 'Mon']) }))[0]).toMatch(/Chart can’t be drawn: categories and series names must be unique/);
    expect(
      issuesOf(card({}, { a: leaf('Chart', { title: 't', chart: { type: 'bar', categories: ['a', 'b'], series: [{ name: 's', values: [1] }] } }) })),
    ).toEqual(['a: series "s" has 1 values, expected 2']);
  });

  it('allows one table, and refuses one too big for Slack', () => {
    const table = rows => leaf('Table', { headers: ['Task'], rows: Array.from({ length: rows }, (_, i) => [`T-${i}`]) });
    expect(issuesOf(card({}, { a: table(1), b: table(1) }))).toEqual(['at most 1 Table per message']);
    expect(issuesOf(card({}, { a: table(100) }))).toEqual(['a: at most 100 rows including the header']);
    expect(issuesOf(card({}, { a: leaf('Table', { headers: ['T'], rows: Array.from({ length: 20 }, () => ['x'.repeat(600)]) }) }))).toEqual([
      'the Table is too big: at most 10,000 characters in all its cells',
    ]);
  });

  it('refuses a card too long to share a message with the reply and task cards', () => {
    const many = Object.fromEntries(Array.from({ length: MAX_CARD_BLOCKS + 1 }, (_, i) => [`t${i}`, leaf('Text', { content: `line ${i}` })]));
    expect(issuesOf(card({}, many))[0]).toMatch(/takes 31 Slack blocks, at most 30/);
  });

  it('refuses a malformed spec with what to fix', () => {
    expect(issuesOf({ elements: {} })).toEqual(['spec needs a root and elements']);
    expect(issuesOf({ root: 't', elements: { t: leaf('Text', { content: 'x' }) } })).toEqual(['root must be a Card']);
    expect(issuesOf(card({}, { f: leaf('Field', { label: 'x' }) }))).toEqual(['f.props.value: Invalid input']);
  });
});

describe('cards under replies', () => {
  const mention = (h, { text = '<@UBOT> what’s on my plate?', channel = 'C1' } = {}) =>
    h.handlers.onMention({ event: { type: 'app_mention', user: 'UBEA', channel, ts: '100.000001', text } }).then(() => h.handlers.idle());
  const lastUpdate = h => h.slack.of('chat.update').at(-1);
  const toolResults = async (h, name) =>
    (await h.agent.graph.getState({ configurable: { thread_id: h.store.conversation('C1:100.000001:UBEA').threadId } })).values.messages
      .filter(m => m.getType() === 'tool' && m.name === name)
      .map(m => m.content);

  it('posts the agent’s card in its reply, under the text', async () => {
    const w = await tracker();
    const h = await harness(w, { turns: [[call('show_card', args(PLATE))], []] });
    await mention(h);
    const { blocks, text } = lastUpdate(h);
    expect(blocks.map(b => b.type)).toEqual(['section', 'header', 'context', 'data_table', 'context']);
    expect(blocks[3].rows[1][0].text).toBe('WEB-12');
    expect(text.length).toBeGreaterThan(0);
    expect(await toolResults(h, 'show_card')).toEqual([expect.stringMatching(/^The card will be shown under your reply/)]);
  });

  it('sends a bad spec back to the agent, and its plain-text answer goes out without a card', async () => {
    const w = await tracker();
    const bad = card(
      { title: 'Plate' },
      { a: { type: 'Actions', props: {}, children: ['b'] }, b: leaf('Button', { id: 'task_complete', label: 'Done', value: 'WEB-1' }) },
    );
    const h = await harness(w, { turns: [[call('show_card', args(bad))], []] });
    await mention(h);
    const [result] = await toolResults(h, 'show_card');
    expect(result).toMatch(/^The card wasn't shown\. Fix these and call show_card again, or answer in plain text:/);
    expect(result).toContain('- b: unknown component "Button"');
    const { blocks } = lastUpdate(h);
    expect(blocks.map(b => b.type)).toEqual(['section']);
    expect(json(blocks)).not.toContain('task_complete');
  });

  it('wrong props are a problem for the agent to fix, not a failed run', async () => {
    const w = await tracker();
    const h = await harness(w, { turns: [[call('show_card', { root: 'c', elements: [{ key: 'c', type: 'Card', props: { title: 1 } }] })], []] });
    await mention(h);
    expect((await toolResults(h, 'show_card'))[0]).toContain('- c.props.title: Invalid input: expected string, received number');
    expect(lastUpdate(h).blocks.map(b => b.type)).toEqual(['section']);
  });

  it('elements sent as a JSON string go back as an error, and a good card after it is shown', async () => {
    const w = await tracker();
    const h = await harness(w, {
      turns: [[call('show_card', { root: 'card', elements: JSON.stringify(args(PLATE).elements) })], [call('show_card', args(PLATE))], []],
    });
    await mention(h);
    const [bad, ok] = await toolResults(h, 'show_card');
    expect(bad).toMatch(/expected array, received string/);
    expect(ok).toMatch(/^The card will be shown under your reply/);
    expect(lastUpdate(h).blocks.map(b => b.type)).toContain('data_table');
  });

  it('builds the spec from the tool’s list of elements, refusing a key used twice', () => {
    expect(
      cardSpec('c', [
        { key: 'c', type: 'Card', children: ['t'] },
        { key: 't', type: 'Text', props: { content: 'x' } },
      ]),
    ).toEqual({
      root: 'c',
      elements: { c: { type: 'Card', props: {}, children: ['t'] }, t: { type: 'Text', props: { content: 'x' }, children: [] } },
    });
    expect(() =>
      cardSpec('c', [
        { key: 'c', type: 'Card' },
        { key: 'c', type: 'Text' },
      ]),
    ).toThrow('two elements have the key "c"');
  });

  it('keeps the last card when the agent shows more than one', async () => {
    const w = await tracker();
    const h = await harness(w, { turns: [[call('show_card', args(PLATE))], [call('show_card', args(STATUS))], []] });
    await mention(h);
    const types = lastUpdate(h).blocks.map(b => b.type);
    expect(types.filter(t => t === 'header')).toHaveLength(1);
    expect(types).toContain('data_visualization');
  });

  it('posts the card as text if Slack refuses its blocks', async () => {
    const w = await tracker();
    const h = await harness(w, { turns: [[call('show_card', args(STATUS))], []] });
    const update = h.slack.chat.update;
    h.slack.chat.update = async args => {
      if (json(args.blocks).includes('data_visualization'))
        throw Object.assign(new Error('An API error occurred: invalid_blocks'), { data: { error: 'invalid_blocks' } });
      return update(args);
    };
    await mention(h);
    const { blocks } = lastUpdate(h);
    expect(blocks.every(b => b.type === 'section' && b.text.type === 'mrkdwn')).toBe(true);
    expect(json(blocks)).toContain('*WEB · Website relaunch*');
    expect(json(blocks)).toContain('```\\nTask   | Needs      | Due');
  });

  it('shows the card with the reply after Confirm when the agent made it before a change', async () => {
    const w = await tracker();
    const task = await w.api.post('/tasks', { project: 'WEB', title: 'Pricing page copy' });
    const h = await harness(w, { turns: [[call('show_card', args(PLATE)), call('complete_task', { key: task.key })], []] });
    await h.handlers
      .onMention({ event: { type: 'app_mention', user: 'UADA', channel: 'C1', ts: '100.000001', text: '<@UBOT> show my plate and close it' } })
      .then(() => h.handlers.idle());
    const confirm = lastUpdate(h);
    expect(json(confirm.blocks)).not.toContain('data_table');
    const id = confirm.blocks.find(b => b.block_id === 'pending').elements[0].value;
    await h.handlers
      .onAction({ action: { action_id: 'pending_confirm', value: id }, body: { user: { id: 'UADA' }, channel: { id: 'C1' } }, respond: async () => {} })
      .then(() => h.handlers.idle());
    expect((await w.api.get(`/tasks/${task.key}`)).status).toBe('done');
    const { blocks } = lastUpdate(h);
    // What was confirmed, the reply, the card, then the completed task's card.
    expect(blocks.map(b => b.type)).toEqual(['section', 'section', 'header', 'context', 'data_table', 'context', 'section']);
    expect(blocks.at(-1).text.text).toContain(task.key);
  });
});
