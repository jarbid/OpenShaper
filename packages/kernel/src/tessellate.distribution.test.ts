// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Are a ring's points spread along the profile, or bunched by knot topology?
 *
 * The reported symptom: a user puts two control points close together on the
 * deck side of a cross-section and the mesh pinches at that spot; deleting one
 * of the pair makes it better. That is not a blending problem — it is how the
 * ring is sampled.
 *
 * Sampling by segment INDEX gives every segment the same share of the ring's
 * points regardless of its arc length. Two knots 0.5 mm apart make a segment
 * holding 0.2% of the profile that still claims a full quarter of the points,
 * while the longest span — nearly half the profile — gets the same quarter. The
 * long spans are then badly under-resolved, which is the pinch.
 *
 * It is also why raising mesh quality never helped: the share per segment is
 * fixed, so more points scale every span equally and the starvation is
 * unchanged. Any fix has to distribute by arc length, and this file is the
 * oracle for that. The measurement is the ratio of the largest to the smallest
 * gap between neighbouring ring points — 1 would be perfectly even.
 *
 * Scope, since it reads like a contradiction otherwise: what is pinned here is
 * the arc-length MAP (`arcLengthTable` / `pointAtArcFraction`), where evenness
 * is the correct property and knot topology must not show through. The ring
 * built on top of it is deliberately NOT even — `ringFractions` biases points
 * toward curvature so hard rails get resolved (`loft.ladder.test.ts`). That is a
 * choice made in fraction space; it only works because the map underneath it is
 * the honest, topology-free one this file guards.
 */
import { describe, expect, it } from 'vitest';
import { arcLengthTable, pointAtArcFraction, splineFromKnots, type Spline } from './bezier-spline';
import { knot, type Knot } from './knot';
import { vec2 } from './vec2';

const W = 22;
const T = 6.5;

/** A rounded rail whose two deck-side knots sit `gap` cm apart. */
const profile = (gap: number): Spline =>
  splineFromKnots([
    knot(vec2(0, 0), vec2(0, 0), vec2(W * 0.5, 0)),
    knot(vec2(W, T * 0.35), vec2(W * 0.8, T * 0.05), vec2(W, T * 0.6)),
    knot(
      vec2(W * 0.72, T * 0.9),
      vec2(W * 0.9, T * 0.78),
      vec2(W * 0.72 - gap, T * 0.9 + gap * 0.2),
    ),
    knot(
      vec2(W * 0.72 - gap * 2, T * 0.9 + gap * 0.4),
      vec2(W * 0.72 - gap, T * 0.9 + gap * 0.2),
      vec2(W * 0.4, T * 0.98),
    ),
    knot(vec2(0, T), vec2(W * 0.3, T), vec2(0, T)),
  ]);

/** Ratio of the largest to smallest spacing between consecutive ring points. */
const spacingRatio = (s: Spline, points: number): number => {
  const arc = arcLengthTable(s);
  const pts = Array.from({ length: points }, (_, i) => pointAtArcFraction(arc, i / (points - 1)));
  let max = 0;
  let min = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = Math.hypot(pts[i + 1]!.x - pts[i]!.x, pts[i + 1]!.y - pts[i]!.y);
    max = Math.max(max, d);
    min = Math.min(min, d);
  }
  return max / Math.max(min, 1e-12);
};

const GAPS = [4, 1, 0.3, 0.05] as const;

describe('ring sampling distributes points along the profile', () => {
  it.each(GAPS)('stays even with deck knots %s cm apart', (gap) => {
    // Segment-index sampling on the same profiles measured 10:1, 17:1, 56:1 and
    // 330:1 respectively — degrading without limit as the knots converge.
    expect(spacingRatio(profile(gap), 12)).toBeLessThan(3);
  });

  it('is barely affected by how close the knot pair gets', () => {
    // The point of the fix: knot topology stops driving point placement, so the
    // spacing is essentially the same whether the pair is 4 cm or 0.5 mm apart.
    const loose = spacingRatio(profile(4), 12);
    const tight = spacingRatio(profile(0.05), 12);
    expect(Math.abs(tight - loose)).toBeLessThan(0.5);
  });

  it('resolves the arc-length map finely enough that more samples change nothing', () => {
    // This is what says the residual non-affineness the smoothness test tolerates
    // is the arc-length map itself and not integration noise: refining the table
    // 4x must not move the sampled points. An adaptive integrator, whose recursion
    // depth is a step function of the geometry, would fail this.
    const s = profile(0.3);
    const coarse = arcLengthTable(s, 64);
    const fine = arcLengthTable(s, 256);
    let worst = 0;
    for (let i = 0; i <= 64; i++) {
      const f = i / 64;
      const a = pointAtArcFraction(coarse, f);
      const b = pointAtArcFraction(fine, f);
      worst = Math.max(worst, Math.hypot(a.x - b.x, a.y - b.y));
    }
    expect(worst).toBeLessThan(1e-3);
  });
});
