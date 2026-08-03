// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { clampSectionIndex } from './section-index';

// `sectionCount` counts ALL cross-sections, including the nose/tail dummies at
// index 0 and the last index. Real, selectable stations are 1..count-2.
describe('clampSectionIndex', () => {
  it('leaves a valid index alone', () => {
    expect(clampSectionIndex(2, 6)).toBe(2);
  });

  it('clamps down when the active station is deleted', () => {
    // 6 sections → real 1..4. Delete one: 5 sections → real 1..3.
    expect(clampSectionIndex(4, 5)).toBe(3);
  });

  it('never selects a nose/tail dummy', () => {
    expect(clampSectionIndex(0, 6)).toBe(1);
    expect(clampSectionIndex(-3, 6)).toBe(1);
  });

  it('degrades to 1 for a board with no real stations', () => {
    expect(clampSectionIndex(3, 2)).toBe(1);
    expect(clampSectionIndex(3, 0)).toBe(1);
  });

  it('is stable when a station is added', () => {
    expect(clampSectionIndex(3, 6)).toBe(3);
    expect(clampSectionIndex(3, 7)).toBe(3);
  });
});
