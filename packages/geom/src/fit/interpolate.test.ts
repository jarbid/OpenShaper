// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Interpolation oracles (design §16, `fit` row):
 *
 * - **passes through the data**, and the reported `maxError` is the error an
 *   independent evaluation measures;
 * - **space reproduction**: data sampled from a spline of the interpolant's
 *   own space (the knots that averaging gives for the same parameters) give
 *   back that spline's control net (curves, periodic curves, surfaces);
 * - **polynomial reproduction**: data on a polynomial of degree ≤ p, at its own
 *   parameters, give that polynomial everywhere, not just at the data;
 * - **end derivatives** hold exactly for degrees 2–5; with them, a
 *   polynomial of degree min(p, 3) is reproduced; for p = 2 the knots are eq.
 *   9.22's midpoints;
 * - **book fixture**: P&T Ex. 9.1 (chord-length parameters and knots);
 * - **hand fixture**: A9.3 on a grid with a pole row averages over the other
 *   lines only (both directions);
 * - **periodic**: C^(p−1) across the seam;
 * - **convergence**: the error of interpolating a circle (periodic) and a sine
 *   (clamped) falls as h^(p+1).
 *
 * Tolerances ("scale" = diagonal of the data's bounding box): data `1e-12 ·
 * scale` (an LU solve of a collocation matrix of condition ~10–100 loses at
 * most two digits of 16); reproduction `1e-10 · scale` (it compares control
 * points, which the inverse collocation matrix amplifies by its condition;
 * measured worst ≈ 1e-13); end derivatives `constraint` (design §7); seam
 * derivatives `1e-9` relative to the derivative's size (order-k derivatives
 * scale as h^−k, rounding as ε·h^−k); convergence slope within ±0.3 of p + 1.
 */
import { describe, expect, it } from 'vitest';
import {
  averagedKnots,
  clampedBasis,
  curveDerivatives,
  curvePoint,
  DEFAULT_TOLERANCES,
  interpolateCurve,
  interpolatePeriodic,
  interpolateSurface,
  isGeomError,
  makeCurve,
  makeSurface,
  surfacePoint,
} from '../index';
import type { Dim, GeomErrorCode, NurbsCurve, Parameterization, PointOf } from '../index';
import { mulberry32 } from '../testing';
import { surfMeshParams } from '../book/fit';
import { interpolationBasis } from './interpolate';

const DATA = 1e-12;
const REPRO = 1e-10;
const CONSTRAINT = DEFAULT_TOLERANCES.constraint;

function expectCode(f: () => unknown, code: GeomErrorCode): void {
  try {
    f();
  } catch (e) {
    expect(isGeomError(e, code), String(e)).toBe(true);
    return;
  }
  throw new Error(`expected GeomError ${code}`);
}

/** Bounding-box diagonal of points of stride `dim`. */
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

function coords(dim: Dim, p: PointOf<Dim>): number[] {
  if (dim === 1) return [p as number];
  const q = p as { x: number; y: number; z?: number };
  return dim === 2 ? [q.x, q.y] : [q.x, q.y, q.z!];
}

/** Largest |C(params[k]) − Q_k| by `curvePoint`, independently of the fitter. */
function measured(c: NurbsCurve, params: ArrayLike<number>, pts: ArrayLike<number>): number {
  let max = 0;
  for (let k = 0; k < params.length; k++) {
    const q = coords(c.dim, curvePoint(c, params[k]!));
    let s = 0;
    for (let d = 0; d < c.dim; d++) s += (q[d]! - pts[k * c.dim + d]!) ** 2;
    max = Math.max(max, Math.sqrt(s));
  }
  return max;
}

/** Sorted parameters 0 = ū_0 < … < ū_n = 1 with gaps ≥ 1/(4n). */
function randomParams(rng: () => number, n1: number): Float64Array {
  const gaps = Float64Array.from({ length: n1 - 1 }, () => 0.25 + rng());
  const total = gaps.reduce((a, b) => a + b, 0);
  const ub = new Float64Array(n1);
  for (let k = 1; k < n1; k++) ub[k] = ub[k - 1]! + gaps[k - 1]! / total;
  ub[n1 - 1] = 1;
  return ub;
}

/** Evaluates a random polynomial curve of degree `d` (power basis). */
function polynomial(rng: () => number, dim: number, d: number): (t: number) => number[] {
  const a = Array.from({ length: (d + 1) * dim }, () => 2 * rng() - 1);
  return (t) =>
    Array.from({ length: dim }, (_, c) => {
      let s = 0;
      for (let k = d; k >= 0; k--) s = s * t + a[k * dim + c]!;
      return s;
    });
}

function slope(hs: readonly number[], errs: readonly number[]): number {
  // Least-squares slope of log(err) against log(h).
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

const METHODS: readonly Parameterization[] = ['uniform', 'chord', 'centripetal', { exponent: 0.7 }];

describe('interpolateCurve (A9.1)', () => {
  it('passes through the data and reports the error it achieved', () => {
    const rng = mulberry32(11);
    for (const dim of [1, 2, 3] as const) {
      for (let p = 1; p <= 5; p++) {
        for (const method of METHODS) {
          // A noisy helix keeps the points apart, as interpolation needs.
          const n = 14;
          const pts = new Float64Array(n * dim);
          for (let k = 0; k < n; k++) {
            const a = k * 0.6;
            const xyz = [Math.cos(a) + 0.1 * rng(), Math.sin(a) + 0.1 * rng(), 0.3 * k];
            for (let d = 0; d < dim; d++) pts[k * dim + d] = dim === 1 ? k + 0.3 * rng() : xyz[d]!;
          }
          const r = interpolateCurve(pts, dim, { degree: p, params: method });
          const scale = scaleOf(pts, dim);
          expect(r.curve.basis.degree).toBe(p);
          expect(r.curve.basis.count).toBe(n);
          expect(r.curve.basis.domain).toEqual([0, 1]);
          expect(r.params[0]).toBe(0);
          expect(r.params[n - 1]).toBe(1);
          const m = measured(r.curve, r.params, pts);
          expect(m, `dim ${dim} p ${p} ${JSON.stringify(method)}`).toBeLessThanOrEqual(
            DATA * scale,
          );
          expect(Math.abs(r.maxError - m)).toBeLessThanOrEqual(Number.EPSILON * scale);
          expect(Object.isFrozen(r)).toBe(true);
        }
      }
    }
  });

  it('reproduces a spline of its own space from the spline’s samples', () => {
    const rng = mulberry32(12);
    for (const dim of [1, 2, 3] as const) {
      for (let p = 1; p <= 5; p++) {
        const n1 = 9 + p;
        const ub = randomParams(rng, n1);
        const basis = clampedBasis(p, averagedKnots(ub, p));
        const pts = Float64Array.from({ length: n1 * dim }, () => 2 * rng() - 1);
        const original = makeCurve({ dim, basis, points: pts });
        const data = new Float64Array(n1 * dim);
        for (let k = 0; k < n1; k++) data.set(coords(dim, curvePoint(original, ub[k]!)), k * dim);
        const r = interpolateCurve(data, dim, { degree: p, params: ub });
        expect(Array.from(r.curve.basis.knots)).toEqual(Array.from(basis.knots));
        const scale = scaleOf(pts, dim);
        for (let i = 0; i < n1; i++) {
          for (let d = 0; d < dim; d++) {
            const got = r.curve.cw[i * (dim + 1) + d]!;
            expect(Math.abs(got - pts[i * dim + d]!), `p ${p} dim ${dim}`).toBeLessThanOrEqual(
              REPRO * scale,
            );
          }
        }
      }
    }
  });

  it('reproduces polynomials of degree ≤ p everywhere, not only at the data', () => {
    const rng = mulberry32(13);
    for (let p = 1; p <= 5; p++) {
      for (let d = 0; d <= p; d++) {
        const P = polynomial(rng, 3, d);
        const ub = randomParams(rng, p + 6);
        const data = Float64Array.from(Array.from(ub, (t) => P(t)).flat());
        const r = interpolateCurve(data, 3, { degree: p, params: ub });
        const scale = Math.max(scaleOf(data, 3), 1);
        for (let i = 0; i <= 100; i++) {
          const t = i / 100;
          const q = curvePoint(r.curve, t);
          const e = P(t);
          const err = Math.hypot(q.x - e[0]!, q.y - e[1]!, q.z - e[2]!);
          expect(err, `p ${p} poly degree ${d} t ${t}`).toBeLessThanOrEqual(REPRO * scale);
        }
      }
    }
  });

  it('holds end derivatives exactly and reproduces a polynomial with them (§9.2.2)', () => {
    const rng = mulberry32(14);
    for (let p = 2; p <= 5; p++) {
      // A polynomial of degree d = min(p, 3), and its end derivatives: its own
      // degree-d interpolant is the polynomial (polynomial reproduction).
      const deg = Math.min(p, 3);
      const P = polynomial(rng, 2, deg);
      const ub = randomParams(rng, p + 4);
      const data = Float64Array.from(Array.from(ub, (t) => P(t)).flat());
      const exact = interpolateCurve(data, 2, { degree: deg, params: ub }).curve;
      const [, d0] = curveDerivatives(exact, 0, 1);
      const [, d1] = curveDerivatives(exact, 1, 1);
      for (const ends of [
        [d0!, d1!],
        [d0!, null],
        [null, d1!],
      ] as const) {
        const r = interpolateCurve(data, 2, { degree: p, params: ub, endDerivatives: ends });
        const extra = (ends[0] ? 1 : 0) + (ends[1] ? 1 : 0);
        expect(r.curve.basis.count).toBe(ub.length + extra);
        if (p === 2 && extra === 2) {
          // Eq. 9.22 (p = 2, both ends): {0,0,0, ū_1/2, (ū_1+ū_2)/2, …, (ū_{n−1}+1)/2, 1,1,1}.
          const n = ub.length - 1;
          const want = [0, 0, 0, ub[1]! / 2];
          for (let j = 1; j < n; j++) want.push((ub[j]! + ub[j + 1]!) / 2);
          want.push(1, 1, 1);
          expect(Array.from(r.curve.basis.knots)).toEqual(want);
        }
        if (ends[0]) {
          const [, g] = curveDerivatives(r.curve, 0, 1);
          expect(Math.hypot(g!.x - d0!.x, g!.y - d0!.y)).toBeLessThanOrEqual(CONSTRAINT);
        }
        if (ends[1]) {
          const [, g] = curveDerivatives(r.curve, 1, 1);
          expect(Math.hypot(g!.x - d1!.x, g!.y - d1!.y)).toBeLessThanOrEqual(CONSTRAINT);
        }
        const scale = scaleOf(data, 2);
        expect(measured(r.curve, ub, data)).toBeLessThanOrEqual(DATA * scale);
        for (let i = 0; i <= 50; i++) {
          const t = i / 50;
          const q = curvePoint(r.curve, t);
          const e = P(t);
          expect(Math.hypot(q.x - e[0]!, q.y - e[1]!)).toBeLessThanOrEqual(
            REPRO * Math.max(scale, 1),
          );
        }
      }
    }
  });

  it('holds arbitrary end derivatives on arbitrary data', () => {
    const rng = mulberry32(15);
    const pts = Float64Array.from({ length: 8 * 3 }, (_, i) => (i % 3 === 0 ? i : 2 * rng() - 1));
    const D0 = { x: 3, y: -2, z: 5 };
    const Dn = { x: -1, y: 4, z: 0.5 };
    const r = interpolateCurve(pts, 3, { endDerivatives: [D0, Dn] });
    const [, g0] = curveDerivatives(r.curve, 0, 1);
    const [, g1] = curveDerivatives(r.curve, 1, 1);
    expect(Math.hypot(g0!.x - D0.x, g0!.y - D0.y, g0!.z - D0.z)).toBeLessThanOrEqual(CONSTRAINT);
    expect(Math.hypot(g1!.x - Dn.x, g1!.y - Dn.y, g1!.z - Dn.z)).toBeLessThanOrEqual(CONSTRAINT);
    expect(r.maxError).toBeLessThanOrEqual(DATA * scaleOf(pts, 3));
  });

  it('matches P&T Ex. 9.1 (chord-length parameters, averaged knots)', () => {
    const Q = [0, 0, 3, 4, -1, 4, -4, 0, -4, -3];
    const r = interpolateCurve(Q, 2, { degree: 3, params: 'chord' });
    const ub = [0, 5 / 17, 9 / 17, 14 / 17, 1];
    for (let k = 0; k < 5; k++)
      expect(Math.abs(r.params[k]! - ub[k]!)).toBeLessThanOrEqual(2 * Number.EPSILON);
    const U = [0, 0, 0, 0, 28 / 51, 1, 1, 1, 1];
    for (let k = 0; k < U.length; k++) {
      expect(Math.abs(r.curve.basis.knots[k]! - U[k]!)).toBeLessThanOrEqual(4 * Number.EPSILON);
    }
    expect(r.maxError).toBeLessThanOrEqual(DATA * 10);
  });

  it('converges as h^(p+1) on a smooth function', () => {
    // f(t) = eᵗ sin 3t on [0, 1] at uniform parameters; x = t exactly (linear
    // precision), so the error is |C_y(t) − f(t)| on 8,001 samples. Meshes are
    // fine enough to be asymptotic (measured local slopes: p = 2: 2.91–2.98,
    // 3: 3.97–4.00, 4: 5.26–5.09, 5: 5.90–6.03).
    const f = (t: number): number => Math.exp(t) * Math.sin(3 * t);
    for (const p of [2, 3, 4, 5]) {
      const hs: number[] = [];
      const errs: number[] = [];
      for (const n of [40, 80, 160, 320]) {
        const ub = Float64Array.from({ length: n + 1 }, (_, k) => k / n);
        const data = Float64Array.from(Array.from(ub, (t) => [t, f(t)]).flat());
        const c = interpolateCurve(data, 2, { degree: p, params: ub }).curve;
        let e = 0;
        for (let i = 0; i <= 8000; i++) {
          const t = i / 8000;
          e = Math.max(e, Math.abs(curvePoint(c, t).y - f(t)));
        }
        hs.push(1 / n);
        errs.push(e);
      }
      expect(Math.abs(slope(hs, errs) - (p + 1)), `p ${p}: ${errs.join(', ')}`).toBeLessThanOrEqual(
        0.3,
      );
    }
  });

  it('rejects data it cannot interpolate', () => {
    expectCode(() => interpolateCurve([0, 0, 1, 1, 1, 1, 2, 0, 3, 1], 2), 'schoenberg-whitney');
    expectCode(() => interpolateCurve([0, 1, 2], 1, { degree: 3 }), 'too-few-points');
    expectCode(() => interpolateCurve([0, 1, 2, 3], 1, { degree: 0 }), 'invalid-degree');
    expectCode(() => interpolateCurve([0, 1, 2, 3, 4], 2), 'size-mismatch');
    expectCode(() => interpolateCurve([0, 1, 2, NaN], 1, { degree: 2 }), 'non-finite');
    expectCode(
      () => interpolateCurve([0, 1, 2, 3], 1, { degree: 2, params: [0, 0.5, 0.4, 1] }),
      'schoenberg-whitney',
    );
    expectCode(
      () => interpolateCurve([0, 1, 2, 3], 1, { degree: 2, params: [0.1, 0.3, 0.5, 1] }),
      'param-out-of-domain',
    );
    expectCode(
      () => interpolateCurve([0, 1, 2, 3], 1, { degree: 1, endDerivatives: [1, null] }),
      'unsupported',
    );
  });
});

describe('interpolatePeriodic', () => {
  it('closes C^(p−1) across the seam and passes through the data', () => {
    const rng = mulberry32(21);
    for (let p = 1; p <= 5; p++) {
      for (const method of METHODS) {
        const n = 11;
        const pts = new Float64Array(n * 3);
        for (let k = 0; k < n; k++) {
          const a = (2 * Math.PI * (k + 0.3 * rng())) / n;
          pts.set([Math.cos(a) * (1 + 0.2 * rng()), Math.sin(a), 0.2 * rng()], 3 * k);
        }
        const r = interpolatePeriodic(pts, 3, { degree: p, params: method });
        expect(r.curve.basis.kind).toBe('periodic');
        expect(r.curve.basis.domain).toEqual([0, 1]);
        expect(r.curve.basis.count).toBe(n);
        const scale = scaleOf(pts, 3);
        const m = measured(r.curve, r.params, pts);
        expect(m).toBeLessThanOrEqual(DATA * scale);
        expect(Math.abs(r.maxError - m)).toBeLessThanOrEqual(Number.EPSILON * scale);
        if (p >= 2) {
          const order = Math.min(p - 1, 3) as 1 | 2 | 3;
          const L = curveDerivatives(r.curve, 0, order, 'left');
          const R = curveDerivatives(r.curve, 0, order, 'right');
          for (let k = 0; k <= order; k++) {
            const size = Math.max(1, Math.hypot(R[k]!.x, R[k]!.y, R[k]!.z));
            const d = Math.hypot(L[k]!.x - R[k]!.x, L[k]!.y - R[k]!.y, L[k]!.z - R[k]!.z);
            expect(d, `p ${p} order ${k}`).toBeLessThanOrEqual(1e-9 * size);
          }
        }
      }
    }
  });

  it('reproduces a periodic spline of its own space', () => {
    const rng = mulberry32(22);
    for (let p = 1; p <= 5; p++) {
      const n = 10 + p;
      const raw = randomParams(rng, n + 1).subarray(0, n);
      const { ub, basis } = interpolationBasis(Float64Array.from(raw), p, true, DEFAULT_TOLERANCES);
      const pts = Float64Array.from({ length: n * 2 }, () => 2 * rng() - 1);
      const original = makeCurve({ dim: 2, basis, points: pts });
      const data = new Float64Array(n * 2);
      for (let k = 0; k < n; k++) data.set(coords(2, curvePoint(original, ub[k]!)), 2 * k);
      const r = interpolatePeriodic(data, 2, { degree: p, params: raw });
      expect(Array.from(r.params)).toEqual(Array.from(ub));
      const scale = scaleOf(pts, 2);
      for (let i = 0; i < n; i++) {
        for (let d = 0; d < 2; d++) {
          expect(Math.abs(r.curve.cw[i * 3 + d]! - pts[i * 2 + d]!)).toBeLessThanOrEqual(
            REPRO * scale,
          );
        }
      }
    }
  });

  it('converges as h^(p+1) on a circle', () => {
    for (const p of [2, 3, 4]) {
      const hs: number[] = [];
      const errs: number[] = [];
      for (const n of [12, 24, 48, 96]) {
        const pts = new Float64Array(2 * n);
        for (let k = 0; k < n; k++)
          pts.set([Math.cos((2 * Math.PI * k) / n), Math.sin((2 * Math.PI * k) / n)], 2 * k);
        const c = interpolatePeriodic(pts, 2, { degree: p }).curve;
        let e = 0;
        for (let i = 0; i < 4000; i++) {
          const q = curvePoint(c, i / 4000);
          e = Math.max(e, Math.abs(Math.hypot(q.x, q.y) - 1));
        }
        hs.push(1 / n);
        errs.push(e);
      }
      // Even degrees on uniform data superconverge on the circle's symmetric
      // error (its odd terms cancel), so the slope is at least p + 1.
      const s = slope(hs, errs);
      expect(s, `p ${p}: ${errs.join(', ')}`).toBeGreaterThanOrEqual(p + 1 - 0.3);
      if (p % 2 === 1) expect(s).toBeLessThanOrEqual(p + 1 + 0.3);
    }
  });

  it('rejects a repeated closing point and too few points', () => {
    expectCode(() => interpolatePeriodic([0, 0, 1, 0, 1, 1, 0, 1, 0, 0], 2), 'schoenberg-whitney');
    expectCode(() => interpolatePeriodic([0, 0, 1, 0, 1, 1], 2), 'too-few-points');
  });
});

describe('interpolateSurface (A9.4)', () => {
  /** A `rows × cols` grid sampled from `f(u, v)` at the given parameters. */
  function grid(
    us: ArrayLike<number>,
    vs: ArrayLike<number>,
    f: (u: number, v: number) => readonly number[],
  ): Float64Array {
    const g = new Float64Array(us.length * vs.length * 3);
    for (let k = 0; k < us.length; k++) {
      for (let l = 0; l < vs.length; l++) g.set(f(us[k]!, vs[l]!), (k * vs.length + l) * 3);
    }
    return g;
  }

  it('reproduces a surface of its own space (clamped and periodic directions)', () => {
    const rng = mulberry32(31);
    for (const [p, q, pu, pv] of [
      [3, 3, false, false],
      [2, 4, false, true],
      [5, 1, true, false],
      [3, 2, true, true],
    ] as const) {
      const rows = 8 + p;
      const cols = 7 + q;
      // 'uniform' parameters do not depend on the points, so A9.3 on any grid of
      // the same size gives the parameters, hence the space, in advance.
      const dummy = Float64Array.from({ length: rows * cols * 3 }, () => rng());
      const uni = (dir: 'u' | 'v', periodic: boolean): Float64Array => {
        const ub = new Float64Array(dir === 'u' ? rows : cols);
        surfMeshParams(dummy, rows, cols, dir, 0, periodic, ub);
        return ub;
      };
      const U = interpolationBasis(uni('u', pu), p, pu, DEFAULT_TOLERANCES);
      const V = interpolationBasis(uni('v', pv), q, pv, DEFAULT_TOLERANCES);
      const net = Float64Array.from({ length: rows * cols * 3 }, () => 2 * rng() - 1);
      const S = makeSurface({ u: U.basis, v: V.basis, points: net });
      const g = grid(U.ub, V.ub, (u, v) => {
        const x = surfacePoint(S, u, v);
        return [x.x, x.y, x.z];
      });
      const r = interpolateSurface(g, rows, cols, {
        degreeU: p,
        degreeV: q,
        paramU: 'uniform',
        paramV: 'uniform',
        periodicU: pu,
        periodicV: pv,
      });
      expect(Array.from(r.paramsU)).toEqual(Array.from(U.ub));
      expect(Array.from(r.paramsV)).toEqual(Array.from(V.ub));
      const scale = scaleOf(net, 3);
      for (let i = 0; i < rows * cols; i++) {
        for (let c = 0; c < 3; c++) {
          expect(
            Math.abs(r.surface.cw[i * 4 + c]! - net[i * 3 + c]!),
            `${p} ${q} ${pu} ${pv}`,
          ).toBeLessThanOrEqual(REPRO * scale);
        }
      }
      expect(r.maxError).toBeLessThanOrEqual(DATA * scale);
    }
  });

  it('averages A9.3 parameters over the lines that do not collapse (a pole row)', () => {
    // Hand fixture, chord length, 3 × 3 grid whose last row is a pole (a board's
    // nose): every point of row 2 is (5, 0, 0).
    //   v (along rows): row 0 chords 1, 2 → {0, 1/3, 1}; row 1 chords 3, 1 →
    //   {0, 3/4, 1}; row 2 collapses and is skipped: ū_1 = (1/3 + 3/4)/2 = 13/24
    //   (averaging it in as zeros would give 13/36).
    //   u (along columns): chords 2, 3 → 2/5; 2√2, 3√2 → 2/5; √5, 5 → √5/(√5 + 5).
    // The transposed grid must give the same values with u and v exchanged.
    // Tolerance 4ε: two sums and a division, each rounded once.
    const rows: number[][][] = [
      [
        [0, 0, 0],
        [0, 1, 0],
        [0, 3, 0],
      ],
      [
        [2, 0, 0],
        [2, 3, 0],
        [2, 4, 0],
      ],
      [
        [5, 0, 0],
        [5, 0, 0],
        [5, 0, 0],
      ],
    ];
    const g = Float64Array.from(rows.flat(2));
    const gt = Float64Array.from([0, 1, 2].flatMap((l) => [0, 1, 2].flatMap((k) => rows[k]![l]!)));
    const wantV = [0, 13 / 24, 1];
    const wantU = [0, (2 / 5 + 2 / 5 + Math.sqrt(5) / (Math.sqrt(5) + 5)) / 3, 1];
    const tol = 4 * Number.EPSILON;
    const r = interpolateSurface(g, 3, 3, {
      degreeU: 2,
      degreeV: 2,
      paramU: 'chord',
      paramV: 'chord',
    });
    const t = interpolateSurface(gt, 3, 3, {
      degreeU: 2,
      degreeV: 2,
      paramU: 'chord',
      paramV: 'chord',
    });
    for (let k = 0; k < 3; k++) {
      expect(Math.abs(r.paramsV[k]! - wantV[k]!), `v ${k}`).toBeLessThanOrEqual(tol);
      expect(Math.abs(r.paramsU[k]! - wantU[k]!), `u ${k}`).toBeLessThanOrEqual(tol);
      expect(Math.abs(t.paramsU[k]! - wantV[k]!), `transposed u ${k}`).toBeLessThanOrEqual(tol);
      expect(Math.abs(t.paramsV[k]! - wantU[k]!), `transposed v ${k}`).toBeLessThanOrEqual(tol);
    }
    expect(r.maxError).toBeLessThanOrEqual(DATA * scaleOf(g, 3));
  });

  it('reproduces a bicubic polynomial height field everywhere', () => {
    const rng = mulberry32(32);
    const a = Array.from({ length: 16 }, () => 2 * rng() - 1);
    const f = (u: number, v: number): number => {
      let s = 0;
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) s += a[i * 4 + j]! * u ** i * v ** j;
      return s;
    };
    const us = Float64Array.from({ length: 9 }, (_, k) => k / 8);
    const vs = Float64Array.from({ length: 7 }, (_, k) => k / 6);
    const g = grid(us, vs, (u, v) => [u, 2 * v, f(u, v)]);
    const r = interpolateSurface(g, 9, 7, { paramU: 'uniform', paramV: 'uniform' });
    const scale = scaleOf(g, 3);
    for (let i = 0; i < 200; i++) {
      const u = rng();
      const v = rng();
      const x = surfacePoint(r.surface, u, v);
      expect(Math.hypot(x.x - u, x.y - 2 * v, x.z - f(u, v))).toBeLessThanOrEqual(REPRO * scale);
    }
  });

  it('passes through any grid and reports the error it achieved', () => {
    const rng = mulberry32(33);
    const rows = 12;
    const cols = 9;
    const g = new Float64Array(rows * cols * 3);
    for (let k = 0; k < rows; k++) {
      for (let l = 0; l < cols; l++) {
        g.set(
          [k + 0.3 * rng(), l + 0.3 * rng(), Math.sin(k) * Math.cos(l) + 0.1 * rng()],
          (k * cols + l) * 3,
        );
      }
    }
    for (const m of METHODS) {
      const r = interpolateSurface(g, rows, cols, { paramU: m, paramV: m });
      let max = 0;
      for (let k = 0; k < rows; k++) {
        for (let l = 0; l < cols; l++) {
          const x = surfacePoint(r.surface, r.paramsU[k]!, r.paramsV[l]!);
          const o = (k * cols + l) * 3;
          max = Math.max(max, Math.hypot(x.x - g[o]!, x.y - g[o + 1]!, x.z - g[o + 2]!));
        }
      }
      const scale = scaleOf(g, 3);
      expect(max).toBeLessThanOrEqual(DATA * scale);
      expect(Math.abs(r.maxError - max)).toBeLessThanOrEqual(Number.EPSILON * scale);
    }
  });

  it('rejects grids it cannot interpolate', () => {
    const g = new Float64Array(4 * 4 * 3);
    for (let k = 0; k < 4; k++) for (let l = 0; l < 4; l++) g.set([k, l, 0], (k * 4 + l) * 3);
    expectCode(() => interpolateSurface(g, 4, 3), 'size-mismatch');
    expectCode(() => interpolateSurface(g, 4, 4, { degreeU: 4 }), 'too-few-points');
    const dup = g.slice();
    for (let l = 0; l < 4; l++) dup.set(dup.subarray(l * 3, l * 3 + 3), (4 + l) * 3); // row 1 = row 0
    expectCode(() => interpolateSurface(dup, 4, 4), 'schoenberg-whitney');
  });
});
