// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * P42: the previous/next real-station lookups stay on real stations (index 1 to
 * length - 2) for any position. The audit read getPreviousCrossSectionIndex's
 * `index = size` branch as a way past the end; it is unreachable, because the
 * search starts from the nearest REAL station and only steps back. This pins that.
 */
import { describe, expect, it } from 'vitest';
import { splineFromKnots } from './bezier-spline';
import { board, getNextCrossSectionIndex, getPreviousCrossSectionIndex } from './board';
import { crossSection } from './cross-section';
import { knot } from './knot';
import { vec2 } from './vec2';

const line = (y: number) =>
  splineFromKnots([
    knot(vec2(0, y), vec2(-5, y), vec2(5, y)),
    knot(vec2(100, y), vec2(95, y), vec2(105, y)),
  ]);
const prof = splineFromKnots([
  knot(vec2(0, 1), vec2(0, 1), vec2(5, 1)),
  knot(vec2(10, 3), vec2(10, 2), vec2(10, 3)),
]);
const b = board(
  line(10),
  line(1),
  line(7),
  [0, 30, 60, 100].map((p) => crossSection(p, prof)),
);

describe('real-station lookups (P42)', () => {
  it('previous stays on a real station past the nose and before the tail', () => {
    expect(getPreviousCrossSectionIndex(b, 150)).toBe(2);
    expect(getPreviousCrossSectionIndex(b, -5)).toBe(1);
  });

  it('is unchanged inside the board', () => {
    expect(getPreviousCrossSectionIndex(b, 45)).toBe(1);
    expect(getNextCrossSectionIndex(b, 45)).toBe(2);
    expect(getNextCrossSectionIndex(b, 150)).toBe(2);
  });
});
