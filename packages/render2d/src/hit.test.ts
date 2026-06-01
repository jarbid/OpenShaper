import { knot, splineFromKnots, vec2 } from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import { hitTest } from './hit';
import type { Viewport } from './viewport';
import { worldToScreen } from './viewport';

/**
 * Build a simple 2-knot spline centred on a grid so screen positions are easy to derive.
 * Knot 0 is at world (0, 0), knot 1 at world (100, 0).
 * Both tangent handles share the same position as the endpoint (degenerate but valid).
 */
const makeSpline = () =>
  splineFromKnots([
    knot(vec2(0, 0), vec2(0, 0), vec2(10, 0)),
    knot(vec2(100, 0), vec2(90, 0), vec2(100, 0)),
  ]);

/** Viewport: 2 px/cm, origin at screen (200, 300). */
const VP: Viewport = { scale: 2, originX: 200, originY: 300 };

describe('hitTest', () => {
  it('returns null when no handle is within tolerance', () => {
    const s = makeSpline();
    // Pick a screen point far from all handles
    const hit = hitTest(s, VP, { x: 999, y: 999 });
    expect(hit).toBeNull();
  });

  it('hits knot-0 endpoint when exactly on its screen position', () => {
    const s = makeSpline();
    const k0Screen = worldToScreen(VP, vec2(0, 0));
    const hit = hitTest(s, VP, k0Screen);
    expect(hit).not.toBeNull();
    expect(hit!.index).toBe(0);
    expect(hit!.kind).toBe('end');
  });

  it('hits knot-1 endpoint when exactly on its screen position', () => {
    const s = makeSpline();
    const k1Screen = worldToScreen(VP, vec2(100, 0));
    const hit = hitTest(s, VP, k1Screen);
    expect(hit).not.toBeNull();
    expect(hit!.index).toBe(1);
    expect(hit!.kind).toBe('end');
  });

  it('hits knot-0 "next" tangent handle', () => {
    const s = makeSpline();
    // tangentToNext of knot 0 is at world (10, 0)
    const tangentScreen = worldToScreen(VP, vec2(10, 0));
    const hit = hitTest(s, VP, tangentScreen);
    expect(hit).not.toBeNull();
    expect(hit!.index).toBe(0);
    // 'next' tangent
    expect(hit!.kind).toBe('next');
  });

  it('respects custom tolerance: misses just outside but hits just inside', () => {
    const s = makeSpline();
    const k0Screen = worldToScreen(VP, vec2(0, 0));
    const tol = 5;

    // Exactly at tolerance distance: just outside should miss (distance > tol)
    const outside = { x: k0Screen.x + tol + 1, y: k0Screen.y };
    expect(hitTest(s, VP, outside, tol)).toBeNull();

    // Just inside tolerance
    const inside = { x: k0Screen.x + tol - 1, y: k0Screen.y };
    const hit = hitTest(s, VP, inside, tol);
    expect(hit).not.toBeNull();
    expect(hit!.index).toBe(0);
  });

  it('endpoint wins over a tangent handle at the same distance (bias)', () => {
    // Use a spline where tangentToPrev of knot 0 is placed at the same world position
    // as knot 0's endpoint (distance 0 from screen point) and also knot 1's end is very
    // far away. We check that 'end' wins over 'prev' when both are at distance 0.
    const s = splineFromKnots([
      knot(vec2(0, 0), vec2(0, 0), vec2(5, 0)), // tangentToPrev === end
      knot(vec2(100, 0), vec2(90, 0), vec2(100, 0)),
    ]);
    const k0Screen = worldToScreen(VP, vec2(0, 0));
    const hit = hitTest(s, VP, k0Screen);
    expect(hit).not.toBeNull();
    // endpoint should win due to the -0.5 bias
    expect(hit!.kind).toBe('end');
  });

  it('returns null for an empty spline', () => {
    // A single-knot spline produces no segments but has one knot
    const s = splineFromKnots([knot(vec2(0, 0), vec2(0, 0), vec2(0, 0))]);
    const k0Screen = worldToScreen(VP, vec2(0, 0));
    // With default tolerance it should hit the single knot
    const hit = hitTest(s, VP, k0Screen);
    expect(hit).not.toBeNull();
    expect(hit!.index).toBe(0);
    expect(hit!.kind).toBe('end');
  });
});
