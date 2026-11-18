// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Reading keys as zones and blends: the constants, `railZones`, `zoneIndexAt`, `railDistance`
 * and `railAt`, on small hand-made lists and on the converted test boards.
 */
import { describe, expect, it } from 'vitest';
import { railsBoards } from './test-support/boards';
import { between, key, rail, randomRail, seeded } from './test-support/zone-kit';
import type { RailKey } from './types';
import {
  RAIL_LIMITS,
  RAIL_NUMBERS,
  ZONE_MIN_GAP,
  ZONE_SCALES,
  railAt,
  railDistance,
  railZones,
  zoneIndexAt,
} from './zones';

const A = { band: 2, apex: 0.5 };
const B = { band: 1, apex: 0.4 };

describe('the constants', () => {
  it('give every number a scale and a range, and the gap is a positive distance', () => {
    expect(ZONE_MIN_GAP).toBeGreaterThan(0);
    for (const name of RAIL_NUMBERS) {
      expect(ZONE_SCALES[name]).toBeGreaterThan(0);
      expect(RAIL_LIMITS[name][0]).toBeLessThan(RAIL_LIMITS[name][1]);
    }
  });
});

describe('railZones', () => {
  it('reads a converted board as a zone of no length at each key, with a blend between each pair', () => {
    for (const [name, make] of railsBoards) {
      const sides = make().rails;
      for (const keys of [sides.plus, sides.minus ?? []]) {
        const { zones, blends } = railZones(keys);
        expect(zones, name).toHaveLength(keys.length);
        expect(blends, name).toHaveLength(Math.max(0, keys.length - 1));
        zones.forEach((z, i) => {
          expect([z.first, z.last]).toEqual([i, i]);
          expect([z.from, z.to]).toEqual([keys[i]!.x, keys[i]!.x]);
          expect(z.rail).toBe(keys[i]!.rail);
        });
        blends.forEach((b, i) => {
          expect([b.before, b.after]).toEqual([i, i + 1]);
          expect([b.from, b.to]).toEqual([keys[i]!.x, keys[i + 1]!.x]);
        });
      }
    }
  });

  it('reads runs of equal keys as zones, a lone key as a zone of no length', () => {
    const keys = [key(0, A), key(10, A), key(20, B), key(30, A), key(40, A), key(50, A)];
    const { zones, blends } = railZones(keys);
    expect(zones.map((z) => [z.first, z.last, z.from, z.to])).toEqual([
      [0, 1, 0, 10],
      [2, 2, 20, 20],
      [3, 5, 30, 50],
    ]);
    expect(zones[0]!.rail).toBe(keys[0]!.rail);
    expect(blends).toEqual([
      { before: 0, after: 1, from: 10, to: 20 },
      { before: 1, after: 2, from: 20, to: 30 },
    ]);
  });

  it('treats keys that differ in any one number as different', () => {
    for (const name of RAIL_NUMBERS) {
      const a = rail();
      const keys: RailKey[] = [
        { x: 0, rail: a },
        { x: 5, rail: { ...a, [name]: a[name] + 1e-9 } },
      ];
      expect(railZones(keys).zones, name).toHaveLength(2);
    }
  });

  it('holds equal keys that are separate objects as one zone', () => {
    const { zones } = railZones([key(0, A), key(9, A)]);
    expect(zones).toHaveLength(1);
  });

  it('joins keys within a tolerance, each number in its own unit, the limit itself included', () => {
    const keys = [key(0, { band: 2 }), key(10, { band: 2.0625 }), key(20, { band: 2.25 })];
    expect(railZones(keys, 0.0625).zones.map((z) => [z.first, z.last])).toEqual([
      [0, 1],
      [2, 2],
    ]);
    expect(railZones(keys, 0.06).zones).toHaveLength(3);
    expect(railZones(keys, 0.25).zones.map((z) => [z.first, z.last])).toEqual([[0, 2]]);
    // numbers a binary fraction apart, so the difference is exactly the tolerance
    const base = rail({ band: 2, hardness: 0.5, tuck: 1.5, tuckShape: 0.5, apex: 0.5 });
    for (const name of RAIL_NUMBERS) {
      const pair = [
        { x: 0, rail: base },
        { x: 10, rail: { ...base, [name]: base[name] + 0.25 } },
      ];
      expect(railZones(pair, 0.25).zones, name).toHaveLength(1);
      expect(railZones(pair, 0.2).zones, name).toHaveLength(2);
    }
  });

  it('keeps every key of a run within the tolerance of every other, so a slow taper is not one run', () => {
    // each step is 0.6 and the tolerance 1: chaining neighbours would join all three
    const keys = [key(0, { band: 1 }), key(10, { band: 1.6 }), key(20, { band: 2.2 })];
    expect(railZones(keys, 1).zones.map((z) => [z.first, z.last])).toEqual([
      [0, 1],
      [2, 2],
    ]);
  });

  it('gives a run of unequal keys the mean of theirs, and a run of equal keys the first key rail itself', () => {
    const keys = [key(0, { band: 2 }), key(10, { band: 2.1 }), key(20, { band: 2.2 })];
    const { zones } = railZones(keys, 0.5);
    expect(zones).toHaveLength(1);
    expect(zones[0]!.rail.band).toBeCloseTo(2.1, 12);
    expect(zones[0]!.rail.apex).toBe(0.5);
    const same = [key(0, A), key(10, A)];
    expect(railZones(same, 0.5).zones[0]!.rail).toBe(same[0]!.rail);
  });

  it('reads a tolerance that is not a positive number as 0', () => {
    const keys = [key(0, A), key(10, { ...A, band: 2.0000001 })];
    for (const t of [0, -1, Number.NaN, Infinity, -Infinity]) {
      expect(railZones(keys, t).zones, String(t)).toHaveLength(2);
    }
  });

  it('is empty for no keys, and one zone for one key', () => {
    expect(railZones([])).toEqual({ zones: [], blends: [] });
    expect(railZones([key(3)]).zones).toHaveLength(1);
    expect(railZones([key(3)]).blends).toHaveLength(0);
  });

  it('never lets a key that is not a number join a zone', () => {
    const keys = [
      key(0, A),
      key(10, { ...A, band: Number.NaN }),
      key(20, { ...A, band: Number.NaN }),
    ];
    expect(railZones(keys).zones).toHaveLength(3);
    expect(railZones(keys, 5).zones).toHaveLength(3);
  });

  it('partitions any list of keys, at any tolerance: every key is in exactly one zone, in order', () => {
    const rng = seeded(11);
    for (let trial = 0; trial < 200; trial++) {
      const n = 1 + Math.floor(between(rng, 0, 9));
      const palette = [rail(), randomRail(rng), randomRail(rng)];
      const keys = Array.from({ length: n }, (_, i) => ({
        x: i * 3,
        rail: palette[Math.floor(between(rng, 0, 3))]!,
      }));
      for (const tol of [0, 0.01, 0.3, 2, 100]) {
        const { zones, blends } = railZones(keys, tol);
        expect(zones[0]!.first).toBe(0);
        expect(zones[zones.length - 1]!.last).toBe(n - 1);
        zones.forEach((z, i) => {
          expect(z.last).toBeGreaterThanOrEqual(z.first);
          if (i > 0) expect(z.first).toBe(zones[i - 1]!.last + 1);
        });
        expect(blends).toHaveLength(zones.length - 1);
      }
    }
  });
});

describe('zoneIndexAt', () => {
  const keys = [key(10, A), key(20, A), key(40, B), key(60, A)];
  it('finds the zone whose keys span a place', () => {
    expect(zoneIndexAt(keys, 10)).toBe(0);
    expect(zoneIndexAt(keys, 15)).toBe(0);
    expect(zoneIndexAt(keys, 20)).toBe(0);
    expect(zoneIndexAt(keys, 40)).toBe(1);
    expect(zoneIndexAt(keys, 60)).toBe(2);
  });
  it('finds the nearest zone for a place in a blend or beyond the ends, the earlier on a tie', () => {
    expect(zoneIndexAt(keys, 25)).toBe(0);
    expect(zoneIndexAt(keys, 35)).toBe(1);
    expect(zoneIndexAt(keys, 30)).toBe(0);
    expect(zoneIndexAt(keys, 50)).toBe(1);
    expect(zoneIndexAt(keys, -5)).toBe(0);
    expect(zoneIndexAt(keys, 500)).toBe(2);
  });
  it('is -1 with no key', () => {
    expect(zoneIndexAt([], 3)).toBe(-1);
  });
});

describe('railDistance', () => {
  it('is the largest difference of a number over its scale', () => {
    expect(railDistance(rail(), rail())).toBe(0);
    expect(railDistance(rail(), rail({ band: 2.3, apex: 0.45 }))).toBeCloseTo(0.3, 12);
    const a = rail({ bottomEdge: 10 });
    const b = rail({ bottomEdge: 14, tuck: 1.5 });
    expect(railDistance(a, b)).toBeCloseTo(4 / ZONE_SCALES.bottomEdge, 12);
    expect(railDistance(a, b)).toBe(railDistance(b, a));
  });
});

describe('railAt', () => {
  const keys = [key(10, A), key(20, A), key(40, B), key(60, { band: 3, apex: 0.6 })];

  it('reads a key own rail at its place', () => {
    for (const k of keys) expect(railAt(keys, k.x)).toEqual(k.rail);
  });

  it('holds the first and last rail flat outside the keys', () => {
    for (const x of [-100, 0, 9.999]) expect(railAt(keys, x)).toEqual(keys[0]!.rail);
    for (const x of [60.001, 100, 1e9]) expect(railAt(keys, x)).toEqual(keys[3]!.rail);
  });

  it('holds the rail flat between two equal keys, at every place', () => {
    for (let i = 0; i <= 100; i++) {
      expect(railAt(keys, 10 + i / 10)).toEqual(keys[0]!.rail);
    }
  });

  it('reads one key as that rail everywhere, and no key as zeros', () => {
    const one = [key(5, B)];
    for (const x of [-3, 5, 90]) expect(railAt(one, x)).toEqual(one[0]!.rail);
    expect(railAt([], 5)).toEqual({
      ...rail(),
      band: 0,
      hardness: 0,
      tuck: 0,
      tuckShape: 0,
      apex: 0,
    });
  });

  it('runs every number monotonically between two keys, never beyond either', () => {
    const rng = seeded(3);
    for (let trial = 0; trial < 150; trial++) {
      const n = 2 + Math.floor(between(rng, 0, 6));
      const list: RailKey[] = [];
      let x = between(rng, 0, 10);
      for (let i = 0; i < n; i++) {
        // some keys repeat the rail before them, as a zone does
        list.push({ x, rail: i > 0 && rng() < 0.3 ? list[i - 1]!.rail : randomRail(rng) });
        x += between(rng, 1, 30);
      }
      for (let i = 0; i + 1 < n; i++) {
        const a = list[i]!;
        const b = list[i + 1]!;
        for (const name of RAIL_NUMBERS) {
          const lo = Math.min(a.rail[name], b.rail[name]);
          const hi = Math.max(a.rail[name], b.rail[name]);
          const up = b.rail[name] >= a.rail[name];
          let last = a.rail[name];
          for (let s = 0; s <= 40; s++) {
            const v = railAt(list, a.x + ((b.x - a.x) * s) / 40)[name];
            expect(v).toBeGreaterThanOrEqual(lo - 1e-12);
            expect(v).toBeLessThanOrEqual(hi + 1e-12);
            if (up) expect(v).toBeGreaterThanOrEqual(last - 1e-12);
            else expect(v).toBeLessThanOrEqual(last + 1e-12);
            last = v;
          }
        }
      }
    }
  });

  it('eases into and out of a flat run: its slope is zero where the run ends', () => {
    // a rail that changes on one side of a flat run does not move at the run's end
    const list = [
      key(0, { band: 1 }),
      key(10, { band: 3 }),
      key(30, { band: 3 }),
      key(40, { band: 1 }),
    ];
    const e = 1e-4;
    for (const edge of [10, 30]) {
      const slope = Math.abs(railAt(list, edge + e).band - railAt(list, edge - e).band) / (2 * e);
      expect(slope).toBeLessThan(1e-3);
    }
  });
});
