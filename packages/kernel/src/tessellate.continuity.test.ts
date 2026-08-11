// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { board, type BezierBoard } from './board';
import { splineFromKnots } from './bezier-spline';
import { crossSection } from './cross-section';
import { knot } from './knot';
import { polylineSpline } from './test-support/synthetic-boards';
import { reslice } from './test-support/reslice';
import { tessellateBoard } from './tessellate';
import { vec2 } from './vec2';

const LENGTH = 120;
const HALF_WIDTH = 10;
const THICK = 6;

/**
 * A 4-knot rounded rail "D" shape: bottom-centre → lower rail → upper rail →
 * deck-centre. 3 segments, so 3 distinct insertion points are available below.
 */
const railProfile = () =>
  splineFromKnots([
    knot(vec2(0, 0), vec2(0, 0), vec2(HALF_WIDTH * 0.5, 0)),
    knot(
      vec2(HALF_WIDTH, THICK * 0.25),
      vec2(HALF_WIDTH * 0.7, THICK * 0.05),
      vec2(HALF_WIDTH, THICK * 0.45),
    ),
    knot(
      vec2(HALF_WIDTH, THICK * 0.75),
      vec2(HALF_WIDTH, THICK * 0.55),
      vec2(HALF_WIDTH * 0.7, THICK * 0.95),
    ),
    knot(vec2(0, THICK), vec2(HALF_WIDTH * 0.5, THICK), vec2(0, THICK)),
  ]);

/**
 * A board whose outline/rocker/deck are flat (constant width & thickness along
 * the whole length), and whose three interior stations A/B/C are the exact same
 * rail curve — just resliced (via exact de Casteljau split, see
 * `test-support/reslice`) into 4, 5, and 7 knots respectively. B (5) is
 * deliberately NOT a local max among {4, 5, 7}, reproducing what happens when a
 * rail-profile preset changes one station's knot count relative to its
 * neighbors. Because the true shape never changes along x, a correct loft
 * should be a perfect constant-cross-section prism regardless of how any one
 * station's curve happens to be sliced into knots.
 */
const makeBoard = (): BezierBoard => {
  const outline = polylineSpline([
    [0, HALF_WIDTH],
    [LENGTH, HALF_WIDTH],
  ]);
  const bottom = polylineSpline([
    [0, 0],
    [LENGTH, 0],
  ]);
  const deck = polylineSpline([
    [0, THICK],
    [LENGTH, THICK],
  ]);

  const four = railProfile().knots;
  const five = reslice(four, [{ seg: 0, t: 0.5 }]);
  const seven = reslice(four, [
    { seg: 0, t: 0.5 },
    { seg: 1, t: 0.5 },
    { seg: 2, t: 0.5 },
  ]);

  const sections = [
    crossSection(0, splineFromKnots(four)),
    crossSection(30, splineFromKnots(four)), // A: 4 knots
    crossSection(60, splineFromKnots(five)), // B: 5 knots
    crossSection(90, splineFromKnots(seven)), // C: 7 knots
    crossSection(LENGTH, splineFromKnots(four)),
  ];
  return board(outline, bottom, deck, sections, 'controlPoint');
};

describe('tessellateBoard: continuity across a mismatched knot-count station', () => {
  it('produces no localized crease where a station is not a local max of knot count', () => {
    const b = makeBoard();
    const lengthSteps = 400;
    const ringSteps = 32;
    const mesh = tessellateBoard(b, { lengthSteps, ringSteps });

    const vertexCount = mesh.positions.length / 3;
    const capVerts = 2; // two tip-cap vertices appended after all rings
    const ringLen = (vertexCount - capVerts) / lengthSteps;
    expect(Number.isInteger(ringLen)).toBe(true); // every station here yields a valid ring

    // Ring vertex (y, z) only — x is each station's own longitudinal position,
    // which advances by design every ring, so it must be excluded from a "did
    // the cross-section's SHAPE jump" comparison.
    const ringPointYZ = (ring: number, i: number): [number, number] => {
      const base = (ring * ringLen + i) * 3;
      return [mesh.positions[base + 1]!, mesh.positions[base + 2]!];
    };
    const dist2 = (a: [number, number], b2: [number, number]): number =>
      Math.hypot(a[0] - b2[0], a[1] - b2[1]);

    let maxJump = 0;
    for (let r = 0; r < lengthSteps - 1; r++) {
      for (let i = 0; i < ringLen; i++) {
        maxJump = Math.max(maxJump, dist2(ringPointYZ(r, i), ringPointYZ(r + 1, i)));
      }
    }

    // The board's real shape never varies along x (every station is the exact
    // same curve, just resliced differently) — a correct loft is a constant
    // cross-section prism, so ring-to-ring shape motion should be zero. A
    // segment-index sampler instead shows a jump of order the profile's own
    // scale (~4.8 cm) exactly at the ring pair straddling station B, the station
    // that isn't a local max of knot count among its neighbours.
    //
    // The point-blended loft (`loft.ts`) makes this case exact rather than
    // merely small: fractional arc length along a curve doesn't care how that
    // curve was resliced, so all four knot counts sample the identical points.
    // Measured 1.5e-6 cm, against 0.05 when the loft blended control points —
    // the residual there was the morph reconstructing the curve imperfectly from
    // two different control polygons of it.
    expect(maxJump).toBeLessThan(1e-5);
  });
});
