// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { makeTestBoard } from '../fixture.test-helper';
import { cuttingList } from './cutlist';
import { buildHwsTemplates } from './hws';

const board = makeTestBoard();

describe('cuttingList', () => {
  it('lists one row per part, in sheet order, with bbox dims and default count 1', () => {
    const sheet = buildHwsTemplates(board, { ribMode: 'evenCount', ribCount: 3 });
    const list = cuttingList(sheet);
    expect(list.map((i) => i.partId)).toEqual(sheet.parts.map((p) => p.id));
    for (const item of list) {
      expect(item.widthCm).toBeGreaterThan(0);
      expect(item.heightCm).toBeGreaterThan(0);
      expect(item.label.length).toBeGreaterThan(0);
    }
    const stringer = list.find((i) => i.partId === 'stringer')!;
    expect(stringer.count).toBe(1);
    // The stringer spans the board minus the two trimmed ends (endMargin = 8).
    expect(stringer.widthCm).toBeGreaterThan(80);
  });

  it('carries the rail-band multi-cut counts and totals pieces', () => {
    const sheet = buildHwsTemplates(board, {
      ribMode: 'evenCount',
      ribCount: 3,
      railLaminations: 4,
      railStripThickness: 0.5,
    });
    const list = cuttingList(sheet);
    expect(list.find((i) => i.partId === 'rail-band')!.count).toBe(8);
    const pieces = list.reduce((s, i) => s + i.count, 0);
    // stringer + 3 ribs + 2 skins + 8 band strips
    expect(pieces).toBe(1 + 3 + 2 + 8);
  });
});
