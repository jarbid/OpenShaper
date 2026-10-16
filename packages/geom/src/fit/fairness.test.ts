// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The `fairness` option of the fitters (design §6.12, A3): least squares plus
 * `½ β E` on the shape.
 *
 * - **Same machinery, two codes.** A fit with fairness equals the fair
 *   solver's answer to the same problem (data as soft targets, fairness on the
 *   shape, no stiffness, the same hard constraints): one is the band
 *   normal-equation path of `lsq.ts`, the other the envelope/KKT path of
 *   `solver.ts`.
 * - **Planar data ⇒ the plane.** Data on an affine image of their parameters
 *   are fitted exactly by that affine surface, whose bending energy is zero:
 *   the global minimiser for any β. The fit returns it.
 * - **Smoothing.** As β grows the bending energy of the fit falls and its data
 *   error grows, monotonically (the two terms trade off along the solution
 *   path of a convex problem). Measured in the functional the fit minimises:
 *   the parametric energy (a fit's scaled metric is a constant multiple of
 *   it); the scaled energy with the fit itself as reference is a different
 *   functional and need not be monotone.
 * - **Regularisation by fairness.** Fewer data than control points: without
 *   fairness the fit reports `schoenberg-whitney`; with it the fit exists.
 *
 * Tolerances: the two solve paths agree to `1e-9` relative to the data's size
 * (normal equations: condition ≲ 1e6 here, ε·κ ≈ 2e-10); "exact" fits to
 * `1e-12` of the data size.
 */
import { describe, expect, it } from 'vitest';
import {
  approximateCurve,
  approximateSurface,
  clampedBasis,
  clampedUniformKnots,
  curvePoint,
  fairnessEnergy,
  makeCurve,
  makeDofMap,
  makeSurface,
  prepareFairSolver,
  solveFair,
} from '../index';
import type { NurbsCurve, NurbsSurface } from '../index';
import { mulberry32 } from '../testing';

const PATHS = 1e-9;
const EXACT = 1e-12;

describe('fits with fairness', () => {
  it('a curve fit equals the fair solver on the same problem (with a point constraint)', () => {
    const rng = mulberry32(4);
    const m = 60;
    const ts = Float64Array.from({ length: m }, (_, k) => k / (m - 1));
    const pts = Float64Array.from({ length: 2 * m }, (_, i) => {
      const t = ts[i >> 1]!;
      return i % 2 ? Math.sin(6 * t) * 20 + rng() : 100 * t;
    });
    const basis = clampedBasis(3, clampedUniformKnots(3, 14));
    const fairness = { bend: 3e-4, stretch: 1e-3, metric: 'parametric' } as const;
    const fit = approximateCurve(pts, 2, {
      knots: basis.knots,
      params: ts,
      fairness,
      constraints: [{ kind: 'point', t: 0.5, value: { x: 50, y: 3 } }],
    });
    if (!fit.ok) throw new Error(JSON.stringify(fit.issues));
    const target = makeCurve({ dim: 2, basis, points: new Float64Array(28) });
    const s = prepareFairSolver({
      target,
      dof: makeDofMap(target, []),
      fairness: { ...fairness, on: 'shape' },
      stiffness: 0,
      data: { params: ts, points: pts },
      constraints: [{ kind: 'point', t: 0.5, value: { x: 0, y: 0 } }],
    });
    if (!s.ok) throw new Error(JSON.stringify(s.issues));
    const { result } = solveFair<NurbsCurve<2>>(s.value, [50, 3, 0]);
    for (let i = 0; i < result.cw.length; i++) {
      expect(Math.abs(result.cw[i]! - fit.value.curve.cw[i]!), `cw[${i}]`).toBeLessThanOrEqual(
        PATHS * 100,
      );
    }
    const p = curvePoint(fit.value.curve as NurbsCurve<2>, 0.5);
    expect(Math.abs(p.x - 50) + Math.abs(p.y - 3)).toBeLessThanOrEqual(1e-9);
  });

  it('a surface fit equals the fair solver on the same problem (scattered data)', () => {
    const rng = mulberry32(5);
    const n = 150;
    const uv = Float64Array.from({ length: 2 * n }, () => rng());
    const pts = Float64Array.from({ length: 3 * n }, (_, i) => {
      const k = Math.floor(i / 3);
      const u = uv[2 * k]!;
      const v = uv[2 * k + 1]!;
      return i % 3 === 0 ? 200 * u : i % 3 === 1 ? 50 * v : 3 * Math.sin(4 * u) * v + 0.1 * rng();
    });
    const u = clampedBasis(3, clampedUniformKnots(3, 9));
    const v = clampedBasis(3, clampedUniformKnots(3, 6));
    const fairness = { bend: 2e-3, metric: 'parametric' } as const;
    const fit = approximateSurface(pts, { uv }, { u, v, fairness });
    if (!fit.ok) throw new Error(JSON.stringify(fit.issues));
    const target = makeSurface({ u, v, points: new Float64Array(9 * 6 * 3) });
    const s = prepareFairSolver({
      target,
      dof: makeDofMap(target, []),
      fairness: { ...fairness, on: 'shape' },
      stiffness: 0,
      data: { params: uv, points: pts },
      constraints: [],
    });
    if (!s.ok) throw new Error(JSON.stringify(s.issues));
    const { result } = solveFair<NurbsSurface>(s.value, []);
    for (let i = 0; i < result.cw.length; i++) {
      expect(Math.abs(result.cw[i]! - fit.value.surface.cw[i]!), `cw[${i}]`).toBeLessThanOrEqual(
        PATHS * 200,
      );
    }
  });

  it('planar data are fitted by the plane, with zero bending energy, for any weight', () => {
    const rng = mulberry32(6);
    const n = 80;
    const uv = Float64Array.from({ length: 2 * n }, () => rng());
    const A = [3, -1, 2, 0.5, 4, 1];
    const pts = Float64Array.from({ length: 3 * n }, (_, i) => {
      const k = Math.floor(i / 3);
      const c = i % 3;
      return A[2 * c]! * uv[2 * k]! * 50 + A[2 * c + 1]! * uv[2 * k + 1]! * 50 + c;
    });
    const u = clampedBasis(3, clampedUniformKnots(3, 7));
    const v = clampedBasis(2, clampedUniformKnots(2, 5));
    for (const bend of [1e-6, 1, 1e3]) {
      const fit = approximateSurface(pts, { uv }, { u, v, fairness: { bend, stretch: 0 } });
      if (!fit.ok) throw new Error(JSON.stringify(fit.issues));
      expect(fit.value.maxError).toBeLessThanOrEqual(EXACT * 300);
      // Relative to the bending of a non-planar fit of the same size.
      const rough = approximateSurface(
        pts.map((x, i) => x + (i % 3 === 2 ? 30 * Math.sin(i) : 0)),
        { uv },
        { u, v },
      );
      if (!rough.ok) throw new Error('rough');
      expect(fairnessEnergy(fit.value.surface, { bend: 1 })).toBeLessThanOrEqual(
        1e-13 * fairnessEnergy(rough.value.surface, { bend: 1 }),
      );
    }
  });

  it('smoothing: more weight, less bending and more data error, monotonically', () => {
    const rng = mulberry32(7);
    const m = 80;
    const ts = Float64Array.from({ length: m }, (_, k) => k / (m - 1));
    const pts = Float64Array.from({ length: m }, (_, k) => Math.sin(5 * ts[k]!) * 10 + rng() - 0.5);
    const knots = clampedBasis(3, clampedUniformKnots(3, 30)).knots;
    let lastE = Infinity;
    let lastErr = -Infinity;
    for (const bend of [0, 1e-6, 1e-5, 1e-4, 1e-3, 1e-2]) {
      const fit = approximateCurve(pts, 1, {
        knots,
        params: ts,
        ...(bend > 0 ? { fairness: { bend } } : {}),
      });
      if (!fit.ok) throw new Error(JSON.stringify(fit.issues));
      // The fit's default 'scaled' metric has no reference shape, so it uses
      // one constant speed (the data's box diagonal over the domain): it is
      // the parametric energy times a fixed factor. The trade-off is monotone
      // in the functional that is minimised, so measure that one.
      const e = fairnessEnergy(fit.value.curve, { bend: 1, metric: 'parametric' });
      const err = fit.value.rmsError;
      expect(e, `bend ${bend}`).toBeLessThan(lastE);
      expect(err, `bend ${bend}`).toBeGreaterThan(lastErr);
      lastE = e;
      lastErr = err;
    }
  });

  it('fairness determines control points the data leave free; displacement fairness is refused', () => {
    // 12 control points, 8 data points: underdetermined without fairness.
    const ts = Float64Array.from({ length: 8 }, (_, k) => k / 7);
    const pts = Float64Array.from(ts, (t) => t * t);
    const knots = clampedBasis(3, clampedUniformKnots(3, 12)).knots;
    const bare = approximateCurve(pts, 1, { knots, params: ts });
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.issues[0]!.code).toBe('schoenberg-whitney');
    const faired = approximateCurve(pts, 1, { knots, params: ts, fairness: { bend: 1e-6 } });
    expect(faired.ok).toBe(true);
    expect(() =>
      approximateCurve(pts, 1, { knots, params: ts, fairness: { bend: 1, on: 'displacement' } }),
    ).toThrow(/displacement/);
  });
});
