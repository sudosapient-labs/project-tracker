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
  // t.due.slice(0, 10), p.start.slice(0, 10), m.date.slice(0, 10)
  { what: 'the day of a start or due cut from the string', re: /\.(due|start|date)\??\.slice\(0,\s*10\)/ },
  // (a.due || '9999').localeCompare(…)
  { what: 'starts or dues compared as strings', re: /\.(due|start)\s*\|\|\s*'9999'/ },
];

describe('dates go through packages/client/dates.js', () => {
  it('nothing reads a start or due by cutting or comparing strings', () => {
    const hits = [];
    for (const dir of DIRS)
      for (const f of files(dir))
        fs.readFileSync(path.join(ROOT, f), 'utf8')
          .split('\n')
          .forEach((line, i) => {
            for (const r of RULES) if (r.re.test(line)) hits.push(`${f}:${i + 1}: ${r.what}`);
          });
    expect(hits).toEqual([]);
  });
});
