// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The height-field least squares of `lsq.ts` (step S7) against geom's
 * `approximateSurface` with the stringer identity as point constraints at the
 * Greville sites (§3.4) and parametric thin-plate fairness: the problem
 * `fitField` solved before S7, solved here by elimination with the data's
 * normal equations assembled once.
 *
 * Oracles and tolerances:
 * - **Same minimiser**: on seeded random data (`mulberry32`, seed printed),
 *   both control nets agree within 1e-9 × the data's z range at three weights
 *   across the bracket. Both solve the same strictly convex problem; geom by
 *   multipliers on the full xyz system, `lsq.ts` by eliminating one control
 *   value per column on z alone, so they differ by rounding amplified by the
 *   systems' condition (about 1e4 here).
 * - **Stringer identity, exact by construction**: `Σ_j M_j(v_s) z_ij = c_i`
 *   for every column within 1e-12 × the line's range (rounding of one
 *   substitution).
 * - **Residuals** returned equal |S(u_k, v_k) − z_k| evaluated by geom within
 *   1e-12.
 * - **Determination**: with no data on half of the domain and no fairness the
 *   system is refused, as geom refuses it (`schoenberg-whitney`); a small
 *   weight determines it.
 */
import { describe, expect, it } from 'vitest';
import {
  approximateSurface,
  basisFunsInto,
  clampedBasis,
  createScratch,
  findSpan,
  makeCurve,
  makeSurface,
  resolveTolerances,
  surfaceControlPoint,
  surfaceEvalInto,
} from '@openshaper/geom';
import type { ClampedCurve } from '@openshaper/geom';
import { mulberry32 } from '@openshaper/geom/testing';
import { stringerConstraints, stringerParam } from '../height-field';
import type { HeightFieldJSON } from '../types';
import { fieldProblem, solveField } from './lsq';

const tol = resolveTolerances();
const SEED = 20261022;
const EX = [0, 40] as const;
const EY = [-10, 10] as const;
const U = [0, 0, 0, 0, 0.2, 0.35, 0.5, 0.7, 0.85, 1, 1, 1, 1];
const V = [0, 0, 0, 0, 0.25, 0.5, 0.75, 1, 1, 1, 1];
const bu = clampedBasis(3, U);
const bv = clampedBasis(3, V);

function data(halfOnly: boolean): { uv: Float64Array; pts: Float64Array; z: Float64Array } {
  const rnd = mulberry32(SEED);
  const n = 600;
  const uv = new Float64Array(2 * n);
  const pts = new Float64Array(3 * n);
  const z = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const u = halfOnly ? 0.5 * rnd() : rnd();
    const v = rnd();
    const x = EX[0] + u * (EX[1] - EX[0]);
    const y = EY[0] + v * (EY[1] - EY[0]);
    const h = 3 + 0.002 * (x - 20) ** 2 + 0.01 * y * y + 0.05 * Math.sin(x / 3) + 0.01 * rnd();
    uv[2 * k] = u;
    uv[2 * k + 1] = v;
    pts.set([x, y, h], 3 * k);
    z[k] = h;
  }
  return { uv, pts, z };
}

/** A stringer line on the field's u basis: z = 3 + 0.002 (x − 20)² sampled at the Greville sites, smoothed. */
const lineValues = Float64Array.from({ length: bu.count }, (_, i) => 3 + 0.01 * i * (bu.count - i));
const line = makeCurve({ dim: 1, basis: bu, points: lineValues }) as ClampedCurve<1>;
const hf: HeightFieldJSON = {
  degreeU: 3,
  degreeV: 3,
  knotsU: U,
  knotsV: V,
  x: [EX[0], EX[1]],
  y: [EY[0], EY[1]],
  z: new Array<number>(bu.count * bv.count).fill(0),
};
const vs = stringerParam(hf);

describe('lsq: the height-field least squares (S7)', () => {
  it(`is geom's constrained minimiser (seed ${SEED})`, () => {
    const d = data(false);
    const P = fieldProblem(bu, bv, d.uv, d.z, vs, lineValues);
    let zr = 0;
    for (const v of d.z) zr = Math.max(zr, Math.abs(v - 3));
    // β relative to the data term: the same scale the converter's search uses.
    for (const beta of [1e-6, 1e-3, 1]) {
      const mine = solveField(P, beta, tol.pivotRel);
      expect(mine.ok).toBe(true);
      if (!mine.ok) return;
      const ref = approximateSurface(
        d.pts,
        { uv: d.uv },
        {
          u: bu,
          v: bv,
          constraints: stringerConstraints(hf, line, tol),
          fairness: { bend: beta, metric: 'parametric' },
          tol,
        },
      );
      expect(ref.ok).toBe(true);
      if (!ref.ok) return;
      let worst = 0;
      for (let i = 0; i < bu.count; i++) {
        for (let j = 0; j < bv.count; j++) {
          const a = mine.z[i * bv.count + j]!;
          const b = surfaceControlPoint(ref.value.surface, i, j).z;
          worst = Math.max(worst, Math.abs(a - b));
        }
      }
      expect(worst, `β ${beta}`).toBeLessThanOrEqual(1e-9 * Math.max(1, zr));
    }
  });

  it('holds the stringer identity by construction and reports its own residuals', () => {
    const d = data(false);
    const P = fieldProblem(bu, bv, d.uv, d.z, vs, lineValues);
    const r = solveField(P, 1e-4, tol.pivotRel);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sc = createScratch({ maxDegree: 3, maxDerivs: 0 });
    const m = new Float64Array(4);
    const span = findSpan(bv, vs);
    basisFunsInto(bv, span, vs, m, 0, sc);
    for (let i = 0; i < bu.count; i++) {
      let s = 0;
      for (let b = 0; b <= 3; b++) s += m[b]! * r.z[i * bv.count + span - 3 + b]!;
      expect(Math.abs(s - lineValues[i]!)).toBeLessThanOrEqual(1e-12 * 4);
    }
    const pts = new Float64Array(3 * bu.count * bv.count);
    for (let i = 0; i < bu.count; i++) {
      for (let j = 0; j < bv.count; j++)
        pts.set([i, j, r.z[i * bv.count + j]!], 3 * (i * bv.count + j));
    }
    const s = makeSurface({ u: bu, v: bv, points: pts });
    const f = new Float64Array(3);
    for (let k = 0; k < d.z.length; k++) {
      surfaceEvalInto(s, d.uv[2 * k]!, d.uv[2 * k + 1]!, 0, f, 0, sc);
      expect(Math.abs(Math.abs(f[2]! - d.z[k]!) - r.residual[k]!)).toBeLessThanOrEqual(1e-12);
    }
  });

  it('refuses an undetermined net, as geom does, until fairness determines it', () => {
    const d = data(true);
    const P = fieldProblem(bu, bv, d.uv, d.z, vs, lineValues);
    expect(solveField(P, 0, tol.pivotRel).ok).toBe(false);
    const ref = approximateSurface(d.pts, { uv: d.uv }, { u: bu, v: bv, tol });
    expect(ref.ok).toBe(false);
    expect(solveField(P, 1e-3, tol.pivotRel).ok).toBe(true);
  });
});
