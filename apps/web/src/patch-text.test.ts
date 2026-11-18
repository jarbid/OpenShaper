// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { fmtLen, lengthUnitByKey } from './format';
import {
  MAX_ZONES,
  PATCH_COLORS,
  RAIL_NO_ZONES_COLOR,
  RAIL_ZONE_COLORS,
} from '@openshaper/render3d/patches';
import { zonesAt } from './test/zones-at';
import { patchKeyEntries, patchPhrase, sideWord } from './patch-text';

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

describe('the key to the Patches look', () => {
  const labels = (keys: Parameters<typeof zonesAt>[0]) =>
    patchKeyEntries(zonesAt(keys)).map((e) => e.label);

  it('lists the deck, the bottom, a rail per zone from the tail, the tail edge and the corner', () => {
    expect(labels({ plus: [10, 50, 90] })).toEqual([
      'Deck',
      'Bottom',
      'Rail zone 1',
      'Rail zone 2',
      'Rail zone 3',
      'Tail edge',
      'Corner',
    ]);
  });

  it('colours each line as the 3D view does: from the palette module and the zones it is given', () => {
    const zones = zonesAt({ plus: [10, 50, 90, 120] });
    const entries = patchKeyEntries(zones);
    const color = (id: string) => entries.find((e) => e.id === id)?.color;
    expect(color('deck')).toBe(PATCH_COLORS.deck);
    expect(color('bottom')).toBe(PATCH_COLORS.bottom);
    expect(color('tailEdge')).toBe(PATCH_COLORS.tailEdge);
    expect(color('corner')).toBe(PATCH_COLORS.corner);
    zones.plus.forEach((zone, i) => expect(color(`rail-${i}`)).toBe(zone.color));
    expect(color('rail-0')).toBe(RAIL_ZONE_COLORS[0]);
  });

  it('has one plain "Rail", in the no-zones colour, for a board with no zones', () => {
    const entries = patchKeyEntries(zonesAt(null));
    expect(entries.map((e) => e.label)).toEqual(['Deck', 'Bottom', 'Rail', 'Tail edge', 'Corner']);
    expect(entries.find((e) => e.id === 'rail')?.color).toBe(RAIL_NO_ZONES_COLOR);
  });

  it('says "Rail zone 1" for a single zone, and takes the longer side of an asymmetric board', () => {
    expect(labels({ plus: [20] })).toContain('Rail zone 1');
    expect(labels({ plus: [20] })).not.toContain('Rail');
    expect(
      labels({ plus: [10, 50], minus: [10, 50, 90] }).filter((l) => l.startsWith('Rail')),
    ).toEqual(['Rail zone 1', 'Rail zone 2', 'Rail zone 3']);
  });

  it('lists no more zones than the view paints', () => {
    const keys = { plus: Array.from({ length: MAX_ZONES + 5 }, (_, i) => i * 4) };
    expect(patchKeyEntries(zonesAt(keys)).filter((e) => e.id.startsWith('rail-'))).toHaveLength(
      MAX_ZONES,
    );
  });

  it('gives every line an id of its own', () => {
    const ids = patchKeyEntries(zonesAt({ plus: [1, 2, 3, 4, 5, 6, 7, 8, 9] })).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
