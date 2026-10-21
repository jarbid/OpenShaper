// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Integration over trimmed domains (design §11.3, §16 "integrate, mass").
 *
 * Oracles (analytic, independent of the code):
 * - plane trimmed by a circle: area `|u × v| · πr²`; annulus
 *   `|u × v| · π(R² − r²)`; square with a circular hole `|u × v|(1 − πr²)`;
 * - sphere from rational patches: area `4πr²`, volume `4/3 πr³`;
 * - torus: area `4π²Rr`, volume `2π²Rr²`;
 * - cylinder closed by two trimmed planar caps: volume `πr²h`;
 * - polynomial prism (bicubic top over the unit square, ruled walls): volume
 *   `Σ z_ij / 16` exactly (each cubic Bernstein integrates to ¼);
 * - polynomial integrands over polygonal loops: Green's rule is exact;
 * - multi-span bicubic (a C0 u-knot of multiplicity 3, simple knots in u and
 *   v) under a polynomial trim crossing every knot line: the exact Green rule
 *   (trim curves split where they cross knot lines) against the tensor rule
 *   over the natural domain, and against adaptive integration.
 *
 * Tolerances and why:
 * - rational geometry or the area element (adaptive): `10 · quadRel` relative,
 *   the design's bound (§16): the adaptive rule stops when its pessimistic
 *   estimate meets `quadRel`, and the true error is below it; 10× covers
 *   the summation of the nested levels;
 * - exact (polynomial) rules: `1e-12` relative (rounding of ~10³–10⁴ summed
 *   terms of mixed sign; the rules are exact in exact arithmetic);
 * - translation by 100 cm: `1e-12` relative (polynomial: exact rules; the
 *   centring of `c` keeps cancellation at the rounding level).
 */
import { describe, expect, it } from 'vitest';
import { bezierSurface, circle2, cylinder, line2, planeSurface, sphere, torus } from './primitives';
import { bezierCurve, transformCurve2 } from './curve';
import { clampedBasis } from './basis';
import { mulberry32 } from './testing';
import { DEFAULT_TOLERANCES } from './tolerance';
import { enclosedVolume, integrateTrimmed, surfaceArea } from './integrate';
import type { SurfaceIntegrand } from './integrate';
import { makeTrimLoop, makeTrimmedSurface, naturalBoundaryLoop } from './trim';
import { makeSurface, transformSurface } from './surface';
import type { ClampedCurve, NurbsSurface, Result, TrimLoop, TrimmedSurface } from './types';

const QREL = 10 * DEFAULT_TOLERANCES.quadRel;
const EXACT = 1e-12;

function ok<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

const loop = (curves: ClampedCurve<2>[]): TrimLoop => ok(makeTrimLoop(curves));
/** The circle about (cu, cv) of radius r, clockwise (mirrored in v about cv). */
const cwCircle = (cu: number, cv: number, r: number): ClampedCurve<2> =>
  transformCurve2(circle2({ x: cu, y: cv }, r), [1, 0, 0, 0, -1, 2 * cv]);

function relErr(a: number, b: number): number {
  return Math.abs(a - b) / Math.abs(b);
}

/** Plane S = (2u, 3v, 0) on [0, 1]²: area element 6. */
const plane = planeSurface({ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 0, y: 3, z: 0 });

describe('surfaceArea of trimmed planes', () => {
  it('plane trimmed by a circle: 6πr²', () => {
    const ts = ok(makeTrimmedSurface(plane, loop([circle2({ x: 0.5, y: 0.45 }, 0.3)])));
    const r = surfaceArea(ts);
    expect(r.converged).toBe(true);
    expect(relErr(r.value, 6 * Math.PI * 0.09)).toBeLessThanOrEqual(QREL);
    expect(r.errorEstimate).toBeGreaterThanOrEqual(0);
  });

  it('annulus: 6π(R² − r²); a hole given counter-clockwise is reversed with a warning', () => {
    const outer = loop([circle2({ x: 0.5, y: 0.5 }, 0.4)]);
    const want = 6 * Math.PI * (0.16 - 0.04);
    const ts = ok(makeTrimmedSurface(plane, outer, [loop([cwCircle(0.5, 0.5, 0.2)])]));
    expect(relErr(surfaceArea(ts).value, want)).toBeLessThanOrEqual(QREL);
    const r = makeTrimmedSurface(plane, outer, [loop([circle2({ x: 0.5, y: 0.5 }, 0.2)])]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.issues.map((i) => [i.code, i.severity])).toEqual([['trim-orientation', 'warning']]);
    expect(relErr(surfaceArea(r.value).value, want)).toBeLessThanOrEqual(QREL);
  });

  it('square with a circular hole (natural outer): 6(1 − πr²)', () => {
    const ts = ok(makeTrimmedSurface(plane, null, [loop([cwCircle(0.3, 0.6, 0.25)])]));
    expect(relErr(surfaceArea(ts).value, 6 * (1 - Math.PI * 0.0625))).toBeLessThanOrEqual(QREL);
    expect(relErr(surfaceArea(plane).value, 6)).toBeLessThanOrEqual(EXACT);
  });

  it('converges as quadRel tightens, and the estimate bounds the error', () => {
    const ts = ok(makeTrimmedSurface(plane, loop([circle2({ x: 0.5, y: 0.45 }, 0.3)])));
    const want = 6 * Math.PI * 0.09;
    let prev = Infinity;
    for (const q of [1e-4, 1e-7, 1e-10]) {
      const r = surfaceArea(ts, { quadRel: q });
      const e = Math.abs(r.value - want);
      expect(e).toBeLessThanOrEqual(10 * q * want);
      expect(r.errorEstimate).toBeGreaterThanOrEqual(e * 0.999);
      expect(e).toBeLessThanOrEqual(prev);
      prev = e;
    }
  });
});

describe('integrateTrimmed: exact rules', () => {
  it('integrates polynomials over polygonal loops exactly (Green’s theorem)', () => {
    // The triangle (0.1, 0.1), (0.9, 0.2), (0.3, 0.8).
    const P = [
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.2 },
      { x: 0.3, y: 0.8 },
    ];
    const tri = loop([line2(P[0]!, P[1]!), line2(P[1]!, P[2]!), line2(P[2]!, P[0]!)]);
    const ts = ok(makeTrimmedSurface(plane, tri));
    const area =
      0.5 * ((P[1]!.x - P[0]!.x) * (P[2]!.y - P[0]!.y) - (P[1]!.y - P[0]!.y) * (P[2]!.x - P[0]!.x));
    const one = integrateTrimmed(ts, () => 1, { polynomialDegree: [0, 0] });
    expect(relErr(one.value, area)).toBeLessThanOrEqual(EXACT);
    expect(relErr(one.value, tri.signedArea)).toBeLessThanOrEqual(EXACT);
    // ∫∫ u² v over the triangle: the 7-point Radon rule is exact to degree 5.
    const f = (u: number, v: number): number => u * u * v;
    const exact = radon7(P, f);
    const r = integrateTrimmed(ts, (u, v) => f(u, v), { polynomialDegree: [2, 1] });
    expect(relErr(r.value, exact)).toBeLessThanOrEqual(EXACT);
    // A much higher-degree promise changes nothing (the rule is already exact).
    const r5 = integrateTrimmed(ts, (u, v) => f(u, v), { polynomialDegree: [12, 11] });
    expect(relErr(r5.value, r.value)).toBeLessThanOrEqual(EXACT);
  });

  it('a rule that is too low is detectably wrong (the exactness test can fail)', () => {
    const P = [
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.2 },
      { x: 0.3, y: 0.8 },
    ];
    const ts = ok(
      makeTrimmedSurface(
        plane,
        loop([line2(P[0]!, P[1]!), line2(P[1]!, P[2]!), line2(P[2]!, P[0]!)]),
      ),
    );
    const f = (u: number, v: number): number => u ** 6 * v;
    const low = integrateTrimmed(ts, (u, v) => f(u, v), { polynomialDegree: [1, 1] });
    expect(relErr(low.value, radon7Refined(P, f))).toBeGreaterThan(1e-6);
  });
});

describe('integrateTrimmed: multi-span surfaces under a trim (knot-line splits)', () => {
  // Bicubic: u knots 0.3 (multiplicity 3, C0) and 0.6; v knots 0.25 and 0.7.
  const U = [0, 0, 0, 0, 0.3, 0.3, 0.3, 0.6, 1, 1, 1, 1];
  const V = [0, 0, 0, 0, 0.25, 0.7, 1, 1, 1, 1];
  const nu = U.length - 4;
  const nv = V.length - 4;
  const rnd = mulberry32(7);
  const pts: number[] = [];
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      pts.push(2 * (i / (nu - 1)) + 0.2 * rnd(), 1.5 * (j / (nv - 1)) + 0.2 * rnd(), rnd());
    }
  }
  const s = makeSurface({ u: clampedBasis(3, U), v: clampedBasis(3, V), points: pts });
  /** The volume integrand S·(S_u × S_v): bidegree (3p − 1, 3q − 1) per span pair. */
  const vol = (_u: number, _v: number, d: ArrayLike<number>): number =>
    d[0]! * (d[4]! * d[8]! - d[5]! * d[7]!) +
    d[1]! * (d[5]! * d[6]! - d[3]! * d[8]!) +
    d[2]! * (d[3]! * d[7]! - d[4]! * d[6]!);
  const deg = [8, 8] as const;

  it('the exact Green rule over the natural loop equals the tensor rule', () => {
    const tensor = integrateTrimmed(ok(makeTrimmedSurface(s, null)), vol, {
      polynomialDegree: deg,
    });
    const green = integrateTrimmed(ok(makeTrimmedSurface(s, naturalBoundaryLoop(s))), vol, {
      polynomialDegree: deg,
    });
    expect(relErr(green.value, tensor.value)).toBeLessThanOrEqual(EXACT);
  });

  it('a curved trim crossing every knot line: exact rule equals adaptive', () => {
    // Triangle with one quadratic side; it crosses u = 0.3, 0.6 and v = 0.25, 0.7.
    const a = { x: 0.1, y: 0.1 };
    const b = { x: 0.9, y: 0.15 };
    const c = { x: 0.15, y: 0.85 };
    const tri = loop([line2(a, b), bezierCurve(2, [b.x, b.y, 0.75, 0.95, c.x, c.y]), line2(c, a)]);
    const ts = ok(makeTrimmedSurface(s, tri));
    const exact = integrateTrimmed(ts, vol, { polynomialDegree: deg });
    // Adaptive to quadRel 1e-13; the file's 10× margin gives the bound.
    const adaptive = integrateTrimmed(ts, vol, { tol: { quadRel: 1e-13 } });
    expect(adaptive.converged).toBe(true);
    expect(relErr(exact.value, adaptive.value)).toBeLessThanOrEqual(1e-12);
  });

  it('a trim crossing a knot line exactly at a de Casteljau split point keeps that break', () => {
    // Bilinear plane (u, v, 0) with a u-knot at 0.5; f = max(u − 0.5, 0)² is
    // a polynomial on each span. The cubic side is non-monotone in u and
    // crosses u = 0.5 at s = 0.18…, exactly at s = 0.5 (the first bisection
    // point: u(½) = (0.25 + 3 + 0 + 0.75) / 8), and at s = 0.85….
    const S = makeSurface({
      u: clampedBasis(1, [0, 0, 0.5, 1, 1]),
      v: clampedBasis(1, [0, 0, 1, 1]),
      points: [0, 0, 0, 0, 1, 0, 0.5, 0, 0, 0.5, 1, 0, 1, 0, 0, 1, 1, 0],
    });
    const cubic = [0.25, 0.1, 1.0, 0.3, 0.0, 0.5, 0.75, 0.7];
    const corners = [
      { x: 0.75, y: 0.7 },
      { x: 0.05, y: 0.95 },
      { x: 0.02, y: 0.05 },
      { x: 0.25, y: 0.1 },
    ];
    const ts = ok(
      makeTrimmedSurface(
        S,
        loop([
          bezierCurve(2, cubic),
          line2(corners[0]!, corners[1]!),
          line2(corners[1]!, corners[2]!),
          line2(corners[2]!, corners[3]!),
        ]),
      ),
    );
    const f = (u: number): number => Math.max(u - 0.5, 0) ** 2;
    // Oracle (independent of the code): Green, ∬ f = ∮ G(u) dv with
    // G(u) = max(u − 0.5, 0)³ / 3, by composite Simpson on each Bézier side.
    // G is C², so the error is O(h⁴) ≈ 1e-17 here, far below the bound.
    const sides: number[][] = [cubic];
    for (let k = 0; k < 3; k++) {
      const p = corners[k]!;
      const q = corners[k + 1]!;
      sides.push([p.x, p.y, q.x, q.y]);
    }
    const G = (u: number): number => Math.max(u - 0.5, 0) ** 3 / 3;
    let want = 0;
    const N = 20000;
    for (const cp of sides) {
      const n = cp.length / 2 - 1;
      const at = (s: number): [number, number] => {
        // Bernstein form: u(s) and v′(s).
        let u = 0;
        let dv = 0;
        for (let j = 0; j <= n; j++) {
          const bin = n === 3 ? [1, 3, 3, 1][j]! : 1;
          u += bin * s ** j * (1 - s) ** (n - j) * cp[2 * j]!;
        }
        for (let j = 0; j < n; j++) {
          const bin = n === 3 ? [1, 2, 1][j]! : 1;
          dv += n * bin * s ** j * (1 - s) ** (n - 1 - j) * (cp[2 * j + 3]! - cp[2 * j + 1]!);
        }
        return [u, dv];
      };
      const g = (s: number): number => {
        const [u, dv] = at(s);
        return G(u) * dv;
      };
      let sum = g(0) + g(1);
      for (let i = 1; i < N; i++) sum += (i % 2 === 1 ? 4 : 2) * g(i / N);
      want += sum / (3 * N);
    }
    const r = integrateTrimmed(ts, (u) => f(u), { polynomialDegree: [2, 0] });
    expect(r.converged).toBe(true);
    expect(relErr(r.value, want)).toBeLessThanOrEqual(EXACT);
  });
});

/** Radon's 7-point rule on a triangle (exact for degree ≤ 5; Strang & Fix, table 4.1), closed form. */
function radon7(
  P: readonly { x: number; y: number }[],
  f: (u: number, v: number) => number,
): number {
  const r = Math.sqrt(15);
  const a = (9 - 2 * r) / 21;
  const b = (6 + r) / 21;
  const c = (9 + 2 * r) / 21;
  const d = (6 - r) / 21;
  const wc = 9 / 40;
  const wb = (155 + r) / 1200;
  const wd = (155 - r) / 1200;
  const bary: [number, number, number, number][] = [
    [1 / 3, 1 / 3, 1 / 3, wc],
    [a, b, b, wb],
    [b, a, b, wb],
    [b, b, a, wb],
    [c, d, d, wd],
    [d, c, d, wd],
    [d, d, c, wd],
  ];
  const area =
    0.5 * ((P[1]!.x - P[0]!.x) * (P[2]!.y - P[0]!.y) - (P[1]!.y - P[0]!.y) * (P[2]!.x - P[0]!.x));
  let s = 0;
  for (const [l0, l1, l2, w] of bary) {
    s +=
      w * f(l0 * P[0]!.x + l1 * P[1]!.x + l2 * P[2]!.x, l0 * P[0]!.y + l1 * P[1]!.y + l2 * P[2]!.y);
  }
  return s * area;
}

/**
 * A reference for a degree-7 integrand: the degree-5 rule on 4 levels of
 * midpoint subdivision (256 triangles; its error, O(h⁶) relative, is far below
 * the 1e-6 the test asserts).
 */
function radon7Refined(
  P: readonly { x: number; y: number }[],
  f: (u: number, v: number) => number,
): number {
  let tris = [P];
  for (let k = 0; k < 4; k++) {
    const next: { x: number; y: number }[][] = [];
    for (const [A, B, C] of tris as [
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
    ][]) {
      const m = (p: { x: number; y: number }, q: { x: number; y: number }) => ({
        x: 0.5 * (p.x + q.x),
        y: 0.5 * (p.y + q.y),
      });
      const ab = m(A, B);
      const bc = m(B, C);
      const ca = m(C, A);
      next.push([A, ab, ca], [ab, B, bc], [ca, bc, C], [ab, bc, ca]);
    }
    tris = next;
  }
  return tris.reduce((s, t) => s + radon7(t, f), 0);
}

describe('closed solids', () => {
  it('sphere from rational patches: area 4πr², volume 4/3 πr³', () => {
    const r = 1.7;
    const s = sphere({ x: 3, y: -2, z: 1 }, r);
    const A = surfaceArea(s);
    expect(A.converged).toBe(true);
    expect(relErr(A.value, 4 * Math.PI * r * r)).toBeLessThanOrEqual(QREL);
    const V = enclosedVolume([{ face: s }]);
    expect(V.converged).toBe(true);
    expect(relErr(V.value, (4 / 3) * Math.PI * r ** 3)).toBeLessThanOrEqual(QREL);
    // Flipped orientation negates it.
    expect(enclosedVolume([{ face: s, sameSense: false }]).value).toBe(-V.value);
  });

  it('torus: area 4π²Rr, volume 2π²Rr²', () => {
    const R = 3;
    const r = 0.8;
    const s = torus({ x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 0.5 }, R, r);
    expect(relErr(surfaceArea(s).value, 4 * Math.PI ** 2 * R * r)).toBeLessThanOrEqual(QREL);
    expect(
      relErr(enclosedVolume([{ face: s }]).value, 2 * Math.PI ** 2 * R * r * r),
    ).toBeLessThanOrEqual(QREL);
  });

  it('a rational face whose integrand is rounding noise converges on an absolute target (G2 regression)', () => {
    // Nested adaptive rules on noise used to refine to quadMaxSplits at both levels
    // (61k inner evaluations per outer node: a hang at the defaults). massProperties hit it
    // on a skinned wall whose normal has no z component (V5b with no bulge).
    const side = cylinder({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 1.2, 2.5);
    const noise: SurfaceIntegrand = (_u, _v, d) =>
      (((d[0]! * 1e5 + d[2]! * 3e4) % 1) - 0.5) * Number.EPSILON;
    const natural = ok(makeTrimmedSurface(side, null));
    // With a small cap the relative-only run shows the failure quickly.
    const capped = integrateTrimmed(natural, noise, { tol: { quadMaxSplits: 16 } });
    expect(capped.converged).toBe(false);
    // The runs with absTol keep a modest cap too, so a regression fails here instead of hanging.
    const bounded = { quadMaxSplits: 64 };
    const abs = integrateTrimmed(natural, noise, { absTol: 1e-12, tol: bounded });
    expect(abs.converged).toBe(true);
    expect(abs.errorEstimate).toBeLessThanOrEqual(1e-12);
    expect(Math.abs(abs.value)).toBeLessThanOrEqual(1e-12);
    // Cheap: well under one capped inner integral per outer node.
    expect(abs.evaluations).toBeLessThan(capped.evaluations);
    // The same through Green's theorem (a trimmed face).
    const cap = ok(
      makeTrimmedSurface(
        planeSurface(
          { x: 0, y: 0, z: 0 },
          { x: 1, y: 0, z: 0 },
          { x: 0, y: 1, z: 0 },
          {
            u: [-1.5, 1.5] as const,
            v: [-1.5, 1.5] as const,
          },
        ),
        loop([circle2({ x: 0, y: 0 }, 1.2)]),
      ),
    );
    const green = integrateTrimmed(cap, noise, { absTol: 1e-12, tol: bounded });
    expect(green.converged).toBe(true);
    expect(green.errorEstimate).toBeLessThanOrEqual(1e-12);
    expect(() => integrateTrimmed(natural, noise, { absTol: -1 })).toThrow();
  });

  it('cylinder closed by trimmed planar caps: πr²h', () => {
    const r = 1.2;
    const h = 2.5;
    const side = cylinder({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, r, h);
    const dom = { u: [-1.5, 1.5] as const, v: [-1.5, 1.5] as const };
    const cap = (z: number): TrimmedSurface =>
      ok(
        makeTrimmedSurface(
          planeSurface({ x: 0, y: 0, z }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, dom),
          loop([circle2({ x: 0, y: 0 }, r)]),
        ),
      );
    const V = enclosedVolume([
      { face: side },
      { face: cap(0), sameSense: false },
      { face: cap(h) },
    ]);
    expect(V.converged).toBe(true);
    expect(relErr(V.value, Math.PI * r * r * h)).toBeLessThanOrEqual(QREL);
  });

  it('polynomial prism: Σ z_ij / 16 exactly; unchanged by translation; negated when flipped', () => {
    const z = [
      [1.0, 1.3, 0.9, 1.1],
      [1.2, 2.0, 1.7, 0.8],
      [0.7, 1.5, 2.2, 1.0],
      [1.1, 0.9, 1.4, 1.6],
    ];
    const faces = prism(z);
    const want = z.flat().reduce((a, b) => a + b, 0) / 16;
    const V = enclosedVolume(faces);
    expect(V.converged).toBe(true);
    expect(relErr(V.value, want)).toBeLessThanOrEqual(EXACT);
    const moved = faces.map((f) => ({
      ...f,
      face: transformSurface(f.face as NurbsSurface, [1, 0, 0, 100, 0, 1, 0, -100, 0, 0, 1, 100]),
    }));
    expect(relErr(enclosedVolume(moved).value, want)).toBeLessThanOrEqual(EXACT);
    const flipped = faces.map((f) => ({ ...f, sameSense: f.sameSense === false }));
    expect(relErr(enclosedVolume(flipped).value, -want)).toBeLessThanOrEqual(EXACT);
    // Dropping a wall breaks closure: the result is wrong (the oracle can fail).
    expect(relErr(enclosedVolume(faces.slice(0, 5)).value, want)).toBeGreaterThan(1e-3);
  });
});

/** Bicubic graph z(u, v) over [0, 1]² with x = u, y = v, the plane z = 0 below and four ruled walls. */
function prism(z: number[][]): { face: NurbsSurface; sameSense?: boolean }[] {
  const top: number[] = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) top.push(i / 3, j / 3, z[i]![j]!);
  /** Wall over a cubic edge `(x(t), y(t), h(t))` down to z = 0, (t, w) ↦ (x, y, w·h). */
  const wall = (pts: [number, number, number][]): NurbsSurface => {
    const cp: number[] = [];
    for (const [x, y, hz] of pts) cp.push(x, y, 0, x, y, hz);
    return bezierSurface(cp, 4, 2);
  };
  const edge = (f: (k: number) => [number, number, number]) => [0, 1, 2, 3].map(f);
  return [
    { face: bezierSurface(top, 4, 4) },
    {
      face: planeSurface({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }),
      sameSense: false,
    },
    { face: wall(edge((k) => [k / 3, 0, z[k]![0]!])) }, // y = 0: normal −y
    { face: wall(edge((k) => [k / 3, 1, z[k]![3]!])), sameSense: false }, // y = 1
    { face: wall(edge((k) => [0, k / 3, z[0]![k]!])), sameSense: false }, // x = 0
    { face: wall(edge((k) => [1, k / 3, z[3]![k]!])) }, // x = 1
  ];
}
