/* Ids minted in the browser must not need a secure context: crypto.randomUUID only exists on https
   or localhost, and calling it at load left a blank page over plain http on another address. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomHex } from '../../src/core/random.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src');
const files = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('randomHex', () => {
  it('returns lowercase hex of the length asked for, different each time', () => {
    for (const n of [1, 14, 16, 31]) expect(randomHex(n)).toMatch(new RegExp(`^[0-9a-f]{${n}}$`));
    expect(new Set(Array.from({ length: 200 }, () => randomHex(14))).size).toBe(200);
  });

  it('works where crypto.randomUUID doesn’t exist (plain http off localhost)', async () => {
    vi.stubGlobal('crypto', { getRandomValues: a => (a.forEach((_, i) => (a[i] = (i * 37) & 255)), a) });
    expect(globalThis.crypto.randomUUID).toBeUndefined();
    expect(randomHex(6)).toBe('00254a');
    // The API module mints this tab's id at load: importing it must not throw.
    const { CLIENT_ID } = await import('../../src/core/api.js');
    expect(CLIENT_ID).toMatch(/^tab[0-9a-f]{16}$/);
  });

  it('is what the app uses: nothing in src/ calls crypto.randomUUID', () => {
    const offenders = files(SRC).filter(f => f.endsWith('.js') && /crypto\.randomUUID\s*\(/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
