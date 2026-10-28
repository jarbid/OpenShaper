// SPDX-License-Identifier: GPL-3.0-or-later
/** The specialised cubic basis against geom's general one. */
import { basisDersInto, clampedBasis, createScratch } from '@openshaper/geom';
import { describe, expect, it } from 'vitest';
import { BASIS_SIZE, basisDers, spanOfKnots } from './bspline';
import { controlCount, sectionKnots } from './sections';

describe('cubic basis', () => {
  const m = 6;
  const knots = sectionKnots(m);
  const count = controlCount(m);
  const geomBasis = clampedBasis(3, knots);
  const sc = createScratch({ maxDegree: 3, maxDerivs: 2 });

  it('matches geom values and derivatives to order 2, and sums to a partition of unity', () => {
    const mine = new Float64Array(BASIS_SIZE);
    const theirs = new Float64Array(BASIS_SIZE);
    for (const t of [0, 0.01, 0.2, 0.4999, 0.5, 0.5001, 0.77, 0.999, 1]) {
      const span = spanOfKnots(knots, count, t, false);
      basisDers(knots, span, t, 2, mine);
      basisDersInto(geomBasis, span, t, 2, theirs, 0, sc);
      for (let k = 0; k < BASIS_SIZE; k++) expect(mine[k]).toBeCloseTo(theirs[k]!, 10);
      expect(mine[0]! + mine[1]! + mine[2]! + mine[3]!).toBeCloseTo(1, 12);
      expect(mine[4]! + mine[5]! + mine[6]! + mine[7]!).toBeCloseTo(0, 9);
    }
  });

  it('picks the right-hand span at the apex and the left-hand one on request', () => {
    expect(knots[spanOfKnots(knots, count, 0.5, false)]).toBe(0.5);
    const left = spanOfKnots(knots, count, 0.5, true);
    expect(knots[left]).toBeLessThan(0.5);
    expect(knots[left + 1]).toBe(0.5);
  });
});
