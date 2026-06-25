// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { splineFromKnots, valueAt } from './bezier-spline';
import { knotFromArray } from './knot';
import { hasTailCutout, outlineSegments, sampleOutline, yInOut } from './outline-cutout';

/**
 * Helpers build piecewise-LINEAR outlines: each tangent handle sits exactly 1/3 of
 * the way along its chord, so every cubic segment collapses to a straight line and
 * the (y_in, y_out) interpolation is analytically predictable.
 */
const third = (ax: number, ay: number, bx: number, by: number): [number, number] => [
  ax + (bx - ax) / 3,
  ay + (by - ay) / 3,
];

/** Normal outline: tail tip (0,0) → wide (100,25) → nose (200,0). Monotonic in x. */
const normalOutline = splineFromKnots([
  knotFromArray([0, 0, 0, 0, ...third(0, 0, 100, 25)], false, false),
  knotFromArray([100, 25, ...third(100, 25, 0, 0), ...third(100, 25, 200, 0)], false, false),
  knotFromArray([200, 0, ...third(200, 0, 100, 25), 200, 0], false, false),
]);

/**
 * Swallow outline: notch bottom on the stringer (15,0) → tail tip (0,9, rearmost) →
 * wide (100,25) → nose (200,0). The curve folds back in x at the tail, so the
 * station x ∈ [0,15] carries an inner wall (notch) and an outer rail.
 */
const swallowOutline = splineFromKnots([
  knotFromArray([15, 0, 15, 0, ...third(15, 0, 0, 9)], false, false),
  knotFromArray([0, 9, ...third(0, 9, 15, 0), ...third(0, 9, 100, 25)], false, false),
  knotFromArray([100, 25, ...third(100, 25, 0, 9), ...third(100, 25, 200, 0)], false, false),
  knotFromArray([200, 0, ...third(200, 0, 100, 25), 200, 0], false, false),
]);

describe('outline-cutout: detection', () => {
  it('a normal monotonic outline has no tail cutout', () => {
    expect(hasTailCutout(normalOutline)).toBe(false);
    expect(outlineSegments(normalOutline).tipIndex).toBe(0);
  });

  it('a back-folding swallow outline is detected as a cutout', () => {
    expect(hasTailCutout(swallowOutline)).toBe(true);
    expect(outlineSegments(swallowOutline).tipIndex).toBeGreaterThan(0);
  });

  it('an empty/degenerate outline has no cutout', () => {
    const empty = splineFromKnots([]);
    expect(hasTailCutout(empty)).toBe(false);
    expect(sampleOutline(empty)).toHaveLength(0);
  });
});

describe('outline-cutout: (y_in, y_out) — normal board (back-compat)', () => {
  const seg = outlineSegments(normalOutline);

  it('y_in is 0 everywhere and y_out tracks valueAt', () => {
    // Non-apex stations are linear-exact; the apex (x=100) carries a ~0.1cm
    // polyline-sampling error, so compare within 0.5cm. (Normal boards never
    // actually route width through this path — Stage 3 keeps exact valueAt.)
    for (const x of [10, 50, 100, 150, 190]) {
      const { yIn, yOut } = yInOut(seg, x);
      expect(yIn).toBe(0);
      expect(yOut).toBeCloseTo(valueAt(normalOutline, x), 0);
    }
  });

  it('y_out at the wide point ≈ 25', () => {
    expect(yInOut(seg, 100).yOut).toBeCloseTo(25, 0);
  });
});

describe('outline-cutout: (y_in, y_out) — swallow board', () => {
  const seg = outlineSegments(swallowOutline);

  it('splits into a real inner wall and outer rail', () => {
    expect(seg.tailInner.length).toBeGreaterThan(1);
    expect(seg.mainRail.length).toBeGreaterThan(1);
  });

  it('inside the notch both boundaries are present (y_out > y_in > 0)', () => {
    // Inner wall is the line (15,0)→(0,9): at x=7.5, y_in ≈ 4.5.
    // Outer rail is the line (0,9)→(100,25): at x=7.5, y_out ≈ 10.2.
    const { yIn, yOut } = yInOut(seg, 7.5);
    expect(yIn).toBeCloseTo(4.5, 0);
    expect(yOut).toBeCloseTo(10.2, 0);
    expect(yOut).toBeGreaterThan(yIn);
  });

  it('the notch closes (y_in → 0) at its forward bottom', () => {
    expect(yInOut(seg, 14.5).yIn).toBeLessThan(0.6);
  });

  it('forward of the notch there is no inner wall (y_in = 0)', () => {
    const { yIn, yOut } = yInOut(seg, 20);
    expect(yIn).toBe(0);
    expect(yOut).toBeCloseTo(12.2, 0); // rail line at x=20
  });

  it('clamps y_out ≥ y_in', () => {
    for (let x = 0; x <= 15; x += 1) {
      const { yIn, yOut } = yInOut(seg, x);
      expect(yOut).toBeGreaterThanOrEqual(yIn - 1e-9);
    }
  });
});
