// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Surface-operation oracles (design §16, `curve-ops` and `surface` rows, per
 * direction):
 *
 * - **shape invariance** of insertion (A5.3), refinement (A5.5), elevation
 *   (A5.9 row-wise), splitting, reversal twice, `swapUV` twice and
 *   `toClampedSurface`, on random surfaces with every combination of clamped
 *   and periodic directions, polynomial and rational, in u and in v;
 * - **row form**: an operation on the surface equals the curve operation on
 *   its iso-curves (A5.3 is A5.1 per row; A5.5 is A5.4 per row);
 * - **exact analytic cases**: the rational sphere and torus stay on their
 *   implicit surfaces after elevation and refinement in both directions; a
 *   ruled surface between two parallel circles is the cylinder;
 * - **mappings**: reversal `S′(a + b − u, v) = S(u, v)`, `swapUV` exchanges
 *   the parameters and flips the normal, reparameterisation is affine;
 * - **ruled**: `S(u, 0) = a(u)`, `S(u, 1) = b(u)`, and `(1 − v)·a + v·b` for
 *   polynomial curves.
 *
 * Tolerances: `SHAPE = 1e-13 · scale` for exact operations (as for curves:
 * convex combinations; measured worst ~5e-15 · scale), `64 ε r` for points on
 * the sphere, torus and cylinder (the radius tolerance of the primitives'
 * oracles: ~10 flops and one division per coordinate).
 */
import { describe, expect, it } from 'vitest';
import {
  circle,
  circleArc,
  createScratch,
  elevateDegreeSurface,
  insertKnot,
  insertKnotSurface,
  isGeomError,
  isoCurve,
  line,
  makeCompatible,
  makeCurve,
  clampedBasis,
  normalizeSurfaceDomain,
  periodicCircle,
  refineKnots,
  refineKnotsSurface,
  reparameterizeSurface,
  reverseSurface,
  ruled,
  sphere,
  splitSurface,
  surfaceEvalGridInto,
  surfaceNormal,
  surfacePoint,
  swapUV,
  toClampedSurface,
  torus,
  curvePoint,
  elevateDegree,
} from './index';
import type { GeomErrorCode, NurbsCurve, NurbsSurface, ParamDir, Point3 } from './index';
import { mulberry32, randomCurve, randomSurface } from './testing';

const EPS = Number.EPSILON;
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

/** `n` parameters over a domain (periodic: half-open) plus its knots. */
function axis(s: NurbsSurface, dir: ParamDir, n = 24): number[] {
  const b = dir === 'u' ? s.u : s.v;
  const [a, e] = b.domain;
  const per = b.kind === 'periodic';
  const ts: number[] = [];
  for (let i = 0; i <= n; i++) ts.push(per ? a + ((e - a) * i) / (n + 1) : a + ((e - a) * i) / n);
  for (const k of b.knots) if (k >= a && (per ? k < e : k <= e)) ts.push(k);
  return ts.sort((x, y) => x - y);
}

function grid(s: NurbsSurface, us: number[], vs: number[]): Float64Array {
  const out = new Float64Array(us.length * vs.length * 3);
  surfaceEvalGridInto(
    s,
    Float64Array.from(us),
    Float64Array.from(vs),
    0,
    out,
    createScratch({ maxDegree: 12 }),
  );
  return out;
}

function maxDist(A: Float64Array, B: Float64Array): number {
  let m = 0;
  for (let i = 0; i < A.length; i += 3) {
    m = Math.max(m, Math.hypot(A[i]! - B[i]!, A[i + 1]! - B[i + 1]!, A[i + 2]! - B[i + 2]!));
  }
  return m;
}

function scaleOf(s: NurbsSurface): number {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < s.cw.length; k += 4) {
    for (let c = 0; c < 3; c++) {
      const x = s.cw[k + c]! / s.cw[k + 3]!;
      lo[c] = Math.min(lo[c]!, x);
      hi[c] = Math.max(hi[c]!, x);
    }
  }
  return Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!);
}

/** `q(mu(u), mv(v))` against `s(u, v)` on s's grid, relative to s's scale. */
function shapeError(
  s: NurbsSurface,
  q: NurbsSurface,
  mu = (u: number) => u,
  mv = (v: number) => v,
  us = axis(s, 'u'),
  vs = axis(s, 'v'),
): number {
  return maxDist(grid(s, us, vs), grid(q, us.map(mu), vs.map(mv))) / scaleOf(s);
}

interface Spec {
  readonly seed: number;
  readonly kindU: 'clamped' | 'periodic';
  readonly kindV: 'clamped' | 'periodic';
  readonly rational: boolean;
}

function specs(): Spec[] {
  const out: Spec[] = [];
  let seed = 100;
  for (const kindU of ['clamped', 'periodic'] as const) {
    for (const kindV of ['clamped', 'periodic'] as const) {
      for (const rational of [false, true]) out.push({ seed: seed++, kindU, kindV, rational });
    }
  }
  return out;
}

function surfaceOf(sp: Spec): { s: NurbsSurface; rng: () => number } {
  const rng = mulberry32(sp.seed);
  const s = randomSurface(rng, {
    degreeU: 3,
    degreeV: 2,
    countU: 7,
    countV: 6,
    kindU: sp.kindU,
    kindV: sp.kindV,
    basis: { maxMult: 2 },
    weightRange: sp.rational ? [0.4, 2.5] : undefined,
  });
  return { s, rng };
}

const label = (sp: Spec): string =>
  `${sp.kindU} × ${sp.kindV}${sp.rational ? ', rational' : ''} (seed ${sp.seed})`;

describe('per-direction operations keep the shape', () => {
  for (const sp of specs()) {
    for (const dir of ['u', 'v'] as const) {
      it(`insert, refine, elevate, reverse² in ${dir}: ${label(sp)}`, () => {
        const { s, rng } = surfaceOf(sp);
        const b = dir === 'u' ? s.u : s.v;
        const [a, e] = b.domain;
        const t = a + rng() * (e - a);
        const ins = insertKnotSurface(s, dir, t);
        expect((dir === 'u' ? ins.u : ins.v).count).toBe(b.count + 1);
        expect(dir === 'u' ? ins.v : ins.u).toBe(dir === 'u' ? s.v : s.u); // other basis shared
        expect(shapeError(s, ins)).toBeLessThan(SHAPE);
        const X = Array.from({ length: 4 }, () => a + rng() * (e - a));
        expect(shapeError(s, refineKnotsSurface(s, dir, X))).toBeLessThan(SHAPE);
        const el = elevateDegreeSurface(s, dir, 2);
        expect((dir === 'u' ? el.u : el.v).degree).toBe(b.degree + 2);
        expect(shapeError(s, el)).toBeLessThan(SHAPE);
        expect(shapeError(s, reverseSurface(reverseSurface(s, dir), dir))).toBeLessThan(SHAPE);
        expect(el.rational).toBe(s.rational);
      });
    }
  }

  it('A5.3 / A5.5 are A5.1 / A5.4 applied to every row (iso-curves agree)', () => {
    const { s } = surfaceOf(specs()[3]!);
    const v0 = 0.37;
    const u0 = 0.61;
    const a = isoCurve(insertKnotSurface(s, 'u', 0.42, 2), 'v', v0);
    const b = insertKnot(isoCurve(s, 'v', v0), 0.42, 2);
    expect(Array.from(a.basis.knots)).toEqual(Array.from(b.basis.knots));
    const err = (x: NurbsCurve, y: NurbsCurve): number => {
      let m = 0;
      for (let k = 0; k < x.cw.length; k++) m = Math.max(m, Math.abs(x.cw[k]! - y.cw[k]!));
      return m;
    };
    expect(err(a, b)).toBeLessThan(SHAPE * scaleOf(s));
    const c = isoCurve(refineKnotsSurface(s, 'v', [0.2, 0.5, 0.5]), 'u', u0);
    const d = refineKnots(isoCurve(s, 'u', u0), [0.2, 0.5, 0.5]);
    expect(Array.from(c.basis.knots)).toEqual(Array.from(d.basis.knots));
    expect(err(c, d)).toBeLessThan(SHAPE * scaleOf(s));
  });
});

describe('analytic surfaces stay exact', () => {
  const ctr = { x: 1, y: -2, z: 3 };
  it('sphere: elevated and refined in both directions, every point at radius r (64 ε r)', () => {
    const r = 2.5;
    let s = sphere(ctr, r);
    s = elevateDegreeSurface(s, 'u', 1);
    s = elevateDegreeSurface(s, 'v', 2);
    s = refineKnotsSurface(s, 'u', [0.1, 0.33]);
    s = refineKnotsSurface(s, 'v', [0.7]);
    s = insertKnotSurface(s, 'u', 0.9, 2);
    for (let i = 0; i <= 30; i++) {
      for (let j = 0; j <= 30; j++) {
        const P = surfacePoint(s, i / 31, j / 30);
        const d = Math.hypot(P.x - ctr.x, P.y - ctr.y, P.z - ctr.z);
        expect(Math.abs(d - r)).toBeLessThan(64 * EPS * r);
      }
    }
  });

  it('torus: elevated, refined and clamped at a seam, every point on the torus', () => {
    const R = 4;
    const r = 1.5;
    let s = torus(ctr, { x: 0, y: 0, z: 1 }, R, r);
    s = elevateDegreeSurface(s, 'v', 1);
    s = refineKnotsSurface(s, 'u', [0.05, 0.6]);
    s = toClampedSurface(s, 'u', 0.3);
    s = toClampedSurface(s, 'v');
    expect(s.u.kind).toBe('clamped');
    expect(s.u.domain).toEqual([0.3, 1.3]);
    for (let i = 0; i <= 30; i++) {
      for (let j = 0; j <= 30; j++) {
        const P = surfacePoint(s, 0.3 + i / 30, j / 30);
        const rho = Math.hypot(P.x - ctr.x, P.y - ctr.y) - R;
        const d = Math.hypot(rho, P.z - ctr.z);
        expect(Math.abs(d - r)).toBeLessThan(64 * EPS * (R + r));
      }
    }
  });
});

describe('split, reverse, swap, reparameterise, toClamped', () => {
  for (const sp of specs()) {
    it(`mappings hold: ${label(sp)}`, () => {
      const { s } = surfaceOf(sp);
      for (const dir of ['u', 'v'] as const) {
        const b = dir === 'u' ? s.u : s.v;
        const [a, e] = b.domain;
        const along = (f: (t: number) => number) =>
          dir === 'u' ? ([f, (t: number) => t] as const) : ([(t: number) => t, f] as const);
        // Reverse: S′(a + b − u, v) = S(u, v); periodic t ↦ 2t0 + T − t, wrapped.
        const rev = reverseSurface(s, dir);
        const mirror = (t: number): number => (t === a && b.kind === 'periodic' ? a : a + (e - t));
        expect(shapeError(s, rev, ...along(mirror))).toBeLessThan(SHAPE);
        // Reparameterise onto [−1, 4].
        const k = 5 / (e - a);
        const rp = reparameterizeSurface(s, dir, [-1, 4]);
        expect((dir === 'u' ? rp.u : rp.v).domain).toEqual([-1, 4]);
        expect(rp.cw).toBe(s.cw);
        expect(shapeError(s, rp, ...along((t) => -1 + (t - a) * k))).toBeLessThan(SHAPE);
        if (b.kind === 'clamped') {
          const t = a + 0.4 * (e - a);
          const [lo, hi] = splitSurface(s, dir, t);
          const us = axis(s, 'u');
          const vs = axis(s, 'v');
          const keep = (ts: number[], f: (x: number) => boolean) => ts.filter(f);
          const [ul, vl] =
            dir === 'u' ? [keep(us, (x) => x <= t), vs] : [us, keep(vs, (x) => x <= t)];
          const [uh, vh] =
            dir === 'u' ? [keep(us, (x) => x >= t), vs] : [us, keep(vs, (x) => x >= t)];
          expect(shapeError(s, lo, undefined, undefined, ul, vl)).toBeLessThan(SHAPE);
          expect(shapeError(s, hi, undefined, undefined, uh, vh)).toBeLessThan(SHAPE);
          const at = dir === 'u' ? [t, vs[3]!] : [us[3]!, t];
          expect(surfacePoint(lo, at[0]!, at[1]!)).toEqual(surfacePoint(hi, at[0]!, at[1]!));
          expectCode(() => toClampedSurface(s, dir), 'unsupported');
        } else {
          const T = e - a;
          const seam = a + 0.25 * T;
          const tc = toClampedSurface(s, dir, seam);
          const nb = dir === 'u' ? tc.u : tc.v;
          expect(nb.kind).toBe('clamped');
          expect(nb.domain).toEqual([seam, seam + T]);
          const unwrap = (t: number): number => (t < seam ? t + T : t);
          expect(shapeError(s, tc, ...along(unwrap))).toBeLessThan(SHAPE);
          expectCode(() => splitSurface(s, dir, a + 0.5 * T), 'unsupported');
        }
      }
      // swapUV: S′(v, u) = S(u, v), and the normal flips.
      const sw = swapUV(s);
      expect(sw.u).toBe(s.v);
      expect(sw.v).toBe(s.u);
      const us = axis(s, 'u', 8);
      const vs = axis(s, 'v', 8);
      const A = grid(s, us, vs);
      const B = grid(sw, vs, us);
      let m = 0;
      for (let i = 0; i < us.length; i++) {
        for (let j = 0; j < vs.length; j++) {
          const p = (i * vs.length + j) * 3;
          const q = (j * us.length + i) * 3;
          m = Math.max(m, Math.hypot(A[p]! - B[q]!, A[p + 1]! - B[q + 1]!, A[p + 2]! - B[q + 2]!));
        }
      }
      expect(m / scaleOf(s)).toBeLessThan(SHAPE);
      const u = (us[2]! + us[3]!) / 2;
      const v = (vs[2]! + vs[3]!) / 2;
      const n0 = surfaceNormal(s, u, v);
      const n1 = surfaceNormal(sw, v, u);
      if (n0.kind === 'regular' && n1.kind === 'regular') {
        expect(Math.hypot(n0.n.x + n1.n.x, n0.n.y + n1.n.y, n0.n.z + n1.n.z)).toBeLessThan(1e-13);
      }
      expect(Array.from(swapUV(sw).cw)).toEqual(Array.from(s.cw));
      const nz = normalizeSurfaceDomain(s);
      expect(nz.u.domain).toEqual([0, 1]);
      expect(nz.v.domain).toEqual([0, 1]);
    });
  }

  it('rejects a bad direction', () => {
    const { s } = surfaceOf(specs()[0]!);
    expectCode(() => insertKnotSurface(s, 'w' as ParamDir, 0.5), 'unsupported');
    expectCode(() => reparameterizeSurface(s, 'x' as ParamDir, [0, 1]), 'unsupported');
  });
});

describe('ruled', () => {
  const dist = (P: Point3, Q: Point3): number => Math.hypot(P.x - Q.x, P.y - Q.y, P.z - Q.z);

  it('interpolates both curves; polynomial curves give (1 − v)·a + v·b', () => {
    // Random nets lie in [−1, 1]³: scale ≤ 2√3 < 4.
    const NET = 4;
    const rng = mulberry32(201);
    for (let trial = 0; trial < 6; trial++) {
      const a = randomCurve(rng, {
        dim: 3,
        degree: 2,
        count: 5 + trial,
        maxMult: 2,
      }) as NurbsCurve<3>;
      const b = randomCurve(rng, { dim: 3, degree: 3, count: 6 }) as NurbsCurve<3>;
      const s = ruled(a, b);
      expect(s.v.degree).toBe(1);
      expect(s.u.degree).toBe(3);
      for (let i = 0; i <= 40; i++) {
        const u = i / 40;
        const A = curvePoint(a, u);
        const B = curvePoint(b, u);
        expect(dist(surfacePoint(s, u, 0), A)).toBeLessThan(SHAPE * NET);
        expect(dist(surfacePoint(s, u, 1), B)).toBeLessThan(SHAPE * NET);
        const v = (i % 7) / 6;
        const M = {
          x: (1 - v) * A.x + v * B.x,
          y: (1 - v) * A.y + v * B.y,
          z: (1 - v) * A.z + v * B.z,
        };
        expect(dist(surfacePoint(s, u, v), M)).toBeLessThan(SHAPE * NET);
      }
    }
  });

  it('between rational curves every v line is a straight segment', () => {
    const X = { x: 1, y: 0, z: 0 };
    const Y = { x: 0, y: 1, z: 0 };
    const a = circleArc({ x: 0, y: 0, z: 0 }, X, Y, 2, 0, 2);
    const b = elevateDegree(line({ x: -3, y: 1, z: 4 }, { x: 3, y: 2, z: 5 }), 1);
    const s = ruled(a, b);
    for (let i = 0; i <= 20; i++) {
      const u = i / 20;
      const A = curvePoint(a, u);
      const B = curvePoint(b, u);
      expect(dist(surfacePoint(s, u, 0), A)).toBeLessThan(64 * EPS * 6);
      expect(dist(surfacePoint(s, u, 1), B)).toBeLessThan(64 * EPS * 6);
      const S = surfacePoint(s, u, 0.37);
      // On the segment: |AS| + |SB| = |AB|.
      expect(Math.abs(dist(A, S) + dist(S, B) - dist(A, B))).toBeLessThan(64 * EPS * 6);
    }
  });

  it('two parallel circles rule the cylinder', () => {
    const X = { x: 1, y: 0, z: 0 };
    const Y = { x: 0, y: 1, z: 0 };
    for (const mk of [circle, periodicCircle]) {
      const s = ruled(mk({ x: 0, y: 0, z: 0 }, X, Y, 3), mk({ x: 0, y: 0, z: 2 }, X, Y, 3));
      for (let i = 0; i <= 20; i++) {
        for (let j = 0; j <= 4; j++) {
          const P = surfacePoint(s, i / 21, j / 4);
          expect(Math.abs(Math.hypot(P.x, P.y) - 3)).toBeLessThan(64 * EPS * 3);
          expect(Math.abs(P.z - (2 * j) / 4)).toBeLessThan(64 * EPS * 3);
        }
      }
    }
  });

  it('rules curves with near-coincident knots; refuses when unifying them moves a boundary beyond point', () => {
    // a's knots are 1.5·d apart (valid); b's lies between them, within d of both
    // (d = knotRel × domain = 1e-10). makeCompatible snaps b's knot onto one of a's.
    const d = 1e-10;
    const cubic = (ks: number[], z: number): NurbsCurve<3> => {
      const n = ks.length + 4;
      return makeCurve({
        dim: 3,
        basis: clampedBasis(3, [0, 0, 0, 0, ...ks, 1, 1, 1, 1]),
        points: Array.from({ length: n }, (_, i) => [i, (i * i) % 3, z]).flat(),
      });
    };
    const a = cubic([0.3, 0.3 + 1.5 * d], 0);
    const b = cubic([0.3 + 0.75 * d], 1);
    const { maxDeviation } = makeCompatible([a, b]);
    expect(maxDeviation).toBeGreaterThan(0);
    const s = ruled(a, b);
    for (let i = 0; i <= 200; i++) {
      const u = i / 200;
      // a keeps its knots: exact to rounding. b moved: within the certified bound.
      expect(dist(surfacePoint(s, u, 0), curvePoint(a, u))).toBeLessThan(SHAPE * 8);
      expect(dist(surfacePoint(s, u, 1), curvePoint(b, u))).toBeLessThanOrEqual(
        maxDeviation + SHAPE * 8,
      );
    }
    expectCode(() => ruled(a, b, { point: maxDeviation / 2 }), 'knots-near-coincident');
  });

  it('rejects mixed kinds and 2D curves', () => {
    const X = { x: 1, y: 0, z: 0 };
    const Y = { x: 0, y: 1, z: 0 };
    const o = { x: 0, y: 0, z: 0 };
    expectCode(() => ruled(circle(o, X, Y, 1), periodicCircle(o, X, Y, 1)), 'unsupported');
    const c2 = randomCurve(mulberry32(3), { dim: 2, degree: 2, count: 4 });
    expectCode(
      () => ruled(c2 as unknown as NurbsCurve<3>, circle(o, X, Y, 1)),
      'dimension-mismatch',
    );
  });
});
