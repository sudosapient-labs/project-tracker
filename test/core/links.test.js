/* What the URL hash says to open: a page, the task open over it, or a copied link. */
import { describe, expect, it } from 'vitest';
import { parseHash, withTask } from '../../src/core/links.js';

describe('parseHash', () => {
  it('reads a page', () => {
    expect(parseHash('#project/web/list')).toEqual({ page: 'project/web/list', task: null, file: null });
    expect(parseHash('')).toEqual({ page: '', task: null, file: null });
  });
  it('reads the task open over a page', () => {
    expect(parseHash('#project/web/list?task=WEB-12')).toEqual({ page: 'project/web/list', task: 'WEB-12', file: null });
    expect(parseHash('settings?task=WEB-1')).toEqual({ page: 'settings', task: 'WEB-1', file: null });
  });
  it('reads a copied task or file link, which names no page', () => {
    expect(parseHash('#task/WEB-12')).toEqual({ page: '', task: 'WEB-12', file: null });
    expect(parseHash('#file/f_1')).toEqual({ page: '', task: null, file: 'f_1' });
  });
  it('drops what cannot be decoded, and an empty key', () => {
    expect(parseHash('#task/%E0%A4%A')).toEqual({ page: '', task: null, file: null });
    expect(parseHash('#home?task=')).toEqual({ page: 'home', task: null, file: null });
  });
  it('is undone by withTask', () => {
    for (const [page, key] of [
      ['project/web/board', 'WEB-12'],
      ['home', 'A B&C?'],
      ['mytasks', null],
    ])
      expect(parseHash('#' + withTask(page, key))).toEqual({ page, task: key, file: null });
    expect(withTask('home', null)).toBe('home');
  });
});
