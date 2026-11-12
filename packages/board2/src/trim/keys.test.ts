// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Rail keys to laws: the interpolation along the board passes through its keys, is held flat
 * outside them and never overshoots between two, and the laws of a loop come from the side of
 * the board each sample lies on.
 */
import { describe, expect, it } from 'vitest';
import type { RailKey } from './board';
import { lawsFromKeys, railsAlong } from './keys';
import type { RailLawsAlong } from './keys';
import { buildLoop } from './loop';
import type { Loop } from './loop';
import { railLaws } from './rails';
import type { RailRecipe } from './rails';

const BASE: RailRecipe = {
  band: 4,
  hardness: 0.5,
  tuck: 3,
  tuckShape: 0.5,
  bottomEdge: 0,
  deckEdge: 0,
  apex: 0.5,
};
const key = (x: number, rail: Partial<RailRecipe>): RailKey => ({ x, rail: { ...BASE, ...rail } });
const NAMES = Object.keys(BASE) as (keyof RailRecipe)[];

/** A slab 120 long and 40 wide with its tail at x = 0. */
function slab(): Loop {
  const d = 20;
  const side = new Float64Array(2 * 201);
  const back = new Float64Array(2 * 201);
  const edge = new Float64Array(2 * 41);
  const nose = new Float64Array(2 * 41);
  for (let i = 0; i <= 200; i++) {
    side[2 * i] = 120 - (120 * i) / 200;
    side[2 * i + 1] = d;
    back[2 * i] = (120 * i) / 200;
    back[2 * i + 1] = -d;
  }
  for (let i = 0; i <= 40; i++) {
    edge[2 * i] = 0;
    edge[2 * i + 1] = d - (2 * d * i) / 40;
    nose[2 * i] = 120;
    nose[2 * i + 1] = -d + (2 * d * i) / 40;
  }
  return buildLoop({
    pieces: [
      { pts: side, kind: 0 },
      { pts: edge, kind: 1 },
      { pts: back, kind: 0 },
      { pts: nose, kind: 1 },
    ],
    corners: [1.5, 1.5, 1.5, 1.5],
  });
}

describe('railsAlong', () => {
  const keys = [
    key(10, { band: 2, tuck: 1 }),
    key(40, { band: 5, tuck: 1 }),
    key(70, { band: 6, tuck: 4 }),
    key(100, { band: 3, tuck: 2 }),
  ];
  const along = railsAlong(keys);

  it('passes through its keys', () => {
    for (const k of keys) for (const n of NAMES) expect(along[n](k.x)).toBeCloseTo(k.rail[n], 12);
  });

  it('is held flat outside the keys', () => {
    for (const n of NAMES) {
      expect(along[n](-50)).toBe(keys[0]!.rail[n]);
      expect(along[n](0)).toBe(keys[0]!.rail[n]);
      expect(along[n](100.5)).toBe(keys[3]!.rail[n]);
      expect(along[n](900)).toBe(keys[3]!.rail[n]);
    }
  });

  it('stays between two keys and never overshoots', () => {
    const rising = railsAlong([key(0, { band: 1 }), key(50, { band: 7 })]);
    let last = rising.band(0);
    for (let x = 0; x <= 50; x += 0.5) {
      const v = rising.band(x);
      expect(v).toBeGreaterThanOrEqual(last - 1e-12);
      expect(v).toBeGreaterThanOrEqual(1 - 1e-12);
      expect(v).toBeLessThanOrEqual(7 + 1e-12);
      last = v;
    }
    // a peak at a key is held there, not overshot
    for (let x = 40; x <= 70; x += 0.5) expect(along.band(x)).toBeLessThanOrEqual(6 + 1e-12);
  });

  it('is constant for one key', () => {
    const one = railsAlong([key(33, { band: 2.5, apex: 0.2 })]);
    for (const x of [-10, 0, 33, 80]) {
      expect(one.band(x)).toBe(2.5);
      expect(one.apex(x)).toBe(0.2);
      expect(one.tuck(x)).toBe(BASE.tuck);
    }
  });
});

describe('lawsFromKeys', () => {
  const loop = slab();
  const plus: RailLawsAlong = railsAlong([
    key(0, { band: 4, tuck: 3 }),
    key(120, { band: 5, tuck: 2 }),
  ]);
  const minus: RailLawsAlong = railsAlong([
    key(0, { band: 2, tuck: 1.5 }),
    key(120, { band: 2.5, tuck: 1 }),
  ]);

  it('takes the plus laws where y >= 0 and the minus laws elsewhere', () => {
    const got = lawsFromKeys(loop, plus, minus);
    const want = railLaws(loop, (i) => {
      const l = loop.y[i]! >= 0 ? plus : minus;
      const x = loop.x[i]!;
      return {
        band: l.band(x),
        hardness: l.hardness(x),
        tuck: l.tuck(x),
        tuckShape: l.tuckShape(x),
        bottomEdge: l.bottomEdge(x),
        deckEdge: l.deckEdge(x),
        apex: l.apex(x),
      };
    });
    for (const name of Object.keys(want) as (keyof typeof want)[]) {
      expect(Array.from(got[name])).toEqual(Array.from(want[name]));
    }
  });

  it('gives the two sides different widths when their keys differ', () => {
    const got = lawsFromKeys(loop, plus, minus);
    const onPlus = loop.y.findIndex(
      (y, i) => i < loop.n && y > 19 && loop.x[i]! > 55 && loop.x[i]! < 65,
    );
    const onMinus = loop.y.findIndex(
      (y, i) => i < loop.n && y < -19 && loop.x[i]! > 55 && loop.x[i]! < 65,
    );
    expect(onPlus).toBeGreaterThanOrEqual(0);
    expect(onMinus).toBeGreaterThanOrEqual(0);
    expect(got.deckWidth[onPlus]!).toBeGreaterThan(got.deckWidth[onMinus]! + 0.5);
    const mirrored = lawsFromKeys(loop, plus, plus);
    expect(mirrored.deckWidth[onMinus]!).toBeGreaterThan(got.deckWidth[onMinus]! + 0.5);
  });
});
