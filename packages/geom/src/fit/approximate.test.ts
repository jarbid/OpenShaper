// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Least-squares oracles (design §16, `fit` row):
 *
 * - **space reproduction**: data sampled from a spline of the fit's own space
 *   (curves clamped and periodic, surfaces scattered and gridded) give back
 *   that spline, with any positive weights;
 * - **optimality**: the unconstrained solution agrees with a dense Householder
 *   QR solve of the weighted problem built from A2.4 (an independent basis
 *   algorithm); the constrained solution satisfies the KKT conditions — the
 *   weighted residual's gradient lies in the constraints' row space, with the
 *   returned multipliers as coefficients;
 * - **constraints exact**: point, first and second derivative and tangent
 *   direction constraints hold to `constraint`, checked by evaluating the
 *   result; dependent rows are reported (consistent: warning; contradictory:
 *   failure);
 * - **convergence**: approximating a circular arc, the error falls as h^(p+1)
 *   in the knot spacing;
 * - **adaptivity and correction**: the adaptive fit meets its tolerance and
 *   reports its error honestly; parameter correction never increases the
 *   residual;
 * - **book**: with point constraints at the ends the fit is P&T eqs.
 *   9.63–9.67 (ends fixed, interior by least squares), checked against that
 *   system solved by dense QR; without them the ends are free;
 * - **weights**: a point of weight 0 changes nothing, also when the fit
 *   places its own parameters and knots (the oracle is the fit of the other
 *   points alone, matched exactly);
 * - **scale**: constraint residuals of large derivative rows are judged per
 *   unit row norm, so rounding at board scale is not reported as a
 *   contradiction.
 *
 * Tolerances ("scale" = diagonal of the data's bounding box): reproduction
 * `1e-10 · scale` (normal equations square the collocation condition, design
 * §16; measured worst ≈ 1e-12); agreement with QR `1e-10 · scale` (same
 * reason); constraints `constraint` = 1e-9 (design §7) on O(1) data; KKT
 * stationarity `1e-10 ×` the gradient's size (sums of ~m products of O(1)
 * terms); convergence slope within ±0.3 of p + 1.
 */
import { describe, expect, it } from 'vitest';
import {
  approximateCurve,
  approximateSurface,
  basisDersInto,
  basisFunction,
  clampedBasis,
  clampedUniformKnots,
  createScratch,
  curveDerivatives,
  curvePoint,
  DEFAULT_TOLERANCES,
  findSpan,
  interpolatePeriodic,
  isGeomError,
  makeCurve,
  makeSurface,
  parameterize,
  periodicBasis,
  periodicUniformKnots,
  surfaceDerivatives,
  surfacePoint,
} from '../index';
import type {
  Basis,
  CurveConstraint,
  CurveFit,
  GeomErrorCode,
  NurbsCurve,
  Result,
  SurfaceConstraint,
  SurfaceFit,
} from '../index';
import { householderLsq } from '../linalg/dense';
import { mulberry32, randomClampedBasis, randomPeriodicBasis } from '../testing';

const REPRO = 1e-10;
const CONSTRAINT = DEFAULT_TOLERANCES.constraint;
const KKT = 1e-10;

function expectCode(f: () => unknown, code: GeomErrorCode): void {
  try {
    f();
  } catch (e) {
    expect(isGeomError(e, code), String(e)).toBe(true);
    return;
  }
  throw new Error(`expected GeomError ${code}`);
}

function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`fit failed: ${r.issues.map((i) => i.message).join('; ')}`);
  return r.value;
}

function scaleOf(pts: ArrayLike<number>, dim: number): number {
  let s = 0;
  for (let d = 0; d < dim; d++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = d; k < pts.length; k += dim) {
      lo = Math.min(lo, pts[k]!);
      hi = Math.max(hi, pts[k]!);
    }
    s += (hi - lo) ** 2;
  }
  return Math.sqrt(s);
}

function xyz(dim: number, p: unknown): number[] {
  if (dim === 1) return [p as number];
  const q = p as { x: number; y: number; z?: number };
  return dim === 2 ? [q.x, q.y] : [q.x, q.y, q.z!];
}

/** Euclidean control point `i` of a curve. */
function cp(c: NurbsCurve, i: number): number[] {
  const d = c.dim;
  const w = c.cw[i * (d + 1) + d]!;
  return Array.from({ length: d }, (_, k) => c.cw[i * (d + 1) + k]! / w);
}

/** Row `k`-th derivative of every basis function at `t` (dense, length `count`). */
function basisRow(b: Basis, t: number, order: number): Float64Array {
  const row = new Float64Array(b.count);
  if (order === 0) {
    for (let i = 0; i < b.count; i++) row[i] = basisFunction(b, i, t); // A2.4
    return row;
  }
  const span = findSpan(b, t);
  const p1 = b.degree + 1;
  const out = new Float64Array((order + 1) * p1);
  basisDersInto(b, span, t, order, out, 0, createScratch({ maxDegree: b.degree }));
  for (let j = 0; j < p1; j++) {
    const i = (((span - b.degree + j) % b.count) + b.count) % b.count;
    row[i] = row[i]! + out[order * p1 + j]!;
  }
  return row;
}

/**
 * Checks the KKT conditions of a weighted curve fit: `r = AᵀW(q − A x)` must
 * equal `Cᵀμ` for some `μ` (`C` = the test's own constraint rows); returns `μ`.
 */
function kktMultipliers(
  fit: CurveFit,
  pts: ArrayLike<number>,
  weights: ArrayLike<number>,
  rowsC: readonly Float64Array[],
): Float64Array {
  const c = fit.curve;
  const dim = c.dim;
  const N = c.basis.count;
  const r = new Float64Array(dim * N);
  let gsize = 0;
  for (let k = 0; k < fit.params.length; k++) {
    const a = basisRow(c.basis, fit.params[k]!, 0);
    const at = xyz(dim, curvePoint(c, fit.params[k]!));
    for (let d = 0; d < dim; d++) {
      const res = weights[k]! * (pts[k * dim + d]! - at[d]!);
      for (let i = 0; i < N; i++) {
        r[d * N + i] = r[d * N + i]! + a[i]! * res;
        gsize = Math.max(gsize, Math.abs(a[i]! * weights[k]! * pts[k * dim + d]!));
      }
    }
  }
  const m = rowsC.length;
  const Ct = new Float64Array(dim * N * m);
  for (let j = 0; j < m; j++) for (let i = 0; i < dim * N; i++) Ct[i * m + j] = rowsC[j]![i]!;
  const mu = householderLsq(dim * N, m, Ct, r, 1, DEFAULT_TOLERANCES.pivotRel)!;
  for (let i = 0; i < dim * N; i++) {
    let s = 0;
    for (let j = 0; j < m; j++) s += Ct[i * m + j]! * mu[j]!;
    expect(Math.abs(s - r[i]!), `stationarity row ${i}`).toBeLessThanOrEqual(
      KKT * gsize * fit.params.length,
    );
  }
  return mu;
}

/** The dense least-squares oracle: Householder QR on A2.4 basis rows (unit weights). */
function qrFit(b: Basis, ts: ArrayLike<number>, pts: ArrayLike<number>, dim: number): Float64Array {
  const m = ts.length;
  const N = b.count;
  const A = new Float64Array(m * N);
  for (let k = 0; k < m; k++) A.set(basisRow(b, ts[k]!, 0), k * N);
  return householderLsq(m, N, A, pts, dim, DEFAULT_TOLERANCES.pivotRel)!;
}

/**
 * 40 points on r = 1 + 0.3·cos 5a, a ∈ [0, 2π], the first equal to the last
 * (the review's case that the book's eq. 9.69 knots made near-singular).
 */
function rose(m = 40): Float64Array {
  const pts = new Float64Array(2 * m);
  for (let k = 0; k < m; k++) {
    const a = (2 * Math.PI * k) / (m - 1);
    const r = 1 + 0.3 * Math.cos(5 * a);
    pts.set([r * Math.cos(a), r * Math.sin(a)], 2 * k);
  }
  return pts;
}

function slope(hs: readonly number[], errs: readonly number[]): number {
  const x = hs.map(Math.log);
  const y = errs.map(Math.log);
  const mx = x.reduce((a, b) => a + b) / x.length;
  const my = y.reduce((a, b) => a + b) / y.length;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < x.length; i++) {
    sxy += (x[i]! - mx) * (y[i]! - my);
    sxx += (x[i]! - mx) ** 2;
  }
  return sxy / sxx;
}

/** `n` points on the unit half circle, at their angle / π. */
function halfCircle(n: number): { pts: Float64Array; ts: Float64Array } {
  const ts = Float64Array.from({ length: n }, (_, k) => k / (n - 1));
  const pts = Float64Array.from(
    Array.from(ts, (t) => [Math.cos(Math.PI * t), Math.sin(Math.PI * t)]).flat(),
  );
  return { pts, ts };
}

/**
 * Max |C(t) − (cos πt, sin πt)| over a dense sample: the error of a fitted
 * half circle against the parameterisation its data were sampled at.
 */
function arcError(c: NurbsCurve, samples = 4000): number {
  let e = 0;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const q = curvePoint(c, t) as { x: number; y: number };
    e = Math.max(e, Math.hypot(q.x - Math.cos(Math.PI * t), q.y - Math.sin(Math.PI * t)));
  }
  return e;
}

describe('approximateCurve', () => {
  it('reproduces a spline of its own space from weighted samples', () => {
    const rng = mulberry32(41);
    for (const kind of ['clamped', 'periodic'] as const) {
      for (const dim of [1, 2, 3] as const) {
        for (let p = 1; p <= 5; p++) {
          const count = p + 6;
          const basis =
            kind === 'clamped'
              ? randomClampedBasis(rng, p, count)
              : randomPeriodicBasis(rng, p, count);
          const pts = Float64Array.from({ length: count * dim }, () => 2 * rng() - 1);
          const original = makeCurve({ dim, basis, points: pts });
          const m = 300;
          const ts = Float64Array.from({ length: m }, () => rng());
          const data = new Float64Array(m * dim);
          for (let k = 0; k < m; k++) data.set(xyz(dim, curvePoint(original, ts[k]!)), k * dim);
          const weights = Float64Array.from({ length: m }, () => 0.5 + 1.5 * rng());
          const fit = value(
            approximateCurve(data, dim, {
              degree: p,
              periodic: kind === 'periodic',
              knots: basis.knots,
              params: ts,
              dataWeights: weights,
            }),
          );
          const scale = scaleOf(pts, dim);
          for (let i = 0; i < count; i++) {
            const got = cp(fit.curve, i);
            for (let d = 0; d < dim; d++) {
              expect(
                Math.abs(got[d]! - pts[i * dim + d]!),
                `${kind} dim ${dim} p ${p}`,
              ).toBeLessThanOrEqual(REPRO * scale);
            }
          }
          expect(fit.maxError).toBeLessThanOrEqual(REPRO * scale);
          expect(fit.withinTolerance).toBe(true);
          expect(fit.multipliers.length).toBe(0);
        }
      }
    }
  });

  it('agrees with a dense QR solve of the weighted problem', () => {
    const rng = mulberry32(42);
    for (const periodic of [false, true]) {
      for (let p = 1; p <= 4; p++) {
        const m = 60;
        const pts = new Float64Array(m * 3);
        for (let k = 0; k < m; k++) {
          const a = (2 * Math.PI * k) / m;
          pts.set([Math.cos(a) + 0.05 * rng(), Math.sin(2 * a) + 0.05 * rng(), 0.1 * rng()], 3 * k);
        }
        const weights = Float64Array.from({ length: m }, () => 0.2 + rng());
        const fit = value(
          approximateCurve(pts, 3, { degree: p, periodic, count: 10, dataWeights: weights }),
        );
        const b = fit.curve.basis;
        const N = b.count;
        const A = new Float64Array(m * N);
        const q = new Float64Array(m * 3);
        for (let k = 0; k < m; k++) {
          const row = basisRow(b, fit.params[k]!, 0);
          const sw = Math.sqrt(weights[k]!);
          for (let i = 0; i < N; i++) A[k * N + i] = sw * row[i]!;
          for (let d = 0; d < 3; d++) q[k * 3 + d] = sw * pts[k * 3 + d]!;
        }
        const x = householderLsq(m, N, A, q, 3, DEFAULT_TOLERANCES.pivotRel)!;
        const scale = scaleOf(pts, 3);
        for (let i = 0; i < N; i++) {
          const got = cp(fit.curve, i);
          for (let d = 0; d < 3; d++) {
            expect(
              Math.abs(got[d]! - x[i * 3 + d]!),
              `periodic ${periodic} p ${p}`,
            ).toBeLessThanOrEqual(REPRO * scale);
          }
        }
        // The reported errors are the measured ones.
        let max = 0;
        let ss = 0;
        for (let k = 0; k < m; k++) {
          const at = xyz(3, curvePoint(fit.curve, fit.params[k]!));
          const e = Math.hypot(
            at[0]! - pts[3 * k]!,
            at[1]! - pts[3 * k + 1]!,
            at[2]! - pts[3 * k + 2]!,
          );
          max = Math.max(max, e);
          ss += e * e;
        }
        expect(Math.abs(fit.maxError - max)).toBeLessThanOrEqual(Number.EPSILON * scale);
        expect(Math.abs(fit.rmsError - Math.sqrt(ss / m))).toBeLessThanOrEqual(1e-14 * scale);
      }
    }
  });

  it('holds point, derivative and tangent-direction constraints exactly, at a KKT point', () => {
    const rng = mulberry32(43);
    const m = 80;
    const pts = new Float64Array(m * 3);
    for (let k = 0; k < m; k++) {
      const t = k / (m - 1);
      pts.set([3 * t, Math.sin(4 * t) + 0.05 * rng(), t * t + 0.05 * rng()], 3 * k);
    }
    const weights = Float64Array.from({ length: m }, () => 0.5 + rng());
    const dir = { x: 1, y: 2, z: -0.5 };
    const constraints: CurveConstraint<3>[] = [
      { kind: 'point', t: 0, value: { x: 0, y: 0.2, z: 0 } },
      { kind: 'point', t: 1, value: { x: 3, y: -1, z: 1.5 } },
      { kind: 'derivative', t: 0.3, order: 1, value: { x: 3, y: 0, z: 1 } },
      { kind: 'derivative', t: 0.7, order: 2, value: { x: 0, y: -10, z: 2 } },
      { kind: 'tangentDirection', t: 0.5, direction: dir },
    ];
    const r = approximateCurve(pts, 3, { count: 14, dataWeights: weights, constraints });
    const fit = value(r);
    expect(r.issues).toEqual([]);
    const c = fit.curve as NurbsCurve<3>;
    const P0 = curvePoint(c, 0);
    const P1 = curvePoint(c, 1);
    const D1 = curveDerivatives(c, 0.3, 1)[1]!;
    const D2 = curveDerivatives(c, 0.7, 2)[2]!;
    const T = curveDerivatives(c, 0.5, 1)[1]!;
    const dist = (
      a: { x: number; y: number; z: number },
      b: { x: number; y: number; z: number },
    ): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z));
    expect(dist(P0, { x: 0, y: 0.2, z: 0 })).toBeLessThanOrEqual(CONSTRAINT);
    expect(dist(P1, { x: 3, y: -1, z: 1.5 })).toBeLessThanOrEqual(CONSTRAINT);
    expect(dist(D1, { x: 3, y: 0, z: 1 })).toBeLessThanOrEqual(CONSTRAINT);
    expect(dist(D2, { x: 0, y: -10, z: 2 })).toBeLessThanOrEqual(CONSTRAINT);
    const len = Math.hypot(dir.x, dir.y, dir.z);
    const cross = {
      x: (T.y * dir.z - T.z * dir.y) / len,
      y: (T.z * dir.x - T.x * dir.z) / len,
      z: (T.x * dir.y - T.y * dir.x) / len,
    };
    expect(Math.hypot(cross.x, cross.y, cross.z)).toBeLessThanOrEqual(2 * CONSTRAINT);
    // The condition is linear, so it also admits the opposite sense: here the
    // data's own tangent at t = 0.5 projects negatively onto dir, and so does C′.
    // 3 + 3 + 3 + 3 point/derivative rows, then 2 tangent rows.
    expect(fit.multipliers.length).toBe(14);

    // KKT with the test's own rows (A2.4 / A2.3; any basis of d⊥ for the tangent).
    const b = c.basis;
    const N = b.count;
    const rows: Float64Array[] = [];
    const coordRows = (t: number, order: number): void => {
      const a = basisRow(b, t, order);
      for (let d = 0; d < 3; d++) {
        const row = new Float64Array(3 * N);
        row.set(a, d * N);
        rows.push(row);
      }
    };
    coordRows(0, 0);
    coordRows(1, 0);
    coordRows(0.3, 1);
    coordRows(0.7, 2);
    const a = basisRow(b, 0.5, 1);
    for (const nrm of [
      [2, -1, 0],
      [0.5, 0, 1],
    ]) {
      const row = new Float64Array(3 * N);
      for (let d = 0; d < 3; d++) for (let i = 0; i < N; i++) row[d * N + i] = nrm[d]! * a[i]!;
      rows.push(row);
    }
    const mu = kktMultipliers(fit, pts, weights, rows);
    // Point and derivative rows: the returned multipliers are those coefficients.
    for (let j = 0; j < 12; j++) {
      expect(Math.abs(fit.multipliers[j]! - mu[j]!)).toBeLessThanOrEqual(
        1e-8 * Math.max(1, Math.abs(mu[j]!)),
      );
    }
  });

  it('reports dependent constraints: consistent as a warning, contradictory as a failure', () => {
    const { pts } = halfCircle(40);
    const same: CurveConstraint<2>[] = [
      { kind: 'point', t: 0, value: { x: 1, y: 0 } },
      { kind: 'point', t: 0, value: { x: 1, y: 0 } },
    ];
    const ok = approximateCurve(pts, 2, { count: 8, constraints: same });
    expect(ok.ok).toBe(true);
    expect(ok.issues.map((i) => [i.code, i.severity])).toEqual([
      ['dependent-constraints', 'warning'],
      ['dependent-constraints', 'warning'],
    ]);
    const P0 = curvePoint(value(ok).curve as NurbsCurve<2>, 0);
    expect(Math.hypot(P0.x - 1, P0.y)).toBeLessThanOrEqual(CONSTRAINT);
    const clash: CurveConstraint<2>[] = [
      { kind: 'point', t: 0, value: { x: 1, y: 0 } },
      { kind: 'point', t: 0, value: { x: 1.1, y: 0 } },
    ];
    const bad = approximateCurve(pts, 2, { count: 8, constraints: clash });
    expect(bad.ok).toBe(false);
    expect(bad.issues.some((i) => i.code === 'inconsistent-constraints')).toBe(true);
  });

  it('converges as h^(p+1) approximating a circular arc', () => {
    // 2,001 samples of the half circle at t = angle / π; uniform knots. Measured
    // local slopes: p = 2: 3.11, 3.05, 3.05; 3: 4.16, 4.02, 4.01; 4: 5.21, 5.02, 5.01.
    const { pts, ts } = halfCircle(2001);
    for (const p of [2, 3, 4]) {
      const hs: number[] = [];
      const errs: number[] = [];
      for (const spans of [4, 8, 16, 32]) {
        const knots = clampedUniformKnots(p, spans + p, [0, 1]);
        const fit = value(approximateCurve(pts, 2, { degree: p, knots, params: ts }));
        const e = arcError(fit.curve);
        hs.push(1 / spans);
        errs.push(e);
      }
      expect(Math.abs(slope(hs, errs) - (p + 1)), `p ${p}: ${errs.join(', ')}`).toBeLessThanOrEqual(
        0.3,
      );
    }
  });

  it('adds knots until the tolerance holds, and reports the error honestly', () => {
    const { pts } = halfCircle(500);
    for (const tolerance of [1e-3, 1e-5, 1e-7]) {
      const fit = value(approximateCurve(pts, 2, { tolerance }));
      expect(fit.withinTolerance).toBe(true);
      expect(fit.maxError).toBeLessThanOrEqual(tolerance);
      let max = 0;
      for (let k = 0; k < 500; k++) {
        const q = curvePoint(fit.curve as NurbsCurve<2>, fit.params[k]!);
        max = Math.max(max, Math.hypot(q.x - pts[2 * k]!, q.y - pts[2 * k + 1]!));
      }
      expect(Math.abs(max - fit.maxError)).toBeLessThanOrEqual(Number.EPSILON * 4);
      // Far fewer control points than data: the error is reached by refinement, not interpolation.
      expect(fit.curve.basis.count).toBeLessThan(80);
    }
    const capped = value(approximateCurve(pts, 2, { tolerance: 1e-9, maxCount: 6 }));
    expect(capped.withinTolerance).toBe(false);
    expect(capped.curve.basis.count).toBeLessThanOrEqual(6);
    expect(capped.maxError).toBeGreaterThan(1e-9);
  });

  it('adapts a periodic fit around a closed curve', () => {
    const n = 400;
    const pts = new Float64Array(2 * n);
    for (let k = 0; k < n; k++) {
      const a = (2 * Math.PI * k) / n;
      pts.set([2 * Math.cos(a), Math.sin(a) + 0.3 * Math.sin(3 * a)], 2 * k);
    }
    const fit = value(approximateCurve(pts, 2, { periodic: true, tolerance: 1e-6 }));
    expect(fit.curve.basis.kind).toBe('periodic');
    expect(fit.curve.basis.domain).toEqual([0, 1]);
    expect(fit.maxError).toBeLessThanOrEqual(1e-6);
    // C² across the seam (cubic, simple knots).
    const L = curveDerivatives(fit.curve as NurbsCurve<2>, 0, 2, 'left');
    const R = curveDerivatives(fit.curve as NurbsCurve<2>, 0, 2, 'right');
    for (let k = 0; k <= 2; k++) {
      const size = Math.max(1, Math.hypot(R[k]!.x, R[k]!.y));
      expect(Math.hypot(L[k]!.x - R[k]!.x, L[k]!.y - R[k]!.y)).toBeLessThanOrEqual(1e-9 * size);
    }
  });

  it('never increases the residual by parameter correction', () => {
    // Chord-length parameters on an unevenly sampled arc are poor foot points.
    const n = 120;
    const pts = new Float64Array(2 * n);
    for (let k = 0; k < n; k++) {
      const a = Math.PI * (k / (n - 1)) ** 2;
      pts.set([Math.cos(a), 0.5 * Math.sin(a)], 2 * k);
    }
    let prev = Infinity;
    const rms: number[] = [];
    for (let passes = 0; passes <= 4; passes++) {
      const fit = value(
        approximateCurve(pts, 2, { count: 8, params: 'chord', parameterCorrection: passes }),
      );
      expect(fit.rmsError).toBeLessThanOrEqual(prev);
      prev = fit.rmsError;
      rms.push(fit.rmsError);
    }
    // Alternating projection and refit converges linearly; measured 0.57 after 4 passes.
    expect(rms[4]!).toBeLessThan(0.7 * rms[0]!);
  });

  it('stays well conditioned and QR-exact up to count = number of points', () => {
    // Centred least-squares knots: the collocation condition stays below ~11 for
    // every count here (with eq. 9.69's knots it reaches 1e7 at 37 and 1e18 at
    // 40), so the normal equations agree with QR to the reproduction tolerance.
    const pts = rose();
    const m = 40;
    const scale = scaleOf(pts, 2);
    for (const p of [2, 3, 4]) {
      for (const count of [p + 1, 10, 20, 30, 35, 36, 37, 38, 39, 40]) {
        const r = approximateCurve(pts, 2, { degree: p, count, params: 'centripetal' });
        const fit = value(r);
        expect(r.issues).toEqual([]);
        const x = qrFit(fit.curve.basis, fit.params, pts, 2);
        let qrMax = 0;
        const N = fit.curve.basis.count;
        for (let k = 0; k < m; k++) {
          const row = basisRow(fit.curve.basis, fit.params[k]!, 0);
          let ex = -pts[2 * k]!;
          let ey = -pts[2 * k + 1]!;
          for (let i = 0; i < N; i++) {
            ex += row[i]! * x[2 * i]!;
            ey += row[i]! * x[2 * i + 1]!;
          }
          qrMax = Math.max(qrMax, Math.hypot(ex, ey));
        }
        for (let i = 0; i < N; i++) {
          const got = cp(fit.curve, i);
          expect(
            Math.hypot(got[0]! - x[2 * i]!, got[1]! - x[2 * i + 1]!),
            `p ${p} count ${count} control point ${i}`,
          ).toBeLessThanOrEqual(REPRO * scale);
        }
        expect(Math.abs(fit.maxError - qrMax), `p ${p} count ${count}`).toBeLessThanOrEqual(
          REPRO * scale,
        );
        // count = points is interpolation.
        if (count === m) expect(fit.maxError).toBeLessThanOrEqual(REPRO * scale);
      }
    }
  });

  it('rejects knots that leave the normal equations numerically singular', () => {
    // Eq. 9.69 as printed, for 40 parameters and 39 cubic control points, puts
    // the first interior knot 0.11 of a parameter spacing from ū_0. Every pivot
    // passes, but the estimated reciprocal condition is ~2e-18: an error, not a
    // fit with meaningless control points (it used to return one 6% off the
    // least-squares optimum at the data).
    const pts = rose();
    const ub = parameterize(pts, 2, 'centripetal');
    const book969 = (p: number, count: number): Float64Array => {
      const mm = ub.length - 1;
      const n = count - 1;
      const U = new Float64Array(count + p + 1);
      for (let i = 0; i <= p; i++) U[n + p + 1 - i] = 1;
      const d = (mm + 1) / (n - p + 1);
      for (let j = 1; j <= n - p; j++) {
        const i = Math.floor(j * d);
        const a = j * d - i;
        U[p + j] = (1 - a) * ub[i - 1]! + a * ub[i]!;
      }
      return U;
    };
    const bad = approximateCurve(pts, 2, { degree: 3, knots: book969(3, 39), params: ub });
    expect(bad.ok).toBe(false);
    expect(bad.issues[0]!.code).toBe('schoenberg-whitney');
    expect(bad.issues[0]!.value).toBeLessThanOrEqual(DEFAULT_TOLERANCES.pivotRel);
    // The same rule at a modest count is well conditioned and accepted.
    const fine = value(approximateCurve(pts, 2, { degree: 3, knots: book969(3, 10), params: ub }));
    const x = qrFit(fine.curve.basis, fine.params, pts, 2);
    for (let i = 0; i < 10; i++) {
      const got = cp(fine.curve, i);
      expect(Math.hypot(got[0]! - x[2 * i]!, got[1]! - x[2 * i + 1]!)).toBeLessThanOrEqual(
        REPRO * scaleOf(pts, 2),
      );
    }
  });

  it('fits a periodic curve with count = number of points, any degree (interpolation)', () => {
    // Even degrees once put every knot on a data site here, a singular cyclic
    // system; the centred rule gives the interpolation knots instead, so the
    // fit is interpolatePeriodic's, knots and shifted parameters included.
    for (const n of [7, 8, 10]) {
      const pts = new Float64Array(2 * n);
      for (let k = 0; k < n; k++)
        pts.set([Math.cos((2 * Math.PI * k) / n), Math.sin((2 * Math.PI * k) / n)], 2 * k);
      for (const p of [2, 3, 4]) {
        const r = approximateCurve(pts, 2, {
          degree: p,
          periodic: true,
          count: n,
          params: 'uniform',
        });
        const fit = value(r);
        expect(r.issues).toEqual([]);
        const ref = interpolatePeriodic(pts, 2, { degree: p, params: 'uniform' });
        const tag = `n ${n} p ${p}`;
        // Knots and parameters: (1 − α)a + αb against a mean of p values, a few ε apart.
        for (let j = 0; j < n; j++) {
          expect(
            Math.abs(fit.curve.basis.knots[j]! - ref.curve.basis.knots[j]!),
            tag,
          ).toBeLessThanOrEqual(8 * Number.EPSILON);
          expect(Math.abs(fit.params[j]! - ref.params[j]!), tag).toBeLessThanOrEqual(
            8 * Number.EPSILON,
          );
        }
        for (let i = 0; i < n; i++) {
          const a = cp(fit.curve, i);
          const b = cp(ref.curve, i);
          expect(Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!), tag).toBeLessThanOrEqual(REPRO * 2);
        }
        expect(fit.maxError, tag).toBeLessThanOrEqual(REPRO * 2);
      }
    }
  });

  it('holds constraints at a KKT point on a periodic fit, across the seam', () => {
    const rng = mulberry32(47);
    const m = 60;
    const pts = new Float64Array(m * 2);
    for (let k = 0; k < m; k++) {
      const a = (2 * Math.PI * k) / m;
      pts.set([2 * Math.cos(a) + 0.05 * rng(), Math.sin(a) + 0.05 * rng()], 2 * k);
    }
    const weights = Float64Array.from({ length: m }, () => 0.5 + rng());
    const constraints: CurveConstraint<2>[] = [
      { kind: 'point', t: 0, value: { x: 2.1, y: 0 } },
      { kind: 'derivative', t: 0, order: 2, value: { x: -70, y: 1 } },
      { kind: 'point', t: 0.45, value: { x: -1.9, y: 0.4 } },
      { kind: 'derivative', t: 0.7, order: 1, value: { x: -5, y: -1 } },
    ];
    for (const p of [2, 3]) {
      const r = approximateCurve(pts, 2, {
        degree: p,
        periodic: true,
        count: 12,
        dataWeights: weights,
        constraints,
      });
      const fit = value(r);
      expect(r.issues).toEqual([]);
      const c = fit.curve as NurbsCurve<2>;
      expect(c.basis.kind).toBe('periodic');
      const near = (q: { x: number; y: number }, x: number, y: number): number =>
        Math.max(Math.abs(q.x - x), Math.abs(q.y - y));
      expect(near(curvePoint(c, 0), 2.1, 0)).toBeLessThanOrEqual(CONSTRAINT);
      expect(near(curveDerivatives(c, 0, 2)[2]!, -70, 1)).toBeLessThanOrEqual(CONSTRAINT);
      expect(near(curvePoint(c, 0.45), -1.9, 0.4)).toBeLessThanOrEqual(CONSTRAINT);
      expect(near(curveDerivatives(c, 0.7, 1)[1]!, -5, -1)).toBeLessThanOrEqual(CONSTRAINT);
      const N = c.basis.count;
      const rows: Float64Array[] = [];
      for (const [t, order] of [
        [0, 0],
        [0, 2],
        [0.45, 0],
        [0.7, 1],
      ] as const) {
        const a = basisRow(c.basis, t, order);
        for (let d = 0; d < 2; d++) {
          const row = new Float64Array(2 * N);
          row.set(a, d * N);
          rows.push(row);
        }
      }
      const mu = kktMultipliers(fit, pts, weights, rows);
      for (let j = 0; j < 8; j++) {
        expect(Math.abs(fit.multipliers[j]! - mu[j]!), `p ${p} row ${j}`).toBeLessThanOrEqual(
          1e-8 * Math.max(1, Math.abs(mu[j]!)),
        );
      }
    }
  });

  it('never increases the residual by parameter correction on a periodic fit', () => {
    // An ellipse sampled unevenly in angle: uniform parameters are poor foot points.
    const n = 90;
    const pts = new Float64Array(2 * n);
    for (let k = 0; k < n; k++) {
      const s = k / n;
      const a = 2 * Math.PI * (s + 0.12 * Math.sin(2 * Math.PI * s));
      pts.set([2 * Math.cos(a), Math.sin(a)], 2 * k);
    }
    let prev = Infinity;
    const rms: number[] = [];
    for (let passes = 0; passes <= 4; passes++) {
      const r = approximateCurve(pts, 2, {
        periodic: true,
        count: 10,
        params: 'uniform',
        parameterCorrection: passes,
      });
      const fit = value(r);
      expect(r.issues).toEqual([]);
      expect(fit.rmsError).toBeLessThanOrEqual(prev);
      // Corrected parameters stay in the periodic domain [0, 1).
      for (const t of fit.params) expect(t >= 0 && t < 1).toBe(true);
      prev = fit.rmsError;
      rms.push(fit.rmsError);
    }
    expect(rms[4]!).toBeLessThan(0.7 * rms[0]!);
  });

  it('ignores a point of weight 0', () => {
    const { pts, ts } = halfCircle(50);
    const knots = clampedUniformKnots(3, 9, [0, 1]);
    const base = value(approximateCurve(pts, 2, { knots, params: ts }));
    const withOutlier = Float64Array.from([...pts, 5, 5]);
    const tsOut = Float64Array.from([...ts, 0.4]);
    const w = Float64Array.from({ length: 51 }, (_, k) => (k === 50 ? 0 : 1));
    const fit = value(approximateCurve(withOutlier, 2, { knots, params: tsOut, dataWeights: w }));
    for (let i = 0; i < 9; i++) {
      const a = cp(base.curve, i);
      const b = cp(fit.curve, i);
      expect(Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!)).toBeLessThanOrEqual(1e-12 * 2);
    }
    expect(Math.abs(fit.maxError - base.maxError)).toBeLessThanOrEqual(1e-12 * 2);
  });

  it('ignores a point of weight 0 also when it would place the parameters and knots', () => {
    // Oracle: the fit of the other points alone. Parameters, knots, centre and
    // the normal equations' sums are then the same numbers in the same order,
    // so the control points must agree exactly, not to a tolerance.
    const closed = new Float64Array(2 * 40);
    for (let k = 0; k < 40; k++) {
      const a = (2 * Math.PI * k) / 40;
      closed.set([Math.cos(a) * (1 + 0.2 * Math.cos(3 * a)), Math.sin(a)], 2 * k);
    }
    const cases = [
      { pts: halfCircle(50).pts, opts: { count: 8 } },
      { pts: halfCircle(50).pts, opts: { tolerance: 1e-6 } },
      { pts: halfCircle(50).pts, opts: { count: 8, params: 'chord' as const } },
      { pts: closed, opts: { count: 9, periodic: true } },
      { pts: closed, opts: { tolerance: 1e-5, periodic: true } },
    ];
    for (const { pts, opts } of cases) {
      const n = pts.length / 2;
      const base = value(approximateCurve(pts, 2, opts));
      for (const at of [0, 25, n]) {
        const withOutlier = Float64Array.from([
          ...pts.subarray(0, 2 * at),
          5,
          5,
          ...pts.subarray(2 * at),
        ]);
        const w = Float64Array.from({ length: n + 1 }, (_, k) => (k === at ? 0 : 1));
        const fit = value(approximateCurve(withOutlier, 2, { ...opts, dataWeights: w }));
        const label = `${JSON.stringify(opts)} outlier at ${at}`;
        expect(Array.from(fit.curve.basis.knots), label).toEqual(
          Array.from(base.curve.basis.knots),
        );
        expect(Array.from(fit.curve.cw), label).toEqual(Array.from(base.curve.cw));
        expect(fit.maxError, label).toBe(base.maxError);
        expect(fit.rmsError, label).toBe(base.rmsError);
        const all = Array.from(fit.params);
        const rest = [...all.slice(0, at), ...all.slice(at + 1)];
        expect(rest, label).toEqual(Array.from(base.params));
        // The outlier's reported parameter lies between its neighbours' (clamped,
        // or across the seam when periodic).
        const u = fit.params[at]!;
        expect(u >= 0 && u <= 1, label).toBe(true);
        if (!opts.periodic && at > 0 && at < n) {
          expect(u >= fit.params[at - 1]! && u <= fit.params[at + 1]!, label).toBe(true);
        }
      }
    }
    // Explicit parameters: knots come from those of positive weight, on [0, 1].
    const { pts, ts } = halfCircle(50);
    const base = value(approximateCurve(pts, 2, { count: 8, params: ts }));
    const outlier = Float64Array.from([5, 5, ...pts]);
    const tsOut = Float64Array.from([0, ...ts.map((t) => (t === 0 ? 1e-3 : t))]);
    const w = Float64Array.from({ length: 51 }, (_, k) => (k === 0 ? 0 : 1));
    const fit = value(approximateCurve(outlier, 2, { count: 8, params: tsOut, dataWeights: w }));
    const kb = base.curve.basis.knots;
    const kf = fit.curve.basis.knots;
    expect(kf[0]).toBe(0);
    expect(kf[kf.length - 1]).toBe(1);
    // Interior knots: the centred rule on the shifted first parameter moves
    // them by at most the shift (1e-3) times their weight in the interpolation.
    for (let i = 4; i < kb.length - 4; i++)
      expect(Math.abs(kf[i]! - kb[i]!)).toBeLessThanOrEqual(1e-3);
    expect(fit.maxError).toBeLessThan(10 * base.maxError);
    expectCode(
      () =>
        approximateCurve(pts, 2, {
          count: 5,
          dataWeights: Float64Array.from({ length: 50 }, (_, k) => (k < 4 ? 1 : 0)),
        }),
      'too-few-points',
    );
    expectCode(
      () =>
        approximateCurve(pts, 2, {
          dataWeights: Float64Array.from({ length: 50 }, (_, k) => (k < 3 ? 1 : 0)),
        }),
      'too-few-points',
    );
  });

  it('is P&T eqs. 9.63–9.67 with point constraints at the ends; without them the ends are free', () => {
    // §9.4.1 fixes P_0 = Q_0 and P_n = Q_m and solves (NᵀN) P = R for the
    // interior points, R_k = Q_k − N_0(ū_k) Q_0 − N_n(ū_k) Q_m (eqs. 9.63–9.67).
    // Oracle: that system by dense Householder QR on A2.4 basis rows, on the
    // fit's own knots and parameters. Tolerance REPRO (normal equations).
    const rng = mulberry32(47);
    const m1 = 50;
    const pts = new Float64Array(2 * m1);
    for (let k = 0; k < m1; k++) {
      const x = (6 * k) / (m1 - 1);
      pts.set([x, Math.sin(x) + 0.01 * (rng() - 0.5)], 2 * k);
    }
    const Q0 = { x: pts[0]!, y: pts[1]! };
    const Qm = { x: pts[2 * m1 - 2]!, y: pts[2 * m1 - 1]! };
    const free = value(approximateCurve(pts, 2, { count: 8 }));
    const book = value(
      approximateCurve(pts, 2, {
        count: 8,
        constraints: [
          { kind: 'point', t: 0, value: Q0 },
          { kind: 'point', t: 1, value: Qm },
        ],
      }),
    );
    expect(Array.from(book.params)).toEqual(Array.from(free.params));
    const b = book.curve.basis;
    const N = b.count;
    const A = new Float64Array((m1 - 2) * (N - 2));
    const R = new Float64Array((m1 - 2) * 2);
    for (let k = 1; k < m1 - 1; k++) {
      const row = basisRow(b, book.params[k]!, 0);
      for (let i = 1; i < N - 1; i++) A[(k - 1) * (N - 2) + i - 1] = row[i]!;
      R[(k - 1) * 2] = pts[2 * k]! - row[0]! * Q0.x - row[N - 1]! * Qm.x;
      R[(k - 1) * 2 + 1] = pts[2 * k + 1]! - row[0]! * Q0.y - row[N - 1]! * Qm.y;
    }
    const P = householderLsq(m1 - 2, N - 2, A, R, 2, DEFAULT_TOLERANCES.pivotRel)!;
    const scale = scaleOf(pts, 2);
    expect(
      Math.hypot(cp(book.curve, 0)[0]! - Q0.x, cp(book.curve, 0)[1]! - Q0.y),
    ).toBeLessThanOrEqual(CONSTRAINT);
    for (let i = 1; i < N - 1; i++) {
      const got = cp(book.curve, i);
      expect(Math.abs(got[0]! - P[(i - 1) * 2]!), `P_${i}`).toBeLessThanOrEqual(REPRO * scale);
      expect(Math.abs(got[1]! - P[(i - 1) * 2 + 1]!), `P_${i}`).toBeLessThanOrEqual(REPRO * scale);
    }
    // Unconstrained, the fit is closer overall and does not pass through the ends
    // (its gaps are of the order of the ±0.005 noise).
    expect(free.rmsError).toBeLessThan(book.rmsError);
    const c0 = cp(free.curve, 0);
    expect(Math.hypot(c0[0]! - Q0.x, c0[1]! - Q0.y)).toBeGreaterThan(1e-4);
  });

  it('judges constraint residuals per unit row norm, so large derivative rows do not misfire', () => {
    // A board-scale curve (300 cm, 300 control points) with C″(0) = 0 given
    // twice (consistent, dependent) and C′(1) fixed; and a 3000 cm curve. The
    // C″ rows have norm ~5e5: rounding alone left raw residuals of 4e-9, which
    // an absolute 1e-9 test called inconsistent (a failure) or inexact.
    for (const [S, count] of [
      [300, 300],
      [3000, 80],
    ] as const) {
      const n = 1000;
      const pts = new Float64Array(3 * n);
      for (let k = 0; k < n; k++) {
        const t = k / (n - 1);
        pts.set([S * t, 0.01 * S * Math.sin(6 * t), 0.003 * S * Math.cos(5 * t)], 3 * k);
      }
      const zero = { x: 0, y: 0, z: 0 };
      const end = { x: S, y: 0, z: 0 };
      const r = approximateCurve(pts, 3, {
        count,
        constraints: [
          { kind: 'derivative', t: 0, order: 2, value: zero },
          { kind: 'derivative', t: 0, order: 2, value: zero },
          { kind: 'derivative', t: 1, order: 1, value: end },
        ],
      });
      const label = `S ${S} count ${count}: ${r.issues.map((i) => i.message).join('; ')}`;
      expect(r.ok, label).toBe(true);
      expect(new Set(r.issues.map((i) => i.code)), label).toEqual(
        new Set(['dependent-constraints']),
      );
      // The constraints hold to rounding relative to the derivative's size.
      const c = value(r).curve as NurbsCurve<3>;
      const [, , d2] = curveDerivatives(c, 0, 2);
      const [, d1] = curveDerivatives(c, 1, 1);
      expect(Math.hypot(d2!.x, d2!.y, d2!.z), label).toBeLessThanOrEqual(1e-12 * S * count ** 2);
      expect(Math.hypot(d1!.x - S, d1!.y, d1!.z), label).toBeLessThanOrEqual(1e-12 * S * count);
    }
    // A real contradiction in a derivative row is still a failure.
    const { pts } = halfCircle(200);
    const bad = approximateCurve(pts, 2, {
      count: 40,
      constraints: [
        { kind: 'derivative', t: 0, order: 1, value: { x: 0, y: 3 } },
        { kind: 'derivative', t: 0, order: 1, value: { x: 0, y: 3.001 } },
      ],
    });
    expect(bad.ok).toBe(false);
    expect(bad.issues.some((i) => i.code === 'inconsistent-constraints')).toBe(true);
  });

  it('returns data-dependent failures and throws on invalid input', () => {
    const { pts, ts } = halfCircle(30);
    // Every parameter in [0, 0.5): the control points of the last spans are undetermined.
    const crowded = Float64Array.from(ts, (t) => t / 2.01);
    crowded[29] = 1;
    const knots = clampedUniformKnots(3, 12, [0, 1]);
    const r = approximateCurve(pts, 2, { knots, params: crowded });
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.code).toBe('schoenberg-whitney');
    expectCode(() => approximateCurve(pts, 2, { knots, count: 8 }), 'unsupported');
    expectCode(() => approximateCurve(pts, 2, { count: 31 }), 'too-few-points');
    expectCode(() => approximateCurve(pts, 2, { count: 3 }), 'too-few-points');
    expectCode(() => approximateCurve(pts, 2, { dataWeights: [1] }), 'size-mismatch');
    expectCode(
      () => approximateCurve(pts, 2, { dataWeights: Float64Array.from({ length: 30 }, () => -1) }),
      'weight-not-positive',
    );
    expectCode(
      () =>
        approximateCurve(pts, 2, {
          constraints: [{ kind: 'point', t: 1.5, value: { x: 0, y: 0 } }],
        }),
      'param-out-of-domain',
    );
    expectCode(
      () =>
        approximateCurve([0, 1, 2, 3, 4], 1, {
          constraints: [{ kind: 'tangentDirection', t: 0, direction: 1 }],
        }),
      'unsupported',
    );
    expectCode(
      () =>
        approximateCurve(pts, 2, {
          degree: 1,
          constraints: [{ kind: 'derivative', t: 0, order: 2, value: { x: 0, y: 0 } }],
        }),
      'unsupported',
    );
  });
});

describe('approximateSurface', () => {
  it('reproduces a surface of its own space from scattered weighted samples', () => {
    const rng = mulberry32(51);
    for (const [pu, pv] of [
      [false, false],
      [true, false],
      [false, true],
    ] as const) {
      const p = 3;
      const q = 2;
      const bu = pu
        ? periodicBasis(p, periodicUniformKnots(7), 1)
        : clampedBasis(p, clampedUniformKnots(p, 7, [0, 1]));
      const bv = pv
        ? periodicBasis(q, periodicUniformKnots(6), 1)
        : clampedBasis(q, clampedUniformKnots(q, 5, [0, 1]));
      const net = Float64Array.from({ length: bu.count * bv.count * 3 }, () => 2 * rng() - 1);
      const S = makeSurface({ u: bu, v: bv, points: net });
      const m = 600;
      const uv = Float64Array.from({ length: 2 * m }, () => rng());
      const pts = new Float64Array(3 * m);
      for (let k = 0; k < m; k++) {
        const x = surfacePoint(S, uv[2 * k]!, uv[2 * k + 1]!);
        pts.set([x.x, x.y, x.z], 3 * k);
      }
      const weights = Float64Array.from({ length: m }, () => 0.5 + rng());
      const fit = value(approximateSurface(pts, { uv }, { u: bu, v: bv, dataWeights: weights }));
      const scale = scaleOf(net, 3);
      for (let i = 0; i < bu.count * bv.count; i++) {
        for (let c = 0; c < 3; c++) {
          expect(Math.abs(fit.surface.cw[i * 4 + c]! - net[i * 3 + c]!)).toBeLessThanOrEqual(
            REPRO * scale,
          );
        }
      }
      expect(fit.maxError).toBeLessThanOrEqual(REPRO * scale);
      expect(fit.withinTolerance).toBe(true);
    }
  });

  it('reproduces a bicubic height field from a grid', () => {
    const rng = mulberry32(52);
    const a = Array.from({ length: 16 }, () => 2 * rng() - 1);
    const f = (u: number, v: number): number => {
      let s = 0;
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) s += a[i * 4 + j]! * u ** i * v ** j;
      return s;
    };
    const rows = 15;
    const cols = 12;
    const g = new Float64Array(rows * cols * 3);
    for (let k = 0; k < rows; k++) {
      for (let l = 0; l < cols; l++) {
        const u = k / (rows - 1);
        const v = l / (cols - 1);
        g.set([u, v, f(u, v)], (k * cols + l) * 3);
      }
    }
    const bu = clampedBasis(3, clampedUniformKnots(3, 6, [0, 1]));
    const bv = clampedBasis(3, clampedUniformKnots(3, 5, [0, 1]));
    const fit = value(approximateSurface(g, { rows, cols }, { u: bu, v: bv, params: 'uniform' }));
    for (let i = 0; i < 100; i++) {
      const u = rng();
      const v = rng();
      const x = surfacePoint(fit.surface, u, v);
      expect(Math.hypot(x.x - u, x.y - v, x.z - f(u, v))).toBeLessThanOrEqual(REPRO * 2);
    }
  });

  it('agrees with a dense QR solve and holds its constraints', () => {
    const rng = mulberry32(53);
    const bu = clampedBasis(3, clampedUniformKnots(3, 6, [0, 1]));
    const bv = clampedBasis(2, clampedUniformKnots(2, 5, [0, 1]));
    const m = 300;
    const uv = Float64Array.from({ length: 2 * m }, () => rng());
    const pts = new Float64Array(3 * m);
    for (let k = 0; k < m; k++) {
      const u = uv[2 * k]!;
      const v = uv[2 * k + 1]!;
      pts.set(
        [u + 0.01 * rng(), v + 0.01 * rng(), Math.sin(3 * u) * Math.cos(2 * v) + 0.02 * rng()],
        3 * k,
      );
    }
    const weights = Float64Array.from({ length: m }, () => 0.3 + rng());
    const fit = value(approximateSurface(pts, { uv }, { u: bu, v: bv, dataWeights: weights }));
    const N = bu.count * bv.count;
    const A = new Float64Array(m * N);
    const qv = new Float64Array(m * 3);
    for (let k = 0; k < m; k++) {
      const ru = basisRow(bu, uv[2 * k]!, 0);
      const rv = basisRow(bv, uv[2 * k + 1]!, 0);
      const sw = Math.sqrt(weights[k]!);
      for (let i = 0; i < bu.count; i++)
        for (let j = 0; j < bv.count; j++) A[k * N + i * bv.count + j] = sw * ru[i]! * rv[j]!;
      for (let c = 0; c < 3; c++) qv[k * 3 + c] = sw * pts[k * 3 + c]!;
    }
    const x = householderLsq(m, N, A, qv, 3, DEFAULT_TOLERANCES.pivotRel)!;
    for (let i = 0; i < N * 3; i++) {
      expect(
        Math.abs(fit.surface.cw[Math.floor(i / 3) * 4 + (i % 3)]! - x[i]!),
      ).toBeLessThanOrEqual(REPRO * 2);
    }

    const constraints: SurfaceConstraint[] = [
      { kind: 'point', uv: { u: 0, v: 0 }, value: { x: 0, y: 0, z: 0.5 } },
      { kind: 'point', uv: { u: 0.5, v: 0.5 }, value: { x: 99, y: 99, z: 1 }, axes: 4 },
      { kind: 'derivative', uv: { u: 1, v: 1 }, du: 1, dv: 0, value: { x: 1, y: 0, z: -2 } },
      { kind: 'derivative', uv: { u: 0.3, v: 0.6 }, du: 1, dv: 1, value: { x: 0, y: 0, z: 0 } },
    ];
    const r = approximateSurface(pts, { uv }, { u: bu, v: bv, dataWeights: weights, constraints });
    const cf = value(r);
    expect(r.issues).toEqual([]);
    expect(cf.multipliers.length).toBe(3 + 1 + 3 + 3);
    const d00 = surfacePoint(cf.surface, 0, 0);
    expect(Math.max(Math.abs(d00.x), Math.abs(d00.y), Math.abs(d00.z - 0.5))).toBeLessThanOrEqual(
      CONSTRAINT,
    );
    const mid = surfacePoint(cf.surface, 0.5, 0.5);
    expect(Math.abs(mid.z - 1)).toBeLessThanOrEqual(CONSTRAINT);
    expect(Math.abs(mid.x - 99)).toBeGreaterThan(1); // unselected axes are free
    const d11 = surfaceDerivatives(cf.surface, 1, 1, 1);
    expect(
      Math.max(Math.abs(d11.Su.x - 1), Math.abs(d11.Su.y), Math.abs(d11.Su.z + 2)),
    ).toBeLessThanOrEqual(CONSTRAINT);
    const tw = surfaceDerivatives(cf.surface, 0.3, 0.6, 2);
    expect(
      Math.max(Math.abs(tw.Suv.x), Math.abs(tw.Suv.y), Math.abs(tw.Suv.z)),
    ).toBeLessThanOrEqual(CONSTRAINT);
    expect(cf.maxError).toBeGreaterThan(fit.maxError * 0.999); // constraints cost accuracy, never gain it
  });

  it('never increases the residual by parameter correction', () => {
    const rng = mulberry32(54);
    const rows = 12;
    const cols = 10;
    const g = new Float64Array(rows * cols * 3);
    for (let k = 0; k < rows; k++) {
      for (let l = 0; l < cols; l++) {
        const s = (k / (rows - 1)) ** 2;
        const t = l / (cols - 1);
        g.set([Math.cos(s * 2), Math.sin(s * 2), t + 0.1 * s * rng()], (k * cols + l) * 3);
      }
    }
    const bu = clampedBasis(3, clampedUniformKnots(3, 6, [0, 1]));
    const bv = clampedBasis(3, clampedUniformKnots(3, 5, [0, 1]));
    let prev = Infinity;
    const rms: number[] = [];
    for (let passes = 0; passes <= 3; passes++) {
      const fit = value(
        approximateSurface(
          g,
          { rows, cols },
          { u: bu, v: bv, params: 'uniform', parameterCorrection: passes },
        ),
      );
      expect(fit.rmsError).toBeLessThanOrEqual(prev);
      prev = fit.rmsError;
      rms.push(fit.rmsError);
    }
    expect(rms[3]!).toBeLessThan(rms[0]!);
  });

  it('returns an undetermined control point as a failure', () => {
    const bu = clampedBasis(3, clampedUniformKnots(3, 6, [0, 1]));
    const bv = clampedBasis(3, clampedUniformKnots(3, 6, [0, 1]));
    const rng = mulberry32(55);
    const m = 200;
    const uv = Float64Array.from({ length: 2 * m }, () => 0.4 * rng()); // one corner only
    const pts = Float64Array.from({ length: 3 * m }, () => rng());
    const r: Result<SurfaceFit> = approximateSurface(pts, { uv }, { u: bu, v: bv });
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.code).toBe('schoenberg-whitney');
    expectCode(
      () => approximateSurface(pts, { rows: 10, cols: 10 }, { u: bu, v: bv }),
      'size-mismatch',
    );
    expectCode(
      () =>
        approximateSurface(
          pts,
          { uv },
          {
            u: bu,
            v: bv,
            constraints: [
              { kind: 'point', uv: { u: 0, v: 0 }, value: { x: 0, y: 0, z: 0 }, axes: 8 },
            ],
          },
        ),
      'unsupported',
    );
  });
});
