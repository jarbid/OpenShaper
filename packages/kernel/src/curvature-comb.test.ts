// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Curvature-comb analysis, pinned analytically: a near-circular arc (κ = 1/R), an
 * antisymmetric S-curve (one inflection at its centre), and the degenerate dummy segment
 * every bundled deck carries at its nose and tail.
 */
import { describe, expect, it } from 'vitest';
import {
  curvatureCombReference,
  curvatureCombRuns,
  curvatureInflections,
  type CombSample,
} from './curvature-comb';
import { knot } from './knot';
import { splineFromKnots } from './bezier-spline';
import { vec2, type Vec2 } from './vec2';

/** Quarter circle, radius R about the origin, counter-clockwise from (R,0) to (0,R). */
const H = 0.5522847498;
const quarter = (R: number, reverse = false) => {
  const knots = [
    knot(vec2(R, 0), vec2(R, -R * H), vec2(R, R * H)),
    knot(vec2(0, R), vec2(R * H, R), vec2(-R * H, R)),
  ];
  return splineFromKnots(
    reverse
      ? [
          knot(knots[1]!.end, knots[1]!.tangentToNext, knots[1]!.tangentToPrev),
          knot(knots[0]!.end, knots[0]!.tangentToNext, knots[0]!.tangentToPrev),
        ]
      : knots,
  );
};
const tip = (c: CombSample): Vec2 => ({ x: c.p.x + c.dir.x * c.k, y: c.p.y + c.dir.y * c.k });

describe('curvatureCombRuns', () => {
  it('reports κ = 1/R on a circular arc, positive when turning left', () => {
    const samples = curvatureCombRuns(quarter(10), 8).flat();
    expect(samples).toHaveLength(9);
    // The cubic quarter circle is within 3e-4 of round, but its curvature wanders ~2%.
    for (const s of samples) expect(Math.abs(s.k - 0.1) / 0.1).toBeLessThan(0.025);
  });

  it('puts quills on the convex side whichever way the curve runs', () => {
    for (const reverse of [false, true]) {
      for (const s of curvatureCombRuns(quarter(10, reverse), 4).flat()) {
        // Outward from the circle's centre: the tip is farther from the origin.
        expect(Math.hypot(tip(s).x, tip(s).y)).toBeGreaterThan(Math.hypot(s.p.x, s.p.y));
      }
    }
  });

  it('drops a zero-length dummy segment and splits the run instead of yielding NaN', () => {
    // Deck-style: a collapsed knot at the nose (all three points coincide).
    const s = splineFromKnots([
      knot(vec2(0, 0), vec2(0, 0), vec2(10, 5)),
      knot(vec2(30, 5), vec2(20, 5), vec2(30, 5)),
      knot(vec2(30, 5), vec2(30, 5), vec2(30, 5)),
    ]);
    const runs = curvatureCombRuns(s, 6);
    const all = runs.flat();
    expect(all.every((c) => [c.p.x, c.p.y, c.dir.x, c.dir.y, c.k].every(Number.isFinite))).toBe(
      true,
    );
    // Segment 0 is whole; segment 1 (end → collapsed nose) has no length and no samples.
    expect(all).toHaveLength(7);
    expect(all.every((c) => c.segment === 0)).toBe(true);
  });
});

describe('curvatureCombReference', () => {
  // Evenly spaced samples along x, so every sample carries the same length.
  const fake = (ks: number[], dx = (_i: number) => 1): CombSample[][] => {
    let x = 0;
    return [ks.map((k, i) => ({ p: vec2((x += dx(i)), 0), dir: vec2(0, 1), k, segment: 0, t: 0 }))];
  };

  it('is the 95th-percentile |κ|, so one spike cannot flatten the comb', () => {
    const ks = Array.from({ length: 100 }, (_, i) => (i % 2 ? 1 : -1) * (i + 1) * 0.01);
    ks[50] = 93; // a collapsed-handle spike, as on the bundled shortboard outline
    const ref = curvatureCombReference(fake(ks));
    expect(ref).toBeLessThan(1.01);
    expect(ref).toBeGreaterThan(0.9);
  });

  it('weights by length, so a short tight stretch cannot dominate', () => {
    // 50 samples of κ = 1 squeezed into 0.5 cm, then 50 of κ = 0.01 over 49 cm.
    const ks = [...Array<number>(50).fill(1), ...Array<number>(50).fill(0.01)];
    expect(curvatureCombReference(fake(ks, (i) => (i < 50 ? 0.01 : 1)))).toBe(0.01);
    // Unweighted (even spacing) the tight half would set the scale.
    expect(curvatureCombReference(fake(ks))).toBe(1);
  });

  it('is 0 with no samples', () => {
    expect(curvatureCombReference([])).toBe(0);
  });
});

describe('curvatureInflections', () => {
  // Point-symmetric about (15, 0): curvature is odd about the midpoint.
  const sCurve = splineFromKnots([
    knot(vec2(0, 0), vec2(-10, -10), vec2(10, 10)),
    knot(vec2(30, 0), vec2(20, -10), vec2(40, 10)),
  ]);

  it('finds the single inflection of an S-curve at its centre', () => {
    const points = curvatureInflections(curvatureCombRuns(sCurve, 21), 1e-6);
    expect(points).toHaveLength(1);
    expect(points[0]!.x).toBeCloseTo(15, 6);
    expect(points[0]!.y).toBeCloseTo(0, 6);
  });

  it('finds none on a convex arc or a straight line', () => {
    expect(curvatureInflections(curvatureCombRuns(quarter(10), 16), 1e-6)).toEqual([]);
    const line = splineFromKnots([
      knot(vec2(0, 0), vec2(-1, 0), vec2(1, 0)),
      knot(vec2(3, 0), vec2(2, 0), vec2(4, 0)),
    ]);
    expect(curvatureInflections(curvatureCombRuns(line, 16), 1e-6)).toEqual([]);
  });

  it('ignores sign flicker below the flat threshold', () => {
    const runs: CombSample[][] = [
      [3, 1e-9, -1e-9, 2].map((k, i) => ({ p: vec2(i, 0), dir: vec2(0, 1), k, segment: 0, t: 0 })),
    ];
    expect(curvatureInflections(runs, 1e-6)).toEqual([]);
  });
});
