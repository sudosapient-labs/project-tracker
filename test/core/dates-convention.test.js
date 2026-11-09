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
