// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { value } from './bezier-curve';
import { knotFromArray } from './knot';
import {
  closestPointOnSpline,
  maxYInRange,
  pointByCurveLength,
  pointByTT,
  splineFromKnots,
  splineLength,
  valueAt,
  xForMaxYInRange,
} from './bezier-spline';
import { reslice } from './test-support/reslice';
import { distance } from './vec2';

/**
 * Real shortboard outline (p32 from docs/specs/golden/shortboard.brd). Outline y is the
 * half-width; the centerline is y=0. Validated against docs/specs/golden/golden.json:
 *   centerWidth = 46.94468582 (half = 23.4723), maxWidth = 46.99000234 (half = 23.495),
 *   maxWidthPos = 90.07625140.
 * cp record order is [endX,endY, prevX,prevY, nextX,nextY].
 */
const shortboardOutline = splineFromKnots([
  knotFromArray([0.0, 0.0, 0.0, 0.0, 0.0, 3.05804454721486], false, false),
  knotFromArray(
    [
      1.396916196324043, 5.7737301929790315, 0.09199389838430455, 4.5383224190388285,
      7.42679238696713, 11.482388810874316,
    ],
    true,
    false,
  ),
  knotFromArray(
    [
      90.13362308681752, 23.49499750470692, 30.390000282383603, 23.502663416291362,
      129.08124632569087, 23.490000000000002,
    ],
    true,
    false,
  ),
  knotFromArray(
    [187.96, 0.5, 165.39140765851977, 16.729079863293684, 187.96215325905928, 0.4806433299508672],
    false,
    false,
  ),
  knotFromArray([187.96, 0.0, 187.96, 0.02097709562634233, 187.96, 0.0], false, false),
]);

describe('bezier-spline (real shortboard outline vs golden)', () => {
  it('half-width at center matches golden centerWidth/2', () => {
    // center of board length 187.96 => x = 93.98
    expect(valueAt(shortboardOutline, 93.98) * 2).toBeCloseTo(46.94468582, 1);
  });

  it('max width matches golden maxWidth', () => {
    expect(maxYInRange(shortboardOutline, 0, 187.96) * 2).toBeCloseTo(46.99000234, 1);
  });

  it('widepoint position matches golden maxWidthPos', () => {
    expect(xForMaxYInRange(shortboardOutline, 0, 187.96)).toBeCloseTo(90.07625, 0);
  });

  it('outline arc length is sensible (> board length)', () => {
    // Perimeter of half-outline nose->tail must exceed the straight length.
    expect(splineLength(shortboardOutline)).toBeGreaterThan(187.96);
  });
});

describe('closestPointOnSpline', () => {
  it('recovers a point sampled on a segment', () => {
    // A point genuinely on segment 2 (widepoint -> tail). The nearest hit must
    // map back to (very near) that point.
    const q = value(shortboardOutline.coeffs[2]!, 0.7);
    const hit = closestPointOnSpline(shortboardOutline, q);
    expect(hit).not.toBeNull();
    const found = value(shortboardOutline.coeffs[hit!.index]!, hit!.t);
    expect(distance(found, q)).toBeLessThan(0.5);
  });

  it('returns null for a spline with no curves', () => {
    const single = splineFromKnots([shortboardOutline.knots[0]!]);
    expect(closestPointOnSpline(single, { x: 0, y: 0 })).toBeNull();
  });
});

describe('arc-length sampling is invariant to reslicing (segment-index sampling is not)', () => {
  // The same curve as shortboardOutline, with 2 extra knots spliced in via exact
  // de Casteljau split (splitCurve reproduces the original curve exactly — this
  // mirrors what matchControlPointCounts does when two adjacent cross-sections
  // have different knot counts).
  const resliced = splineFromKnots(
    reslice(shortboardOutline.knots, [
      { seg: 1, t: 0.5 },
      { seg: 2, t: 0.4 },
    ]),
  );

  it('control: reslicing is exact (same curve, more knots)', () => {
    expect(resliced.knots.length).toBe(shortboardOutline.knots.length + 2);
    // Endpoints of the original curve are still reproduced exactly by the resliced one.
    for (const tt of [0, 1]) {
      expect(distance(pointByTT(shortboardOutline, tt), pointByTT(resliced, tt))).toBeLessThan(
        1e-9,
      );
    }
  });

  it('control: segment-index (tt) sampling diverges after reslicing', () => {
    // floor(tt * n) parametrizes by segment count, which changed — interior tt
    // values should land on visibly different points despite being the same curve.
    let maxDiff = 0;
    for (const tt of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
      maxDiff = Math.max(
        maxDiff,
        distance(pointByTT(shortboardOutline, tt), pointByTT(resliced, tt)),
      );
    }
    expect(maxDiff).toBeGreaterThan(0.3);
  });

  it('fix: arc-length (s) sampling agrees after reslicing', () => {
    // curveLength/tForLength are adaptive numerical searches bounded by
    // LENGTH_TOLERANCE (0.001 cm); more segments means more accumulated search
    // error, but it stays tiny relative to the segment-index divergence above
    // (0.3 cm) — two orders of magnitude apart, not the same failure mode.
    const totalOriginal = splineLength(shortboardOutline);
    const totalResliced = splineLength(resliced);
    for (const sFrac of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      const a = pointByCurveLength(shortboardOutline, sFrac * totalOriginal);
      const b = pointByCurveLength(resliced, sFrac * totalResliced);
      expect(distance(a, b)).toBeLessThan(0.01);
    }
  });
});
