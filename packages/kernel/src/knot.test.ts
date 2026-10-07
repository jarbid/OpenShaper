import { describe, expect, it } from 'vitest';
import { scaleSpline, splineFromKnots } from './bezier-spline';
import { knot, scaleKnot, withHandles, type Knot } from './knot';
import { vec2, type Vec2 } from './vec2';

const unit = (x: number, y: number): Vec2 => vec2(x / Math.hypot(x, y), y / Math.hypot(x, y));

/** A corner point whose handles leave at two different, off-axis angles, both locked. */
const lockedCorner = (): Knot =>
  knot(vec2(10, 10), vec2(6, 13), vec2(14, 13), false, false, {
    prev: unit(-4, 3),
    next: unit(4, 3),
  });

describe('knot handle-angle locks', () => {
  it('omits the lock key on a free knot, so free knots serialize as they always have', () => {
    expect(Object.keys(knot(vec2(0, 0), vec2(-1, 0), vec2(1, 0)))).toEqual([
      'end',
      'tangentToPrev',
      'tangentToNext',
      'continuous',
      'other',
    ]);
  });

  it('withHandles moves only the handles, keeping the flags and the lock', () => {
    const k = lockedCorner();
    const moved = withHandles(k, vec2(2, 16), vec2(18, 16));
    expect(moved).toEqual({ ...k, tangentToPrev: vec2(2, 16), tangentToNext: vec2(18, 16) });
  });

  it('scaleKnot turns each lock with its handle under a non-uniform scale', () => {
    const s = scaleKnot(lockedCorner(), 1.5, 0.5);
    for (const [h, d] of [
      [s.tangentToPrev, s.lock!.prev!],
      [s.tangentToNext, s.lock!.next!],
    ] as const) {
      const hx = h.x - s.end.x;
      const hy = h.y - s.end.y;
      expect(hx * d.y - hy * d.x).toBeCloseTo(0, 12); // parallel…
      expect(hx * d.x + hy * d.y).toBeGreaterThan(0); // …and the same way
      expect(Math.hypot(d.x, d.y)).toBeCloseTo(1, 12); // still a unit vector
    }
  });

  it('scaleKnot drops a direction the scale flattens to nothing', () => {
    const k = knot(vec2(0, 0), vec2(0, -1), vec2(1, 1), false, false, {
      prev: vec2(0, -1),
      next: unit(1, 1),
    });
    expect(scaleKnot(k, 1, 0).lock).toEqual({ next: vec2(1, 0) });
    const vertical = knot(vec2(0, 0), vec2(0, -1), vec2(0, 1), true, false, {
      prev: vec2(0, -1),
      next: vec2(0, 1),
    });
    expect(scaleKnot(vertical, 1, 0)).not.toHaveProperty('lock');
  });

  it('scaleKnot leaves a free knot free', () => {
    expect(scaleKnot(knot(vec2(1, 1), vec2(0, 1), vec2(2, 1)), 2, 3)).not.toHaveProperty('lock');
  });

  it('scaleSpline carries locks through every knot', () => {
    const s = scaleSpline(splineFromKnots([lockedCorner(), lockedCorner()]), 2, 1);
    for (const k of s.knots) expect(k.lock).toBeDefined();
  });
});
