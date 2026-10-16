// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Curve-operation oracles (design §16, `curve-ops` row):
 *
 * - **shape invariance**: insertion, refinement, elevation, splitting,
 *   sub-curves, reversal twice, `toClamped`, Bézier decomposition and
 *   `makeCompatible` leave the curve unchanged at 1,001 parameters per curve,
 *   on random clamped and periodic, polynomial and rational curves of
 *   dimension 1–3 and degree 1–5 with interior multiplicities up to 2;
 * - **book fixtures**: P&T Ex. 5.1 (insertion) bitwise; eq. 5.36 (Bézier
 *   degree elevation) in closed form;
 * - **two algorithms agree**: A5.4 against repeated A5.1; elevation by `t`
 *   against `t` elevations by 1;
 * - **exact analytic cases**: the rational circle stays a circle under
 *   elevation, insertion and conversion; reparameterisation scales the first
 *   derivative by the inverse map factor;
 * - **removal recovers insertion**: inserting a knot `k` times and removing it
 *   `k` times returns the original knots bitwise and points to rounding; an
 *   essential knot is not removed; a lossy removal's reported bound is honest
 *   against dense sampling;
 * - **counts**: `knots = count + p + 1` (clamped), multiplicities as stated;
 * - **periodic windows**: the unrolled window equals the periodic curve, and
 *   after an operation its middle period equals its neighbours shifted by `T`.
 *
 * Tolerances (`ε` = 2.2·10⁻¹⁶, "scale" = diagonal of the control net's box):
 * `SHAPE = 1e-13 · scale` for every exact operation (design §16: convex
 * combinations, ~ε each, chained ≤ 100 times; measured worst 5e-15 · scale on
 * these seeds, so a wrong alpha, which moves points by O(scale), cannot pass).
 * Bitwise where the book's numbers are exact in binary.
 */
import { describe, expect, it } from 'vitest';
import {
  circle,
  clampedBasis,
  controlPointsInto,
  createScratch,
  curveFromHomogeneous,
  curveDerivatives,
  curveEvalBatchInto,
  curvePoint,
  decomposeBezier,
  elevateDegree,
  insertKnot,
  isClosed,
  isGeomError,
  knotMultiplicities,
  makeCompatible,
  makeCurve,
  normalizeDomain,
  periodicCircle,
  refineKnots,
  removeKnot,
  reparameterize,
  reverseCurve,
  splitCurve,
  subCurve,
  toClamped,
  weightsInto,
} from './index';
import type {
  ClampedCurve,
  Dim,
  GeomErrorCode,
  NurbsCurve,
  PeriodicBasis,
  PeriodicCurve,
} from './index';
import { curveKnotIns, refineKnotVectCurve } from './book/refine';
import { deviationBound } from './curve-ops';
import { extractPeriod, unrollPeriodic } from './book/periodic';
import { mulberry32, randomCurve } from './testing';

const EPS = Number.EPSILON;
/** Exact operations: see the header. */
const SHAPE = 1e-13;

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

/** Points (stride dim) at `ts`, through the batch kernel (parameters already valid). */
function evalPts(c: NurbsCurve, ts: ArrayLike<number>): Float64Array {
  const out = new Float64Array(ts.length * c.dim);
  curveEvalBatchInto(c, Float64Array.from(ts), 0, out, createScratch({ maxDegree: 12 }));
  return out;
}

function maxDist(A: Float64Array, B: Float64Array, dim: number): number {
  let m = 0;
  for (let i = 0; i < A.length / dim; i++) {
    let d2 = 0;
    for (let c = 0; c < dim; c++) d2 += (A[i * dim + c]! - B[i * dim + c]!) ** 2;
    m = Math.max(m, Math.sqrt(d2));
  }
  return m;
}

/** Diagonal of the bounding box of the Euclidean control points. */
function scaleOf(c: NurbsCurve): number {
  const P = new Float64Array(c.basis.count * c.dim);
  controlPointsInto(c, P);
  let d2 = 0;
  for (let k = 0; k < c.dim; k++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < c.basis.count; i++) {
      lo = Math.min(lo, P[i * c.dim + k]!);
      hi = Math.max(hi, P[i * c.dim + k]!);
    }
    d2 += (hi - lo) ** 2;
  }
  return Math.sqrt(d2);
}

/** 1,001 parameters over the domain (periodic: the half-open period) plus every knot in it. */
function params(c: NurbsCurve, n = 1000): number[] {
  const [a, b] = c.basis.domain;
  const per = c.basis.kind === 'periodic';
  const ts: number[] = [];
  for (let i = 0; i <= n; i++) ts.push(per ? a + ((b - a) * i) / (n + 1) : a + ((b - a) * i) / n);
  for (const k of c.basis.knots) if (k >= a && (per ? k < b : k <= b)) ts.push(k);
  return ts;
}

/** `c2(map(t))` against `c1(t)` at every parameter of c1, relative to c1's scale. */
function shapeError(
  c1: NurbsCurve,
  c2: NurbsCurve,
  map = (t: number) => t,
  ts = params(c1),
): number {
  return maxDist(evalPts(c1, ts), evalPts(c2, ts.map(map)), c1.dim) / scaleOf(c1);
}

interface Spec {
  readonly seed: number;
  readonly kind: 'clamped' | 'periodic';
  readonly dim: Dim;
  readonly degree: number;
  readonly rational: boolean;
}

/** The random-curve grid: both kinds, dims 1–3, degrees 1–5, polynomial and rational. */
function specs(): Spec[] {
  const out: Spec[] = [];
  let seed = 1;
  for (const kind of ['clamped', 'periodic'] as const) {
    for (const dim of [1, 2, 3] as const) {
      for (let degree = 1; degree <= 5; degree++) {
        for (const rational of [false, true])
          out.push({ seed: seed++, kind, dim, degree, rational });
      }
    }
  }
  return out;
}

function curveOf(s: Spec): { c: NurbsCurve; rng: () => number } {
  const rng = mulberry32(s.seed);
  const c = randomCurve(rng, {
    dim: s.dim,
    degree: s.degree,
    count: s.degree + 4 + (s.seed % 4),
    kind: s.kind,
    maxMult: 2,
    weightRange: s.rational ? [0.4, 2.5] : undefined,
    domain: s.seed % 3 === 0 ? [-2, 5] : [0, 1],
  });
  return { c, rng };
}

const label = (s: Spec): string =>
  `seed ${s.seed}: ${s.kind} p=${s.degree} dim=${s.dim}${s.rational ? ' rational' : ''}`;

function weights(c: NurbsCurve): Float64Array {
  const w = new Float64Array(c.basis.count);
  weightsInto(c, w);
  return w;
}

describe('insertKnot (A5.1)', () => {
  it('reproduces P&T Ex. 5.1 bitwise', () => {
    // U = {0,0,0,0,1,2,3,4,5,5,5,5}, p = 3, insert 5/2 (k = 5): α₃ = 5/6, α₄ = 1/2, α₅ = 1/6.
    const U = [0, 0, 0, 0, 1, 2, 3, 4, 5, 5, 5, 5];
    const P = [0, 0, 1, 3, 2, 5, 4, 4, 6, 1, 7, -2, 9, 0, 10, 3];
    const c = makeCurve({ dim: 2, basis: clampedBasis(3, U), points: P });
    const q = insertKnot(c, 5 / 2);
    expect(Array.from(q.basis.knots)).toEqual([0, 0, 0, 0, 1, 2, 2.5, 3, 4, 5, 5, 5, 5]);
    const pt = (i: number): [number, number] => [P[2 * i]!, P[2 * i + 1]!];
    const mix = (al: number, i: number): number[] =>
      [0, 1].map((k) => al * pt(i)[k]! + (1 - al) * pt(i - 1)[k]!);
    const expected = [
      ...pt(0),
      ...pt(1),
      ...pt(2),
      ...mix(5 / 6, 3),
      ...mix(1 / 2, 4),
      ...mix(1 / 6, 5),
      ...pt(5),
      ...pt(6),
      ...pt(7),
    ];
    const got = new Float64Array(18);
    controlPointsInto(q, got);
    expect(Array.from(got)).toEqual(expected);
    expect(q.rational).toBe(false);
  });

  for (const s of specs()) {
    it(`keeps the shape: ${label(s)}`, () => {
      const { c, rng } = curveOf(s);
      const [a, b] = c.basis.domain;
      for (let k = 0; k < 3; k++) {
        const t = a + rng() * (b - a);
        const times = 1 + Math.floor(rng() * s.degree);
        const q = insertKnot(c, t, times);
        expect(q.basis.kind).toBe(c.basis.kind);
        expect(q.basis.count).toBe(c.basis.count + times);
        expect(q.basis.domain).toEqual(c.basis.domain);
        expect(q.rational).toBe(c.rational);
        expect(shapeError(c, q)).toBeLessThan(SHAPE);
      }
    });
  }

  it('raises the multiplicity of an existing knot, snapping within knotRel', () => {
    const c = randomCurve(mulberry32(5), { dim: 2, degree: 3, count: 8 });
    const k = c.basis.knots[5]!;
    const q = insertKnot(c, k + 0.3e-10); // knotRel × domain = 1e-10
    const m = knotMultiplicities(q.basis);
    const at = Array.from(m.values).indexOf(k);
    expect(m.mults[at]).toBe(2);
    expect(Array.from(q.basis.knots).filter((x) => x !== k && Math.abs(x - k) < 1e-9)).toEqual([]);
  });

  it('inserts a periodic seam (t0 + T snaps to t0) and keeps the period', () => {
    const c = randomCurve(mulberry32(7), { dim: 3, degree: 3, count: 7, kind: 'periodic' });
    const q = insertKnot(c, 1 - 1e-12);
    expect(q.basis.knots[0]).toBe(0);
    expect(q.basis.knots[1]).toBe(0);
    expect((q.basis as PeriodicBasis).period).toBe(1);
    expect(shapeError(c, q)).toBeLessThan(SHAPE);
  });

  it('rejects ends, excess multiplicity and outside parameters', () => {
    const c = randomCurve(mulberry32(6), { dim: 3, degree: 2, count: 6, maxMult: 2 });
    expectCode(() => insertKnot(c, 0), 'knot-multiplicity');
    expectCode(() => insertKnot(c, 1), 'knot-multiplicity');
    expectCode(() => insertKnot(c, 0.5, 3), 'knot-multiplicity');
    expectCode(() => insertKnot(c, 1.5), 'param-out-of-domain');
    expectCode(() => insertKnot(c, 0.5, -1), 'unsupported');
    expect(insertKnot(c, 0.5, 0).basis).toBe(c.basis);
  });
});

describe('refineKnots (A5.4)', () => {
  for (const s of specs()) {
    it(`keeps the shape and agrees with repeated A5.1: ${label(s)}`, () => {
      const { c, rng } = curveOf(s);
      const [a, b] = c.basis.domain;
      const X = Array.from({ length: 6 }, () => a + rng() * (b - a));
      if (s.degree >= 2) X.push(X[0]!); // a repeat raises the multiplicity
      const q = refineKnots(c, X);
      expect(q.basis.count).toBe(c.basis.count + X.length);
      expect(shapeError(c, q)).toBeLessThan(SHAPE);
      if (s.degree >= 2) {
        let r: NurbsCurve = c;
        for (const x of X) r = insertKnot(r, x);
        expect(Array.from(r.basis.knots)).toEqual(Array.from(q.basis.knots));
        expect(maxDist(r.cw as Float64Array, q.cw as Float64Array, c.dim + 1)).toBeLessThan(
          SHAPE * scaleOf(c),
        );
      }
    });
  }

  it('snaps new values to one another and leaves an empty refinement unchanged', () => {
    const c = randomCurve(mulberry32(8), { dim: 2, degree: 3, count: 7 });
    const q = refineKnots(c, [0.123, 0.123 + 0.4e-10]);
    expect(Array.from(q.basis.knots).filter((x) => x === 0.123)).toHaveLength(2);
    expect(refineKnots(c, []).basis).toBe(c.basis);
    expectCode(() => refineKnots(c, [0.4, 0.4, 0.4, 0.4]), 'knot-multiplicity');
  });
});

describe('elevateDegree (A5.9)', () => {
  it('matches the Bézier closed form (P&T eq. 5.36)', () => {
    const rng = mulberry32(11);
    for (let p = 1; p <= 6; p++) {
      const P = Array.from({ length: 3 * (p + 1) }, () => 2 * rng() - 1);
      const U = [...Array(p + 1).fill(0), ...Array(p + 1).fill(1)];
      const c = makeCurve({ dim: 3, basis: clampedBasis(p, U), points: P });
      const q = elevateDegree(c, 1);
      const got = new Float64Array(3 * (p + 2));
      controlPointsInto(q, got);
      for (let i = 0; i <= p + 1; i++) {
        const al = i / (p + 1);
        for (let k = 0; k < 3; k++) {
          const prev = i > 0 ? P[3 * (i - 1) + k]! : 0;
          const cur = i <= p ? P[3 * i + k]! : 0;
          // Two products and a sum: a few ε of the unit-cube net.
          expect(Math.abs(got[3 * i + k]! - (al * prev + (1 - al) * cur))).toBeLessThan(8 * EPS);
        }
      }
    }
  });

  for (const s of specs()) {
    it(`keeps the shape; by t equals t steps of 1: ${label(s)}`, () => {
      const { c } = curveOf(s);
      const by = 1 + (s.seed % 3);
      const q = elevateDegree(c, by);
      expect(q.basis.degree).toBe(c.basis.degree + by);
      expect(shapeError(c, q)).toBeLessThan(SHAPE);
      // Every distinct knot's multiplicity grows by `by`.
      const m0 = knotMultiplicities(c.basis);
      const m1 = knotMultiplicities(q.basis);
      expect(Array.from(m1.values)).toEqual(Array.from(m0.values));
      expect(Array.from(m1.mults)).toEqual(Array.from(m0.mults, (m) => m + by));
      let r: NurbsCurve = c;
      for (let k = 0; k < by; k++) r = elevateDegree(r, 1);
      expect(Array.from(r.basis.knots)).toEqual(Array.from(q.basis.knots));
      expect(shapeError(q, r)).toBeLessThan(SHAPE);
    });
  }

  it('keeps the rational circle a circle (radius 64 ε r)', () => {
    const r = 3;
    const ctr = { x: 1, y: -2, z: 0.5 };
    const X = { x: 1, y: 0, z: 0 };
    const Y = { x: 0, y: 1, z: 0 };
    for (const c of [circle(ctr, X, Y, r), periodicCircle(ctr, X, Y, r)] as NurbsCurve<3>[]) {
      const q = elevateDegree(c, 2);
      for (let i = 0; i <= 400; i++) {
        const P = curvePoint(q, i / 401);
        const d = Math.hypot(P.x - ctr.x, P.y - ctr.y, P.z - ctr.z);
        expect(Math.abs(d - r)).toBeLessThan(64 * EPS * r);
      }
    }
  });

  it('keeps a polynomial curve polynomial (weights exactly 1)', () => {
    const c = randomCurve(mulberry32(12), { dim: 3, degree: 3, count: 9, maxMult: 2 });
    const q = elevateDegree(c, 3);
    expect(q.rational).toBe(false);
    expect(Array.from(weights(q)).every((w) => w === 1)).toBe(true);
    expect(elevateDegree(c, 0).basis).toBe(c.basis);
  });
});

describe('removeKnot (A5.8)', () => {
  for (const s of specs().filter((x) => x.kind === 'clamped' && x.degree >= 2)) {
    it(`removing inserted knots recovers the curve: ${label(s)}`, () => {
      const { c, rng } = curveOf(s);
      const [a, b] = c.basis.domain;
      const t = a + (0.2 + 0.6 * rng()) * (b - a);
      const k = 1 + Math.floor(rng() * (s.degree - 1));
      const ins = insertKnot(c as ClampedCurve, t, k);
      const r = removeKnot(ins, t, k);
      expect(r.removed).toBe(k);
      expect(Array.from(r.curve.basis.knots)).toEqual(Array.from(c.basis.knots));
      const P0 = c.cw as Float64Array;
      expect(maxDist(P0, r.curve.cw as Float64Array, c.dim + 1)).toBeLessThan(SHAPE * scaleOf(c));
      expect(r.maxDeviation).toBeLessThan(SHAPE * scaleOf(c));
      expect(r.curve.rational).toBe(c.rational);
    });
  }

  it('does not remove an essential knot; returns the input', () => {
    const rng = mulberry32(21);
    for (const rational of [false, true]) {
      const c = randomCurve(rng, {
        dim: 2,
        degree: 3,
        count: 8,
        weightRange: rational ? [0.5, 2] : undefined,
      }) as ClampedCurve<2>;
      const r = removeKnot(c, c.basis.knots[5]!);
      expect(r.removed).toBe(0);
      expect(r.curve).toBe(c);
      expect(r.maxDeviation).toBe(0);
    }
  });

  it('reports an honest bound for a lossy removal (dense sampling ≤ maxDeviation ≤ point)', () => {
    const rng = mulberry32(22);
    let lossy = 0;
    for (let trial = 0; trial < 20; trial++) {
      const rational = trial % 2 === 1;
      const c = randomCurve(rng, {
        dim: 3,
        degree: 3,
        count: 12,
        weightRange: rational ? [0.5, 2] : undefined,
      }) as ClampedCurve<3>;
      // A gentle bump: a smooth curve plus a small perturbation of one point.
      const smooth = elevateDegree(
        makeCurve({
          dim: 3,
          basis: clampedBasis(2, [0, 0, 0, 1, 1, 1]),
          points: [0, 0, 0, 1, 2, 0, 2, 0, 1],
        }),
        1,
      );
      const fine = refineKnots(smooth, [0.2, 0.4, 0.5, 0.6, 0.8]) as ClampedCurve<3>;
      const target = rational ? c : fine;
      const point = 0.05;
      const r = removeKnot(target, target.basis.knots[6]!, 1, { point });
      if (r.removed === 0) continue;
      lossy++;
      expect(r.maxDeviation).toBeLessThanOrEqual(point);
      const ts = params(target, 20000);
      const dense = maxDist(evalPts(target, ts), evalPts(r.curve, ts), 3);
      expect(dense).toBeLessThanOrEqual(r.maxDeviation);
    }
    expect(lossy).toBeGreaterThan(0);
  });

  it('reports an honest bound for a lossy rational removal (weights change too)', () => {
    // Insert a knot into a rational curve, then scale one of the new homogeneous points
    // by (1 + δ): its Euclidean point stays, its weight moves, so the knot is no longer
    // removable exactly and every removal changes the weights (ΔW ≠ 0, P&T eq. 5.30).
    const rng = mulberry32(23);
    for (let trial = 0; trial < 10; trial++) {
      const p = 2 + (trial % 3);
      const c0 = randomCurve(rng, {
        dim: 3,
        degree: p,
        count: p + 6,
        weightRange: [0.5, 2],
      }) as ClampedCurve<3>;
      const t = 0.35 + 0.3 * rng();
      const ins = insertKnot(c0, t);
      const cw = Float64Array.from(ins.cw as Float64Array);
      let k = 0;
      while (ins.basis.knots[k + 1]! <= t) k++; // t = U[k], last copy
      const i = k - p + 1 + (trial % p); // one of the p new points
      const delta = 1e-4 * (trial % 2 ? 1 : -1);
      for (let c = 0; c < 4; c++) cw[4 * i + c] = cw[4 * i + c]! * (1 + delta);
      const target = curveFromHomogeneous({ dim: 3, basis: ins.basis, cw }) as ClampedCurve<3>;
      // A5.8's rational check distance is point·w_min/(1 + |P|_max) ≥ point/7 here, above
      // the ≤ 4·δ homogeneous change; the certified bound stays below point.
      const point = 1e-2;
      const r = removeKnot(target, t, 1, { point });
      expect(r.removed).toBe(1);
      expect(r.maxDeviation).toBeGreaterThan(0);
      expect(r.maxDeviation).toBeLessThanOrEqual(point);
      const ts = params(target, 20000);
      const dense = maxDist(evalPts(target, ts), evalPts(r.curve, ts), 3);
      expect(dense).toBeGreaterThan(0);
      expect(dense).toBeLessThanOrEqual(r.maxDeviation);
    }
  });

  it('rejects non-knots, ends, excess counts and periodic curves', () => {
    const c = randomCurve(mulberry32(23), { dim: 2, degree: 3, count: 8 }) as ClampedCurve<2>;
    expectCode(() => removeKnot(c, 0.123456), 'unsupported');
    expectCode(() => removeKnot(c, 0), 'knot-multiplicity');
    expectCode(() => removeKnot(c, c.basis.knots[5]!, 2), 'knot-multiplicity');
    const pc = periodicCircle({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 1);
    expectCode(() => removeKnot(pc as unknown as ClampedCurve<3>, 0.25), 'unsupported');
  });
});

describe('splitCurve, subCurve, decomposeBezier', () => {
  for (const s of specs().filter((x) => x.kind === 'clamped')) {
    it(`pieces reproduce the curve: ${label(s)}`, () => {
      const { c, rng } = curveOf(s);
      const cc = c as ClampedCurve;
      const [a, b] = c.basis.domain;
      for (const t of [a + rng() * (b - a), c.basis.knots[s.degree + 1]!]) {
        const [l, r] = splitCurve(cc, t);
        expect(l.basis.domain).toEqual([a, t]);
        expect(r.basis.domain).toEqual([t, b]);
        const ts = params(c);
        expect(
          shapeError(
            c,
            l,
            undefined,
            ts.filter((x) => x <= t),
          ),
        ).toBeLessThan(SHAPE);
        expect(
          shapeError(
            c,
            r,
            undefined,
            ts.filter((x) => x >= t),
          ),
        ).toBeLessThan(SHAPE);
        // The join is one control point, bit for bit.
        expect(curvePoint(l, t)).toEqual(curvePoint(r, t));
      }
      const t0 = a + 0.2 * (b - a);
      const t1 = a + 0.7 * (b - a);
      const sub = subCurve(c, t0, t1);
      expect(sub.basis.domain).toEqual([t0, t1]);
      expect(shapeError(c, sub, undefined, params(sub))).toBeLessThan(SHAPE);
      const segs = decomposeBezier(cc);
      const breaks = new Set(Array.from(c.basis.knots));
      expect(segs).toHaveLength(breaks.size - 1);
      for (const g of segs) {
        expect(g.basis.count).toBe(s.degree + 1);
        expect(shapeError(c, g, undefined, params(g))).toBeLessThan(SHAPE);
      }
    });
  }

  it('periodic sub-curves: inside one period, across the seam, and the whole loop', () => {
    for (const s of specs().filter((x) => x.kind === 'periodic')) {
      const { c } = curveOf(s);
      const [a, b] = c.basis.domain;
      const T = b - a;
      const t0 = a + 0.7 * T;
      const t1 = a + 0.3 * T;
      const across = subCurve(c, t0, t1);
      expect(across.basis.domain).toEqual([t0, t1 + T]);
      const wrap = (t: number): number => (t >= b ? t - T : t);
      expect(shapeError(across, c, wrap, params(across))).toBeLessThan(SHAPE);
      const inside = subCurve(c, t1, t0);
      expect(inside.basis.domain).toEqual([t1, t0]);
      expect(shapeError(inside, c, undefined, params(inside))).toBeLessThan(SHAPE);
      const loop = subCurve(c, t1, t1);
      expect(loop.basis.domain).toEqual([t1, t1 + T]);
      expect(Array.from(loop.cw)).toEqual(Array.from(toClamped(c as PeriodicCurve, t1).cw));
    }
  });

  it('rejects empty pieces and periodic splits', () => {
    const c = randomCurve(mulberry32(31), { dim: 2, degree: 2, count: 6 }) as ClampedCurve<2>;
    expectCode(() => splitCurve(c, 0), 'empty-domain');
    expectCode(() => splitCurve(c, 1 - 1e-12), 'empty-domain');
    expectCode(() => subCurve(c, 0.6, 0.4), 'empty-domain');
    const pc = periodicCircle({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 1);
    expectCode(() => splitCurve(pc as unknown as ClampedCurve<3>, 0.5), 'unsupported');
    expectCode(() => decomposeBezier(pc as unknown as ClampedCurve<3>), 'unsupported');
  });
});

describe('reverseCurve, reparameterize, normalizeDomain', () => {
  for (const s of specs()) {
    it(`reverse maps t to a + b − t; twice is the identity: ${label(s)}`, () => {
      const { c } = curveOf(s);
      const [a, b] = c.basis.domain;
      const r = reverseCurve(c);
      expect(r.basis.domain).toEqual(c.basis.domain);
      const mirror =
        c.basis.kind === 'clamped'
          ? (t: number) => a + (b - t)
          : (t: number) => (t === a ? a : a + (b - t)); // 2·t0 + T − t, wrapped
      expect(shapeError(c, r, mirror)).toBeLessThan(SHAPE);
      expect(shapeError(c, reverseCurve(r))).toBeLessThan(SHAPE);
    });
  }

  it('reparameterize maps the domain affinely and scales C′ by the inverse factor', () => {
    for (const s of specs().filter((x) => x.seed % 5 === 0)) {
      const { c } = curveOf(s);
      const [a, b] = c.basis.domain;
      const q = reparameterize(c, [10, 13]);
      expect(q.basis.domain).toEqual([10, 13]);
      expect(q.cw).toBe(c.cw);
      const k = 3 / (b - a);
      const map = (t: number): number => 10 + (t - a) * k;
      expect(shapeError(c, q, map)).toBeLessThan(SHAPE);
      for (let i = 1; i < 10; i++) {
        const t = a + ((b - a) * i) / 10.3;
        const d0 = curveDerivatives(c, t, 1)[1]!;
        const d1 = curveDerivatives(q, map(t), 1)[1]!;
        const v0 = typeof d0 === 'number' ? [d0] : Object.values(d0);
        const v1 = typeof d1 === 'number' ? [d1] : Object.values(d1);
        const mag = Math.max(...v0.map(Math.abs));
        // C′ is O(scale/h): one division by k, a few ulps of it.
        v0.forEach((x, j) => expect(Math.abs(v1[j]! * k - x)).toBeLessThan(1e-12 * mag + 1e-300));
      }
      const n = normalizeDomain(c);
      expect(n.basis.domain).toEqual([0, 1]);
      if (n.basis.kind === 'periodic') expect((n.basis as PeriodicBasis).period).toBe(1);
    }
    const c = randomCurve(mulberry32(41), { dim: 1, degree: 2, count: 5 });
    expectCode(() => reparameterize(c, [1, 1]), 'empty-domain');
    expectCode(() => reparameterize(c, [0, Infinity]), 'non-finite');
  });
});

describe('toClamped', () => {
  for (const s of specs().filter((x) => x.kind === 'periodic')) {
    it(`unrolls the period exactly at any seam: ${label(s)}`, () => {
      const { c, rng } = curveOf(s);
      const pc = c as PeriodicCurve;
      const [a, b] = c.basis.domain;
      const T = b - a;
      for (const seam of [a, c.basis.knots[1]!, a + rng() * T]) {
        const q = toClamped(pc, seam);
        expect(q.basis.kind).toBe('clamped');
        expect(q.basis.domain).toEqual([seam, seam + T]);
        expect(isClosed(q)).toBe(true);
        const wrap = (t: number): number => (t >= b ? t - T : t);
        expect(shapeError(q, c, wrap, params(q))).toBeLessThan(SHAPE);
      }
    });
  }

  it('keeps the periodic circle on its circle', () => {
    const ctr = { x: 0, y: 0, z: 2 };
    const c = periodicCircle(ctr, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }, 5);
    const q = toClamped(c, 0.3);
    for (let i = 0; i <= 200; i++) {
      const P = curvePoint(q, 0.3 + i / 200);
      expect(Math.abs(Math.hypot(P.x - ctr.x, P.y - ctr.y, P.z - ctr.z) - 5)).toBeLessThan(
        64 * EPS * 5,
      );
    }
  });
});

describe('makeCompatible', () => {
  for (const kind of ['clamped', 'periodic'] as const) {
    it(`gives one degree and one knot vector, shapes unchanged (${kind})`, () => {
      const rng = mulberry32(kind === 'clamped' ? 51 : 52);
      for (let trial = 0; trial < 10; trial++) {
        const cs = [1, 2, 3, 4].map((p, i) =>
          randomCurve(rng, {
            dim: 3,
            degree: p,
            count: p + 3 + i,
            kind,
            maxMult: 2,
            weightRange: (trial + i) % 2 ? [0.5, 2] : undefined,
          }),
        );
        const r = makeCompatible(cs);
        expect(r.maxKnotShift).toBe(0);
        expect(r.maxDeviation).toBe(0);
        const U = Array.from(r.curves[0]!.basis.knots);
        for (let i = 0; i < cs.length; i++) {
          const q = r.curves[i]!;
          expect(q.basis.degree).toBe(4);
          expect(Array.from(q.basis.knots)).toEqual(U);
          expect(q.rational).toBe(cs[i]!.rational);
          expect(shapeError(cs[i]!, q)).toBeLessThan(SHAPE);
        }
      }
    });
  }

  it('unifies near-coincident knots across curves and bounds the change honestly', () => {
    const d = 1e-10; // knotRel × domain
    const mk = (k: number, ys: number[], w?: number[]): NurbsCurve<2> =>
      makeCurve({
        dim: 2,
        basis: clampedBasis(3, [0, 0, 0, 0, 0.3, k, 1, 1, 1, 1]),
        points: ys.flatMap((y, i) => [i / 5, y]),
        weights: w,
      });
    const A = mk(0.5, [0, 1, -1, 2, 0, 1]);
    const B = mk(0.5 + 0.4 * d, [1, 0, 2, -1, 1, 0], [1, 2, 0.5, 1, 1.5, 1]);
    const C = mk(0.5, [2, 2, 0, 1, 3, 2]);
    const r = makeCompatible([A, B, C]);
    // 0.5 is used by two curves: B's knot moves onto it.
    expect(r.maxKnotShift).toBe(0.5 + 0.4 * d - 0.5);
    expect(r.curves.every((q) => q.basis.count === 6)).toBe(true);
    expect(Array.from(r.curves[1]!.basis.knots)).toEqual(Array.from(A.basis.knots));
    expect(shapeError(A, r.curves[0]!)).toBeLessThan(SHAPE);
    const ts = params(B, 50000);
    const dense = maxDist(evalPts(B, ts), evalPts(r.curves[1]!, ts), 2);
    expect(dense).toBeLessThanOrEqual(r.maxDeviation);
    // The move is O(shift / span) × net size: far below `point`.
    expect(r.maxDeviation).toBeLessThan(1e-6);
    expect(r.maxDeviation).toBeGreaterThan(0);
  });

  /** A cubic on [0, 1] with interior knots `ks` (each simple) and a bumpy net. */
  const cubicWith = (ks: number[], seed: number): NurbsCurve<2> => {
    const rng = mulberry32(seed);
    const n = ks.length + 4;
    return makeCurve({
      dim: 2,
      basis: clampedBasis(3, [0, 0, 0, 0, ...ks, 1, 1, 1, 1]),
      points: Array.from({ length: n }, (_, i) => [i / (n - 1), 2 * rng() - 1]).flat(),
    });
  };

  it('never chains near-coincident knots: two knots of one curve ≥ knotRel apart stay apart', () => {
    // A's knots are 1.5·d apart (valid); B's knot lies between them, within d of both.
    // Unifying transitively would put all three into one cluster and merge A's two knots.
    const d = 1e-10; // knotRel × domain
    const A = cubicWith([0.3, 0.3 + 1.5 * d], 1);
    const B = cubicWith([0.3 + 0.75 * d], 2);
    const r = makeCompatible([A, B]);
    // §4.3: a knot moves by less than knotRel × domain.
    expect(r.maxKnotShift).toBeGreaterThan(0);
    expect(r.maxKnotShift).toBeLessThan(d);
    // A keeps both knots (B's knot snaps onto one of them), so A is unchanged.
    expect(knotMultiplicities(r.curves[0]!.basis).values).toEqual(
      knotMultiplicities(A.basis).values,
    );
    expect(shapeError(A, r.curves[0]!)).toBeLessThan(SHAPE);
    const ts = params(B, 50000);
    expect(maxDist(evalPts(B, ts), evalPts(r.curves[1]!, ts), 2)).toBeLessThanOrEqual(
      r.maxDeviation,
    );
  });

  it('moves a knot by less than knotRel × domain however many curves crowd a value', () => {
    // Eight curves with one knot each at 0.5 + 0.9·d·k: every neighbour pair is within d.
    const d = 1e-10;
    const cs = Array.from({ length: 8 }, (_, k) => cubicWith([0.5 + 0.9 * d * k], 10 + k));
    const r = makeCompatible(cs);
    expect(r.maxKnotShift).toBeGreaterThan(0);
    expect(r.maxKnotShift).toBeLessThan(d);
    // Greedy representatives: 0.5, 0.5 + 1.8·d, … (pairwise ≥ d apart, which the basis
    // constructor checks); every other knot snaps 0.9·d onto its left neighbour.
    const vals = knotMultiplicities(r.curves[0]!.basis).values;
    for (const [k, c] of cs.entries()) {
      const ts = params(c, 20000);
      expect(maxDist(evalPts(c, ts), evalPts(r.curves[k]!, ts), 2)).toBeLessThanOrEqual(
        r.maxDeviation,
      );
    }
    expect(vals.length).toBe(2 + 4);
  });

  it('rejects a unification that would merge two knots of one curve', () => {
    // B and C share 0.5 (most used, so it is kept); A's knots 0.5 ± 0.9·d are 1.8·d
    // apart but both within d of 0.5. The greedy unification cannot keep them apart.
    const d = 1e-10;
    const A = cubicWith([0.5 - 0.9 * d, 0.5 + 0.9 * d], 3);
    const B = cubicWith([0.5], 4);
    const C = cubicWith([0.5], 5);
    expectCode(() => makeCompatible([A, B, C]), 'knots-near-coincident');
  });

  it('rejects mixed dimensions, kinds and domains; accepts an empty list', () => {
    const rng = mulberry32(53);
    const a = randomCurve(rng, { dim: 2, degree: 2, count: 5 });
    const b = randomCurve(rng, { dim: 3, degree: 2, count: 5 });
    const p = randomCurve(rng, { dim: 2, degree: 2, count: 5, kind: 'periodic' });
    const e = randomCurve(rng, { dim: 2, degree: 2, count: 5, domain: [0, 2] });
    expectCode(() => makeCompatible([a, b]), 'dimension-mismatch');
    expectCode(() => makeCompatible([a, p]), 'unsupported');
    expectCode(() => makeCompatible([a, e]), 'size-mismatch');
    expect(makeCompatible([]).curves).toEqual([]);
  });
});

describe('periodic windows (book/periodic)', () => {
  for (const s of specs().filter((x) => x.kind === 'periodic' && x.dim === 2)) {
    it(`the window is the curve, and its periods agree after insertion: ${label(s)}`, () => {
      const { c, rng } = curveOf(s);
      const b = c.basis as PeriodicBasis;
      const h = 3;
      const p = b.degree;
      const n = b.count;
      const T = b.period;
      const t0 = b.domain[0];
      const W = unrollPeriodic(p, b.knots, T, n, c.cw, h);
      // As a clamped curve on [t0 − T, t0 + 2T] it equals the periodic curve there.
      const wc = makeCurve({
        dim: 2,
        basis: clampedBasis(p, W.U),
        points: Array.from({ length: W.Pw.length / h }, (_, i) => [
          W.Pw[i * h]! / W.Pw[i * h + 2]!,
          W.Pw[i * h + 1]! / W.Pw[i * h + 2]!,
        ]).flat(),
        weights: Array.from({ length: W.Pw.length / h }, (_, i) => W.Pw[i * h + 2]!),
      });
      const ts = params(wc, 3000);
      const wrap = (t: number): number => t0 + ((((t - t0) % T) + T) % T);
      expect(shapeError(wc, c, wrap, ts)).toBeLessThan(SHAPE);
      // Insert x in all three copies, as insertKnot does, and compare the periods.
      const x = t0 + (0.1 + 0.8 * rng()) * T;
      const X = [x - T, x, x + T];
      const R = refineKnotVectCurve(W.U.length - p - 2, p, W.U, W.Pw, h, X);
      const mid = extractPeriod(R.Ubar, R.Qw, h, t0, T);
      const next = extractPeriod(R.Ubar, R.Qw, h, t0 + T, T);
      const n1 = mid.U.length;
      expect(next.U.length).toBe(n1);
      for (let i = 0; i < n1; i++) expect(next.U[i]).toBe(mid.U[i]! + T);
      // Next-period functions whose support ends by t0 + 2T are untouched by the
      // window's clamped end: functions 0 … n1 − p − 1.
      const valid = (n1 - p) * h;
      expect(maxDist(mid.Pw.slice(0, valid), next.Pw.slice(0, valid), h)).toBeLessThan(
        SHAPE * scaleOf(c),
      );
      // And the extracted period is insertKnot's result.
      const q = insertKnot(c, x);
      expect(Array.from(q.basis.knots)).toEqual(Array.from(mid.U));
    });
  }

  it('A5.1 and A5.4 give the same window insertion bitwise for one knot', () => {
    const c = randomCurve(mulberry32(61), { dim: 3, degree: 3, count: 9 });
    const b = c.basis;
    const n = b.count - 1;
    const x = 0.437;
    let k = 3;
    while (b.knots[k + 1]! <= x) k++;
    const a = curveKnotIns(n, 3, b.knots, c.cw, 4, x, k, 0, 1);
    const r = refineKnotVectCurve(n, 3, b.knots, c.cw, 4, [x]);
    expect(Array.from(r.Ubar)).toEqual(Array.from(a.UQ));
    expect(maxDist(r.Qw, a.Qw, 4)).toBeLessThan(4 * EPS);
  });
});

describe('deviationBound (removal and makeCompatible certificates)', () => {
  it('the Lebesgue bound (2/π)·ln(p + 1) + 1 holds for Chebyshev nodes, p ≤ 12', () => {
    for (let p = 1; p <= 12; p++) {
      const x = Array.from({ length: p + 1 }, (_, k) =>
        Math.cos(((2 * k + 1) * Math.PI) / (2 * p + 2)),
      );
      let lam = 0;
      for (let i = 0; i <= 20000; i++) {
        const t = -1 + i / 10000;
        let sum = 0;
        for (let k = 0; k <= p; k++) {
          let l = 1;
          for (let j = 0; j <= p; j++) if (j !== k) l *= (t - x[j]!) / (x[k]! - x[j]!);
          sum += Math.abs(l);
        }
        lam = Math.max(lam, sum);
      }
      expect(lam).toBeLessThanOrEqual((2 / Math.PI) * Math.log(p + 1) + 1);
    }
  });

  /** `c` with homogeneous point `i` scaled by `1 + delta`: same Euclidean point, new weight. */
  const reweighted = (c: NurbsCurve<3>, i: number, delta: number): NurbsCurve<3> => {
    const cw = Float64Array.from(c.cw as Float64Array);
    for (let k = 0; k < 4; k++) cw[4 * i + k] = cw[4 * i + k]! * (1 + delta);
    return curveFromHomogeneous({ dim: 3, basis: c.basis, cw });
  };

  it('bounds a weight change (ΔW ≠ 0): dense ≤ bound', () => {
    // A reweighted point pulls the curve towards it by (P_i − C(t))·ΔW/W, so the
    // quotient term R·max|ΔW| of eq. 5.30 carries the bound. With P_i at the centre
    // of the net's box the centred numerator difference vanishes identically, and
    // only that term is left (a bound without it would be rounding noise).
    const centred = makeCurve({
      dim: 3,
      basis: clampedBasis(3, [0, 0, 0, 0, 0.5, 1, 1, 1, 1]),
      points: [0, 0, 0, 0, 1, 0, 1, 0.5, 0.5, 2, 1, 1, 2, 0, 0],
      weights: [1, 0.8, 1.3, 0.9, 1],
    });
    const cases: [NurbsCurve<3>, number, number][] = [
      [centred, 2, 0.1],
      [centred, 2, -0.2],
    ];
    const rng = mulberry32(72);
    for (let trial = 0; trial < 12; trial++) {
      const p = 1 + (trial % 5);
      const c = randomCurve(rng, {
        dim: 3,
        degree: p,
        count: p + 5,
        maxMult: 2,
        weightRange: [0.5, 2],
      }) as NurbsCurve<3>;
      cases.push([c, 1 + (trial % (p + 3)), 0.2 * rng() - 0.1]);
    }
    for (const [c, i, delta] of cases) {
      const q = reweighted(c, i, delta);
      const U = c.basis.knots;
      const bound = deviationBound(c.basis.degree, U, c.cw, U, q.cw, 3, true);
      const ts = params(c, 20000);
      const dense = maxDist(evalPts(c, ts), evalPts(q, ts), 3);
      expect(dense).toBeGreaterThan(0);
      expect(dense).toBeLessThanOrEqual(bound);
    }
  });

  it('the rational bound is translation invariant (centred on the net), so it stays tight', () => {
    // The deviation of two curves does not change when both nets move by the same
    // offset; the bound centres the numerators on the first net's box so it does not
    // either. Uncentred, |ΔA| would grow with |offset|·|ΔW|: ~10³ times larger here.
    // Rounding of the 10³-sized homogeneous coordinates: ~10³ ε relative to the 1e-2
    // differences, so 1e-9 relative slack.
    const rng = mulberry32(73);
    for (let trial = 0; trial < 6; trial++) {
      const p = 2 + (trial % 3);
      const c = randomCurve(rng, {
        dim: 3,
        degree: p,
        count: p + 4,
        weightRange: [0.5, 2],
      }) as NurbsCurve<3>;
      const q = reweighted(c, 2, 0.05);
      const shift = (x: NurbsCurve<3>): Float64Array =>
        Float64Array.from(x.cw as Float64Array, (v, k) =>
          k % 4 === 3 ? v : v + 1000 * x.cw[k - (k % 4) + 3]!,
        );
      const U = c.basis.knots;
      const b0 = deviationBound(p, U, c.cw, U, q.cw, 3, true);
      const b1 = deviationBound(p, U, shift(c), U, shift(q), 3, true);
      expect(Math.abs(b1 - b0)).toBeLessThan(1e-9 * b0);
    }
  });

  it('brackets the true deviation of a moved control point: dense ≤ bound ≤ Λ·dense', () => {
    const rng = mulberry32(71);
    for (let trial = 0; trial < 12; trial++) {
      const p = 1 + (trial % 5);
      const rational = trial % 2 === 1;
      const c = randomCurve(rng, {
        dim: 3,
        degree: p,
        count: p + 5,
        maxMult: 2,
        weightRange: rational ? [0.5, 2] : undefined,
      });
      const cw = Float64Array.from(c.cw as Float64Array);
      const i = 2 + (trial % 3);
      const w = cw[4 * i + 3]!;
      cw[4 * i] = cw[4 * i]! + 1e-3 * w; // move control point i by 1e-3 in x
      const U = c.basis.knots;
      const bound = deviationBound(p, U, c.cw, U, cw, 3, rational);
      const q = makeCurve({
        dim: 3,
        basis: c.basis,
        points: Array.from(
          { length: c.basis.count * 3 },
          (_, k) => cw[4 * ((k / 3) | 0) + (k % 3)]! / cw[4 * ((k / 3) | 0) + 3]!,
        ),
        weights: Array.from({ length: c.basis.count }, (_, k) => cw[4 * k + 3]!),
      });
      const ts = params(c, 20000);
      const dense = maxDist(evalPts(c, ts), evalPts(q, ts), 3);
      expect(dense).toBeLessThanOrEqual(bound);
      if (!rational) {
        // Polynomial: the difference is 1e-3·N_i(t) in x, so the bound is within Λ_p of it.
        // Dense sampling (2·10⁴ points plus every knot) underestimates a smooth maximum by
        // O(Δt²·|f″|/f) ≈ 1e-7 relative here, hence the 1e-6 slack.
        expect(bound).toBeLessThanOrEqual(
          ((2 / Math.PI) * Math.log(p + 1) + 1) * dense * (1 + 1e-6),
        );
      }
    }
  });
});
