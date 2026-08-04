// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Guards ring-vertex correspondence BETWEEN stations.
 *
 * `tessellate.continuity.test.ts` guards the other half of this problem — a
 * pinch AT a station whose knot count isn't a local maximum — using a fixture
 * where every station is the same curve, merely resliced. That deliberately
 * makes the cross-section morph a no-op, which is what isolates the sampling
 * variable, but it also means it cannot see anything that only appears when
 * neighbouring stations genuinely DIFFER.
 *
 * This file covers that gap: two adjacent stations with a different shape AND a
 * different knot count, which is what applying a rail preset to one station
 * produces.
 */
import { describe, expect, it } from 'vitest';
import { splineFromKnots } from './bezier-spline';
import { board, type BezierBoard } from './board';
import { crossSection } from './cross-section';
import { knot, type Knot } from './knot';
import { polylineSpline } from './test-support/synthetic-boards';
import { tessellateBoard } from './tessellate';
import { vec2 } from './vec2';

const LEN = 120;
const W = 10;
const T = 6;

/** Soft round rail — 4 knots. */
const softKnots = (): Knot[] => [
  knot(vec2(0, 0), vec2(0, 0), vec2(W * 0.55, 0)),
  knot(vec2(W, T * 0.3), vec2(W * 0.75, T * 0.04), vec2(W, T * 0.52)),
  knot(vec2(W, T * 0.72), vec2(W, T * 0.55), vec2(W * 0.7, T * 0.97)),
  knot(vec2(0, T), vec2(W * 0.5, T), vec2(0, T)),
];

/** Hard tucked-edge rail — 6 knots, a genuinely different shape (not a reslice). */
const hardKnots = (): Knot[] => [
  knot(vec2(0, 0), vec2(0, 0), vec2(W * 0.4, 0)),
  knot(vec2(W * 0.86, T * 0.06), vec2(W * 0.62, 0), vec2(W * 0.97, T * 0.12)),
  knot(vec2(W, T * 0.28), vec2(W, T * 0.18), vec2(W, T * 0.4)),
  knot(vec2(W * 0.98, T * 0.6), vec2(W, T * 0.5), vec2(W * 0.92, T * 0.72)),
  knot(vec2(W * 0.6, T * 0.93), vec2(W * 0.8, T * 0.86), vec2(W * 0.4, T * 0.98)),
  knot(vec2(0, T), vec2(W * 0.2, T), vec2(0, T)),
];

const STATIONS = [0, 30, 60, LEN];

/**
 * Flat outline/rocker/deck, so every scaling operation is a no-op and the ONLY
 * thing varying along x is the rail shape. Station 60 carries the hard rail —
 * the "edited" station — so the intervals 30→60 and 60→120 each blend two
 * genuinely different profiles with mismatched knot counts.
 */
const makeBoard = (): BezierBoard => {
  const outline = polylineSpline([
    [0, W],
    [LEN, W],
  ]);
  const bottom = polylineSpline([
    [0, 0],
    [LEN, 0],
  ]);
  const deck = polylineSpline([
    [0, T],
    [LEN, T],
  ]);
  const profiles = [softKnots(), softKnots(), hardKnots(), softKnots()];
  return board(
    outline,
    bottom,
    deck,
    STATIONS.map((pos, i) => crossSection(pos, splineFromKnots(profiles[i]!))),
    'controlPoint',
  );
};

/** Which station interval x falls in; ring triples that straddle a boundary are excluded. */
const intervalOf = (x: number): number => {
  for (let i = 0; i < STATIONS.length - 1; i++) if (x < STATIONS[i + 1]!) return i;
  return STATIONS.length - 2;
};

describe('tessellateBoard: correspondence smoothness between differing stations', () => {
  const lengthSteps = 400;
  const ringSteps = 24;

  const mesh = tessellateBoard(makeBoard(), { lengthSteps, ringSteps });
  const ringLen = (mesh.positions.length / 3 - 2) / lengthSteps; // −2 tip-cap vertices
  const eps = Math.min(0.5, LEN * 1e-3);
  const xOf = (r: number) => eps + ((LEN - 2 * eps) * r) / (lengthSteps - 1);

  /** Ring vertex (y, z). x is the station's own position and is excluded by design. */
  const yz = (r: number, i: number): [number, number] => {
    const b = (r * ringLen + i) * 3;
    return [mesh.positions[b + 1]!, mesh.positions[b + 2]!];
  };

  it('produces one full ring per station', () => {
    expect(Number.isInteger(ringLen)).toBe(true);
  });

  /**
   * Bezier evaluation at a fixed parameter is affine in the control points, and
   * `interpolateCrossSection` lerps control points, so a correct loft sweeps each
   * ring vertex along a straight line between two stations — second difference
   * zero. Any departure is the sampler failing to hold a consistent
   * correspondence.
   *
   * Measured on this fixture (max over all ring vertices, cm):
   *   arc-length sampling, per-pair knot matching   3.2e-3   <- the reported bug
   *   arc-length sampling, normalised knot counts   3.2e-3   <- sampler, not matching
   *   segment index, per-pair knot matching         6.2e-15 between stations,
   *                                                 but 1.3 cm AT one
   *   segment index + normalised (shipped)          6.2e-15, 1.1e-6 in float32
   *
   * The threshold sits above the float32 storage floor and ~300x below what
   * arc-length sampling produces, so it fails loudly on a regression either way.
   */
  it('sweeps ring vertices near-linearly within a station interval', () => {
    let maxD2 = 0;
    for (let r = 1; r < lengthSteps - 1; r++) {
      if (intervalOf(xOf(r - 1)) !== intervalOf(xOf(r + 1))) continue; // straddles a station
      for (let i = 0; i < ringLen; i++) {
        const [ay, az] = yz(r - 1, i);
        const [by, bz] = yz(r, i);
        const [cy, cz] = yz(r + 1, i);
        maxD2 = Math.max(maxD2, Math.hypot(cy - 2 * by + ay, cz - 2 * bz + az));
      }
    }
    expect(maxD2).toBeLessThan(1e-5);
  });

  /**
   * The visible symptom is not the magnitude of the second difference but its
   * high-frequency content: shading derives normals from neighbouring vertices,
   * and the curvature overlay differentiates those again, so jitter blotches
   * where a smooth trend would not. Arc-length sampling's jitter was 2.6e-3 cm —
   * 85% of its own magnitude, i.e. essentially noise rather than curvature.
   * Normalising knot counts and sampling by segment index leaves 5.3e-15.
   */
  it('has no high-frequency jitter in that sweep', () => {
    let maxJitter = 0;
    const d2 = (r: number, i: number): number => {
      const [ay, az] = yz(r - 1, i);
      const [by, bz] = yz(r, i);
      const [cy, cz] = yz(r + 1, i);
      return Math.hypot(cy - 2 * by + ay, cz - 2 * bz + az);
    };
    for (let r = 1; r < lengthSteps - 2; r++) {
      if (intervalOf(xOf(r - 1)) !== intervalOf(xOf(r + 2))) continue;
      for (let i = 0; i < ringLen; i++) {
        maxJitter = Math.max(maxJitter, Math.abs(d2(r + 1, i) - d2(r, i)));
      }
    }
    expect(maxJitter).toBeLessThan(1e-5);
  });
});
