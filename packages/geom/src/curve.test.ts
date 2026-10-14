// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Curve oracles (design §16, `book/curve`, `curve` and `curve (derivatives)` rows):
 *
 * - exact polynomial reproduction: control points from blossoms make a
 *   B-spline equal to a known polynomial on any knot vector, so values and
 *   derivatives to C‴ have closed forms;
 * - rational Bézier curves against the closed-form Bernstein quotient;
 * - every curve (clamped or periodic, rational or not) against A2.4, an
 *   independent basis algorithm, summed over the control points;
 * - derivatives against Richardson-extrapolated central differences;
 * - multi-span rational derivatives to C‴ against the half-angle closed form
 *   of A7.1 circular arcs;
 * - one-sided derivatives at a C⁰ knot against the two Bézier halves;
 * - periodic wrap continuity across the seam;
 * - affine invariance and the ellipse as the image of a circle;
 * - kernels equal their allocating wrappers bit for bit.
 *
 * Tolerances (`ε` = 2.2·10⁻¹⁶). A point is a sum of p + 1 products, so values
 * err by a few ε times the control-net magnitude `M = max |P_i|`; with weights
 * the quotient adds the weight ratio `ρ = w_max/w_min`. The k-th derivative of a
 * B-spline has coefficients up to `p!/(p−k)! / h^k` times larger, `h` the
 * smallest knot span, so its rounding grows by that factor:
 * `tol_k = 64 ε · M · ρ^(k+1) · p!/(p−k)! / h^k` (design: `64 ε · scale · p!`
 * with unit spans). 64 covers ~10 flops per term and the quotient rule.
 */
import { describe, expect, it } from 'vitest';
import {
  basisFunction,
  bezierCurve,
  circle,
  circleArc,
  clampedBasis,
  clampedUniformKnots,
  clampUnclamped,
  controlPoint,
  controlPointsInto,
  controlWeight,
  createScratch,
  curveDerivatives,
  curveDomain,
  curveEvalBatchInto,
  curveEvalInto,
  curveFromHomogeneous,
  curvePoint,
  curveToJSON,
  isClosed,
  isGeomError,
  knotsFromBreaks,
  makeCurve,
  periodicBasis,
  periodicCircle,
  polyline,
  reviveCurve,
  transformCurve,
  transformCurve2,
  vec,
  weightsInto,
  withControlPoints,
  withWeights,
} from './index';
import type { Affine3, Basis, GeomErrorCode, NurbsCurve, Point3 } from './index';
import { oneBasisFun } from './book/basis';
import { mulberry32, randomClampedBasis, randomCurve } from './testing';

const EPS = Number.EPSILON;

function expectCode(f: () => unknown, code: GeomErrorCode): void {
  try {
    f();
  } catch (e) {
    expect(isGeomError(e), String(e)).toBe(true);
    expect((e as { code: string }).code).toBe(code);
    return;
  }
  expect.unreachable(`expected GeomError '${code}'`);
}

/** Flat Euclidean control points and weights of a curve. */
function net(c: NurbsCurve): { P: Float64Array; w: Float64Array } {
  const P = new Float64Array(c.basis.count * c.dim);
  const w = new Float64Array(c.basis.count);
  controlPointsInto(c, P);
  weightsInto(c, w);
  return { P, w };
}

/** `M = max |P_i|` and `ρ = w_max / w_min`. */
function magnitudes(c: NurbsCurve): { M: number; rho: number } {
  const { P, w } = net(c);
  let M = 0;
  for (let i = 0; i < c.basis.count; i++) {
    let s = 0;
    for (let k = 0; k < c.dim; k++) s += P[i * c.dim + k]! ** 2;
    M = Math.max(M, Math.sqrt(s));
  }
  return { M, rho: Math.max(...w) / Math.min(...w) };
}

/** Smallest non-empty knot span. */
function minSpan(b: Basis): number {
  let h = Infinity;
  const U = b.knots;
  for (let i = 1; i < U.length; i++) if (U[i]! > U[i - 1]!) h = Math.min(h, U[i]! - U[i - 1]!);
  if (b.kind === 'periodic') h = Math.min(h, U[0]! + b.period - U[U.length - 1]!);
  return h;
}

function derivTol(c: NurbsCurve, k: number, factor = 64): number {
  const { M, rho } = magnitudes(c);
  const p = c.basis.degree;
  let g = 1;
  for (let j = 0; j < k; j++) g *= Math.max(1, p - j) / minSpan(c.basis);
  return factor * EPS * Math.max(M, 1) * rho ** (k + 1) * g;
}

/** All derivatives as flat arrays `[C, C′, …]` (dim values each). */
function evalFlat(
  c: NurbsCurve,
  t: number,
  nDer: 0 | 1 | 2 | 3,
  side?: 'left' | 'right',
): Float64Array {
  const out = new Float64Array((nDer + 1) * c.dim);
  curveEvalInto(c, t, nDer, out, 0, createScratch({ maxDegree: c.basis.degree }), side);
  return out;
}

function maxAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>, from = 0, len = a.length): number {
  let m = 0;
  for (let i = from; i < from + len; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
}

// ---------------------------------------------------------------------------
// Construction and accessors
// ---------------------------------------------------------------------------

describe('makeCurve and friends', () => {
  const basis = clampedBasis(2, [0, 0, 0, 0.5, 1, 1, 1]);
  const points = [0, 0, 1, 2, 3, 1, 4, 0];

  it('derives rational from the weights and freezes the record', () => {
    const poly = makeCurve({ dim: 2, basis, points });
    expect(poly.rational).toBe(false);
    expect(Object.isFrozen(poly)).toBe(true);
    expect(poly.basis).toBe(basis);
    expect(makeCurve({ dim: 2, basis, points, weights: [1, 1, 1, 1] }).rational).toBe(false);
    expect(makeCurve({ dim: 2, basis, points, weights: [1, 2, 1, 1] }).rational).toBe(true);
  });

  it('stores P&T Pw and reads back Euclidean points and weights', () => {
    const c = makeCurve({ dim: 2, basis, points, weights: [1, 2, 0.5, 1] });
    expect(Array.from(c.cw)).toEqual([0, 0, 1, 2, 4, 2, 1.5, 0.5, 0.5, 4, 0, 1]);
    expect(controlPoint(c, 1)).toEqual({ x: 1, y: 2 });
    expect(controlWeight(c, 2)).toBe(0.5);
    expect(Array.from(net(c).P)).toEqual(points);
  });

  it('copies inputs', () => {
    const pts = points.slice();
    const c = makeCurve({ dim: 2, basis, points: pts });
    pts[0] = 99;
    expect(controlPoint(c, 0)).toEqual({ x: 0, y: 0 });
  });

  it('rejects invalid input with its code', () => {
    expectCode(() => makeCurve({ dim: 4 as 3, basis, points }), 'dimension-mismatch');
    expectCode(() => makeCurve({ dim: 2, basis, points: points.slice(1) }), 'size-mismatch');
    expectCode(() => makeCurve({ dim: 2, basis, points: [NaN, ...points.slice(1)] }), 'non-finite');
    expectCode(
      () => makeCurve({ dim: 2, basis, points, weights: [1, 0, 1, 1] }),
      'weight-not-positive',
    );
    expectCode(
      () => makeCurve({ dim: 2, basis, points, weights: [1, -1, 1, 1] }),
      'weight-not-positive',
    );
    expectCode(
      () => makeCurve({ dim: 2, basis, points, weights: [1, Infinity, 1, 1] }),
      'non-finite',
    );
    expectCode(() => makeCurve({ dim: 2, basis, points, weights: [1, 1, 1] }), 'size-mismatch');
    expectCode(() => curveFromHomogeneous({ dim: 2, basis, cw: [0, 0, 1] }), 'size-mismatch');
    expectCode(
      () => curveFromHomogeneous({ dim: 1, basis, cw: [0, 1, 0, 0, 0, 1, 0, 1] }),
      'weight-not-positive',
    );
    expectCode(() => bezierCurve(2, [0, 0]), 'too-few-points');
    expectCode(() => controlPoint(makeCurve({ dim: 2, basis, points }), 4), 'size-mismatch');
  });

  it('edits copy on write and share the basis', () => {
    const c = makeCurve({ dim: 2, basis, points, weights: [1, 2, 0.5, 1] });
    const moved = withControlPoints(c, [7, 8], [1]);
    expect(moved.basis).toBe(c.basis);
    expect(controlPoint(moved, 1)).toEqual({ x: 7, y: 8 });
    expect(controlWeight(moved, 1)).toBe(2);
    expect(controlPoint(c, 1)).toEqual({ x: 1, y: 2 });
    const all = withControlPoints(
      c,
      points.map((x) => x + 1),
    );
    expect(controlPoint(all, 3)).toEqual({ x: 5, y: 1 });
    const unit = withWeights(c, [1, 1, 1, 1]);
    expect(unit.rational).toBe(false);
    expect(Array.from(net(unit).P)).toEqual(points);
    const w = withWeights(makeCurve({ dim: 2, basis, points }), [3], [2]);
    expect(w.rational).toBe(true);
    expect(controlPoint(w, 2)).toEqual({ x: 3, y: 1 });
    expectCode(() => withControlPoints(c, [1, 2], [4]), 'size-mismatch');
    expectCode(() => withWeights(c, [0], [0]), 'weight-not-positive');
  });

  it('isClosed: periodic always, clamped when the ends meet within `point`', () => {
    expect(
      isClosed(circle({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 3)),
    ).toBe(true);
    expect(
      isClosed(periodicCircle({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 3)),
    ).toBe(true);
    expect(isClosed(polyline([0, 0, 1, 0, 1, 1], 2, true))).toBe(true);
    expect(isClosed(polyline([0, 0, 1, 0, 1, 1], 2))).toBe(false);
    expect(isClosed(polyline([0, 0, 1, 0, 0, 0.5e-6], 2))).toBe(true);
    expect(isClosed(polyline([0, 0, 1, 0, 0, 2e-6], 2))).toBe(false);
  });
});

describe('reviveCurve and curveToJSON', () => {
  const rng = mulberry32(11);
  const curves = [
    randomCurve(rng, { dim: 3, degree: 3, count: 9, maxMult: 2 }),
    randomCurve(rng, { dim: 2, degree: 2, count: 7, weightRange: [0.3, 3] }),
    randomCurve(rng, { dim: 1, degree: 4, count: 8, kind: 'periodic', weightRange: [0.5, 2] }),
  ];

  it('revives a structured clone bit for bit', () => {
    for (const c of curves) {
      const r = reviveCurve(structuredClone(c));
      expect(Array.from(r.cw)).toEqual(Array.from(c.cw));
      expect(Array.from(r.basis.knots)).toEqual(Array.from(c.basis.knots));
      expect(r.rational).toBe(c.rational);
      expect(Object.isFrozen(r)).toBe(true);
    }
  });

  it('round-trips JSON: polynomial bitwise, rational within an ulp per coordinate', () => {
    for (const c of curves) {
      const json = JSON.parse(JSON.stringify(curveToJSON(c))) as unknown;
      const r = reviveCurve(json);
      expect(Array.from(r.basis.knots)).toEqual(Array.from(c.basis.knots));
      for (let i = 0; i < c.cw.length; i++) {
        const tol = c.rational ? 2 * EPS * Math.abs(c.cw[i]!) : 0;
        expect(Math.abs(r.cw[i]! - c.cw[i]!)).toBeLessThanOrEqual(tol);
      }
    }
  });

  it('rejects malformed values', () => {
    expectCode(() => reviveCurve(null), 'size-mismatch');
    expectCode(() => reviveCurve({ dim: 5 }), 'dimension-mismatch');
    expectCode(
      () =>
        reviveCurve({
          dim: 2,
          kind: 'bspline',
          degree: 1,
          knots: [0, 0, 1, 1],
          points: [0, 0, 1, 1],
        }),
      'unsupported',
    );
    expectCode(
      () =>
        reviveCurve({ dim: 2, kind: 'clamped', degree: 1, knots: [0, 0, 1, 1], points: [0, 0, 1] }),
      'size-mismatch',
    );
    expectCode(
      () =>
        reviveCurve({
          ...curves[0]!,
          cw: Float64Array.from(curves[0]!.cw as Float64Array, (x, i) => (i === 3 ? -1 : x)),
        }),
      'weight-not-positive',
    );
  });
});

// ---------------------------------------------------------------------------
// Exact oracles
// ---------------------------------------------------------------------------

/** Elementary symmetric polynomial e_k of xs. */
function elemSym(xs: number[], k: number): number {
  const e = new Array<number>(k + 1).fill(0);
  e[0] = 1;
  for (const x of xs) for (let j = k; j >= 1; j--) e[j] = e[j]! + x * e[j - 1]!;
  return e[k]!;
}

function binom(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

/** Coefficients (ascending powers) of a polynomial, and its value / derivatives. */
function polyDer(a: number[], k: number, t: number): number {
  let s = 0;
  for (let i = k; i < a.length; i++) {
    let f = 1;
    for (let j = 0; j < k; j++) f *= i - j;
    s += a[i]! * f * t ** (i - k);
  }
  return s;
}

describe('polynomial reproduction (blossoms)', () => {
  // Control point i of the polynomial Σ a_k t^k is its blossom at
  // U[i+1..i+p]: Σ a_k e_k(U[i+1..i+p]) / C(p, k) (P&T §2.x / de Boor).
  it('evaluates known polynomials and their derivatives on random knot vectors', () => {
    const rng = mulberry32(21);
    for (let trial = 0; trial < 24; trial++) {
      const p = 1 + (trial % 5);
      const b = randomClampedBasis(rng, p, p + 1 + Math.floor(rng() * 9), {
        maxMult: p,
        domain: [-1 - rng(), 1 + rng()],
      });
      const dim = 3;
      const coeffs = Array.from({ length: dim }, (_, c) =>
        Array.from({ length: Math.min(p, c + 1) + 1 }, () => 2 * rng() - 1),
      );
      const U = b.knots;
      const pts: number[] = [];
      for (let i = 0; i < b.count; i++) {
        const xs = Array.from(U).slice(i + 1, i + p + 1);
        for (let c = 0; c < dim; c++) {
          pts.push(coeffs[c]!.reduce((s, a, k) => s + (a * elemSym(xs, k)) / binom(p, k), 0));
        }
      }
      const curve = makeCurve({ dim, basis: b, points: pts });
      const [a, e] = b.domain;
      const ts = [
        ...Array.from({ length: 25 }, () => a + rng() * (e - a)),
        ...Array.from(U).slice(p, b.count + 1),
      ];
      for (const t of ts) {
        for (const side of ['left', 'right'] as const) {
          if ((t === a && side === 'left') || (t === e && side === 'right')) continue;
          const D = evalFlat(curve, t, 3, side);
          for (let k = 0; k <= 3; k++) {
            const tol = derivTol(curve, k);
            for (let c = 0; c < dim; c++) {
              expect(
                Math.abs(D[k * dim + c]! - polyDer(coeffs[c]!, k, t)),
                `trial ${trial} t ${t} k ${k}`,
              ).toBeLessThanOrEqual(tol);
            }
          }
        }
      }
    }
  });

  it('reproduces a 1D law (a scalar curve)', () => {
    const b = clampedBasis(2, [0, 0, 0, 0.25, 0.5, 1, 1, 1]);
    // f(t) = 3 − 2t + 5t²: blossom 3 − 2(u1 + u2)/2 + 5·u1·u2.
    const U = b.knots;
    const pts = Array.from(
      { length: b.count },
      (_, i) => 3 - (U[i + 1]! + U[i + 2]!) + 5 * U[i + 1]! * U[i + 2]!,
    );
    const c = makeCurve({ dim: 1, basis: b, points: pts });
    for (const t of [0, 0.1, 0.25, 0.7, 1]) {
      expect(curvePoint(c, t)).toBeCloseTo(3 - 2 * t + 5 * t * t, 14);
      expect(curveDerivatives(c, t, 2)[2]).toBeCloseTo(10, 12);
    }
  });
});

describe('rational Bézier against the closed-form Bernstein quotient', () => {
  it('matches values and derivatives to third order', () => {
    const rng = mulberry32(5);
    for (let trial = 0; trial < 12; trial++) {
      const p = 1 + (trial % 6);
      const dim = 3;
      const P = Array.from({ length: (p + 1) * dim }, () => 2 * rng() - 1);
      const w = Array.from({ length: p + 1 }, () => 0.25 + 2 * rng());
      const c = bezierCurve(dim, P, w);
      // A(t) = Σ B_i w_i P_i, W(t) = Σ B_i w_i with Bernstein derivatives; then the quotient rule.
      const bern = (n: number, i: number, t: number): number =>
        i < 0 || i > n ? 0 : binom(n, i) * t ** i * (1 - t) ** (n - i);
      const bernDer = (i: number, k: number, t: number): number => {
        if (k > p) return 0;
        let s = 0;
        for (let j = 0; j <= k; j++) s += (-1) ** j * binom(k, j) * bern(p - k, i - k + j, t);
        let f = 1;
        for (let j = 0; j < k; j++) f *= p - j;
        return f * s;
      };
      for (let s = 0; s <= 20; s++) {
        const t = s / 20;
        const A = [0, 1, 2, 3].map((k) =>
          Array.from({ length: dim }, (_, d) =>
            w.reduce((acc, wi, i) => acc + bernDer(i, k, t) * wi * P[i * dim + d]!, 0),
          ),
        );
        const W = [0, 1, 2, 3].map((k) => w.reduce((acc, wi, i) => acc + bernDer(i, k, t) * wi, 0));
        const C0 = A[0]!.map((x) => x / W[0]!);
        const C1 = A[1]!.map((x, d) => (x - W[1]! * C0[d]!) / W[0]!);
        const C2 = A[2]!.map((x, d) => (x - 2 * W[1]! * C1[d]! - W[2]! * C0[d]!) / W[0]!);
        const C3 = A[3]!.map(
          (x, d) => (x - 3 * W[1]! * C2[d]! - 3 * W[2]! * C1[d]! - W[3]! * C0[d]!) / W[0]!,
        );
        const D = evalFlat(c, t, 3);
        const ref = [C0, C1, C2, C3];
        for (let k = 0; k <= 3; k++) {
          const tol = derivTol(c, k);
          for (let d = 0; d < dim; d++) {
            expect(
              Math.abs(D[k * dim + d]! - ref[k]![d]!),
              `p ${p} t ${t} k ${k}`,
            ).toBeLessThanOrEqual(tol);
          }
        }
      }
    }
  });
});

/** Σ_i R_i(t) P_i with R_i from A2.4 (`basisFunction`): independent of A2.2 / A3.1 / A4.1. */
function a24Point(c: NurbsCurve, t: number): number[] {
  const { P, w } = net(c);
  const num = new Array<number>(c.dim).fill(0);
  let den = 0;
  for (let i = 0; i < c.basis.count; i++) {
    const N = basisFunction(c.basis, i, t) * w[i]!;
    den += N;
    for (let d = 0; d < c.dim; d++) num[d] = num[d]! + N * P[i * c.dim + d]!;
  }
  return num.map((x) => x / den);
}

describe('every curve against the A2.4 oracle', () => {
  it('agrees for clamped and periodic, polynomial and rational curves of every dimension', () => {
    const rng = mulberry32(31);
    for (let trial = 0; trial < 40; trial++) {
      const p = 1 + (trial % 5);
      const c = randomCurve(rng, {
        dim: ((trial % 3) + 1) as 1 | 2 | 3,
        degree: p,
        count: p + 1 + Math.floor(rng() * 8),
        kind: trial % 2 === 0 ? 'clamped' : 'periodic',
        maxMult: p,
        weightRange: trial % 4 < 2 ? undefined : [0.2, 4],
        domain: [rng() * 3, 4 + rng() * 3],
        extent: 10,
      });
      const [a, e] = curveDomain(c);
      const tol = derivTol(c, 0);
      for (let i = 0; i < 30; i++) {
        const t = a + rng() * (e - a);
        const P = evalFlat(c, t, 0);
        const ref = a24Point(c, t);
        for (let d = 0; d < c.dim; d++)
          expect(Math.abs(P[d]! - ref[d]!), `trial ${trial}`).toBeLessThanOrEqual(tol);
      }
      if (c.basis.kind === 'clamped') {
        // C(a) = P_0 and C(b) = P_n exactly (A2.1's end span; the end basis value is exactly 1).
        const first = controlPoint(c, 0);
        const last = controlPoint(c, c.basis.count - 1);
        expect(curvePoint(c, a)).toEqual(first);
        expect(curvePoint(c, e)).toEqual(last);
      }
    }
  });
});

describe('derivatives against finite differences', () => {
  /**
   * Richardson-extrapolated central difference of g at t with step h:
   * (4·D(h/2) − D(h))/3, truncation O(h⁴). The step is h = 2⁻¹⁰ of the span
   * (design §16): truncation ~h⁴·|g⁽⁵⁾| ≈ 1e-12 of the derivative scale, and
   * cancellation ~ε·|g|/h ≈ 2e-13·|g|/span. Measured on these 30 curves the
   * worst error is 3e-11 of FD_REL's scale, so FD_REL = 1e-8 has a 300× margin
   * and still catches a derivative wrong by 1e-6 relative. (A step of 2⁻⁸
   * leaves a truncation of up to 7e-9 relative on the ρ = 10, p = 5 curves.)
   */
  const FD_STEPS = 1024;
  const FD_REL = 1e-8;

  function richardson(g: (t: number) => Float64Array, t: number, h: number, len: number): number[] {
    const D = (hh: number): number[] => {
      const a = g(t + hh);
      const b = g(t - hh);
      return Array.from({ length: len }, (_, i) => (a[i]! - b[i]!) / (2 * hh));
    };
    const d1 = D(h);
    const d2 = D(h / 2);
    return d1.map((x, i) => (4 * d2[i]! - x) / 3);
  }

  const norm3 = (f: ArrayLike<number>, o: number): number =>
    Math.hypot(f[o]!, f[o + 1]!, f[o + 2]!);

  it('C′, C″ and C‴ are the derivatives of C, C′ and C″ inside every span', () => {
    const rng = mulberry32(41);
    for (let trial = 0; trial < 30; trial++) {
      const p = 2 + (trial % 4);
      const c = randomCurve(rng, {
        dim: 3,
        degree: p,
        count: p + 1 + Math.floor(rng() * 6),
        kind: trial % 2 === 0 ? 'clamped' : 'periodic',
        maxMult: p - 1,
        weightRange: trial % 3 === 0 ? undefined : [0.3, 3],
      });
      const U = c.basis.knots;
      for (let i = 0; i + 1 < U.length; i++) {
        const lo = U[i]!;
        const hi = U[i + 1]!;
        if (!(hi > lo)) continue;
        if (c.basis.kind === 'clamped' && (i < p || i >= c.basis.count)) continue;
        const t = lo + (0.25 + 0.5 * rng()) * (hi - lo);
        const h = (hi - lo) / FD_STEPS;
        const all = evalFlat(c, t, 3);
        for (let k = 1; k <= 3; k++) {
          const lower = (x: number): Float64Array => evalFlat(c, x, 3).subarray((k - 1) * 3, k * 3);
          const fd = richardson(lower, t, h, 3);
          // Relative to |C⁽ᵏ⁾(t)|, local to this point. Where C⁽ᵏ⁾ nearly
          // vanishes (C‴ of a quadratic) the difference quotient still carries
          // the cancellation ε·|C⁽ᵏ⁻¹⁾|/h, so |C⁽ᵏ⁻¹⁾(t)|/span floors the scale:
          // the natural size of a derivative of C⁽ᵏ⁻¹⁾ over this span.
          const scale = Math.max(norm3(all, k * 3), norm3(all, (k - 1) * 3) / (hi - lo));
          const err = Math.hypot(
            all[k * 3]! - fd[0]!,
            all[k * 3 + 1]! - fd[1]!,
            all[k * 3 + 2]! - fd[2]!,
          );
          expect(err, `trial ${trial} span ${i} k ${k}`).toBeLessThanOrEqual(FD_REL * scale);
        }
      }
    }
  });
});

describe('rational derivatives on a multi-span circle against the closed form', () => {
  /**
   * A7.1 builds an arc of sweep θ from n equal rational quadratic segments of
   * sweep dθ = θ/n, inner weight cos(dθ/2), on knots i/n. On segment i, with
   * u = n·t − i and k = tan(dθ/4), the angle is the half-angle substitution
   *   φ(t) = a0 + (i + ½)·dθ + 2·atan(k·(2u − 1)),
   * so C = O + r·e(φ) with e = cos φ·X + sin φ·Y, e⊥ = −sin φ·X + cos φ·Y, and
   *   C′ = r·φ′·e⊥,  C″ = r·(φ″·e⊥ − φ′²·e),  C‴ = r·((φ‴ − φ′³)·e⊥ − 3φ′φ″·e),
   * with τ = k(2u − 1), q = 1 + τ²:
   *   φ′ = 4nk/q,  φ″ = −16n²k²τ/q²,  φ‴ = −32n³k³(1 − 3τ²)/q³.
   * Not unit speed, and C″ jumps at every interior double knot (φ″ changes
   * sign), so both one-sided limits are checked there. Tolerance: the header's
   * rounding model `derivTol(c, k)`; measured ≤ 2ε·(r + |O|)·(4n)^k, well inside.
   */
  const O = { x: 1.5, y: -2, z: 0.25 };
  const r = 3;
  const X = vec.normalize({ x: 1, y: 2, z: 2 })!;
  const Y = vec.normalize(vec.cross(X, { x: 0, y: 0, z: 1 }))!;

  function closedForm(
    a0: number,
    a1: number,
    t: number,
    side: 'left' | 'right',
  ): readonly Point3[] {
    const sweep = a1 - a0;
    const n = sweep <= Math.PI / 2 ? 1 : sweep <= Math.PI ? 2 : sweep <= 1.5 * Math.PI ? 3 : 4;
    const dth = sweep / n;
    const k = Math.tan(dth / 4);
    let i = Math.floor(t * n);
    if (side === 'left' && t * n === i) i -= 1;
    i = Math.min(Math.max(i, 0), n - 1);
    const tau = k * (2 * (n * t - i) - 1);
    const q = 1 + tau * tau;
    const phi = a0 + (i + 0.5) * dth + 2 * Math.atan(tau);
    const p1 = (4 * n * k) / q;
    const p2 = (-16 * n * n * k * k * tau) / (q * q);
    const p3 = (-32 * n ** 3 * k ** 3 * (1 - 3 * tau * tau)) / q ** 3;
    const e = vec.add(vec.scale(X, Math.cos(phi)), vec.scale(Y, Math.sin(phi)));
    const ep = vec.add(vec.scale(X, -Math.sin(phi)), vec.scale(Y, Math.cos(phi)));
    return [
      vec.add(O, vec.scale(e, r)),
      vec.scale(ep, r * p1),
      vec.sub(vec.scale(ep, r * p2), vec.scale(e, r * p1 * p1)),
      vec.sub(vec.scale(ep, r * (p3 - p1 ** 3)), vec.scale(e, 3 * r * p1 * p2)),
    ];
  }

  it('matches C, C′, C″ and C‴ on both sides of every knot, for one to four segments', () => {
    const arcs: readonly (readonly [number, number])[] = [
      [0.2, 0.9],
      [0, Math.PI / 2],
      [0.3, 2.8],
      [-1, 3.5],
      [0, 2 * Math.PI],
    ];
    for (const [a0, a1] of arcs) {
      const c = circleArc(O, X, Y, r, a0, a1);
      for (let s = 0; s <= 240; s++) {
        const t = s / 240;
        for (const side of ['left', 'right'] as const) {
          if ((t === 0 && side === 'left') || (t === 1 && side === 'right')) continue;
          const ref = closedForm(a0, a1, t, side);
          const got = evalFlat(c, t, 3, side);
          for (let d = 0; d <= 3; d++) {
            const g = { x: got[3 * d]!, y: got[3 * d + 1]!, z: got[3 * d + 2]! };
            expect(
              vec.distance(g, ref[d]!),
              `arc [${a0}, ${a1}] t ${t} ${side} C^(${d})`,
            ).toBeLessThanOrEqual(derivTol(c, d));
          }
        }
      }
    }
  });
});

describe('one-sided derivatives at a C⁰ knot equal the Bézier halves', () => {
  it('matches the end derivatives of each half, scaled to its span', () => {
    const rng = mulberry32(51);
    for (const p of [2, 3, 4]) {
      // Knot m of multiplicity p splits the curve into Bézier segments [a, m] and [m, b].
      const a = -0.5;
      const m = 0.3;
      const b = 1.7;
      const basis = clampedBasis(p, knotsFromBreaks([a, m, b], [p + 1, p, p + 1]));
      const P = Array.from({ length: (2 * p + 1) * 3 }, () => 2 * rng() - 1);
      const w = Array.from({ length: 2 * p + 1 }, () => 0.5 + rng());
      const c = makeCurve({ dim: 3, basis, points: P, weights: w });
      const left = bezierCurve(3, P.slice(0, (p + 1) * 3), w.slice(0, p + 1));
      const right = bezierCurve(3, P.slice(p * 3), w.slice(p));
      const L = evalFlat(c, m, 3, 'left');
      const R = evalFlat(c, m, 3, 'right');
      const L0 = evalFlat(left, 1, 3);
      const R0 = evalFlat(right, 0, 3);
      for (let k = 0; k <= 3; k++) {
        const tol = derivTol(c, k);
        for (let d = 0; d < 3; d++) {
          expect(Math.abs(L[k * 3 + d]! - L0[k * 3 + d]! / (m - a) ** k)).toBeLessThanOrEqual(tol);
          expect(Math.abs(R[k * 3 + d]! - R0[k * 3 + d]! / (b - m) ** k)).toBeLessThanOrEqual(tol);
        }
      }
      // The halves genuinely differ in C′ (a kink), so the sides are not interchangeable.
      expect(maxAbsDiff(L, R, 3, 3)).toBeGreaterThan(1e-3);
      // Positions agree exactly at the C⁰ knot: both sides land on P_p.
      expect(maxAbsDiff(L, R, 0, 3)).toBeLessThanOrEqual(derivTol(c, 0));
    }
  });
});

describe('periodic curves', () => {
  it('are continuous to C^(p−1) across the seam at single knots', () => {
    const rng = mulberry32(61);
    for (const p of [2, 3, 4, 5]) {
      const c = randomCurve(rng, {
        dim: 3,
        degree: p,
        count: p + 4,
        kind: 'periodic',
        weightRange: [0.5, 2],
      });
      const [t0] = curveDomain(c);
      const L = evalFlat(c, t0, 3, 'left');
      const R = evalFlat(c, t0, 3, 'right');
      for (let k = 0; k <= Math.min(3, p - 1); k++) {
        expect(maxAbsDiff(L, R, k * 3, 3), `p ${p} k ${k}`).toBeLessThanOrEqual(derivTol(c, k));
      }
      if (p <= 3) expect(maxAbsDiff(L, R, p * 3, 3)).toBeGreaterThan(1e-6); // C^p jumps
    }
  });

  it('repeat with the period: exactly for dyadic parameters, to rounding otherwise', () => {
    const b = periodicBasis(3, [0, 0.125, 0.25, 0.5, 0.75], 1);
    const c = makeCurve({
      dim: 2,
      basis: b,
      points: [0, 0, 1, 0, 2, 1, 1, 2, 0, 1],
      weights: [1, 2, 1, 0.5, 1],
    });
    for (const t of [0, 0.0625, 0.3125, 0.875]) {
      for (const k of [-3, -1, 1, 2]) expect(curvePoint(c, t + k)).toEqual(curvePoint(c, t));
    }
    const T = 2 * Math.PI;
    const d = makeCurve({
      dim: 2,
      basis: periodicBasis(2, [0, 1, 2, 4], T),
      points: [0, 0, 1, 0, 2, 1, 1, 2],
    });
    for (const t of [0.1, 1.5, 3, 6]) {
      for (const k of [-2, 1, 5]) {
        // The wrapped parameter differs from t by rounding of t + kT (≤ ε·|t + kT|).
        const p0 = curvePoint(d, t);
        const p1 = curvePoint(d, t + k * T);
        const speed = vec.norm(curveDerivatives(d, t, 1)[1]!);
        expect(vec.distance(p0, p1)).toBeLessThanOrEqual(
          4 * EPS * Math.abs(t + k * T) * speed + 4 * EPS * 2,
        );
      }
    }
  });

  it('keep a sharp tip at a full-multiplicity seam knot', () => {
    const b = periodicBasis(2, [0, 0, 0.5, 0.75], 1);
    const c = makeCurve({ dim: 2, basis: b, points: [1, 0, 0, 1, -1, 0, 0, -1] });
    const L = evalFlat(c, 0, 1, 'left');
    const R = evalFlat(c, 1, 1, 'right');
    expect(maxAbsDiff(L, R, 0, 2)).toBeLessThanOrEqual(4 * EPS);
    expect(maxAbsDiff(L, R, 2, 2)).toBeGreaterThan(0.1);
    // C(0) is the control point the double knot interpolates: P_{-1 mod 4} = P_3.
    expect(curvePoint(c, 0)).toEqual(controlPoint(c, 3));
  });
});

// ---------------------------------------------------------------------------
// The rational circle
// ---------------------------------------------------------------------------

describe('rational circles are exact', () => {
  const O = { x: 1.5, y: -2, z: 0.25 };
  const r = 3;
  const X = vec.normalize({ x: 1, y: 2, z: 2 })!;
  const Y = vec.normalize(vec.cross(X, { x: 0, y: 0, z: 1 }))!;
  // Coordinates ~ |O| + r: rounding scales with them (64 ε r at the origin, design §16).
  const tol = 64 * EPS * (r + vec.norm(O));

  it('|C(t) − O| = r for the 9-point and periodic 8-point circles', () => {
    for (const c of [circle(O, X, Y, r), periodicCircle(O, X, Y, r)]) {
      for (let s = 0; s <= 400; s++) {
        expect(Math.abs(vec.distance(curvePoint(c, s / 400), O) - r)).toBeLessThanOrEqual(tol);
      }
    }
  });

  it('is not unit speed, yet C′ ⊥ C − O everywhere', () => {
    const c = circle(O, X, Y, r);
    const v0 = vec.norm(curveDerivatives(c, 0, 1)[1]!);
    const v1 = vec.norm(curveDerivatives(c, 0.125, 1)[1]!);
    expect(Math.abs(v0 - v1) / v0).toBeGreaterThan(0.1);
    for (let s = 0; s <= 100; s++) {
      const [P, d1] = curveDerivatives(c, s / 100, 1);
      expect(Math.abs(vec.dot(vec.sub(P!, O), d1!)) / (r * vec.norm(d1!))).toBeLessThanOrEqual(tol);
    }
  });

  it('the periodic circle matches the clamped one point for point', () => {
    const a = circle(O, X, Y, r);
    const b = periodicCircle(O, X, Y, r);
    for (let s = 0; s < 64; s++) {
      expect(vec.distance(curvePoint(a, s / 64), curvePoint(b, s / 64))).toBeLessThanOrEqual(tol);
    }
  });
});

describe('affine maps', () => {
  it('map the curve exactly (affine invariance)', () => {
    const rng = mulberry32(71);
    for (let trial = 0; trial < 10; trial++) {
      const c = randomCurve(rng, {
        dim: 3,
        degree: 3,
        count: 7,
        weightRange: [0.5, 2],
        kind: trial % 2 ? 'periodic' : 'clamped',
      }) as NurbsCurve<3>;
      const m = Array.from({ length: 12 }, () => 2 * rng() - 1) as unknown as Affine3;
      const mc = transformCurve(c, m);
      expect(mc.basis).toBe(c.basis);
      const tol = derivTol(mc, 0) * 8;
      for (let i = 0; i < 20; i++) {
        const t = rng();
        const a = vec.applyAffine3(m, curvePoint(c, t) as Point3);
        expect(vec.distance(curvePoint(mc, t) as Point3, a)).toBeLessThanOrEqual(tol);
      }
    }
  });

  it('turn a circle into an exact ellipse', () => {
    const c = circle({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 1);
    const [A, B] = [5, 2];
    const e = transformCurve(c, [A, 0, 0, 1, 0, B, 0, -2, 0, 0, 1, 0]);
    for (let s = 0; s <= 200; s++) {
      const p = curvePoint(e, s / 200);
      expect(Math.abs(((p.x - 1) / A) ** 2 + ((p.y + 2) / B) ** 2 - 1)).toBeLessThanOrEqual(
        64 * EPS * 3,
      );
    }
    const flat = makeCurve({ dim: 2, basis: clampedBasis(1, [0, 0, 1, 1]), points: [0, 0, 1, 1] });
    expect(curvePoint(transformCurve2(flat, [2, 0, 1, 0, 3, -1]), 1)).toEqual({ x: 3, y: 2 });
    expectCode(
      () => transformCurve(flat as unknown as NurbsCurve<3>, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]),
      'dimension-mismatch',
    );
  });
});

// ---------------------------------------------------------------------------
// Kernels and wrappers, parameters and sides
// ---------------------------------------------------------------------------

describe('kernels equal their wrappers bit for bit', () => {
  const rng = mulberry32(81);
  const curves = [
    randomCurve(rng, { dim: 3, degree: 3, count: 10, maxMult: 2, weightRange: [0.4, 2.5] }),
    randomCurve(rng, { dim: 2, degree: 4, count: 9, kind: 'periodic', maxMult: 3 }),
    randomCurve(rng, { dim: 1, degree: 1, count: 5 }),
  ];

  it('curvePoint, curveDerivatives and curveEvalInto agree', () => {
    for (const c of curves) {
      const [a, e] = curveDomain(c);
      for (let i = 0; i < 30; i++) {
        const t = a + rng() * (e - a);
        const P = evalFlat(c, t, 0);
        const D = evalFlat(c, t, 3);
        const pt = curvePoint(c, t);
        const ds = curveDerivatives(c, t, 3);
        const flat = (q: unknown): number[] =>
          typeof q === 'number' ? [q] : Object.values(q as Record<string, number>);
        expect(flat(pt)).toEqual(Array.from(P));
        expect(ds.flatMap(flat)).toEqual(Array.from(D));
        expect(Array.from(D.subarray(0, c.dim))).toEqual(Array.from(P));
      }
    }
  });

  it('curveEvalBatchInto equals curveEvalInto for ascending, descending and shuffled parameters', () => {
    for (const c of curves) {
      const [a, e] = curveDomain(c);
      const ts = Float64Array.from([
        ...Array.from({ length: 60 }, () => a + rng() * (e - a)),
        ...c.basis.knots,
        a,
        e,
      ]);
      const orders = [Float64Array.from(ts).sort(), Float64Array.from(ts).sort().reverse(), ts];
      for (const order of orders) {
        for (const nDer of [0, 2, 3] as const) {
          const stride = (nDer + 1) * c.dim;
          const out = new Float64Array(order.length * stride);
          const out32 = new Float32Array(order.length * stride);
          const s = createScratch({ maxDegree: 5 });
          curveEvalBatchInto(c, order, nDer, out, s);
          curveEvalBatchInto(c, order, nDer, out32, s);
          for (let i = 0; i < order.length; i++) {
            const one = new Float64Array(stride);
            curveEvalInto(c, order[i]!, nDer, one, 0, s);
            expect(Array.from(out.subarray(i * stride, (i + 1) * stride))).toEqual(Array.from(one));
            expect(Array.from(out32.subarray(i * stride, (i + 1) * stride))).toEqual(
              Array.from(Float32Array.from(one)),
            );
          }
        }
      }
    }
  });
});

describe('parameters and sides', () => {
  const c = makeCurve({
    dim: 2,
    basis: clampedBasis(2, clampedUniformKnots(2, 5, [1, 3])),
    points: [0, 0, 1, 2, 2, -1, 3, 1, 4, 0],
    weights: [1, 2, 1, 0.5, 1],
  });

  it('allocating evaluators throw beyond paramRel slack and clamp within it', () => {
    expect(curvePoint(c, 3 + 1e-13)).toEqual(curvePoint(c, 3));
    expect(curvePoint(c, 1 - 1e-13)).toEqual(curvePoint(c, 1));
    expectCode(() => curvePoint(c, 3 + 1e-10), 'param-out-of-domain');
    expectCode(() => curvePoint(c, NaN), 'non-finite');
    expectCode(() => curveDerivatives(c, 2, 4 as 3), 'unsupported');
  });

  it('kernels clamp out-of-domain and NaN parameters without throwing', () => {
    expect(Array.from(evalFlat(c, 99, 2))).toEqual(Array.from(evalFlat(c, 3, 2)));
    expect(Array.from(evalFlat(c, NaN, 2))).toEqual(Array.from(evalFlat(c, 1, 2)));
    expect(Array.from(evalFlat(c, -Infinity, 1))).toEqual(Array.from(evalFlat(c, 1, 1)));
  });

  it('only the inner side exists at a clamped end', () => {
    expectCode(() => curveDerivatives(c, 1, 1, 'left'), 'side-unavailable');
    expectCode(() => curveDerivatives(c, 3, 1, 'right'), 'side-unavailable');
    expect(curveDerivatives(c, 3, 1)).toEqual(curveDerivatives(c, 3, 1, 'left'));
    expect(curveDerivatives(c, 1, 1)).toEqual(curveDerivatives(c, 1, 1, 'right'));
  });

  it('kernels check the scratch and the output size', () => {
    const out = new Float64Array(6);
    expectCode(
      () => curveEvalInto(c, 2, 2, out, 0, createScratch({ maxDegree: 1 })),
      'scratch-too-small',
    );
    expectCode(
      () => curveEvalInto(c, 2, 2, out, 0, createScratch({ maxDegree: 2, maxDerivs: 1 })),
      'scratch-too-small',
    );
    expectCode(
      () => curveEvalInto(c, 2, 2, out, 1, createScratch({ maxDegree: 2 })),
      'size-mismatch',
    );
    expectCode(
      () => curveEvalInto(c, 2, 5 as 3, out, 0, createScratch({ maxDegree: 2 })),
      'unsupported',
    );
    expectCode(() => createScratch({ maxDegree: 0 }), 'invalid-degree');
    expectCode(() => createScratch({ maxDegree: 2, maxDerivs: 4 }), 'unsupported');
  });
});

// ---------------------------------------------------------------------------
// clampUnclamped
// ---------------------------------------------------------------------------

describe('clampUnclamped', () => {
  /** The unclamped curve evaluated with A2.4 on its own knots. */
  function unclampedPoint(
    p: number,
    U: number[],
    P: number[],
    w: number[],
    dim: number,
    t: number,
  ): number[] {
    const num = new Array<number>(dim).fill(0);
    let den = 0;
    for (let i = 0; i < w.length; i++) {
      const N = oneBasisFun(p, U.length - 1, U, i, t) * w[i]!;
      den += N;
      for (let d = 0; d < dim; d++) num[d] = num[d]! + N * P[i * dim + d]!;
    }
    return num.map((x) => x / den);
  }

  it('gives the identical curve on the domain, for uniform and irregular unclamped knots', () => {
    const rng = mulberry32(91);
    for (let trial = 0; trial < 16; trial++) {
      const p = 1 + (trial % 4);
      const count = p + 1 + Math.floor(rng() * 6);
      const U = Array.from({ length: count + p + 1 }, (_, i) => i + (trial % 2 ? 0.4 * rng() : 0));
      for (let i = 1; i < U.length; i++) U[i] = Math.max(U[i]!, U[i - 1]! + 0.2);
      const dim = 2;
      const P = Array.from({ length: count * dim }, () => 2 * rng() - 1);
      const w = Array.from({ length: count }, () => (trial % 3 ? 0.5 + rng() : 1));
      const c = clampUnclamped({ dim, degree: p, knots: U, points: P, weights: w });
      const [a, b] = curveDomain(c);
      expect([a, b]).toEqual([U[p], U[count]]);
      // Shape invariance at 200 parameters and every knot: 1e-13 · scale (design: knot
      // insertion is convex combinations, ~ε per step, chained ≤ p times).
      const ts = [
        ...Array.from({ length: 200 }, () => a + rng() * (b - a)),
        ...U.filter((x) => x >= a && x < b),
      ];
      for (const t of ts) {
        const ref = unclampedPoint(p, U, P, w, dim, t);
        const got = evalFlat(c, t, 0);
        for (let d = 0; d < dim; d++)
          expect(Math.abs(got[d]! - ref[d]!)).toBeLessThanOrEqual(1e-13 * 2);
      }
    }
  });

  /**
   * The left-hand limit at `t` of the unclamped curve, by A2.4 on the mirrored
   * knots: `N_{i,p}(t⁻)` on U equals `N_{n−i,p}(−t)` on `U′_j = −U_{m−j}`
   * (A2.4's half-open spans give right-hand limits). At `t = b` this is the
   * curve's value on the domain: a knot run that starts before index `count`
   * switches on `N_{count−1}` from the right only.
   */
  function unclampedPointLeft(
    p: number,
    U: number[],
    P: number[],
    w: number[],
    dim: number,
    t: number,
  ): number[] {
    const n = w.length - 1;
    const Um = U.map((_, j) => -U[U.length - 1 - j]!);
    const Pm = Array.from(
      { length: P.length },
      (_, j) => P[(n - Math.floor(j / dim)) * dim + (j % dim)]!,
    );
    return unclampedPoint(p, Um, Pm, [...w].reverse(), dim, -t);
  }

  it('handles every end multiplicity 1 … p + 1 and every position of the end runs', () => {
    // An end run of multiplicity s covers index p (start) or count (end) at any
    // offset: runs may start before index p, end after index count, or be
    // already clamped (s = p + 1 at the very ends). Each start case meets each
    // end case once, with one or two simple interior knots.
    const rng = mulberry32(17);
    let cases = 0;
    for (const p of [2, 3]) {
      for (let sa = 1; sa <= p + 1; sa++) {
        for (let oa = 0; oa <= Math.min(sa - 1, p); oa++) {
          for (let sb = 1; sb <= p + 1; sb++) {
            for (let j = 0; j < sb; j++) {
              // Knot values: simple knots below a = 0, the a-run, simple interior
              // knots, the b-run, simple knots above b; irregular spacing.
              const ra = p - oa; // index of the a-run's first knot
              const ni = 1 + Math.floor(rng() * 2);
              const after = j + p + 1 - sb;
              const U: number[] = [];
              for (let i = ra; i > 0; i--) U.push(-i - 0.3 * rng());
              for (let i = 0; i < sa; i++) U.push(0);
              for (let i = 1; i <= ni; i++) U.push(i + 0.3 * rng());
              const b = ni + 1;
              for (let i = 0; i < sb; i++) U.push(b);
              for (let i = 1; i <= after; i++) U.push(b + i + 0.3 * rng());
              const count = U.length - p - 1;
              expect([U[p], U[count]]).toEqual([0, b]);
              const dim = 2;
              const P = Array.from({ length: count * dim }, () => 2 * rng() - 1);
              const w = Array.from({ length: count }, () => 0.5 + rng());
              const label = `p ${p} a-run ${sa}@${ra} b-run ${sb}@${count - j} U ${U.join(',')}`;
              const c = clampUnclamped({ dim, degree: p, knots: U, points: P, weights: w });
              expect(curveDomain(c), label).toEqual([0, b]);
              // Same tolerance as the random case above: 1e-13 · scale.
              const ts = [
                ...Array.from({ length: 50 }, () => rng() * b),
                ...U.filter((x) => x >= 0 && x < b),
              ];
              for (const t of ts) {
                const ref = unclampedPoint(p, U, P, w, dim, t);
                const got = evalFlat(c, t, 0);
                for (let d = 0; d < dim; d++)
                  expect(Math.abs(got[d]! - ref[d]!), `${label} t ${t}`).toBeLessThanOrEqual(2e-13);
              }
              // At b the domain's value is the left-hand limit, and the clamped
              // curve ends exactly on its last control point.
              const ref = unclampedPointLeft(p, U, P, w, dim, b);
              const got = evalFlat(c, b, 0);
              const last = controlPoint(c, c.basis.count - 1);
              expect([got[0], got[1]], label).toEqual([last.x, last.y]);
              for (let d = 0; d < dim; d++)
                expect(Math.abs(got[d]! - ref[d]!), `${label} t = b`).toBeLessThanOrEqual(2e-13);
              cases++;
            }
          }
        }
      }
    }
    // p = 2: 6 start × 6 end cases; p = 3: 10 × 10.
    expect(cases).toBe(136);
  });

  it('returns a clamped input unchanged', () => {
    const U = [0, 0, 0, 0.4, 1, 1, 1];
    const P = [0, 0, 1, 1, 2, 0, 3, 1];
    const c = clampUnclamped({ dim: 2, degree: 2, knots: U, points: P });
    expect(Array.from(c.basis.knots)).toEqual(U);
    expect(Array.from(net(c).P)).toEqual(P);
  });

  it('rejects invalid unclamped input', () => {
    expectCode(
      () => clampUnclamped({ dim: 2, degree: 2, knots: [0, 1, 2, 3, 4], points: [0, 0, 1, 1] }),
      'knot-count',
    );
    expectCode(
      () => clampUnclamped({ dim: 1, degree: 1, knots: [0, 1, 1, 1, 2, 3], points: [0, 1, 2, 3] }),
      'knot-multiplicity',
    );
    expectCode(
      () => clampUnclamped({ dim: 1, degree: 1, knots: [0, 2, 1, 3], points: [0, 1] }),
      'knots-decreasing',
    );
  });
});
