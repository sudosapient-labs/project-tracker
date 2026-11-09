/* Starts and dues are read only through packages/client/dates.js (see AGENTS.md). A timed value is a
   UTC instant, so cutting its first ten characters gives the UTC day, not the reader's, and
   comparing values as strings mixes the two shapes. This fails when code does either again. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIRS = ['server', 'src', 'packages/cli/src', 'packages/mcp/src', 'packages/slack-bot/src', 'packages/client'];
const SKIP = new Set(['node_modules', 'test', 'migrations']);

const files = dir =>
  fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(e => {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) return SKIP.has(e.name) ? [] : files(rel);
    return e.name.endsWith('.js') ? [rel] : [];
  });

const RULES = [
  // t.due.slice(0, 10), p.start.slice(0, 10), m.date.slice(0, 10), e.when.slice(0, 10) (an event, or
  // the value an activity entry set)
  { what: 'the day of a start or due cut from the string', re: /\.(due|start|date|when)\??\.slice\(0,\s*10\)/ },
  // (a.due || '9999').localeCompare(…)
  { what: 'starts or dues compared as strings', re: /\.(due|start|when)\s*\|\|\s*'9999'/ },
  // e.date === ds, e.time in the app: a stored event's day and time are the saver's; read `when` on
  // the reader's clock. (The API's events already give `date` and `time` on the reader's clock.)
  { what: 'an event’s day or time as saved, not on the reader’s clock', re: /\b(e|ev|it\.ev)\.(date|time)\b/, only: 'src/' },
];

/* Whose clock is decided in one place (AGENTS.md): server/lib/clock.js on the server, src/core/clock.js
   in the app. The machine's own zone is UTC on the server, not anyone's, so nothing else reads it.
   Only these files may: the app's one browser-zone helper, and the CLI's and MCP server's fallback
   for a server too old to say the person's zone. */
const MACHINE_ZONE_OK = new Set(['src/core/clock.js', 'packages/cli/src/clock.js', 'packages/mcp/src/tools.js']);
const MACHINE_ZONE = [{ what: 'the machine’s time zone', re: /resolvedOptions\(\)\.timeZone|\bDEFAULT_TZ\b/ }];
// Where code runs for someone other than the machine's owner: the server and the shared packages.
const SERVER_SIDE = ['server', 'packages/cli/src', 'packages/mcp/src', 'packages/slack-bot/src', 'packages/client'];
const LOCAL_TIME = [
  { what: 'a day or time on the machine’s clock', re: /\.(get|set)(Hours|Minutes|Date|Day|Month|FullYear)\(/ },
  { what: 'a date formatted on the machine’s clock (pass timeZone)', re: /toLocale(Date|Time)String\((?![^)]*timeZone)|new Date\([^)]*\)\.toLocaleString\(/ },
];
const scan = (dirs, rules, ok = new Set()) => {
  const hits = [];
  for (const dir of dirs)
    for (const f of files(dir))
      if (!ok.has(f))
        fs.readFileSync(path.join(ROOT, f), 'utf8')
          .split('\n')
          .forEach((line, i) => {
            for (const r of rules) if (r.re.test(line)) hits.push(`${f}:${i + 1}: ${r.what}`);
          });
  return hits;
};

describe('whose clock is decided in one place', () => {
  it('nothing reads the machine’s time zone outside the allowed helpers', () => {
    expect(scan(DIRS, MACHINE_ZONE, MACHINE_ZONE_OK)).toEqual([]);
  });
  it('the server and packages never read a day or time on the machine’s clock', () => {
    expect(scan(SERVER_SIDE, LOCAL_TIME)).toEqual([]);
  });
  it('the allowed helpers still exist (keep the list current)', () => {
    for (const f of MACHINE_ZONE_OK) expect(fs.readFileSync(path.join(ROOT, f), 'utf8')).toMatch(MACHINE_ZONE[0].re);
  });
});

/* What a valid zone is: validZone / modernZone in packages/client/dates.js (validTz / modernTz in the
   app and server). A second check, a bare zone probe (new Intl.DateTimeFormat(…, { timeZone: v })),
   or a second list of renamed zones, fails here. */
const ZONE_CHECK_OK = new Set(['packages/client/dates.js']);
const ZONE_CHECK = [
  { what: 'a second check of a time zone (use validZone / validTz)', re: /new Intl\.DateTimeFormat\([^)]*\{\s*timeZone:\s*[\w.?]+\s*\}\s*\)/ },
  { what: 'a second list of renamed zones (use modernZone / modernTz)', re: /['"]Asia\/Calcutta['"]\s*:/ },
];

describe('one definition of a valid zone', () => {
  it('only packages/client/dates.js checks whether something is a time zone', () => {
    expect(scan(DIRS, ZONE_CHECK, ZONE_CHECK_OK)).toEqual([]);
  });
  it('and it still does', () => {
    const src = fs.readFileSync(path.join(ROOT, 'packages/client/dates.js'), 'utf8');
    for (const r of ZONE_CHECK) expect(src).toMatch(r.re);
  });
});

describe('dates go through packages/client/dates.js', () => {
  it('nothing reads a start or due by cutting or comparing strings', () => {
    const hits = [];
    for (const dir of DIRS)
      for (const f of files(dir))
        fs.readFileSync(path.join(ROOT, f), 'utf8')
          .split('\n')
          .forEach((line, i) => {
            for (const r of RULES) if ((!r.only || f.startsWith(r.only)) && r.re.test(line)) hits.push(`${f}:${i + 1}: ${r.what}`);
          });
    expect(hits).toEqual([]);
  });
});

/* ---------- the rest of the ways to read a moment on the wrong clock ----------
   Each rule has lines it must catch (`bad`) and lines it must leave alone (`good`), tested on their
   own below, so a rule that stops matching fails here rather than letting code through. */

/* The text of each call to `name(` in `src` (its arguments, through the matching ")"), with the
   line it starts on and what follows it. */
function calls(src, name) {
  const out = [];
  const re = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\(', 'g');
  for (const m of src.matchAll(re)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth; i++) depth += src[i] === '(' ? 1 : src[i] === ')' ? -1 : 0;
    out.push({
      args: src.slice(m.index + m[0].length, i - 1),
      after: src.slice(i, i + 40),
      before: src.slice(Math.max(0, m.index - 60), m.index),
      line: src.slice(0, m.index).split('\n').length,
    });
  }
  return out;
}

const MOMENT_GETTERS = '(?:Hours|Minutes|Seconds|Date|Day|Month|FullYear)';
const MORE = [
  {
    what: 'a UTC day cut from a moment (use dayOf / dayKey with the reader’s zone)',
    re: /toISOString\(\)\.(?:slice|substring|substr)\(|\.split\(\s*['"]T['"]\s*\)\s*\[\s*0\s*\]|\.(?:substring|substr)\(\s*0\s*,\s*10\s*\)/,
    bad: [
      'const when = ms => fmtDate(new Date(ms).toISOString().slice(0, 10));',
      "const day = t.due.split('T')[0];",
      'const d = value.substring(0, 10);',
      'const d = new Date(at).toISOString().substr(0, 10);',
    ],
    good: ['const when = ms => fmtDate(dayKey(ms));', "s.slice(0, 10) + '…'", "const parts = line.split('=')[0];"],
  },
  {
    what: 'a day or time read on UTC, not the reader’s clock (use zoneParts / dayOf / timeOf)',
    re: new RegExp(`\\.getUTC${MOMENT_GETTERS}\\(`),
    bad: ['const h = new Date(t.due).getUTCHours();', 'if (d.getUTCDay() === 0) skip();', 'const day = now.getUTCDate();'],
    good: ['const h = zoneParts(ms, tz).hour;', 'const ms = Date.UTC(y, m, d);'],
  },
  {
    what: 'a date compared as a string: starts and dues are two shapes, use instant / compareDue',
    re: /\.(?:due|start|when)\b\s*(?:<=?|>=?)(?!=)|(?<![=>-])(?:<=?|>=?)\s*[\w.?]+\.(?:due|start|when)\b|\.(?:due|start|when)\)?\s*\.localeCompare\(|localeCompare\(\s*[\w.?]+\.(?:due|start|when)\b/,
    bad: [
      'ps.sort((a, b) => (a.due > b.due ? 1 : -1));',
      'if (t.start <= t.due) ok();',
      'const late = now > t.due;',
      'tasks.sort((a, b) => a.due.localeCompare(b.due));',
      'xs.sort((a, b) => String(a.start).localeCompare(b.start));',
    ],
    good: [
      'ps.sort((a, b) => compareDue(a.due, b.due));',
      'const sorter = { due: p => p.due };',
      'if (instant(t.start) <= instant(t.due, true)) ok();',
      'e => e.when',
    ],
  },
];
/* Formatting a date without a zone formats it on the machine's (the server's UTC, the browser's
   instead of the person's). An Intl.DateTimeFormat() with no arguments that only asks for the
   machine's zone (resolvedOptions) is the rule above, with its own allowed files. */
const FORMATS = [
  {
    what: 'a date formatted without a time zone (pass timeZone)',
    find: src =>
      [
        ...calls(src, 'Intl.DateTimeFormat').filter(c => !/timeZone/.test(c.args) && !(c.args.trim() === '' && /^\s*\.resolvedOptions\(\)/.test(c.after))),
        ...calls(src, '.toLocaleDateString').filter(c => !/timeZone/.test(c.args)),
        ...calls(src, '.toLocaleTimeString').filter(c => !/timeZone/.test(c.args)),
        // On a date (not a number: 1,000): `new Date(…).toLocaleString(`, or a name that holds one.
        ...calls(src, '.toLocaleString').filter(
          c =>
            !/timeZone/.test(c.args) &&
            /(?:new Date\((?:[^()]|\([^()]*\))*\)|\b\w*(?:[Dd]ate|[Tt]ime|[Ww]hen|At|[Dd]ue|[Ss]tart|[Nn]ow|Ms|Ts)|\b(?:d|dt|ms|ts))\s*$/.test(c.before),
        ),
      ].map(c => c.line),
    bad: [
      "const fmt = new Intl.DateTimeFormat('en-US', { month: 'short' });",
      "const f = new Intl.DateTimeFormat('en-US', {\n  hour: 'numeric',\n});",
      "return new Date(ts).toLocaleDateString('en-US', { month: 'short' });",
      'const s = t.completedAt.toLocaleTimeString();',
      'const s = new Date(at).toLocaleString();',
      'const s = createdDate.toLocaleString("en-GB");',
    ],
    good: [
      "const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' });",
      "const f = new Intl.DateTimeFormat('en-US', {\n  timeZone: tz,\n  hour: 'numeric',\n});",
      'const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;',
      "return new Date(ts).toLocaleDateString('en-US', { month: 'short', timeZone: tz });",
      "`Keep it under ${RICH_MAX.toLocaleString('en-US')} characters.`",
    ],
  },
];
/* In the app, a calendar day is a local-midnight Date (src/core/utils.js parse, today, addD), and
   reading its day, month or weekday is fine. A moment (now, a timestamp) in a Date is not: its
   day and time on the browser's clock aren't the person's (zoneOf). Read it with dayKey / timeOf. */
const APP_MACHINE_CLOCK = [
  {
    what: 'a moment read on the browser’s clock (use dayKey / timeOf / zoneParts)',
    re: new RegExp(
      `new Date\\(\\s*(?:Date\\.now\\(\\))?\\s*\\)\\s*\\.(?:get|set)${MOMENT_GETTERS}\\(|new Date\\((?:[^()]|\\([^()]*\\))*\\)\\s*\\.(?:get|set)(?:Hours|Minutes|Seconds)\\(|new Date\\(\\s*[\\w.?]*(?:At|ms|Ms|ts|Ts|\\.when|\\.due|\\.start)\\s*\\)\\s*\\.(?:get|set)${MOMENT_GETTERS}\\(|\\.getTimezoneOffset\\(`,
    ),
    bad: [
      'const h = new Date().getHours();',
      "const greet = new Date(Date.now()).getHours() < 12 ? 'Good morning' : '';",
      'const day = new Date(t.completedAt).getDay();',
      'const h = new Date(ms).getHours();',
      'const off = new Date().getTimezoneOffset();',
      'const d = new Date(t.due).getDate();',
    ],
    good: [
      'const n = parse(s).getDay();',
      'const first = new Date(m.getFullYear(), m.getMonth(), 1);',
      'const h = +timeOf(new Date().toISOString()).slice(0, 2);',
      'const d = today().getDate();',
    ],
  },
  {
    what: 'a moment held in a Date and read on the browser’s clock (use dayKey / timeOf)',
    find: src => {
      const held = [
        ...src.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*new Date\(\s*(?:|Date\.now\(\)|[\w.?]*(?:At|ms|Ms|ts|Ts|\.when|\.due|\.start))\s*\)/g),
      ].map(m => m[1]);
      if (!held.length) return [];
      const re = new RegExp(`\\b(?:${held.join('|')})\\.(?:get|set)${MOMENT_GETTERS}\\(`);
      return src.split('\n').flatMap((l, i) => (re.test(l) ? [i + 1] : []));
    },
    bad: ['const now = new Date();\nconst h = now.getHours();', 'let d = new Date(c.createdAt);\nreturn WD[d.getDay()];'],
    good: ['const now = today();\nconst w = now.getDay();', 'const x = new Date(d);\nx.setHours(0, 0, 0, 0);'],
  },
];

/* Files allowed to, and why. */
const MORE_OK = {
  // The shared rules themselves: days as UTC-midnight anchors for calendar arithmetic (addDaysToDay,
  // the weekday of a 'YYYY-MM-DD'), never a moment's day.
  'packages/client/dates.js': ['a UTC day cut from a moment', 'a day or time read on UTC'],
  // The current year, only to pick January and July for a zone's two offsets in the zone picker.
  'src/core/constants.js': ['a day or time read on UTC'],
};
// The app's calendar-day helpers (sod, iso, parse, addD on local-midnight Dates), and its one
// browser-zone helper.
const APP_CLOCK_OK = new Set(['src/core/utils.js', 'src/core/clock.js']);

const hitsOf = (rule, src) => (rule.find ? rule.find(src) : src.split('\n').flatMap((l, i) => (rule.re.test(l) ? [i + 1] : [])));
const allowed = (f, rule) => (MORE_OK[f] || []).some(w => rule.what.startsWith(w));

describe('the guard’s own rules catch what they’re for', () => {
  for (const rule of [...MORE, ...FORMATS, ...APP_MACHINE_CLOCK])
    it(rule.what, () => {
      for (const line of rule.bad) expect(hitsOf(rule, line), line).not.toEqual([]);
      for (const line of rule.good) expect(hitsOf(rule, line), line).toEqual([]);
    });
});

describe('moments are read on the reader’s clock everywhere', () => {
  it('no UTC day cut from a moment, no UTC getters, no dates compared as strings, no date formatted without a zone', () => {
    const hits = [];
    for (const dir of DIRS)
      for (const f of files(dir)) {
        const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
        for (const rule of [...MORE, ...FORMATS]) if (!allowed(f, rule)) for (const n of hitsOf(rule, src)) hits.push(`${f}:${n}: ${rule.what}`);
      }
    expect(hits).toEqual([]);
  });
  it('the app reads moments on the person’s clock, not the browser’s', () => {
    const hits = [];
    for (const f of files('src'))
      if (!APP_CLOCK_OK.has(f)) {
        const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
        for (const rule of APP_MACHINE_CLOCK) for (const n of hitsOf(rule, src)) hits.push(`${f}:${n}: ${rule.what}`);
      }
    expect(hits).toEqual([]);
  });
  it('the allowed files still need it (keep the lists current)', () => {
    for (const [f, whats] of Object.entries(MORE_OK)) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      for (const w of whats)
        expect(
          hitsOf(
            MORE.find(r => r.what.startsWith(w)),
            src,
          ),
          `${f}: ${w}`,
        ).not.toEqual([]);
    }
    for (const f of APP_CLOCK_OK) expect(fs.existsSync(path.join(ROOT, f)), f).toBe(true);
  });
});
