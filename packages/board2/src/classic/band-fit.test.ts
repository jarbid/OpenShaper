// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The band fit's linear algebra (`band-fit.ts`, step S7) on the stadium board,
 * with data made from a known band so the answer is known exactly.
 *
 * - **Recovery**: a band whose kept masters are displaced by seeded random
 *   amounts (`mulberry32`, seed printed) along the structural directions, the
 *   other masters interpolating them and the partners mirrored (exactly the
 *   space the fit searches), sampled at random (u, v) with those parameters
 *   given: the fit at the bracket's smallest weight returns that net within
 *   1e-9 cm (a least squares with a zero-residual solution and a weight of
 *   1e-10 of the data term: the fairness moves it by about the weight times the
 *   displacements' curvature, far below; rounding of the banded solve is
 *   smaller still).
 * - **Structure**: rows 0, 3 and 6 never move; rows 2 and 4 keep the apex
 *   row's x and y bitwise (the apex join stays G1 by construction, §3.5); the
 *   partners are the exact mirrors of their masters.
 * - **Bounds**: data pulling one column's upper apex handle far above its
 *   corner (fullness 1) leave every unknown inside its bounds, that one at its
 *   upper bound.
 */
import { describe, expect, it } from 'vitest';
import {
  makeSurface,
  clampedBasis,
  resolveTolerances,
  surfaceEvalInto,
  createScratch,
} from '@openshaper/geom';
import { mulberry32 } from '@openshaper/geom/testing';
import { BAND_V_KNOTS, bandContext, bandPass } from '../band/band';
import { bandColumns, stationBasis } from '../band/stations';
import { stadiumBoard } from '../testing';
import { bandFitFrame, bandFitProblem, expandDisplacements, netOf, solveBand } from './band-fit';
import { columnInputs } from './extract';
import { DEFAULT_CONVERT_OPTIONS as O } from './params';
import { netOf as surfaceNet } from './rail';

const SEED = 7022;
const tol = resolveTolerances();
const doc = stadiumBoard({ thickness: 6 });
const ctx = bandContext(doc);
const b = stationBasis(ctx.plan, ctx.arc, doc.build, true, tol);
const columns = bandColumns(b, ctx.arc);
const target = surfaceNet(bandPass(ctx, b).band);
const inp = columnInputs(ctx, b, columns);
const frame = bandFitFrame(
  b,
  columns,
  target,
  inp,
  doc.build.fullnessRange[0],
  tol.point,
  O.sampleSpacingX / ctx.arc.total,
);
const nd = frame.free.length;
const R0 = O.fairnessRatioBracket[0];

/** Samples of the band with net `net` at seeded random parameters. */
function samplesOf(
  net: Float64Array,
  n: number,
  seed: number,
): { points: Float64Array; uv: Float64Array } {
  const s = makeSurface({ u: b.basis, v: clampedBasis(3, BAND_V_KNOTS), points: net });
  const rnd = mulberry32(seed);
  const sc = createScratch({ maxDegree: 3, maxDerivs: 0 });
  const f = new Float64Array(3);
  const points = new Float64Array(3 * n);
  const uv = new Float64Array(2 * n);
  for (let k = 0; k < n; k++) {
    const u = rnd();
    const v = rnd();
    surfaceEvalInto(s, u, v, 0, f, 0, sc);
    points.set(f, 3 * k);
    uv[2 * k] = u;
    uv[2 * k + 1] = v;
  }
  return { points, uv };
}

describe('band fit (S7): the stadium band, displaced', () => {
  it(`recovers a known displacement (seed ${SEED})`, () => {
    const rnd = mulberry32(SEED);
    const c = new Float64Array(frame.kept * nd);
    // Small (a millimetre), so no bound is active.
    for (let k = 0; k < c.length; k++) c[k] = 0.1 * (rnd() - 0.5);
    const truth = netOf(frame, expandDisplacements(frame, c));
    const { points, uv } = samplesOf(truth, 40_000, SEED + 1);
    const P = bandFitProblem(frame, points, uv);
    const r = solveBand(P, R0 * P.betaScale, tol.pivotRel);
    expect(r).not.toBeNull();
    const net = netOf(frame, expandDisplacements(frame, r!.w));
    let worst = 0;
    for (let k = 0; k < net.length; k++) worst = Math.max(worst, Math.abs(net[k]! - truth[k]!));
    expect(worst).toBeLessThanOrEqual(1e-9);
    expect(r!.rounds).toBe(1);
  });

  it('moves rows 1, 2, 4, 5 only, keeps the apex handles on the apex vertical, mirrors partners', () => {
    const rnd = mulberry32(SEED + 2);
    const c = new Float64Array(frame.kept * nd);
    for (let k = 0; k < c.length; k++) c[k] = 0.1 * (rnd() - 0.5);
    const net = netOf(frame, expandDisplacements(frame, c));
    for (let i = 0; i < frame.nu; i++) {
      const o = i * 21;
      for (const r of [0, 3, 6]) {
        for (let k = 0; k < 3; k++) expect(net[o + 3 * r + k]).toBe(target[o + 3 * r + k]);
      }
      for (const r of [2, 4]) {
        expect(net[o + 3 * r]).toBe(net[o + 9]);
        expect(net[o + 3 * r + 1]).toBe(net[o + 10]);
      }
      const c0 = columns[i]!;
      if (c0.role === 'partner') {
        const p = c0.partner * 21;
        for (let r = 0; r < 7; r++) {
          expect(net[o + 3 * r]).toBe(net[p + 3 * r]);
          expect(net[o + 3 * r + 1]).toBe(-net[p + 3 * r + 1]!);
          expect(net[o + 3 * r + 2]).toBe(net[p + 3 * r + 2]);
        }
      }
    }
  });

  it('keeps every unknown inside its bounds when the data pull one past them', () => {
    // Raise one kept master's upper apex handle by 5 cm: far above its corner C_u.
    const c = new Float64Array(frame.kept * nd);
    const j = frame.j0[Math.floor(frame.masters.length / 2)]!;
    const m = Array.from(frame.j0).indexOf(j);
    const B2 = frame.free.indexOf(1);
    c[j * nd + B2] = 5;
    const pulled = netOf(frame, expandDisplacements(frame, c));
    // The pull itself, unclamped: write the raised handle back in.
    const i = frame.masters[m]!;
    pulled[i * 21 + 8] = target[i * 21 + 8]! + 5;
    const { points, uv } = samplesOf(pulled, 40_000, SEED + 3);
    const P = bandFitProblem(frame, points, uv);
    const r = solveBand(P, R0 * P.betaScale, tol.pivotRel);
    expect(r).not.toBeNull();
    for (let k = 0; k < P.size; k++) {
      expect(r!.w[k]).toBeGreaterThanOrEqual(P.lo[k]!);
      expect(r!.w[k]).toBeLessThanOrEqual(P.hi[k]!);
    }
    expect(r!.w[j * nd + B2]).toBe(P.hi[j * nd + B2]);
    expect(r!.rounds).toBeGreaterThan(1);
  });
});
