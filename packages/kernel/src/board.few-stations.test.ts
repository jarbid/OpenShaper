/**
 * P32: a board with no real stations (two or fewer cross-sections, only reachable
 * through imported files) must not crash the readouts.
 */
import { describe, expect, it } from 'vitest';
import {
  board,
  crossSection,
  getCrossSectionAreaAt,
  getInterpolatedCrossSection,
  getVolume,
  knot,
  splineFromKnots,
  vec2,
} from './index';

const line = (y: number) =>
  splineFromKnots([
    knot(vec2(0, y), vec2(-5, y), vec2(5, y)),
    knot(vec2(100, y), vec2(95, y), vec2(105, y)),
  ]);
const prof = splineFromKnots([
  knot(vec2(0, 2), vec2(0, 2), vec2(10, 2)),
  knot(vec2(10, 5), vec2(10, 3), vec2(10, 5)),
]);

describe('boards with no real stations (P32)', () => {
  it.each([
    ['one station', [50]],
    ['two stations', [20, 80]],
  ])('%s: no interpolated section, zero area and volume, no throw', (_, positions) => {
    const b = board(
      line(10),
      line(2),
      line(8),
      positions.map((p) => crossSection(p, prof)),
    );
    for (const x of [5, 50, 95]) {
      expect(getInterpolatedCrossSection(b, x)).toBeNull();
      expect(getCrossSectionAreaAt(b, x, 10)).toBe(0);
    }
    expect(getVolume(b)).toBe(0);
  });
});
