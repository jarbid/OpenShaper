import { describe, expect, it } from 'vitest';
import { knot } from './knot';
import { splineFromKnots } from './bezier-spline';
import { referencePointArray } from './reference-point-array';
import { vec2 } from './vec2';

const line = splineFromKnots([
  knot(vec2(0, 0), vec2(0, 0), vec2(10, 10)),
  knot(vec2(30, 30), vec2(20, 20), vec2(30, 30)),
]);

describe('reference point arrays (intersection tolerance 1e-8 cm)', () => {
  it('spaces along the axis rather than curve length and omits partial end intervals', () => {
    const points = referencePointArray(line, 8);
    expect(points.map((p) => p.x)).toEqual([8, 16, 24]);
    for (const point of points) expect(Math.abs(point.y - point.x)).toBeLessThan(1e-8);
  });

  it('finds both sides of a returning curve and its exact interior x extremum', () => {
    const returning = splineFromKnots([
      knot(vec2(0, 0), vec2(0, 0), vec2(20, 3)),
      knot(vec2(0, 9), vec2(20, 6), vec2(0, 9)),
    ]);
    const points = referencePointArray(returning, 5);
    expect(points.map((p) => p.x)).toEqual([5, 5, 10, 10, 15]);
    for (const point of points) {
      // x(t) = 60t(1-t), y(t) = 9t for this cubic.
      const t = point.y / 9;
      expect(Math.abs(60 * t * (1 - t) - point.x)).toBeLessThan(1e-8);
    }
    expect(points.at(-1)!.y).toBeCloseTo(4.5, 8);
  });

  it('deduplicates shared knots on interval boundaries', () => {
    const joined = splineFromKnots([
      knot(vec2(0, 0), vec2(0, 0), vec2(5, 0)),
      knot(vec2(10, 0), vec2(5, 0), vec2(15, 0)),
      knot(vec2(20, 0), vec2(15, 0), vec2(20, 0)),
    ]);
    expect(referencePointArray(joined, 10)).toEqual([
      { x: 10, y: 0 },
      { x: 20, y: 0 },
    ]);
  });

  it.each([0, -1, NaN, Infinity, 0.000001])(
    'rejects invalid or excessive intervals: %s',
    (interval) => {
      expect(() => referencePointArray(line, interval)).toThrow();
    },
  );
});

it('spaces by bottom-rocker distance while intersecting the chosen curve', () => {
  const bottom = splineFromKnots([
    knot(vec2(0, 0), vec2(0, 0), vec2(100 / 3, 25)),
    knot(vec2(100, 75), vec2(200 / 3, 50), vec2(100, 75)),
  ]);
  const chosen = splineFromKnots([
    knot(vec2(0, 3), vec2(0, 3), vec2(100 / 3, 3)),
    knot(vec2(100, 3), vec2(200 / 3, 3), vec2(100, 3)),
  ]);
  const points = referencePointArray(chosen, 25, bottom);
  expect(points).toHaveLength(5);
  for (const [i, point] of points.entries()) {
    expect(point.x).toBeCloseTo((i + 1) * 20, 6);
    expect(point.y).toBeCloseTo(3, 8);
  }
});

it('does not add an origin point when the curve is shorter than the first interval', () => {
  expect(referencePointArray(line, 50)).toEqual([]);
});
