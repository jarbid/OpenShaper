import { describe, expect, it } from 'vitest';
import { decideImport } from './file-io';
import type { ImportWarning } from '@openshaper/io';

const info: ImportWarning = { severity: 'info', message: 'fell back' };
const dropped: ImportWarning = { severity: 'dropped', message: 'removed a section' };

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
