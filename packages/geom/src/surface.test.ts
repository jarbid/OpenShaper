// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Surface oracles (design §16, `surface` row; `book/surface`):
 *
 * - tensor-product Bézier patches against the closed-form Bernstein double
 *   sum and its exact partial derivatives, with the rational quotient rule
 *   written out independently of A4.4;
 * - linear precision: Greville control points reproduce `(u, v, uv)` exactly
 *   on any clamped knot vectors, with closed-form derivatives;
 * - every surface (clamped or periodic, rational or not) against A2.4, an
 *   independent basis algorithm, summed over the net;
 * - partial derivatives to second order against Richardson-extrapolated
 *   central differences of the next lower order;
 * - one-sided derivatives at a C⁰ knot line against the two Bézier halves;
 * - invariance under knot insertion (P&T A5.1 applied to every row or column);
 * - exact iso curves (`isoCurve(s, 'u', u₀)(v) = S(u₀, v)`) and boundary curves
 *   (the net's first or last row or column);
 * - affine invariance; periodic wrap; kernels equal their wrappers bit for bit.
 *
 * Tolerances (`ε` = 2.2·10⁻¹⁶, `M` = largest control coordinate, `ρ` = max/min
 * weight). A value is a sum of (p + 1)(q + 1) products of basis values and
 * control coordinates: it errs by a few ε·M·ρ. A `(k, l)` partial multiplies
 * by basis derivatives up to `p!/(p−k)! · q!/(q−l)!` times `2^(k+l)` (Bernstein
 * on a unit span) and the quotient rule by another `ρ^(k+l)`, which also
 * gives a rational degree-1 direction second partials of size `(2p)^k`; so
 * `tol_kl = 64 ε · M · ρ^(k+l+1) · (2p)^k · (2q)^l` (64: ~10 flops per term
 * and the quotient). Finite differences: `1e-8` relative to the
 * local scale (F1's curve rule; truncation ~h⁴ ≈ 1e-12 at h = 2⁻¹⁰ of the span,
 * cancellation ~ε·1024 ≈ 2e-13). Shape invariance under insertion and the
 * re-associated iso curves: `1e-13 · scale` (convex combinations, ~ε per step).
 */
import { describe, expect, it } from 'vitest';
import {
  basisFunction,
  bezierSurface,
  boundaryCurve,
  clampedBasis,
  createScratch,
  curveDerivatives,
  curvePoint,
  isGeomError,
  isoCurve,
  knotsFromBreaks,
  makeSurface,
  reviveSurface,
  surfaceBounds,
  surfaceControlPoint,
  surfaceControlWeight,
  surfaceDerivatives,
  surfaceDomain,
  surfaceEvalGridInto,
  surfaceEvalInto,
  surfaceFromHomogeneous,
  surfacePoint,
  surfaceToJSON,
  transformSurface,
  vec,
  withSurfaceControlNet,
  withSurfaceControlPoints,
  withSurfaceWeights,
} from './index';
import type { Affine3, GeomErrorCode, NurbsSurface, Point3 } from './index';
import { curveKnotIns } from './book/refine';
import { mulberry32, randomClampedBasis, randomSurface } from './testing';

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

const dist = (a: Point3, b: Point3): number => vec.distance(a, b);
const norm = (a: Point3): number => vec.norm(a);

/** Largest absolute Euclidean control coordinate and the weight ratio of a surface. */
function scaleOf(s: NurbsSurface): { M: number; rho: number } {
  let M = 0;
  let wmin = Infinity;
  let wmax = 0;
  for (let k = 0; k < s.u.count * s.v.count; k++) {
    const w = s.cw[4 * k + 3]!;
    wmin = Math.min(wmin, w);
    wmax = Math.max(wmax, w);
    for (let c = 0; c < 3; c++) M = Math.max(M, Math.abs(s.cw[4 * k + c]! / w));
  }
  return { M, rho: wmax / wmin };
}

const binom = (n: number, k: number): number => {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
};

/** The k-th derivative of the Bernstein polynomial `B_i^p` at `u` (closed form, recursive). */
function bernstein(p: number, i: number, u: number, k: number): number {
  if (i < 0 || i > p) return 0;
  if (k === 0) return binom(p, i) * u ** i * (1 - u) ** (p - i);
  if (p === 0) return 0;
  return p * (bernstein(p - 1, i - 1, u, k - 1) - bernstein(p - 1, i, u, k - 1));
}

/** Closed-form `S` and its partials to order 2 of a rational Bézier patch, quotient rule written out. */
function bezierOracle(
  P: ArrayLike<number>,
  w: ArrayLike<number>,
  nu: number,
  nv: number,
  u: number,
  v: number,
): Point3[] {
  const p = nu - 1;
  const q = nv - 1;
  // A^(k,l) (3 values) and W^(k,l) for k + l ≤ 2.
  const A = (k: number, l: number): [number, number, number, number] => {
    const r: [number, number, number, number] = [0, 0, 0, 0];
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) {
        const b = bernstein(p, i, u, k) * bernstein(q, j, v, l);
        const wij = w[i * nv + j]!;
        for (let c = 0; c < 3; c++) r[c] = r[c]! + b * wij * P[(i * nv + j) * 3 + c]!;
        r[3] += b * wij;
      }
    }
    return r;
  };
  const [a00, a10, a01, a20, a11, a02] = [A(0, 0), A(1, 0), A(0, 1), A(2, 0), A(1, 1), A(0, 2)];
  const W = a00[3];
  const pt = (f: (c: number) => number): Point3 => ({ x: f(0), y: f(1), z: f(2) });
  const S = pt((c) => a00[c]! / W);
  const g = (p3: Point3, c: number): number => (c === 0 ? p3.x : c === 1 ? p3.y : p3.z);
  const Su = pt((c) => (a10[c]! - a10[3] * g(S, c)) / W);
  const Sv = pt((c) => (a01[c]! - a01[3] * g(S, c)) / W);
  const Suu = pt((c) => (a20[c]! - 2 * a10[3] * g(Su, c) - a20[3] * g(S, c)) / W);
  const Suv = pt((c) => (a11[c]! - a10[3] * g(Sv, c) - a01[3] * g(Su, c) - a11[3] * g(S, c)) / W);
  const Svv = pt((c) => (a02[c]! - 2 * a01[3] * g(Sv, c) - a02[3] * g(S, c)) / W);
  return [S, Su, Sv, Suu, Suv, Svv];
}

const ORDERS: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [0, 1],
  [2, 0],
  [1, 1],
  [0, 2],
];

const asList = (d: ReturnType<typeof surfaceDerivatives>): Point3[] => {
  const full = d as { Suu?: Point3; Suv?: Point3; Svv?: Point3 };
  return [d.S, d.Su, d.Sv, full.Suu!, full.Suv!, full.Svv!];
};

describe('tensor-product Bézier patches against the Bernstein closed form', () => {
  it('match values and partials to second order, polynomial and rational (A3.6, A4.4)', () => {
    const rng = mulberry32(11);
    for (let trial = 0; trial < 80; trial++) {
      const nu = 2 + (trial % 4);
      const nv = 2 + ((trial >> 2) % 4);
      const rational = trial % 2 === 1;
      const P = Array.from({ length: nu * nv * 3 }, () => 4 * rng() - 2);
      const w = Array.from({ length: nu * nv }, () => (rational ? 0.4 + 2 * rng() : 1));
      const s = bezierSurface(P, nu, nv, rational ? w : undefined);
      expect(s.rational).toBe(rational);
      const { M, rho } = scaleOf(s);
      for (const [u, v] of [
        [0, 0],
        [1, 1],
        [0, 1],
        [rng(), rng()],
        [rng(), rng()],
        [0.5, rng()],
      ] as const) {
        const got = asList(surfaceDerivatives(s, u, v, 2));
        const want = bezierOracle(P, w, nu, nv, u, v);
        ORDERS.forEach(([k, l], t) => {
          const tol = 64 * EPS * M * rho ** (k + l + 1) * (2 * (nu - 1)) ** k * (2 * (nv - 1)) ** l;
          const err = dist(got[t]!, want[t]!);
          expect(err, `trial ${trial} (${k},${l}) at (${u}, ${v})`).toBeLessThanOrEqual(tol);
        });
      }
    }
  });

  it('interpolates its corner control points exactly', () => {
    const P = [0, 0, 1, 1, 0, 2, 2, 0, 3, 0, 1, 4, 1, 1, 5, 2, 1, 6];
    const s = bezierSurface(P, 2, 3, [1, 2, 3, 0.5, 1.5, 2.5]);
    expect(surfacePoint(s, 0, 0)).toEqual({ x: 0, y: 0, z: 1 });
    expect(surfacePoint(s, 0, 1)).toEqual({ x: 2, y: 0, z: 3 });
    expect(surfacePoint(s, 1, 0)).toEqual({ x: 0, y: 1, z: 4 });
    expect(surfacePoint(s, 1, 1)).toEqual({ x: 2, y: 1, z: 6 });
  });
});

/** Greville abscissae `ξ_i = (t_{i+1} + … + t_{i+p})/p` of a clamped basis. */
function greville(U: ArrayLike<number>, p: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => {
    let s = 0;
    for (let k = 1; k <= p; k++) s += U[i + k]!;
    return s / p;
  });
}

describe('linear precision on arbitrary clamped knots', () => {
  it('Greville control points (ξ_i, η_j, ξ_i η_j) reproduce (u, v, uv) with exact partials', () => {
    const rng = mulberry32(3);
    for (let trial = 0; trial < 40; trial++) {
      const p = 1 + (trial % 4);
      const q = 1 + ((trial >> 2) % 4);
      const bu = randomClampedBasis(rng, p, p + 1 + (trial % 6), {
        domain: [-1, 2],
        maxMult: p,
      });
      const bv = randomClampedBasis(rng, q, q + 2 + (trial % 5), { domain: [0.5, 3], maxMult: q });
      const xi = greville(bu.knots, p, bu.count);
      const eta = greville(bv.knots, q, bv.count);
      const pts: number[] = [];
      for (const x of xi) for (const y of eta) pts.push(x, y, x * y);
      const s = makeSurface({ u: bu, v: bv, points: pts });
      // Value tolerance: (p + 1)(q + 1) products of size ≤ 9; derivatives scale
      // by the largest p/h (h ≥ 1/20 of the domain: 20·4/3 for u).
      const tol0 = 64 * EPS * 9;
      const tol1 = tol0 * 20 * 4;
      for (let k = 0; k < 20; k++) {
        const u = -1 + 3 * rng();
        const v = 0.5 + 2.5 * rng();
        const d = surfaceDerivatives(s, u, v, 2);
        expect(dist(d.S, { x: u, y: v, z: u * v })).toBeLessThanOrEqual(tol0);
        expect(dist(d.Su, { x: 1, y: 0, z: v })).toBeLessThanOrEqual(tol1);
        expect(dist(d.Sv, { x: 0, y: 1, z: u })).toBeLessThanOrEqual(tol1);
        expect(norm(d.Suu)).toBeLessThanOrEqual(tol1 * 20 * 4);
        expect(dist(d.Suv, { x: 0, y: 0, z: 1 })).toBeLessThanOrEqual(tol1 * 20 * 4);
        expect(norm(d.Svv)).toBeLessThanOrEqual(tol1 * 20 * 4);
      }
    }
  });
});

describe('every surface against A2.4 (independent basis algorithm)', () => {
  it('S = Σ R_ij P_ij on clamped and periodic, polynomial and rational nets', () => {
    const rng = mulberry32(5);
    for (let trial = 0; trial < 24; trial++) {
      const s = randomSurface(rng, {
        degreeU: 1 + (trial % 4),
        degreeV: 1 + ((trial + 1) % 3),
        countU: 6,
        countV: 5,
        kindU: trial % 3 === 0 ? 'periodic' : 'clamped',
        kindV: trial % 4 === 1 ? 'periodic' : 'clamped',
        basis: { maxMult: 2 },
        weightRange: trial % 2 ? [0.3, 3] : undefined,
      });
      const { M, rho } = scaleOf(s);
      const [ua, ub] = s.u.domain;
      const [va, vb] = s.v.domain;
      for (let k = 0; k < 25; k++) {
        const u = ua + (ub - ua) * rng();
        const v = va + (vb - va) * rng();
        let x = 0;
        let y = 0;
        let z = 0;
        let W = 0;
        for (let i = 0; i < s.u.count; i++) {
          const Ni = basisFunction(s.u, i, u);
          if (Ni === 0) continue;
          for (let j = 0; j < s.v.count; j++) {
            const b = Ni * basisFunction(s.v, j, v) * surfaceControlWeight(s, i, j);
            const P = surfaceControlPoint(s, i, j);
            x += b * P.x;
            y += b * P.y;
            z += b * P.z;
            W += b;
          }
        }
        const want = { x: x / W, y: y / W, z: z / W };
        expect(dist(surfacePoint(s, u, v), want), `trial ${trial}`).toBeLessThanOrEqual(
          64 * EPS * M * rho,
        );
      }
    }
  });
});

/** A parameter strictly inside a random non-empty span, at least a quarter span from its knots, and the span length. */
function insideSpan(rng: () => number, knots: ArrayLike<number>): { t: number; h: number } {
  const breaks: number[] = [];
  for (let i = 0; i < knots.length; i++)
    if (i === 0 || knots[i] !== knots[i - 1]) breaks.push(knots[i]!);
  // Periodic: the stored knots are one period; the last span ends at t0 + T.
  const k = Math.floor(rng() * (breaks.length - 1));
  const a = breaks[k]!;
  const b = breaks[k + 1]!;
  return { t: a + (0.25 + 0.5 * rng()) * (b - a), h: b - a };
}

/** Richardson-extrapolated central difference of a vector function at step h. */
function richardson(f: (x: number) => Point3, x: number, h: number): Point3 {
  const D = (k: number): Point3 => vec.scale(vec.sub(f(x + k), f(x - k)), 1 / (2 * k));
  return vec.scale(vec.sub(vec.scale(D(h / 2), 4), D(h)), 1 / 3);
}

describe('partial derivatives against finite differences', () => {
  it('Su, Sv from S and Suu, Suv, Svv from Su, Sv agree to 1e-8 of the local scale', () => {
    const rng = mulberry32(17);
    let worst = 0;
    for (let trial = 0; trial < 60; trial++) {
      const periodicU = trial % 3 === 0;
      const periodicV = trial % 5 === 2;
      const s = randomSurface(rng, {
        degreeU: 2 + (trial % 3),
        degreeV: 1 + (trial % 4),
        countU: 7,
        countV: 6,
        kindU: periodicU ? 'periodic' : 'clamped',
        kindV: periodicV ? 'periodic' : 'clamped',
        basis: { maxMult: 2, domain: [0.5, 2.5] },
        weightRange: trial % 2 ? [0.4, 2.5] : undefined,
      });
      const knotsU = periodicU ? [...s.u.knots, s.u.domain[1]] : s.u.knots;
      const knotsV = periodicV ? [...s.v.knots, s.v.domain[1]] : s.v.knots;
      for (let k = 0; k < 6; k++) {
        const { t: u, h: hu } = insideSpan(rng, knotsU);
        const { t: v, h: hv } = insideSpan(rng, knotsV);
        const d = surfaceDerivatives(s, u, v, 2);
        const du = hu / 1024;
        const dv = hv / 1024;
        const fdU = (g: (x: ReturnType<typeof surfaceDerivatives>) => Point3) =>
          richardson((x) => g(surfaceDerivatives(s, x, v, 2)), u, du);
        const fdV = (g: (x: ReturnType<typeof surfaceDerivatives>) => Point3) =>
          richardson((y) => g(surfaceDerivatives(s, u, y, 2)), v, dv);
        const checks: [Point3, Point3, number][] = [
          [d.Su, fdU((x) => x.S), Math.max(norm(d.Su), norm(d.S) / hu)],
          [d.Sv, fdV((x) => x.S), Math.max(norm(d.Sv), norm(d.S) / hv)],
          [d.Suu, fdU((x) => x.Su), Math.max(norm(d.Suu), norm(d.Su) / hu)],
          [d.Suv, fdV((x) => x.Su), Math.max(norm(d.Suv), norm(d.Su) / hv)],
          [d.Suv, fdU((x) => x.Sv), Math.max(norm(d.Suv), norm(d.Sv) / hu)],
          [d.Svv, fdV((x) => x.Sv), Math.max(norm(d.Svv), norm(d.Sv) / hv)],
        ];
        checks.forEach(([got, want, scale], c) => {
          const rel = dist(got, want) / scale;
          worst = Math.max(worst, rel);
          expect(rel, `trial ${trial} check ${c}`).toBeLessThanOrEqual(1e-8);
        });
      }
    }
    expect(worst).toBeGreaterThan(0);
  });

  it('one-sided partials at a C⁰ knot line equal the two Bézier halves', () => {
    // u knots [0,0,0,½,½,1,1,1]: rows 0–2 are the left half, rows 2–4 the right
    // half, each a Bézier patch in u' = 2u (left) or 2u − 1 (right).
    const rng = mulberry32(23);
    const nv = 3;
    const pts = Array.from({ length: 5 * nv * 3 }, () => 2 * rng() - 1);
    const wts = Array.from({ length: 5 * nv }, () => 0.5 + rng());
    const s = makeSurface({
      u: clampedBasis(2, [0, 0, 0, 0.5, 0.5, 1, 1, 1]),
      v: clampedBasis(2, [0, 0, 0, 1, 1, 1]),
      points: pts,
      weights: wts,
    });
    const half = (r0: number) =>
      bezierSurface(
        pts.slice(r0 * nv * 3, (r0 + 3) * nv * 3),
        3,
        nv,
        wts.slice(r0 * nv, (r0 + 3) * nv),
      );
    const left = half(0);
    const right = half(2);
    const { M, rho } = scaleOf(s);
    for (const v of [0, 0.3, 0.77, 1]) {
      const L = surfaceDerivatives(s, 0.5, v, 2, { u: 'left' });
      const R = surfaceDerivatives(s, 0.5, v, 2, { u: 'right' });
      const bl = surfaceDerivatives(left, 1, v, 2);
      const br = surfaceDerivatives(right, 0, v, 2);
      // Chain rule u' = 2u (± 1): ∂/∂u = 2 ∂/∂u'.
      const pairs: [Point3, Point3, number][] = [
        [L.S, bl.S, 0],
        [L.Su, vec.scale(bl.Su, 2), 1],
        [L.Sv, bl.Sv, 1],
        [L.Suu, vec.scale(bl.Suu, 4), 2],
        [L.Suv, vec.scale(bl.Suv, 2), 2],
        [L.Svv, bl.Svv, 2],
        [R.S, br.S, 0],
        [R.Su, vec.scale(br.Su, 2), 1],
        [R.Sv, br.Sv, 1],
        [R.Suu, vec.scale(br.Suu, 4), 2],
        [R.Suv, vec.scale(br.Suv, 2), 2],
        [R.Svv, br.Svv, 2],
      ];
      for (const [a, b, k] of pairs) {
        expect(dist(a, b)).toBeLessThanOrEqual(64 * EPS * M * rho ** (k + 1) * 4 ** k * 8);
      }
      // A genuine C⁰ join: the u-partials differ from side to side.
      expect(dist(L.Su, R.Su)).toBeGreaterThan(1e-3);
      expect(dist(L.S, R.S)).toBe(0);
    }
    expectCode(() => surfaceDerivatives(s, 0, 0.5, 1, { u: 'left' }), 'side-unavailable');
    expectCode(() => surfaceDerivatives(s, 0.5, 1, 1, { v: 'right' }), 'side-unavailable');
  });
});

/** Inserts knot `x` once into every row (dir 'v') or column (dir 'u') of the net with A5.1. */
function insertEverywhere(s: NurbsSurface, dir: 'u' | 'v', x: number): NurbsSurface {
  const b = dir === 'u' ? s.u : s.v;
  if (b.kind !== 'clamped') throw new Error('test helper: clamped only');
  const p = b.degree;
  const U = b.knots;
  let k = p;
  while (k < b.count - 1 && x >= U[k + 1]!) k++;
  let mult = 0;
  for (let i = 0; i < U.length; i++) if (U[i] === x) mult++;
  const nu = s.u.count;
  const nv = s.v.count;
  const lines = dir === 'v' ? nu : nv;
  const len = dir === 'v' ? nv : nu;
  let UQ: Float64Array | null = null;
  const out: Float64Array[] = [];
  for (let l = 0; l < lines; l++) {
    const Pw = new Float64Array(len * 4);
    for (let m = 0; m < len; m++) {
      const src = dir === 'v' ? (l * nv + m) * 4 : (m * nv + l) * 4;
      for (let c = 0; c < 4; c++) Pw[m * 4 + c] = s.cw[src + c]!;
    }
    const r = curveKnotIns(len - 1, p, U, Pw, 4, x, k, mult, 1);
    UQ = r.UQ;
    out.push(r.Qw);
  }
  const len2 = len + 1;
  const cw = new Float64Array(lines * len2 * 4);
  for (let l = 0; l < lines; l++) {
    for (let m = 0; m < len2; m++) {
      const dst = dir === 'v' ? (l * len2 + m) * 4 : (m * nv + l) * 4;
      for (let c = 0; c < 4; c++) cw[dst + c] = out[l]![m * 4 + c]!;
    }
  }
  const nb = clampedBasis(p, UQ!);
  return surfaceFromHomogeneous({ u: dir === 'u' ? nb : s.u, v: dir === 'v' ? nb : s.v, cw });
}

describe('invariance under knot insertion', () => {
  it('inserting a knot in u or v (A5.1 per row or column) leaves the surface unchanged', () => {
    const rng = mulberry32(29);
    for (let trial = 0; trial < 12; trial++) {
      const s = randomSurface(rng, {
        degreeU: 1 + (trial % 4),
        degreeV: 2 + (trial % 2),
        countU: 6,
        countV: 7,
        basis: { maxMult: 2 },
        weightRange: trial % 2 ? [0.5, 2] : undefined,
      });
      const { M } = scaleOf(s);
      for (const dir of ['u', 'v'] as const) {
        const x = 0.05 + 0.9 * rng();
        const r = insertEverywhere(s, dir, x);
        expect((dir === 'u' ? r.u : r.v).count).toBe((dir === 'u' ? s.u : s.v).count + 1);
        for (let k = 0; k < 50; k++) {
          const u = rng();
          const v = rng();
          const a = asList(surfaceDerivatives(s, u, v, 2));
          const b = asList(surfaceDerivatives(r, u, v, 2));
          expect(dist(a[0]!, b[0]!)).toBeLessThanOrEqual(1e-13 * M);
          // Partials: the same identity, scaled by the derivative magnification (≤ (20·4)^k).
          for (let t = 1; t < 6; t++) {
            const ord = t < 3 ? 1 : 2;
            expect(dist(a[t]!, b[t]!)).toBeLessThanOrEqual(1e-13 * M * 80 ** ord);
          }
        }
      }
    }
  });
});

describe('iso and boundary curves', () => {
  it('isoCurve(s, u, u0)(v) is S(u0, v) bit for bit, and isoCurve(s, v, v0)(u) to 1e-14·scale', () => {
    const rng = mulberry32(31);
    for (let trial = 0; trial < 20; trial++) {
      const s = randomSurface(rng, {
        degreeU: 1 + (trial % 3),
        degreeV: 1 + (trial % 4),
        countU: 6,
        countV: 6,
        kindU: trial % 3 === 0 ? 'periodic' : 'clamped',
        kindV: trial % 4 === 1 ? 'periodic' : 'clamped',
        basis: { maxMult: 2 },
        weightRange: trial % 2 ? [0.3, 3] : undefined,
      });
      const { M, rho } = scaleOf(s);
      const u0 = s.u.domain[0] + rng() * (s.u.domain[1] - s.u.domain[0]);
      const v0 = s.v.domain[0] + rng() * (s.v.domain[1] - s.v.domain[0]);
      const cu = isoCurve(s, 'u', u0);
      const cv = isoCurve(s, 'v', v0);
      expect(cu.basis).toBe(s.v);
      expect(cv.basis).toBe(s.u);
      for (let k = 0; k < 20; k++) {
        const v = s.v.domain[0] + rng() * (s.v.domain[1] - s.v.domain[0]);
        const u = s.u.domain[0] + rng() * (s.u.domain[1] - s.u.domain[0]);
        expect(curvePoint(cu, v)).toEqual(surfacePoint(s, u0, v));
        expect(dist(curvePoint(cv, u), surfacePoint(s, u, v0))).toBeLessThanOrEqual(
          1e-14 * M * rho,
        );
        // Its derivative is the surface's partial along it.
        const dc = curveDerivatives(cu, v, 2);
        const ds = surfaceDerivatives(s, u0, v, 2);
        expect(dc[1]).toEqual(ds.Sv);
        expect(dist(dc[2]!, ds.Svv)).toBeLessThanOrEqual(1e-14 * M * rho ** 3 * 80 ** 2);
        const dcv = curveDerivatives(cv, u, 1);
        expect(dist(dcv[1]!, surfaceDerivatives(s, u, v0, 1).Su)).toBeLessThanOrEqual(
          1e-14 * M * rho ** 2 * 80,
        );
      }
    }
  });

  it('boundary curves are the first and last net rows and columns, equal to the iso curves at the ends', () => {
    const rng = mulberry32(37);
    const s = randomSurface(rng, {
      degreeU: 3,
      degreeV: 2,
      countU: 6,
      countV: 5,
      weightRange: [0.5, 2],
    });
    const nv = s.v.count;
    const u0 = boundaryCurve(s, 'u0');
    const u1 = boundaryCurve(s, 'u1');
    const v0 = boundaryCurve(s, 'v0');
    const v1 = boundaryCurve(s, 'v1');
    expect(Array.from(u0.cw)).toEqual(Array.from(s.cw.slice(0, nv * 4)));
    expect(Array.from(u1.cw)).toEqual(Array.from(s.cw.slice((s.u.count - 1) * nv * 4)));
    for (let i = 0; i < s.u.count; i++) {
      for (let c = 0; c < 4; c++) {
        expect(v0.cw[i * 4 + c]).toBe(s.cw[i * nv * 4 + c]);
        expect(v1.cw[i * 4 + c]).toBe(s.cw[(i * nv + nv - 1) * 4 + c]);
      }
    }
    expect(Array.from(u0.cw)).toEqual(Array.from(isoCurve(s, 'u', 0).cw));
    expect(Array.from(u1.cw)).toEqual(Array.from(isoCurve(s, 'u', 1).cw));
    expect(Array.from(v0.cw)).toEqual(Array.from(isoCurve(s, 'v', 0).cw));
    expect(Array.from(v1.cw)).toEqual(Array.from(isoCurve(s, 'v', 1).cw));
    expect(u0.basis).toBe(s.v);
    expect(v1.basis).toBe(s.u);
    const per = randomSurface(rng, {
      degreeU: 2,
      degreeV: 2,
      countU: 5,
      countV: 5,
      kindU: 'periodic',
    });
    expectCode(() => boundaryCurve(per, 'u0'), 'unsupported');
    expect(boundaryCurve(per, 'v1').basis).toBe(per.u);
    expectCode(() => isoCurve(s, 'u', 1.5), 'param-out-of-domain');
  });
});

describe('affine maps, periodic wrap and bounds', () => {
  it('transformSurface maps every point and partial (affine invariance)', () => {
    const rng = mulberry32(41);
    const m: Affine3 = [0.5, -2, 1, 3, 1, 0.25, 0, -1, 2, 1, -0.5, 0.75];
    const lin = (p: Point3): Point3 => ({
      x: m[0] * p.x + m[1] * p.y + m[2] * p.z,
      y: m[4] * p.x + m[5] * p.y + m[6] * p.z,
      z: m[8] * p.x + m[9] * p.y + m[10] * p.z,
    });
    for (let trial = 0; trial < 6; trial++) {
      const s = randomSurface(rng, {
        degreeU: 2,
        degreeV: 3,
        countU: 5,
        countV: 6,
        kindU: trial % 2 ? 'periodic' : 'clamped',
        weightRange: [0.5, 2],
      });
      const t = transformSurface(s, m);
      expect(t.u).toBe(s.u);
      expect(t.v).toBe(s.v);
      const { M, rho } = scaleOf(t);
      for (let k = 0; k < 20; k++) {
        const u = rng();
        const v = rng();
        const a = surfaceDerivatives(s, u, v, 2);
        const b = surfaceDerivatives(t, u, v, 2);
        expect(dist(b.S, vec.applyAffine3(m, a.S))).toBeLessThanOrEqual(64 * EPS * M * rho * 4);
        expect(dist(b.Su, lin(a.Su))).toBeLessThanOrEqual(1e-12 * (1 + norm(b.Su)) * M);
        expect(dist(b.Suv, lin(a.Suv))).toBeLessThanOrEqual(1e-11 * (1 + norm(b.Suv)) * M);
      }
    }
  });

  it('periodic directions wrap exactly and join smoothly across the seam', () => {
    const rng = mulberry32(43);
    const s = randomSurface(rng, {
      degreeU: 3,
      degreeV: 2,
      countU: 7,
      countV: 6,
      kindU: 'periodic',
      kindV: 'periodic',
      basis: { domain: [0.25, 1.75] },
      weightRange: [0.5, 2],
    });
    const T = 1.5;
    for (let k = 0; k < 20; k++) {
      const u = 0.25 + T * rng();
      const v = 0.25 + T * rng();
      expect(surfacePoint(s, u + T, v)).toEqual(surfacePoint(s, u, v));
      expect(surfacePoint(s, u, v - 2 * T)).toEqual(surfacePoint(s, u, v));
    }
    // The left limit at t0 (end of the previous period) equals the right limit there.
    const { M, rho } = scaleOf(s);
    const L = surfaceDerivatives(s, 0.25, 0.9, 2, { u: 'left' });
    const R = surfaceDerivatives(s, 0.25, 0.9, 2, { u: 'right' });
    expect(dist(L.S, R.S)).toBeLessThanOrEqual(64 * EPS * M * rho);
    expect(dist(L.Su, R.Su)).toBeLessThanOrEqual(1e-12 * M * rho ** 2 * 40);
    expect(dist(L.Suu, R.Suu)).toBeLessThanOrEqual(1e-12 * M * rho ** 3 * 40 ** 2);
  });

  it('surfaceBounds contains every sampled point and touches the net', () => {
    const rng = mulberry32(47);
    const s = randomSurface(rng, {
      degreeU: 2,
      degreeV: 2,
      countU: 5,
      countV: 4,
      weightRange: [0.5, 2],
    });
    const b = surfaceBounds(s);
    for (let k = 0; k < 200; k++) {
      const p = surfacePoint(s, rng(), rng());
      for (const c of ['x', 'y', 'z'] as const) {
        expect(p[c]).toBeGreaterThanOrEqual(b.min[c] - 4 * EPS);
        expect(p[c]).toBeLessThanOrEqual(b.max[c] + 4 * EPS);
      }
    }
    expect(b.min.x).toBe(
      Math.min(...Array.from({ length: 20 }, (_, k) => surfaceControlPoint(s, k >> 2, k & 3).x)),
    );
  });
});

describe('kernels and wrappers', () => {
  it('surfaceEvalInto equals surfacePoint and surfaceDerivatives bit for bit, both sides', () => {
    const rng = mulberry32(53);
    const sc = createScratch({ maxDegree: 4 });
    const out = new Float64Array(40);
    for (let trial = 0; trial < 10; trial++) {
      const s = randomSurface(rng, {
        degreeU: 1 + (trial % 4),
        degreeV: 4 - (trial % 4),
        countU: 6,
        countV: 6,
        kindU: trial % 2 ? 'periodic' : 'clamped',
        basis: { maxMult: 2 },
        weightRange: trial % 3 ? [0.5, 2] : undefined,
      });
      const knotU = s.u.knots[Math.floor(s.u.knots.length / 2)]!;
      for (const [u, v, side] of [
        [rng(), rng(), undefined],
        [knotU, rng(), { u: 'left' as const }],
        [knotU, rng(), { u: 'right' as const }],
        [rng(), 1, undefined],
      ] as const) {
        surfaceEvalInto(s, u, v, 2, out, 3, sc, side);
        const d = asList(surfaceDerivatives(s, u, v, 2, side));
        for (let t = 0; t < 6; t++) {
          expect([out[3 + 3 * t], out[4 + 3 * t], out[5 + 3 * t]]).toEqual([
            d[t]!.x,
            d[t]!.y,
            d[t]!.z,
          ]);
        }
        surfaceEvalInto(s, u, v, 0, out, 0, sc);
        expect({ x: out[0], y: out[1], z: out[2] }).toEqual(surfacePoint(s, u, v));
        const d1 = surfaceDerivatives(s, u, v, 1, side);
        expect(Object.keys(d1).sort()).toEqual(['S', 'Su', 'Sv']);
        expect(d1.Su).toEqual(d[1]);
      }
    }
  });

  it('surfaceEvalGridInto equals surfaceEvalInto bit for bit (Float32: rounded)', () => {
    const rng = mulberry32(59);
    const sc = createScratch({ maxDegree: 3 });
    for (let trial = 0; trial < 6; trial++) {
      const s = randomSurface(rng, {
        degreeU: 3,
        degreeV: 1 + (trial % 3),
        countU: 8,
        countV: 6,
        kindU: trial % 2 ? 'periodic' : 'clamped',
        kindV: trial % 3 === 0 ? 'periodic' : 'clamped',
        weightRange: trial % 2 ? [0.5, 2] : undefined,
      });
      const us = Float64Array.from({ length: 9 }, () => -0.1 + 1.2 * rng()).sort();
      const vs = Float64Array.from({ length: 7 }, (_, j) => (j === 3 ? NaN : rng()));
      for (const nDer of [0, 1, 2] as const) {
        const st = [3, 9, 18][nDer]!;
        const out = new Float64Array(us.length * vs.length * st);
        const out32 = new Float32Array(out.length);
        surfaceEvalGridInto(s, us, vs, nDer, out, sc);
        surfaceEvalGridInto(s, us, vs, nDer, out32, sc);
        const one = new Float64Array(st);
        for (let i = 0; i < us.length; i++) {
          for (let j = 0; j < vs.length; j++) {
            surfaceEvalInto(s, us[i]!, vs[j]!, nDer, one, 0, sc);
            const o = (i * vs.length + j) * st;
            expect(Array.from(out.slice(o, o + st))).toEqual(Array.from(one));
            expect(Array.from(out32.slice(o, o + st))).toEqual(Array.from(Float32Array.from(one)));
          }
        }
      }
    }
  });

  it('kernels clamp, wrap and never throw on parameters; wrappers validate', () => {
    const s = randomSurface(mulberry32(61), { degreeU: 2, degreeV: 2, countU: 4, countV: 4 });
    const sc = createScratch({ maxDegree: 2 });
    const out = new Float64Array(18);
    const at = new Float64Array(18);
    surfaceEvalInto(s, -5, 7, 2, out, 0, sc);
    surfaceEvalInto(s, 0, 1, 2, at, 0, sc);
    expect(Array.from(out)).toEqual(Array.from(at));
    surfaceEvalInto(s, NaN, NaN, 0, out, 0, sc);
    const p00 = surfacePoint(s, 0, 0);
    expect([out[0], out[1], out[2]]).toEqual([p00.x, p00.y, p00.z]);
    expectCode(() => surfacePoint(s, 1.01, 0), 'param-out-of-domain');
    expectCode(() => surfacePoint(s, NaN, 0), 'non-finite');
    expect(surfacePoint(s, 1 + 1e-14, -1e-14)).toEqual(surfacePoint(s, 1, 0));
    expectCode(() => surfaceEvalInto(s, 0, 0, 2, new Float64Array(17), 0, sc), 'size-mismatch');
    expectCode(
      () => surfaceEvalInto(s, 0, 0, 2, out, 0, createScratch({ maxDegree: 1 })),
      'scratch-too-small',
    );
    expectCode(
      () => surfaceEvalInto(s, 0, 0, 2, out, 0, createScratch({ maxDegree: 2, maxDerivs: 1 })),
      'scratch-too-small',
    );
    expectCode(() => surfaceEvalInto(s, 0, 0, 3 as 2, out, 0, sc), 'unsupported');
    expectCode(() => surfaceDerivatives(s, 0, 0, 3 as 2), 'unsupported');
    expectCode(
      () =>
        surfaceEvalGridInto(
          s,
          Float64Array.of(0, 1),
          Float64Array.of(0),
          2,
          new Float64Array(35),
          sc,
        ),
      'size-mismatch',
    );
  });
});

describe('construction, accessors and copy-on-write edits', () => {
  const bu = clampedBasis(2, knotsFromBreaks([0, 0.5, 1], [3, 1, 3]));
  const bv = clampedBasis(1, [0, 0, 1, 2, 2]);
  const pts = Array.from({ length: 4 * 3 * 3 }, (_, k) => k * 0.25 - 3);

  it('makeSurface derives rational and keeps bases by reference; accessors read Euclidean points', () => {
    const s = makeSurface({ u: bu, v: bv, points: pts });
    expect(s.rational).toBe(false);
    expect(s.u).toBe(bu);
    expect(s.v).toBe(bv);
    expect(Object.isFrozen(s)).toBe(true);
    expect(surfaceControlPoint(s, 2, 1)).toEqual({ x: pts[21], y: pts[22], z: pts[23] });
    expect(surfaceDomain(s)).toEqual({ u: [0, 1], v: [0, 2] });
    const w = Array.from({ length: 12 }, (_, k) => 1 + k / 8);
    const r = makeSurface({ u: bu, v: bv, points: pts, weights: w });
    expect(r.rational).toBe(true);
    expect(surfaceControlWeight(r, 3, 2)).toBe(w[11]);
    const p = surfaceControlPoint(r, 3, 2);
    expect(dist(p, { x: pts[33]!, y: pts[34]!, z: pts[35]! })).toBeLessThanOrEqual(4 * EPS * 6);
    expect(makeSurface({ u: bu, v: bv, points: pts, weights: w.map(() => 1) }).rational).toBe(
      false,
    );
  });

  it('edits copy the net, keep the bases, and leave other control points bitwise', () => {
    const w = Array.from({ length: 12 }, (_, k) => 1 + k / 8);
    const s = makeSurface({ u: bu, v: bv, points: pts, weights: w });
    const a = withSurfaceControlPoints(s, [9, 8, 7], [5]);
    expect(a.u).toBe(s.u);
    expect(a.v).toBe(s.v);
    expect(surfaceControlPoint(a, 1, 2)).toEqual({ x: 9, y: 8, z: 7 });
    expect(surfaceControlWeight(a, 1, 2)).toBe(w[5]);
    for (let k = 0; k < 48; k++) if (k < 20 || k >= 24) expect(a.cw[k]).toBe(s.cw[k]);
    const b = withSurfaceWeights(s, Array(12).fill(1));
    expect(b.rational).toBe(false);
    const c = withSurfaceWeights(s, [2], [0]);
    expect(surfaceControlWeight(c, 0, 0)).toBe(2);
    expect(surfaceControlPoint(c, 0, 0)).toEqual(surfaceControlPoint(s, 0, 0));
    const d = withSurfaceControlNet(s, s.cw);
    expect(d.u).toBe(s.u);
    expect(Array.from(d.cw)).toEqual(Array.from(s.cw));
    expect(d.cw).not.toBe(s.cw);
    // Writing the same points back reproduces the net bitwise (w·x again).
    expect(Array.from(withSurfaceControlPoints(s, pts).cw)).toEqual(Array.from(s.cw));
  });

  it('JSON and structured clones revive to the same surface', () => {
    const w = Array.from({ length: 12 }, (_, k) => 1 + k / 8);
    for (const s of [
      makeSurface({ u: bu, v: bv, points: pts }),
      makeSurface({ u: bu, v: bv, points: pts, weights: w }),
      randomSurface(mulberry32(67), {
        degreeU: 2,
        degreeV: 3,
        countU: 5,
        countV: 6,
        kindU: 'periodic',
        kindV: 'periodic',
      }),
    ]) {
      const json = JSON.parse(JSON.stringify(surfaceToJSON(s))) as unknown;
      const r = reviveSurface(json);
      const c = reviveSurface(structuredClone(s));
      expect(Array.from(c.cw)).toEqual(Array.from(s.cw));
      expect(c.u).not.toBe(s.u);
      expect(Array.from(c.u.knots)).toEqual(Array.from(s.u.knots));
      expect(r.rational).toBe(s.rational);
      const { M } = scaleOf(s);
      for (let k = 0; k < s.cw.length; k++) {
        expect(Math.abs(r.cw[k]! - s.cw[k]!)).toBeLessThanOrEqual(4 * EPS * M * 3);
      }
      if (!s.rational) expect(Array.from(r.cw)).toEqual(Array.from(s.cw));
      expect(Object.isFrozen(r)).toBe(true);
    }
    expectCode(
      () => reviveSurface({ u: { kind: 'clamped', degree: 1, knots: [0, 1] }, v: {}, points: [] }),
      'knot-count',
    );
    expectCode(() => reviveSurface(3), 'size-mismatch');
  });

  it('rejects malformed input with the documented codes', () => {
    expectCode(() => makeSurface({ u: bu, v: bv, points: pts.slice(1) }), 'size-mismatch');
    expectCode(() => makeSurface({ u: bu, v: bv, points: pts, weights: [1] }), 'size-mismatch');
    expectCode(
      () => makeSurface({ u: bu, v: bv, points: pts.map((x, k) => (k === 7 ? NaN : x)) }),
      'non-finite',
    );
    expectCode(
      () => makeSurface({ u: bu, v: bv, points: pts, weights: Array(12).fill(-1) }),
      'weight-not-positive',
    );
    expectCode(
      () => surfaceFromHomogeneous({ u: bu, v: bv, cw: new Float64Array(47) }),
      'size-mismatch',
    );
    expectCode(
      () => surfaceFromHomogeneous({ u: bu, v: bv, cw: new Float64Array(48) }),
      'weight-not-positive',
    );
    expectCode(() => makeSurface({ u: { ...bu, count: 9 }, v: bv, points: pts }), 'size-mismatch');
    const s = makeSurface({ u: bu, v: bv, points: pts });
    expectCode(() => surfaceControlPoint(s, 4, 0), 'size-mismatch');
    expectCode(() => surfaceControlWeight(s, 0, -1), 'size-mismatch');
    expectCode(() => withSurfaceControlPoints(s, [1, 2, 3], [12]), 'size-mismatch');
    expectCode(() => withSurfaceWeights(s, [0], [1]), 'weight-not-positive');
    expectCode(() => withSurfaceControlNet(s, new Float64Array(4)), 'size-mismatch');
    expectCode(
      () => surfacePoint({ ...s, cw: new Float64Array(4) } as NurbsSurface, 0, 0),
      'size-mismatch',
    );
    expectCode(() => isoCurve(s, 'w' as 'u', 0), 'unsupported');
    expectCode(() => boundaryCurve(s, 'x0' as 'u0'), 'unsupported');
  });
});
