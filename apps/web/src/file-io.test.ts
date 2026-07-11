import { describe, expect, it } from 'vitest';
import { decideImport, slugifyName } from './file-io';
import type { ImportWarning } from '@openshaper/io';

const info: ImportWarning = { severity: 'info', message: 'fell back' };
const dropped: ImportWarning = { severity: 'dropped', message: 'removed a section' };

describe('slugifyName', () => {
  it('lowercases and hyphenates a board model name', () => {
    expect(slugifyName('My Fish 5\'10"')).toBe('my-fish-5-10');
  });

  it('collapses runs of punctuation and trims edge hyphens', () => {
    expect(slugifyName('  ~~Retro // Twin!  ')).toBe('retro-twin');
  });

  it('falls back to "board" for empty or symbol-only names', () => {
    expect(slugifyName(undefined)).toBe('board');
    expect(slugifyName('')).toBe('board');
    expect(slugifyName('☂☂')).toBe('board');
  });
});

describe('decideImport', () => {
  it('loads silently when there are no warnings', () => {
    expect(decideImport([])).toEqual({ action: 'load', dropped: [], info: [] });
  });

  it('loads (no confirm) when warnings are only informational', () => {
    const d = decideImport([info]);
    expect(d.action).toBe('load');
    expect(d.info).toEqual([info]);
    expect(d.dropped).toEqual([]);
  });

  it('requires confirmation when anything was dropped', () => {
    const d = decideImport([info, dropped]);
    expect(d.action).toBe('confirm');
    expect(d.dropped).toEqual([dropped]);
    expect(d.info).toEqual([info]);
  });
});
