/* Cards the agent can add under its reply: a json-render spec (@json-render/chat) → a Chat SDK card →
   Slack Block Kit (@chat-adapter/slack's cardToBlockKit). Tables become Slack's native data_table
   block and charts its data_visualization block.

   What the model writes can echo planted text, and neither library escapes anything (Text, Field
   and subtitle go straight into mrkdwn). So the catalog leaves out everything that acts or loads
   (Actions, Button, LinkButton, Image, Card.imageUrl), every string is escaped the way replies are
   (format.js mrkdwn(): no pings, links only to the tracker and Slack), and the final blocks are
   checked again before they're posted. Anything that fails is a plain-text reply instead. */
import { CardSpecError, standardComponentDefinitions as std, toCard } from '@json-render/chat';
import { cardToBlockKit, cardToFallbackText } from '@chat-adapter/slack/blocks';
import * as z from 'zod';
import { mrkdwn, onHost } from './format.js';

/* The components the model may use. Card is redefined without imageUrl (an image block would load
   any URL the model wrote); Actions, Button, LinkButton and Image aren't here at all, so a spec
   using them is rejected ("unknown component"). */
export const COMPONENTS = {
  Card: { ...std.Card, props: z.object({ title: z.string().nullish(), subtitle: z.string().nullish() }) },
  Section: std.Section,
  Text: std.Text,
  Fields: std.Fields,
  Field: std.Field,
  Table: std.Table,
  Chart: std.Chart,
  Divider: std.Divider,
};

/* Slack's limits per message (docs.slack.dev data_visualization and data_table), enforced here so
   the model gets an error to fix instead of the adapter quietly drawing an ASCII table. */
export const LIMITS = {
  tables: 1,
  charts: 2,
  fields: 10,
  tableRows: 100,
  tableColumns: 20,
  chartTitle: 50,
  chartLabel: 20,
  chartSeries: 12,
  chartPoints: 20,
};
// Blocks a card may take, leaving room in Slack's 50 for the reply, task cards and a prefix.
export const MAX_CARD_BLOCKS = 30;
// Rows a table shows per page (Slack's default is 5).
const PAGE_SIZE = 10;

const BLOCK_TYPES = new Set(['header', 'context', 'section', 'divider', 'data_table', 'table', 'data_visualization']);

/* Text Slack shows as is (header, table cells, chart labels): "<" and ">" become look-alikes, so it
   can't form a mention or a link here or in the ASCII fallback, which is mrkdwn. Same length, so
   chart label limits still hold. */
const plain = s =>
  String(s ?? '')
    .replace(/</g, '‹')
    .replace(/>/g, '›');

/* The card with every string escaped for where it ends up. */
function escapeCard(card, hosts) {
  const md = s => (s == null ? s : mrkdwn(s, { hosts }));
  const child = el => {
    switch (el.type) {
      case 'section':
        return { ...el, children: el.children.map(child) };
      case 'text':
        return { ...el, content: md(el.content) };
      case 'fields':
        return { ...el, children: el.children.map(f => ({ ...f, label: md(f.label), value: md(f.value) })) };
      case 'table':
        return {
          ...el,
          headers: el.headers.map(plain),
          rows: el.rows.map(r => r.map(plain)),
          caption: el.caption == null ? el.caption : plain(el.caption),
          pageSize: PAGE_SIZE,
        };
      case 'chart': {
        const c = el.chart;
        const chart =
          c.type === 'pie'
            ? { ...c, segments: c.segments.map(s => ({ ...s, label: plain(s.label) })) }
            : {
                ...c,
                categories: c.categories.map(plain),
                xLabel: c.xLabel == null ? c.xLabel : plain(c.xLabel),
                yLabel: c.yLabel == null ? c.yLabel : plain(c.yLabel),
                series: c.series.map(s => ({ ...s, name: plain(s.name), data: s.data.map(p => ({ ...p, label: plain(p.label) })) })),
              };
        return { ...el, title: plain(el.title), chart };
      }
      case 'divider':
        return el;
      default:
        // Not in the catalog, so toCard already refused it; never let one through regardless.
        throw new CardSpecError([`${el.type} isn't allowed`]);
    }
  };
  return { type: 'card', title: card.title == null ? card.title : plain(card.title), subtitle: md(card.subtitle), children: card.children.map(child) };
}

/* Every string in the blocks: no "<" except links to `hosts`, only display blocks, and nothing that
   acts or loads (buttons, URLs, images). A second line of defence in case either library changes. */
export function unsafeIn(blocks, text, hosts) {
  const problems = [];
  for (const b of blocks) if (!BLOCK_TYPES.has(b?.type)) problems.push(`block type ${b?.type}`);
  const walk = (v, key) => {
    if (typeof v === 'string') {
      const rest = v.replace(/<(https?:\/\/[^|>\s]+)(\|[^<>]*)?>/g, (m, url) => (onHost(url, hosts) ? '' : m));
      if (/[<>]/.test(rest)) problems.push(`markup in ${key}`);
    } else if (Array.isArray(v)) v.forEach(x => walk(x, key));
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) {
        if (
          ['url', 'image_url', 'action_id', 'accessory', 'elements'].includes(k) &&
          !(k === 'elements' && Array.isArray(x) && x.every(e => e?.type === 'mrkdwn'))
        )
          problems.push(`field ${k}`);
        walk(x, k);
      }
  };
  walk(blocks, 'blocks');
  walk(text, 'text');
  return problems;
}

/* A spec → { blocks, text, plain } for Slack. `text` is the notification text; `plain` is the card
   as mrkdwn sections, posted instead of the blocks if Slack refuses them. Throws CardSpecError,
   with one issue per problem, for anything wrong: the tool sends those back to the model. */
export function renderCard(spec, { hosts = [] } = {}) {
  const raw = toCard(spec, { components: COMPONENTS, limits: LIMITS });
  const card = escapeCard(raw, hosts);
  const blocks = cardToBlockKit(card, { maxBlocks: Infinity });
  const issues = [];
  if (blocks.length > MAX_CARD_BLOCKS)
    issues.push(`the card takes ${blocks.length} Slack blocks, at most ${MAX_CARD_BLOCKS}: use fewer Text elements, or a Table`);
  // The adapter draws what Slack can't show natively as an ASCII code block; ask for a fix instead.
  const count = (els, type) => els.reduce((n, e) => n + (e.type === type ? 1 : 0) + (e.type === 'section' ? count(e.children, type) : 0), 0);
  if (blocks.filter(b => b.type === 'data_visualization').length < count(card.children, 'chart'))
    issues.push('a Chart can’t be drawn: categories and series names must be unique, and axis labels at most 50 characters');
  if (blocks.filter(b => b.type === 'data_table' || b.type === 'table').length < count(card.children, 'table'))
    issues.push('the Table is too big: at most 10,000 characters in all its cells');
  if (issues.length) throw new CardSpecError(issues);
  const text = cardToFallbackText(card).slice(0, 3000);
  const plain = plainBlocks(card);
  const problems = [...unsafeIn(blocks, text, hosts), ...unsafeIn(plain, '', hosts)];
  if (problems.length) throw new CardSpecError([`the card can’t be posted safely (${[...new Set(problems)].join(', ')})`]);
  return { blocks, text, plain };
}

/* The card as mrkdwn sections: a bold title, then each part, tables and charts as code blocks. */
function plainBlocks(card) {
  const fence = s => '```\n' + s.slice(0, 2880) + '\n```';
  const part = el => {
    const s = cardToFallbackText({ type: 'card', children: [el] });
    return el.type === 'table' || el.type === 'chart' ? fence(s) : s.slice(0, 2900);
  };
  const parts = [
    card.title ? `*${card.title}*${card.subtitle ? `\n${card.subtitle}` : ''}` : card.subtitle,
    ...card.children.flatMap(c => (c.type === 'section' ? c.children : [c])).map(part),
  ];
  return parts
    .filter(Boolean)
    .slice(0, MAX_CARD_BLOCKS)
    .map(text => ({ type: 'section', text: { type: 'mrkdwn', text } }));
}

/* The show_card tool's list of elements as a json-render spec ({ root, elements by key }). */
export function cardSpec(root, list) {
  const elements = {};
  const issues = [];
  for (const { key, ...el } of list || []) {
    if (key in elements) issues.push(`two elements have the key "${key}"`);
    elements[key] = { props: {}, children: [], ...el };
  }
  if (issues.length) throw new CardSpecError(issues);
  return { root, elements };
}

/* What the agent's show_card tool says about cards. */
export const CARD_GUIDE = `Show a card under your reply, drawn natively in Slack: a header, short text, label/value fields, one table and up to two charts. Use it when it helps: lists of tasks, status breakdowns, workload per person. Answer short things in plain text without a card.
Your text reply still goes above the card: keep it to a line and don't repeat what the card shows. One card per reply; calling again replaces it. If the result lists problems, fix them and call again, or answer in plain text.
Use only facts from tool results. Cards have no buttons or images; task cards with buttons are added by themselves for tasks you create or change.

The card is flat: "root" is the key of the Card, and "elements" lists every element as { "key", "type", "props", "children": [keys of its children, in order] }. Every element other than the Card is its descendant.
- Card { title?, subtitle? }: the root. title is the header (plain text, keep it short), subtitle a muted line under it.
- Section {}: groups children.
- Text { content, style?: "plain" | "bold" | "muted" }: a paragraph. Markdown: **bold**, _italic_, \`code\`, [WEB-12](task url) links to tracker URLs from tool results. muted is for footnotes.
- Fields {} with Field { label, value } children: up to 10 label/value pairs, for a few key numbers.
- Table { headers: [..], rows: [[..]], caption }: at most one, up to 99 rows and 20 columns, one cell per header in every row. caption names the table ("Open tasks"). Cells are plain text: no links or formatting.
- Chart { title, chart }: at most two. title up to 50 characters; labels, categories and series names up to 20 characters and unique.
  pie: { "type": "pie", "segments": [{ "label", "value" > 0 }] }, up to 12 segments, for shares of a whole.
  bar | line | area: { "type", "categories": [..], "series": [{ "name", "values": [one per category, in order] }], "xLabel"?, "yLabel"? }, up to 20 categories and 12 series.
- Divider {}.

Example: { "root": "card", "elements": [
  { "key": "card", "type": "Card", "props": { "title": "Ada's open work", "subtitle": "4 tasks, 1 overdue" }, "children": ["tasks"] },
  { "key": "tasks", "type": "Table", "props": { "caption": "Open tasks", "headers": ["Task", "Title", "Status", "Due"], "rows": [["WEB-12", "Fix login loop", "In progress", "Nov 3 (overdue)"], ["WEB-15", "Pricing page copy", "To do", "Nov 14"]] }, "children": [] } ] }`;
