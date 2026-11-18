// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The dials: how each maps onto the rail's numbers, the round trip, the ranges, the labels, and
 * that the other four numbers are never touched.
 */
import { describe, expect, it } from 'vitest';
import { DIAL_RANGES, apexLabel, applyDials, dialsOf } from './dials';
import { between, rail, seeded } from './test-support/zone-kit';
import type { RailRecipe } from './types';
import { RAIL_LIMITS } from './zones';

const OTHERS = ['band', 'hardness', 'tuckShape', 'deckEdge'] as const;

/** A rail whose three dial numbers lie inside the dial ranges, the others anywhere. */
function insideRanges(rng: () => number): RailRecipe {
  return rail({
    band: between(rng, 0.1, 4),
    hardness: between(rng, 0.1, 0.9),
    tuck: between(rng, DIAL_RANGES.tuck[0], DIAL_RANGES.tuck[1]),
    tuckShape: between(rng, 0.1, 0.9),
    bottomEdge: between(rng, DIAL_RANGES.edge[0], DIAL_RANGES.edge[1]),
    deckEdge: between(rng, 0, 30),
    apex: between(rng, DIAL_RANGES.apex[1], DIAL_RANGES.apex[0]),
  });
}

describe('DIAL_RANGES', () => {
  it('run in the order each dial is read, inside what the engine allows', () => {
    expect(DIAL_RANGES.apex).toEqual([0.6, 0.2]);
    expect(DIAL_RANGES.tuck).toEqual([RAIL_LIMITS.tuck[0], 4]);
    expect(DIAL_RANGES.edge).toEqual([0, 60]);
    const within = (r: readonly [number, number], l: readonly [number, number]): boolean =>
      Math.min(...r) >= l[0] && Math.max(...r) <= l[1];
    expect(within(DIAL_RANGES.apex, RAIL_LIMITS.apex)).toBe(true);
    expect(within(DIAL_RANGES.tuck, RAIL_LIMITS.tuck)).toBe(true);
    expect(within(DIAL_RANGES.edge, RAIL_LIMITS.bottomEdge)).toBe(true);
  });
});

describe('dialsOf', () => {
  it('is the three numbers themselves, in cm and degrees, whatever they are', () => {
    expect(dialsOf(rail({ apex: 0.4, tuck: 1.2, bottomEdge: 10 }))).toEqual({
      apex: 0.4,
      tuck: 1.2,
      edge: 10,
    });
    expect(dialsOf(rail({ apex: 0.756, tuck: 9, bottomEdge: 80 }))).toEqual({
      apex: 0.756,
      tuck: 9,
      edge: 80,
    });
  });
});

describe('applyDials', () => {
  it('round-trips: dialsOf then applyDials is the rail, inside the ranges or not', () => {
    const rng = seeded(21);
    for (let i = 0; i < 200; i++) {
      const r = insideRanges(rng);
      expect(applyDials(r, dialsOf(r))).toEqual(r);
      expect(applyDials(r, dialsOf(r))).toBe(r);
    }
    // a converted rail outside the ranges keeps its own numbers until a dial is moved
    const converted = rail({ apex: 0.756, tuck: 0.03, bottomEdge: 75, band: 0.1 });
    expect(applyDials(converted, dialsOf(converted))).toBe(converted);
    expect(applyDials(converted, {})).toBe(converted);
    const edged = applyDials(converted, { edge: 40 });
    expect(edged.bottomEdge).toBe(40);
    expect(edged.apex).toBe(0.756);
    expect(edged.tuck).toBe(0.03);
    // moving the dial that is out of range brings that number into range
    expect(applyDials(converted, { apex: 0.7 }).apex).toBe(DIAL_RANGES.apex[0]);
  });

  it('sets each dial on its number and holds it to its range', () => {
    const r = rail({ apex: 0.5, tuck: 1.4, bottomEdge: 0 });
    expect(applyDials(r, { apex: 0.35 }).apex).toBe(0.35);
    expect(applyDials(r, { tuck: 2.5 }).tuck).toBe(2.5);
    expect(applyDials(r, { edge: 25 }).bottomEdge).toBe(25);
    expect(applyDials(r, { apex: 0.9 }).apex).toBe(0.6);
    expect(applyDials(r, { apex: 0.05 }).apex).toBe(0.2);
    expect(applyDials(r, { tuck: 100 }).tuck).toBe(4);
    expect(applyDials(r, { tuck: 0 }).tuck).toBe(RAIL_LIMITS.tuck[0]);
    expect(applyDials(r, { edge: 90 }).bottomEdge).toBe(60);
    expect(applyDials(r, { edge: -5 }).bottomEdge).toBe(0);
    const all = applyDials(r, { apex: 0.3, tuck: 3, edge: 50 });
    expect([all.apex, all.tuck, all.bottomEdge]).toEqual([0.3, 3, 50]);
  });

  it('leaves the other four numbers as they were, whatever the dials do', () => {
    const rng = seeded(5);
    for (let i = 0; i < 300; i++) {
      const r = insideRanges(rng);
      const next = applyDials(r, {
        apex: between(rng, -1, 2),
        tuck: between(rng, -2, 9),
        edge: between(rng, -30, 120),
      });
      for (const name of OTHERS) expect(next[name]).toBe(r[name]);
      expect(next.apex).toBeGreaterThanOrEqual(0.2);
      expect(next.apex).toBeLessThanOrEqual(0.6);
      expect(next.tuck).toBeGreaterThanOrEqual(DIAL_RANGES.tuck[0]);
      expect(next.tuck).toBeLessThanOrEqual(4);
      expect(next.bottomEdge).toBeGreaterThanOrEqual(0);
      expect(next.bottomEdge).toBeLessThanOrEqual(60);
    }
  });

  it('only changes the dials it is given, and returns the rail itself for no change', () => {
    const r = rail({ apex: 0.4, tuck: 1.2, bottomEdge: 10 });
    expect(applyDials(r, { tuck: 2 })).toEqual({ ...r, tuck: 2 });
    expect(applyDials(r, { tuck: 1.2 })).toBe(r);
    expect(applyDials(r, { apex: undefined })).toBe(r);
  });

  it('does not set a dial to something that is not a number', () => {
    const r = rail({ apex: 0.4, tuck: 1.2, bottomEdge: 10 });
    for (const v of [Number.NaN, Infinity, -Infinity]) {
      expect(applyDials(r, { apex: v, tuck: v, edge: v })).toBe(r);
    }
    expect(applyDials(r, { apex: '0.3' as unknown as number })).toBe(r);
  });

  it('does not change its argument', () => {
    const r = Object.freeze(rail({ apex: 0.4 }));
    expect(() => applyDials(r, { apex: 0.3, tuck: 2, edge: 5 })).not.toThrow();
    expect(r.apex).toBe(0.4);
  });
});

describe('apexLabel', () => {
  it('reads the share of the wall above the apex to the share below, to the nearest ten', () => {
    expect(apexLabel(0.5)).toBe('50/50');
    expect(apexLabel(0.4)).toBe('60/40');
    expect(apexLabel(0.2)).toBe('80/20');
    expect(apexLabel(0.6)).toBe('40/60');
    expect(apexLabel(0.3)).toBe('70/30');
    expect(apexLabel(0.52)).toBe('50/50');
    expect(apexLabel(0.42)).toBe('60/40');
    expect(apexLabel(0.38)).toBe('60/40');
    expect(apexLabel(0.21)).toBe('80/20');
    expect(apexLabel(0.756)).toBe('20/80');
  });

  it('reads a share halfway between two tens as the more even, so 0.45 and 0.55 read alike', () => {
    expect(apexLabel(0.55)).toBe('50/50');
    expect(apexLabel(0.45)).toBe('50/50');
    expect(apexLabel(0.35)).toBe('60/40');
    expect(apexLabel(0.65)).toBe('40/60');
    expect(apexLabel(0.25)).toBe('70/30');
    expect(apexLabel(0.75)).toBe('30/70');
  });

  it('reads the mid-board apex of the golden boards (0.52 to 0.55) as 50/50', () => {
    for (const apex of [0.52, 0.53, 0.54, 0.55]) expect(apexLabel(apex)).toBe('50/50');
  });

  it('always gives two shares of 100, and reads an apex off the wall as the end it is past', () => {
    for (let i = -20; i <= 120; i++) {
      const [a, b] = apexLabel(i / 100)
        .split('/')
        .map(Number);
      expect(a! + b!).toBe(100);
      expect(a! % 10).toBe(0);
    }
    expect(apexLabel(-1)).toBe('100/0');
    expect(apexLabel(2)).toBe('0/100');
    expect(apexLabel(0)).toBe('100/0');
    expect(apexLabel(1)).toBe('0/100');
    expect(apexLabel(Number.NaN)).toBe('50/50');
    expect(apexLabel(Infinity)).toBe('50/50');
  });

  it('moves one way only as the apex rises: the share above never grows', () => {
    let last = 100;
    for (let i = 0; i <= 100; i++) {
      const above = Number(apexLabel(i / 100).split('/')[0]);
      expect(above).toBeLessThanOrEqual(last);
      last = above;
    }
  });
});
