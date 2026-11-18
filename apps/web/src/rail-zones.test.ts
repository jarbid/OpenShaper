// SPDX-License-Identifier: GPL-3.0-or-later
import { RAIL_ZONE_COLORS } from '@openshaper/render3d/patches';
import type { RailKey } from '@openshaper/store/rails';
import { describe, expect, it } from 'vitest';
import {
  isLinked,
  NO_RAIL_ZONES,
  railZonesForView,
  zonesOfKeys,
  zonesOfSide,
  type Rails,
} from './rail-zones';

const rail = (apex: number) => ({
  band: 2,
  hardness: 0.5,
  tuck: 1.4,
  tuckShape: 0.45,
  bottomEdge: 0,
  deckEdge: 0,
  apex,
});
const key = (x: number, apex: number): RailKey => ({ x, rail: rail(apex) });
/** A zone from 10 to 30 (two equal keys), a blend, a zone of no length at 80. */
const KEYS: RailKey[] = [key(10, 0.5), key(30, 0.5), key(80, 0.3)];

describe('zones of a side', () => {
  it('reads the keys as zones and blends, and holds the same arrays for the same keys', () => {
    const side = zonesOfKeys(KEYS);
    expect(side.zones.map((z) => [z.from, z.to])).toEqual([
      [10, 30],
      [80, 80],
    ]);
    expect(side.blends.map((b) => [b.from, b.to])).toEqual([[30, 80]]);
    expect(zonesOfKeys(KEYS)).toBe(side);
  });

  it('gives a board with no minus side the plus side on both', () => {
    const rails: Rails = { plus: KEYS };
    expect(zonesOfSide(rails, 'minus')).toBe(zonesOfSide(rails, 'plus'));
  });

  it('gives each side of a board its own', () => {
    const rails: Rails = { plus: KEYS, minus: [key(50, 0.5)] };
    expect(zonesOfSide(rails, 'minus').zones).toHaveLength(1);
    expect(zonesOfSide(rails, 'plus').zones).toHaveLength(2);
  });

  it('says the sides are linked when there is no minus side or its keys are the same', () => {
    expect(isLinked({ plus: KEYS })).toBe(true);
    expect(isLinked({ plus: KEYS, minus: [...KEYS] })).toBe(true);
    expect(isLinked({ plus: KEYS, minus: [key(50, 0.5)] })).toBe(false);
  });
});

describe('zones for the 3D board', () => {
  it('colours each zone by its index along its side, from the palette the board uses', () => {
    const zones = railZonesForView({ plus: KEYS });
    expect(zones.plus.map((z) => [z.from, z.to, z.color])).toEqual([
      [10, 30, RAIL_ZONE_COLORS[0]],
      [80, 80, RAIL_ZONE_COLORS[1]],
    ]);
    // one list for both sides on a board whose sides are one
    expect(zones.minus).toBe(zones.plus);
  });

  it('gives each side its own list when the board has two, and the same value for the same rails', () => {
    const rails: Rails = { plus: KEYS, minus: [key(50, 0.5)] };
    const zones = railZonesForView(rails);
    expect(zones.minus).toHaveLength(1);
    expect(zones.minus).not.toBe(zones.plus);
    expect(railZonesForView(rails)).toBe(zones);
  });

  it('has an empty value for no board', () => {
    expect(NO_RAIL_ZONES).toEqual({ plus: [], minus: [] });
  });
});
