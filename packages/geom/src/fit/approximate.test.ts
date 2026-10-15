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
 * - **weights**: a point of weight 0 changes nothing.
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
  isGeomError,
  makeCurve,
  makeSurface,
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
