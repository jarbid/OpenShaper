// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { crossSection, interpolateCrossSection } from './cross-section';
import { knotFromArray } from './knot';
import { splineFromKnots } from './bezier-spline';

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = resolve(here, '../../../docs/specs/golden');

// Each knot is [endX, endY, prevX, prevY, nextX, nextY] (legacy getPoints order).
type GKnot = [number, number, number, number, number, number];
interface MorphCase {
  t: number;
  knots: GKnot[];
}
interface Morph {
  sourceKnots: GKnot[];
  targetKnots: GKnot[];
  cases: MorphCase[];
}
const golden: { morph: Morph } = JSON.parse(
  readFileSync(resolve(goldenDir, 'interp.golden.json'), 'utf8'),
);

const sectionFrom = (knots: GKnot[]) =>
  crossSection(0, splineFromKnots(knots.map((k) => knotFromArray(k))));

// Morph involves chained de Casteljau splits + root-found closest-t; the legacy used
// 32→…-split recursion. 1e-4 cm covers float-order differences in those searches.
const TOL = 1e-4;

describe('interpolateCrossSection morph vs legacy golden (differing CP counts)', () => {
  const source = sectionFrom(golden.morph.sourceKnots);
  const target = sectionFrom(golden.morph.targetKnots);

  it('source has more control points than target (exercises the morph path)', () => {
    expect(golden.morph.sourceKnots.length).not.toBe(golden.morph.targetKnots.length);
  });

  for (const c of golden.morph.cases) {
    it(`t=${c.t}: matches legacy knots`, () => {
      const result = interpolateCrossSection(source, target, c.t);
      const knots = result.spline.knots;
      expect(knots.length).toBe(c.knots.length);
      knots.forEach((k, i) => {
        const g = c.knots[i]!;
        expect(Math.abs(k.end.x - g[0])).toBeLessThanOrEqual(TOL);
        expect(Math.abs(k.end.y - g[1])).toBeLessThanOrEqual(TOL);
        expect(Math.abs(k.tangentToPrev.x - g[2])).toBeLessThanOrEqual(TOL);
        expect(Math.abs(k.tangentToPrev.y - g[3])).toBeLessThanOrEqual(TOL);
        expect(Math.abs(k.tangentToNext.x - g[4])).toBeLessThanOrEqual(TOL);
        expect(Math.abs(k.tangentToNext.y - g[5])).toBeLessThanOrEqual(TOL);
      });
    });
  }
});

// A knot array shorter than two has no segment to split, so the count-matching
// morph can never make the counts agree. Reached in the wild from an imported
// file whose cross-section carried a single control point: the resample walked
// off the end of the array and threw on every redraw. The legacy bail (return
// the source clone) is the documented behaviour for "no valid insertion point",
// so these pin that the degenerate case takes it instead of crashing.
const flatKnot = (x: number, y: number): GKnot => [x, y, x - 1, y, x + 1, y];

describe('interpolateCrossSection with a degenerate section', () => {
  const full = sectionFrom([flatKnot(0, 0), flatKnot(5, 3), flatKnot(9, 6), flatKnot(10, 10)]);
  const single = sectionFrom([flatKnot(0, 0)]);
  const pair = sectionFrom([flatKnot(0, 0), flatKnot(10, 10)]);

  it('bails to the source when the target has a single control point', () => {
    const out = interpolateCrossSection(full, single, 0.5);
    expect(out.spline.knots).toEqual(full.spline.knots);
  });

  it('bails to the source when the source has a single control point', () => {
    const out = interpolateCrossSection(single, full, 0.5);
    expect(out.spline.knots).toEqual(single.spline.knots);
  });

  // Two knots leave no interior CP to match against, so the resample loop gives
  // up before inserting anything — the counts stay unequal on the way out.
  it('bails when the source has no interior control point to match', () => {
    const out = interpolateCrossSection(pair, single, 0.5);
    expect(out.spline.knots).toEqual(pair.spline.knots);
  });
});
