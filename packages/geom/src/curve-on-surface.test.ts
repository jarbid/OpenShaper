// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Curves on surfaces (design §6.15; oracle row `curve-on-surface` of §16).
 *
 * Oracles:
 *
 * - **Planes are exact.** On `S(u, v) = O + u·U + v·V` the composition is the
 *   affine image of the pcurve, so `C⁽ᵏ⁾ = x⁽ᵏ⁾·U + y⁽ᵏ⁾·V` in closed form,
 *   and a circle pcurve on an orthonormal plane is a circle in space.
 * - **Iso-lines are exact.** `isoLinePcurve` composed with a surface equals
 *   `isoCurve` at the same parameter; `v = const` on a cylinder is a circle.
 * - **Chain rule vs finite differences** (Richardson-extrapolated central
 *   differences) on random rational Bézier patches, which are C^∞, so the
 *   difference quotients see no knot.
 * - **Sides.** Where a pcurve crosses a C⁰ knot line of the surface, the
 *   derivative is the curve's own right-hand derivative (a one-sided
 *   difference), which differs from the other side's; at the end of a
 *   clamped pcurve on such a line it is the left-hand one, from the face the
 *   curve arrives on (also when only the second derivative says which).
 * - **Projection to pcurve samples** recovers known pcurves (iso-curves),
 *   unwraps periodic directions, and reports distances honestly.
 *
 * Tolerances:
 *
 * - exact cases `64 ε · scale`: ~10 flops per coordinate on O(scale) values;
 * - finite differences `1e-8` of the local scale (§16): central differences
 *   at `h` = 1/32 of the pcurve span with two Richardson steps leave a
 *   truncation of ~(1/32)⁶ ≈ 1e-9 of the derivative scale and a cancellation
 *   of ~ε·|C|/h² ≤ 1e-10 (spans ≥ 1/20); measured worst 1.5e-9;
 * - one-sided differences `1e-6` relative: forward differences with one
 *   Richardson step at `h = 2⁻¹²` leave ~h² ≈ 6e-8 times the third derivative;
 *   the two sides differ by O(1) on the test patch;
 * - one-sided differences on a roof `1e-10` absolute: there `C` is a
 *   polynomial of degree ≤ 2 on each face, so the three-point formulas at
 *   `h = 2⁻⁶` have no truncation and only the cancellation ~4ε/h² ≈ 4e-12;
 * - projected samples: parameters `1e-12` of the domain and distances
 *   `64 ε · scale`, as for point inversion (project.test.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  bezierCurve,
  bezierSurface,
  circle2,
  clampedBasis,
  createScratch,
  curveDerivatives,
  curveDomain,
  curveOnSurface,
  curveOnSurfaceDerivatives,
  curveOnSurfaceEvalInto,
  curveOnSurfacePoint,
  curvePoint,
  cylinder,
  isGeomError,
  isoCurve,
  isoLinePcurve,
  line2,
  makeCurve,
  makeSurface,
  periodicCircle,
  planeSurface,
  projectCurveSamplesToSurface,
  sphere,
  surfaceDerivatives,
  surfaceDomain,
  surfacePoint,
  torus,
  vec,
} from './index';
import type { CurveOnSurface, GeomErrorCode, NurbsCurve, NurbsSurface, Point3 } from './index';
import { curveSampleProjector } from './curve-on-surface';
import { mulberry32, randomClampedBasis } from './testing';

const EPS = Number.EPSILON;
const PARAM_REL = 1e-12;

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

const at = (cs: CurveOnSurface, t: number): Point3 => curveOnSurfacePoint(cs, t);
const comb = (a: number, U: Point3, b: number, V: Point3): Point3 =>
  vec.add(vec.scale(U, a), vec.scale(V, b));

/** A random rational Bézier patch of degree (3, 3) on [0, 1]². */
function randomPatch(rng: () => number): NurbsSurface {
  const pts = Array.from({ length: 48 }, () => 2 * (rng() - 0.5));
  const w = Array.from({ length: 16 }, () => 0.5 + 1.5 * rng());
  return bezierSurface(pts, 4, 4, w);
}

/** A random rational cubic pcurve with interior knots, control points in [0.1, 0.9]². */
function randomPcurve(rng: () => number): NurbsCurve<2> {
  const basis = randomClampedBasis(rng, 3, 7);
  return makeCurve({
    dim: 2,
    basis,
    points: Array.from({ length: 14 }, () => 0.1 + 0.8 * rng()),
    weights: Array.from({ length: 7 }, () => 0.5 + 1.5 * rng()),
  });
}

describe('curveOnSurface: exact cases', () => {
  it('is the affine image of the pcurve on a plane, derivatives included', () => {
    const O = { x: 1, y: -2, z: 0.5 };
    const U = { x: 2, y: 0.5, z: -1 };
    const V = { x: -0.3, y: 1.5, z: 0.7 };
    const s = planeSurface(O, U, V, { u: [-1, 2], v: [0, 3] });
    const pc = circle2({ x: 0.5, y: 1.5 }, 1.2);
    const cs = curveOnSurface(s, pc);
    const scale = 10;
    const [a, b] = curveDomain(pc);
    for (let k = 0; k <= 64; k++) {
      const t = a + ((b - a) * k) / 64;
      const [P, D1, D2] = curveDerivatives(pc, t, 2);
      const [C, C1, C2] = curveOnSurfaceDerivatives(cs, t, 2);
      expect(vec.distance(C!, vec.add(O, comb(P!.x, U, P!.y, V)))).toBeLessThanOrEqual(
        64 * EPS * scale,
      );
      // Derivatives scale with the circle's: |x′| ~ 2πr·√2, |x″| ~ (2π)²r·4.
      expect(vec.distance(C1!, comb(D1!.x, U, D1!.y, V))).toBeLessThanOrEqual(
        64 * EPS * scale * 20,
      );
      expect(vec.distance(C2!, comb(D2!.x, U, D2!.y, V))).toBeLessThanOrEqual(
        64 * EPS * scale * 400,
      );
    }
  });

  it('maps a circle pcurve on an orthonormal plane to a circle', () => {
    const O = { x: 0, y: 0, z: 3 };
    const s = planeSurface(
      O,
      { x: 0.6, y: 0.8, z: 0 },
      { x: 0, y: 0, z: 1 },
      {
        u: [-2, 2],
        v: [-2, 2],
      },
    );
    const r = 1.5;
    const cs = curveOnSurface(s, circle2({ x: 0.25, y: -0.1 }, r));
    const c = vec.add(O, comb(0.25, { x: 0.6, y: 0.8, z: 0 }, -0.1, { x: 0, y: 0, z: 1 }));
    for (let k = 0; k <= 100; k++) {
      expect(Math.abs(vec.distance(at(cs, k / 100), c) - r)).toBeLessThanOrEqual(64 * EPS * 5);
    }
  });

  it('gives an exact circle for v = const on a cylinder, equal to the iso-curve', () => {
    const base = { x: 1, y: 2, z: -1 };
    const axis = vec.normalize({ x: 1, y: -1, z: 2 })!;
    const r = 2;
    const h = 5;
    const s = cylinder(base, axis, r, h);
    const cs = curveOnSurface(s, isoLinePcurve(s, 'v', 0.3));
    const iso = isoCurve(s, 'v', 0.3);
    const centre = vec.add(base, vec.scale(axis, 0.3 * h));
    const scale = r + h + vec.norm(base);
    for (let k = 0; k <= 64; k++) {
      const t = k / 64;
      const C = at(cs, t);
      expect(Math.abs(vec.distance(C, centre) - r)).toBeLessThanOrEqual(64 * EPS * scale);
      expect(Math.abs(vec.dot(vec.sub(C, base), axis) - 0.3 * h)).toBeLessThanOrEqual(
        64 * EPS * scale,
      );
      expect(vec.distance(C, curvePoint(iso, t === 1 ? 0 : t))).toBeLessThanOrEqual(
        64 * EPS * scale,
      );
    }
  });

  it('makes iso-line pcurves that run over the other direction, with that parameter', () => {
    const s = sphere({ x: 0, y: 0, z: 0 }, 2);
    const meridian = isoLinePcurve(s, 'u', 0.2);
    expect(curveDomain(meridian)).toEqual([0, 1]);
    const parallel = isoLinePcurve(s, 'v', 0.4);
    // A periodic direction runs over one whole period.
    expect(curveDomain(parallel)).toEqual([0, 1]);
    for (let k = 0; k <= 32; k++) {
      const t = k / 32;
      const p = curvePoint(meridian, t);
      expect(p.x).toBe(0.2);
      expect(Math.abs(p.y - t)).toBeLessThanOrEqual(4 * EPS);
      const q = curvePoint(parallel, t);
      expect(Math.abs(q.x - t)).toBeLessThanOrEqual(4 * EPS);
      expect(q.y).toBe(0.4);
      const m = curveOnSurfacePoint(curveOnSurface(s, meridian), t);
      expect(vec.distance(m, curvePoint(isoCurve(s, 'u', 0.2), t))).toBeLessThanOrEqual(
        64 * EPS * 2,
      );
    }
    // Wrapped like the surface: u = 1.2 is u = 0.2.
    expect(curvePoint(isoLinePcurve(s, 'u', 1.2), 0.5).x).toBeCloseTo(0.2, 15);
    const tor = torus({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 3, 1);
    expect(curveDomain(isoLinePcurve(tor, 'u', 0.3))).toEqual([0, 1]);
    expectCode(
      () =>
        isoLinePcurve(
          planeSurface({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }),
          'u',
          1.5,
        ),
      'param-out-of-domain',
    );
  });
});

describe('curveOnSurface: chain rule', () => {
  /**
   * Central differences of the first and second derivative with two
   * Richardson steps (h, h/2, h/4: truncation O(h⁶)).
   */
  function fd(cs: CurveOnSurface, t: number, h: number): [Point3, Point3] {
    const f = (x: number): Point3 => at(cs, x);
    const C = f(t);
    const d1 = (k: number): Point3 => vec.scale(vec.sub(f(t + k), f(t - k)), 1 / (2 * k));
    const d2 = (k: number): Point3 =>
      vec.scale(vec.add(vec.sub(f(t + k), vec.scale(C, 2)), f(t - k)), 1 / (k * k));
    const rich = (g: (k: number) => Point3): Point3 => {
      const r1 = (k: number): Point3 => vec.scale(vec.sub(vec.scale(g(k / 2), 4), g(k)), 1 / 3);
      return vec.scale(vec.sub(vec.scale(r1(h / 2), 16), r1(h)), 1 / 15);
    };
    return [rich(d1), rich(d2)];
  }

  for (const seed of [61, 62, 63, 64]) {
    it(`matches finite differences on a random rational patch (seed ${seed})`, () => {
      const rng = mulberry32(seed);
      const s = randomPatch(rng);
      const pc = randomPcurve(rng);
      const cs = curveOnSurface(s, pc);
      const U = pc.basis.knots;
      // Points in the middle of each pcurve span, h = 1/32 of the span away from its knots.
      for (let i = 3; i < pc.basis.count; i++) {
        const [a, b] = [U[i]!, U[i + 1]!];
        const h = (b - a) / 32;
        for (const f of [0.3, 0.5, 0.7]) {
          const t = a + f * (b - a);
          const [, C1, C2] = curveOnSurfaceDerivatives(cs, t, 2);
          const [F1, F2] = fd(cs, t, h);
          const scale = Math.max(1, vec.norm(C1!), vec.norm(C2!));
          expect(vec.distance(C1!, F1), `t ${t}`).toBeLessThanOrEqual(1e-8 * scale);
          expect(vec.distance(C2!, F2), `t ${t}`).toBeLessThanOrEqual(1e-8 * scale);
        }
      }
    });
  }

  it('takes the surface side the pcurve moves into at a C⁰ knot line', () => {
    // A creased patch: u-knot 0.5 of multiplicity 2 = degree.
    const rng = mulberry32(65);
    const s = makeSurface({
      u: clampedBasis(2, [0, 0, 0, 0.5, 0.5, 1, 1, 1]),
      v: clampedBasis(2, [0, 0, 0, 1, 1, 1]),
      points: Array.from({ length: 45 }, () => 2 * (rng() - 0.5)),
    });
    const h = 2 ** -12;
    /** Richardson-extrapolated forward difference: the right-hand derivative. */
    const forward = (cs: CurveOnSurface, t: number): Point3 => {
      const C = at(cs, t);
      const q = (k: number): Point3 => vec.scale(vec.sub(at(cs, t + k), C), 1 / k);
      return vec.sub(vec.scale(q(h / 2), 2), q(h));
    };
    for (const [from, to] of [
      [
        { x: 0.8, y: 0.3 },
        { x: 0.2, y: 0.7 },
      ],
      [
        { x: 0.2, y: 0.3 },
        { x: 0.8, y: 0.7 },
      ],
    ] as const) {
      const cs = curveOnSurface(s, line2(from, to));
      // The line crosses u = 0.5 at t = 0.5.
      const [, C1] = curveOnSurfaceDerivatives(cs, 0.5, 1);
      const F = forward(cs, 0.5);
      const scale = Math.max(1, vec.norm(C1!));
      expect(vec.distance(C1!, F)).toBeLessThanOrEqual(1e-6 * scale);
      // The other side differs: the test is not vacuous.
      const other = surfaceDerivatives(s, 0.5, 0.5, 1, { u: to.x < from.x ? 'right' : 'left' });
      const du = to.x - from.x;
      const dv = to.y - from.y;
      const wrong = comb(du, other.Su, dv, other.Sv);
      expect(vec.distance(wrong, F)).toBeGreaterThan(1e-3 * scale);
    }
  });

  it('takes the side the curve arrives from at the end of a clamped pcurve', () => {
    // A roof in u (degree 1, ridge at u = 0.5) and the same roof in v:
    // S = (u, v, 2·min(w, 1 − w)) with w the roofed parameter, so each
    // face's partials are exact constants. At t = 1 only the left-hand
    // limit exists, so the side is the one the pcurve arrives from: by its
    // first derivative, or by its second where the first vanishes (u′ = 0,
    // u″ < 0 arrives from below). Closed forms from the face it arrives on;
    // a backward difference (exact: C is a polynomial of degree ≤ 2 on one
    // face) is the independent check.
    const roofU = makeSurface({
      u: clampedBasis(1, [0, 0, 0.5, 1, 1]),
      v: clampedBasis(1, [0, 0, 1, 1]),
      points: [0, 0, 0, 0, 1, 0, 0.5, 0, 1, 0.5, 1, 1, 1, 0, 0, 1, 1, 0],
    });
    const roofV = makeSurface({
      u: clampedBasis(1, [0, 0, 1, 1]),
      v: clampedBasis(1, [0, 0, 0.5, 1, 1]),
      points: [0, 0, 0, 0, 0.5, 1, 0, 1, 0, 1, 0, 0, 1, 0.5, 1, 1, 1, 0],
    });
    const h = 2 ** -6;
    // [pcurve control values of the roofed parameter (the other is 0.3), t, C′ or C″ index].
    const cases: readonly [readonly number[], number, 1 | 2][] = [
      [[0, 0.5], 1, 1], // arrives from below
      [[1, 0.5], 1, 1], // arrives from above
      [[0.5, 0], 0, 1], // leaves downwards (right-hand, for contrast)
      [[0, 0.5, 0.5], 1, 2], // u′ = 0, u″ = −1 < 0: from below
      [[1, 0.5, 0.5], 1, 2], // u′ = 0, u″ = +1 > 0: from above
    ];
    for (const roofed of ['u', 'v'] as const) {
      const s = roofed === 'u' ? roofU : roofV;
      for (const [w, t, k] of cases) {
        const pts = w.flatMap((x) => (roofed === 'u' ? [x, 0.3] : [0.3, x]));
        const pc = makeCurve({
          dim: 2,
          basis: clampedBasis(w.length - 1, [
            ...Array<number>(w.length).fill(0),
            ...Array<number>(w.length).fill(1),
          ]),
          points: pts,
        });
        const cs = curveOnSurface(s, pc);
        const D = curveOnSurfaceDerivatives(cs, t, 2);
        const [x0, x1, x2] = curveDerivatives(pc, t, 2).map((p) => (roofed === 'u' ? p.x : p.y));
        // The face the curve is on next to t, read off the pcurve itself.
        const before = t === 1;
        const sg = before ? -1 : 1;
        const near = curvePoint(pc, t + sg * h);
        const below = (roofed === 'u' ? near.x : near.y) < 0.5;
        expect(x0).toBe(0.5);
        const slope = below ? 2 : -2;
        const expected = { x: 0, y: 0, z: slope * x2! };
        if (k === 1) Object.assign(expected, { z: slope * x1! });
        if (roofed === 'u') expected.x = k === 1 ? x1! : x2!;
        else expected.y = k === 1 ? x1! : x2!;
        expect(vec.distance(D[k]!, expected)).toBeLessThanOrEqual(64 * EPS);
        // Independent: one-sided differences from the side the curve is on.
        const C = at(cs, t);
        const C1 = at(cs, t + sg * h);
        const C2 = at(cs, t + 2 * sg * h);
        const fd =
          k === 1
            ? // Second-order one-sided first derivative (exact on quadratics).
              vec.scale(
                vec.add(vec.add(vec.scale(C, -1.5), vec.scale(C1, 2)), vec.scale(C2, -0.5)),
                sg / h,
              )
            : vec.scale(vec.add(vec.sub(C, vec.scale(C1, 2)), C2), 1 / (h * h));
        expect(vec.distance(D[k]!, fd)).toBeLessThanOrEqual(1e-10);
      }
    }
  });

  it('agrees bit for bit between the kernel and the allocating wrappers', () => {
    const rng = mulberry32(66);
    for (const s of [randomPatch(rng), torus({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 3, 1)]) {
      const pc = randomPcurve(rng);
      const cs = curveOnSurface(s, pc);
      const sc = createScratch({ maxDegree: 3, maxDerivs: 2 });
      const out = new Float64Array(12);
      for (let k = 0; k <= 20; k++) {
        const t = k / 20;
        const D = curveOnSurfaceDerivatives(cs, t, 2);
        curveOnSurfaceEvalInto(cs, t, 2, out, 3, sc);
        expect(Array.from(out.subarray(3, 12))).toEqual(D.flatMap((p) => [p.x, p.y, p.z]));
        const D1 = curveOnSurfaceDerivatives(cs, t, 1);
        expect(D1[1]).toEqual(D[1]);
        curveOnSurfaceEvalInto(cs, t, 0, out, 0, sc);
        expect(Array.from(out.subarray(0, 3))).toEqual([D[0]!.x, D[0]!.y, D[0]!.z]);
        expect(curveOnSurfacePoint(cs, t)).toEqual(D[0]);
      }
      expectCode(
        () => curveOnSurfaceEvalInto(cs, 0, 2, out, 0, createScratch({ maxDegree: 2 })),
        'scratch-too-small',
      );
      expectCode(
        () => curveOnSurfaceEvalInto(cs, 0, 2, new Float64Array(8), 0, sc),
        'size-mismatch',
      );
    }
  });
});

describe('curveOnSurface: domain', () => {
  const unit = planeSurface({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
  const quad = (ym: number): NurbsCurve<2> => bezierCurve(2, [0.1, 0.5, 0.5, ym, 0.9, 0.5]);

  it('accepts a pcurve inside the domain whose control hull pokes out', () => {
    // y(t) = 0.5 + 2(ym − 0.5)·t(1 − t): its maximum 0.5 + (ym − 0.5)/2 at t = 1/2.
    expect(() => curveOnSurface(unit, quad(1.2))).not.toThrow();
    expect(() => curveOnSurface(unit, quad(1.5))).not.toThrow(); // touches v = 1 exactly
  });

  it('rejects a pcurve that leaves a clamped direction, naming where', () => {
    try {
      curveOnSurface(unit, quad(1.6));
      expect.unreachable('expected a throw');
    } catch (e) {
      expect(isGeomError(e, 'param-out-of-domain')).toBe(true);
      const d = (e as { details: { t: number; value: number } }).details;
      expect(Math.abs(d.t - 0.5)).toBeLessThanOrEqual(1e-6);
      expect(Math.abs(d.value - 1.05)).toBeLessThanOrEqual(1e-12);
    }
    expectCode(
      () => curveOnSurface(unit, line2({ x: 0.5, y: 0.5 }, { x: -0.2, y: 0.5 })),
      'param-out-of-domain',
    );
  });

  it('lets a pcurve run past a period in a periodic direction, and wraps it', () => {
    const s = cylinder({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 1, 2);
    const cs = curveOnSurface(s, line2({ x: -0.3, y: 0.5 }, { x: 1.7, y: 0.5 }));
    for (let k = 0; k <= 20; k++) {
      const t = k / 20;
      const u = -0.3 + 2 * t;
      const w = u - Math.floor(u);
      expect(vec.distance(at(cs, t), surfacePoint(s, w, 0.5))).toBeLessThanOrEqual(64 * EPS * 3);
    }
    expectCode(
      () => curveOnSurface(s, line2({ x: 0.2, y: -0.1 }, { x: 0.2, y: 0.5 })),
      'param-out-of-domain',
    );
  });

  it('rejects a curve that is not 2D and parameters off the pcurve', () => {
    const c3 = bezierCurve(3, [0, 0, 0, 1, 1, 1]);
    expectCode(() => curveOnSurface(unit, c3 as unknown as NurbsCurve<2>), 'dimension-mismatch');
    const cs = curveOnSurface(unit, quad(1));
    expectCode(() => curveOnSurfacePoint(cs, 1.5), 'param-out-of-domain');
    expectCode(() => curveOnSurfaceDerivatives(cs, 0.5, 3 as 2), 'unsupported');
    expect(Object.isFrozen(cs)).toBe(true);
  });
});

describe('projectCurveSamplesToSurface', () => {
  it('recovers the pcurve of an iso-curve of a rational surface', () => {
    const rng = mulberry32(71);
    const nu = 6;
    const nv = 5;
    const pts: number[] = [];
    const w: number[] = [];
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) {
        pts.push(i, 0.8 * j, 0.5 * rng());
        w.push(0.6 + 0.8 * rng());
      }
    }
    const s = makeSurface({
      u: clampedBasis(3, [0, 0, 0, 0, 0.4, 0.7, 1, 1, 1, 1]),
      v: clampedBasis(2, [0, 0, 0, 0.3, 0.6, 1, 1, 1]),
      points: pts,
      weights: w,
    });
    const c = isoCurve(s, 'v', 0.45) as NurbsCurve<3>;
    const ts = Float64Array.from({ length: 101 }, (_, i) => i / 100);
    const r = projectCurveSamplesToSurface(c, s, ts);
    expect(r.notConverged).toBe(0);
    expect(r.withinTolerance).toBe(true);
    expect(r.maxDistance).toBeLessThanOrEqual(64 * EPS * 6);
    for (let i = 0; i < ts.length; i++) {
      expect(Math.abs(r.uv[2 * i]! - ts[i]!), `sample ${i}`).toBeLessThanOrEqual(PARAM_REL);
      expect(Math.abs(r.uv[2 * i + 1]! - 0.45)).toBeLessThanOrEqual(PARAM_REL);
    }
    expect(Array.from(r.t)).toEqual(Array.from(ts));
    expect(Object.isFrozen(r)).toBe(true);
  });

  it('unwraps a periodic direction so the samples stay continuous', () => {
    const s = cylinder({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 1.5, 3);
    const c = isoCurve(s, 'v', 0.4) as NurbsCurve<3>; // periodic in u
    const ts = Float64Array.from({ length: 251 }, (_, i) => -0.5 + i / 100); // 2.5 turns
    const r = projectCurveSamplesToSurface(c, s, ts);
    expect(r.notConverged).toBe(0);
    for (let i = 0; i < ts.length; i++) {
      // The first sample is wrapped into [0, 1); the rest follow it continuously.
      expect(Math.abs(r.uv[2 * i]! - (ts[i]! + 1)), `sample ${i}`).toBeLessThanOrEqual(
        PARAM_REL * 4,
      );
      expect(Math.abs(r.uv[2 * i + 1]! - 0.4)).toBeLessThanOrEqual(PARAM_REL);
    }
  });

  it('reports the distance of a curve off the surface', () => {
    const s = cylinder({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 1, 2);
    const delta = 1e-3;
    const c = periodicCircle(
      { x: 0, y: 0, z: 0.7 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      1 + delta,
    ) as NurbsCurve<3>;
    const ts = Float64Array.from({ length: 50 }, (_, i) => i / 50);
    const r = projectCurveSamplesToSurface(c, s, ts);
    expect(Math.abs(r.maxDistance - delta)).toBeLessThanOrEqual(64 * EPS * 3);
    expect(r.withinTolerance).toBe(false);
    for (let i = 0; i < ts.length; i++) {
      expect(Math.abs(r.distance[i]! - delta)).toBeLessThanOrEqual(64 * EPS * 3);
      expect(Math.abs(r.uv[2 * i + 1]! - 0.35)).toBeLessThanOrEqual(PARAM_REL);
    }
    const near = projectCurveSamplesToSurface(c, s, ts, { tol: { fit: 2 * delta } });
    expect(near.withinTolerance).toBe(true);
  });

  it('rejects malformed input', () => {
    const s = sphere({ x: 0, y: 0, z: 0 }, 1);
    const l = bezierCurve(3, [0, 0, 0, 1, 1, 1]);
    expectCode(() => projectCurveSamplesToSurface(l, s, [0.5, 0.2]), 'size-mismatch');
    expectCode(() => projectCurveSamplesToSurface(l, s, [0.5, 1.2]), 'param-out-of-domain');
    expectCode(() => projectCurveSamplesToSurface(l, s, [NaN]), 'non-finite');
    const l2 = bezierCurve(2, [0, 0, 1, 1]);
    expectCode(
      () => projectCurveSamplesToSurface(l2 as unknown as NurbsCurve<3>, s, [0]),
      'dimension-mismatch',
    );
    expect(surfaceDomain(s).u).toEqual([0, 1]);
  });
});

describe('curveSampleProjector (prepared surface, seeded samples)', () => {
  const side = cylinder({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 2, 3);
  const ring = periodicCircle(
    { x: 0, y: 0, z: 1.5 },
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    2,
  );
  const ts = Float64Array.from({ length: 21 }, (_, i) => 0.9 + (0.2 * i) / 20);

  it('is projectCurveSamplesToSurface, prepared once: the same samples, call after call', () => {
    const project = curveSampleProjector(ring, side);
    const a = projectCurveSamplesToSurface(ring, side, ts);
    for (let k = 0; k < 2; k++) {
      const b = project(ts);
      expect(Array.from(b.uv)).toEqual(Array.from(a.uv));
      expect(Array.from(b.distance)).toEqual(Array.from(a.distance));
      expect(b.notConverged).toBe(0);
    }
  });

  it('starts from a seed and unwraps a periodic direction relative to it, not to the first sample', () => {
    const project = curveSampleProjector(ring, side);
    // The ring at t = 1.02 is the point at u = 0.02 (a period past 0.02): which period the
    // answer lies in is the seed's, and the point is the same one.
    const t = Float64Array.of(1.02);
    const near1 = project(t, [0.98, 0.5]);
    expect(near1.notConverged).toBe(0);
    expect(Math.abs(near1.uv[0]! - 1.02)).toBeLessThanOrEqual(1e-9);
    const near0 = project(t, [0.01, 0.5]);
    expect(Math.abs(near0.uv[0]! - 0.02)).toBeLessThanOrEqual(1e-9);
    // Both are the same surface point to rounding.
    for (const r of [near0, near1]) {
      const p = surfacePoint(side, r.uv[0]!, r.uv[1]!);
      const q = curvePoint(ring, 1.02);
      expect(Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z)).toBeLessThanOrEqual(64 * EPS * 2);
    }
  });

  it('validates its curve once, at construction', () => {
    expectCode(
      () => curveSampleProjector(line2({ x: 0, y: 0 }, { x: 1, y: 1 }) as never, side),
      'dimension-mismatch',
    );
  });
});
