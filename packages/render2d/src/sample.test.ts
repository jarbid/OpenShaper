import { knot, splineFromKnots, vec2 } from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import { boundsOf, sampleSpline } from './sample';

/**
 * A straight 2-segment spline: (0,0) -> (50,0) -> (100,0).
 * Tangent handles are on the same horizontal line so the curve is almost straight.
 */
const makeStraightSpline = () =>
  splineFromKnots([
    knot(vec2(0, 0), vec2(0, 0), vec2(10, 0)),
    knot(vec2(50, 0), vec2(40, 0), vec2(60, 0)),
    knot(vec2(100, 0), vec2(90, 0), vec2(100, 0)),
  ]);

describe('sampleSpline', () => {
  it('returns an empty array for a single-knot (no-segment) spline', () => {
    const s = splineFromKnots([knot(vec2(0, 0), vec2(0, 0), vec2(0, 0))]);
    expect(sampleSpline(s)).toHaveLength(0);
  });

  it('produces (perCurve + 1) points for a one-segment spline', () => {
    const s = splineFromKnots([
      knot(vec2(0, 0), vec2(0, 0), vec2(10, 0)),
      knot(vec2(100, 0), vec2(90, 0), vec2(100, 0)),
    ]);
    const pts = sampleSpline(s, 24);
    // First segment: i=0..24 inclusive = 25 points
    expect(pts).toHaveLength(25);
  });

  it('starts at the spline start point and ends at the spline end point', () => {
    const s = makeStraightSpline();
    const pts = sampleSpline(s);
    const first = pts[0]!;
    const last = pts[pts.length - 1]!;
    expect(first.x).toBeCloseTo(0, 6);
    expect(first.y).toBeCloseTo(0, 6);
    expect(last.x).toBeCloseTo(100, 6);
    expect(last.y).toBeCloseTo(0, 6);
  });

  it('does not duplicate the shared knot between segments', () => {
    // 2 segments → expect 2*perCurve + 1 points (first segment includes 0, second skips 0)
    const perCurve = 10;
    const pts = sampleSpline(makeStraightSpline(), perCurve);
    expect(pts).toHaveLength(2 * perCurve + 1);
  });

  it('respects a custom perCurve resolution', () => {
    const s = splineFromKnots([
      knot(vec2(0, 0), vec2(0, 0), vec2(10, 0)),
      knot(vec2(100, 0), vec2(90, 0), vec2(100, 0)),
    ]);
    const pts = sampleSpline(s, 6);
    expect(pts).toHaveLength(7); // 6+1
  });
});

describe('boundsOf', () => {
  it('returns correct min/max for a set of points', () => {
    const pts = [vec2(3, -1), vec2(-2, 7), vec2(0, 4)];
    const b = boundsOf(pts);
    expect(b.minX).toBe(-2);
    expect(b.maxX).toBe(3);
    expect(b.minY).toBe(-1);
    expect(b.maxY).toBe(7);
  });

  it('handles a single point', () => {
    const b = boundsOf([vec2(5, 9)]);
    expect(b.minX).toBe(5);
    expect(b.maxX).toBe(5);
    expect(b.minY).toBe(9);
    expect(b.maxY).toBe(9);
  });

  it('returns ±Infinity for empty input', () => {
    const b = boundsOf([]);
    expect(b.minX).toBe(Infinity);
    expect(b.maxX).toBe(-Infinity);
  });
});
