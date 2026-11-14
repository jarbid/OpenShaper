// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { fmtLen, lengthUnitByKey } from './format';
import { patchPhrase, sideWord } from './patch-text';

const L = (cm: number): string => fmtLen(cm, lengthUnitByKey('cm'));

describe('what a tap chose, in words', () => {
  it('names the patch and the place, in the display unit', () => {
    const at = (units: string) =>
      patchPhrase({ patch: 'deck', side: 'plus', x: 112, y: 3 }, lengthUnitByKey(units));
    expect(at('cm')).toBe(`Deck, ${fmtLen(112, lengthUnitByKey('cm'))} from the tail`);
    expect(at('mm')).toBe(`Deck, ${fmtLen(112, lengthUnitByKey('mm'))} from the tail`);
    expect(at('mm')).not.toBe(at('ftin'));
    expect(at('ftin')).toContain("3' ");
  });

  it('says which side a rail is on, a zone or a blend, counting zones from one', () => {
    const cm = lengthUnitByKey('cm');
    expect(patchPhrase({ patch: 'rail', side: 'plus', x: 112, y: 9, zone: 1 }, cm)).toBe(
      `Rail, left side, zone 2, ${L(112)} from the tail`,
    );
    expect(patchPhrase({ patch: 'rail', side: 'minus', x: 50, y: -9, blend: 0 }, cm)).toBe(
      `Rail, right side, blend between zones 1 and 2, ${L(50)} from the tail`,
    );
    expect(patchPhrase({ patch: 'rail', side: 'minus', x: 50, y: -9 }, cm)).toBe(
      `Rail, right side, ${L(50)} from the tail`,
    );
  });

  it('names the other patches', () => {
    const cm = lengthUnitByKey('cm');
    const base = { side: 'plus', x: 4, y: 1 } as const;
    expect(patchPhrase({ ...base, patch: 'bottom' }, cm)).toBe(`Bottom, ${L(4)} from the tail`);
    expect(patchPhrase({ ...base, patch: 'tailEdge' }, cm)).toBe(
      `Tail edge, ${L(4)} from the tail`,
    );
    expect(patchPhrase({ ...base, patch: 'corner' }, cm)).toBe(`Corner, ${L(4)} from the tail`);
  });

  it('calls the plus side the left, seen from the tail looking to the nose', () => {
    expect(sideWord('plus')).toBe('left');
    expect(sideWord('minus')).toBe('right');
  });
});
