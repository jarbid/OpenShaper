// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * P31: the board's widest point scans every outline segment. Legacy `getMaxWidth`
 * skipped the last one, so a single-segment outline had no width (-Infinity) and a
 * widest point in the last segment was missed. Analytic oracle: straight segments,
 * whose max y is their larger endpoint. See docs/specs/divergences.md.
 */
import { describe, expect, it } from 'vitest';
import { maxY } from './bezier-spline';
import { board, getMaxWidth } from './board';
import { crossSection } from './cross-section';
import { knot } from './knot';
import { splineFromKnots } from './bezier-spline';
import { vec2 } from './vec2';

/** A straight polyline outline: each segment's handles sit on its chord. */
const straight = (pts: [number, number][]) =>
  splineFromKnots(
    pts.map(([x, y], i) => {
      const prev = pts[i - 1] ?? pts[i]!;
      const next = pts[i + 1] ?? pts[i]!;
      return knot(
        vec2(x, y),
        vec2(x + (prev[0] - x) / 3, y + (prev[1] - y) / 3),
        vec2(x + (next[0] - x) / 3, y + (next[1] - y) / 3),
      );
    }),
  );

const withOutline = (outline: ReturnType<typeof straight>) => {
  const line = (y: number) =>
    straight([
      [0, y],
      [100, y],
    ]);
  const prof = straight([
    [0, 1],
    [10, 3],
  ]);
  return board(outline, line(1), line(7), [
    crossSection(0, prof),
    crossSection(50, prof),
    crossSection(100, prof),
  ]);
};

describe('getMaxWidth over every segment (P31)', () => {
  it('a single-segment outline has its real width, not -Infinity', () => {
    const b = withOutline(
      straight([
        [0, 10],
        [100, 10],
      ]),
    );
    expect(getMaxWidth(b)).toBeCloseTo(20, 9);
  });

  it('finds a widest point in the last segment', () => {
    const outline = straight([
      [0, 5],
      [50, 10],
      [100, 20],
    ]);
    // To the numerical max search's resolution (~1e-4 cm), not machine precision.
    expect(getMaxWidth(withOutline(outline))).toBeCloseTo(40, 3);
    // The legacy scan (kept as maxY for the cross-section matching) stops short.
    expect(maxY(outline)).toBeCloseTo(10, 3);
  });
});
