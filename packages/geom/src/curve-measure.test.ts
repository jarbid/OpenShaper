// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Curve-measure oracles (design §16, `curve-measure` row):
 * - circle curvature `1/r` everywhere (signed `±1/r` in 2D), though the
 *   rational parameterisation is not unit speed; parabola curvature
 *   `2/(1+4x²)^{3/2}`; ellipse curvature `ab/(a² sin²θ + b² cos²θ)^{3/2}`;
 * - arc length: circle `2πr`, arcs `rθ`, parabola
 *   `x√(1+4x²)/2 + asinh(2x)/4`, straight lines exactly;
 * - the arc-length table and its inverse: `paramAtLength(lengthAtParam(t)) = t`;
 * - degenerate points give `null` tangents and zero curvature, never NaN.
 *
 * Tolerances: curvature `1e-12` relative (two derivative evaluations and one
 * division, each a few ε relative to the scale of C′ and C″ — that scale is
 * O(1/r) here); length `10 · quadRel` relative (the GK estimate is not a
 * bound: 10× margin); inverse `paramRel × domain` (Newton stops at that step).
 */
import { describe, expect, it } from 'vitest';
import {
  arcLengthTable,
  bezierCurve,
  circle,
  circle2,
  circleArc,
  clampedBasis,
  createScratch,
  curveBounds,
  curveCurvature,
  curveCurvatureBatchInto,
  curveDerivatives,
  curveDomain,
  curveFrame,
  curveLength,
  curvePoint,
  curveSignedCurvature,
  curveTangent,
  DEFAULT_TOLERANCES,
  isGeomError,
  lengthAtParam,
  line,
  makeCurve,
  paramAtLength,
  periodicCircle,
  polyline,
  reviveCurve,
  transformCurve2,
  vec,
} from './index';
import type { GeomErrorCode, NurbsCurve, Point2, Point3 } from './index';
import { mulberry32, randomCurve } from './testing';

const EPS = Number.EPSILON;
const CURV_REL = 1e-12;
const LEN_REL = 10 * DEFAULT_TOLERANCES.quadRel;
const O3 = { x: 0, y: 0, z: 0 };
const EX = { x: 1, y: 0, z: 0 };
const EY = { x: 0, y: 1, z: 0 };

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

const samples = (n: number): number[] => Array.from({ length: n + 1 }, (_, i) => i / n);

describe('curvature', () => {
  it('is 1/r everywhere on 3D circles and arcs, though the speed varies', () => {
    const O = { x: 3, y: -1, z: 2 };
    const X = vec.normalize({ x: 1, y: 1, z: 0 })!;
    const Y = vec.normalize({ x: -1, y: 1, z: 1 })!;
    for (const r of [0.01, 1, 250]) {
      const curves = [
        circle(O, X, Y, r),
        periodicCircle(O, X, Y, r),
        circleArc(O, X, Y, r, 0.3, 0.3 + 1.2), // 1 segment
        circleArc(O, X, Y, r, -1, 2), // 2 segments
        circleArc(O, X, Y, r, 0, 4.5), // 3 segments
        circleArc(O, X, Y, r, 1, 1 + 2 * Math.PI), // 4 segments
      ];
      for (const c of curves) {
        for (const t of samples(97)) {
          expect(Math.abs(curveCurvature(c, t) * r - 1), `r ${r}`).toBeLessThanOrEqual(CURV_REL);
        }
      }
    }
  });

  it('is signed in 2D: +1/r counter-clockwise, −1/r clockwise', () => {
    const r = 2.5;
    const ccw = circle2({ x: 1, y: 1 }, r);
    const cw = transformCurve2(ccw, [1, 0, 0, 0, -1, 0]); // mirror: clockwise
    const arc = circle2({ x: 0, y: 0 }, r, [0.5, 2]);
    for (const t of samples(64)) {
      expect(Math.abs(curveSignedCurvature(ccw, t) * r - 1)).toBeLessThanOrEqual(CURV_REL);
      expect(Math.abs(curveSignedCurvature(cw, t) * r + 1)).toBeLessThanOrEqual(CURV_REL);
      expect(Math.abs(curveSignedCurvature(arc, t) * r - 1)).toBeLessThanOrEqual(CURV_REL);
    }
  });

  it('matches the parabola y = x²: κ = 2/(1+4x²)^{3/2}', () => {
    // Quadratic Bézier through (x0, x0²), ((x0+x1)/2, x0·x1), (x1, x1²): x is linear in t.
    const [x0, x1] = [-1.5, 2];
    const c = bezierCurve(2, [x0, x0 * x0, (x0 + x1) / 2, x0 * x1, x1, x1 * x1]);
    for (const t of samples(50)) {
      const x = x0 + t * (x1 - x0);
      const k = 2 / (1 + 4 * x * x) ** 1.5;
      expect(Math.abs(curveSignedCurvature(c, t) / k - 1)).toBeLessThanOrEqual(CURV_REL);
    }
  });

  it('matches the ellipse x = a cos θ, y = b sin θ', () => {
    const [a, b] = [4, 1.5];
    const e = transformCurve2(circle2({ x: 0, y: 0 }, 1), [a, 0, 0, 0, b, 0]);
    for (const t of samples(80)) {
      const p = curvePoint(e, t) as Point2;
      const th = Math.atan2(p.y / b, p.x / a);
      const k = (a * b) / (a * a * Math.sin(th) ** 2 + b * b * Math.cos(th) ** 2) ** 1.5;
      expect(Math.abs(curveSignedCurvature(e, t) / k - 1)).toBeLessThanOrEqual(CURV_REL);
    }
  });

  it('batch curvature equals the single-point functions bit for bit', () => {
    const rng = mulberry32(3);
    const c2 = randomCurve(rng, {
      dim: 2,
      degree: 3,
      count: 9,
      weightRange: [0.5, 2],
    }) as NurbsCurve<2>;
    const c3 = randomCurve(rng, { dim: 3, degree: 4, count: 8, kind: 'periodic' }) as NurbsCurve<3>;
    const ts = Float64Array.from(Array.from({ length: 50 }, () => rng()).sort());
    const s = createScratch({ maxDegree: 4 });
    const out = new Float64Array(ts.length);
    curveCurvatureBatchInto(c2, ts, out, s);
    ts.forEach((t, i) => expect(out[i]).toBe(curveSignedCurvature(c2, t)));
    curveCurvatureBatchInto(c3, ts, out, s);
    ts.forEach((t, i) => expect(out[i]).toBe(curveCurvature(c3, t)));
  });

  it('is zero on a straight line and at degenerate points, never NaN', () => {
    const l = line({ x: 1, y: 2, z: 3 }, { x: 4, y: -2, z: 3 });
    for (const t of samples(10)) expect(curveCurvature(l, t)).toBe(0);
    // P0 = P1: C′(0) = 3(P1 − P0) = 0, a cusp-like start.
    const cusp = bezierCurve(2, [1, 1, 1, 1, 2, 0, 3, 1]);
    expect(curveTangent(cusp, 0)).toBeNull();
    expect(curveSignedCurvature(cusp, 0)).toBe(0);
    // Every control point equal, far from the origin: C′ is pure rounding noise.
    const dot = bezierCurve(3, [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100]);
    for (const t of samples(10)) {
      expect(curveTangent(dot, t)).toBeNull();
      expect(curveCurvature(dot, t)).toBe(0);
      expect(curveFrame(dot, t)).toBeNull();
    }
  });
});

describe('tangent and frame', () => {
  it('the tangent is the unit derivative', () => {
    const rng = mulberry32(9);
    const c = randomCurve(rng, {
      dim: 3,
      degree: 3,
      count: 7,
      weightRange: [0.5, 2],
    }) as NurbsCurve<3>;
    for (const t of samples(20)) {
      const T = curveTangent(c, t)!;
      const d = curveDerivatives(c, t, 1)[1]!;
      expect(Math.abs(vec.norm(T) - 1)).toBeLessThanOrEqual(4 * EPS);
      expect(vec.angleBetween(T, d)).toBeLessThanOrEqual(4 * EPS);
    }
    expect(curveTangent(line(O3, { x: 0, y: 0, z: 5 }), 0.3)).toEqual({ x: 0, y: 0, z: 1 });
  });

  it('the Frenet frame of a circle points at the centre with the plane normal as binormal', () => {
    const O = { x: 1, y: 2, z: 3 };
    const X = vec.normalize({ x: 1, y: 0, z: 1 })!;
    const Y = { x: 0, y: 1, z: 0 };
    const r = 4;
    const c = circle(O, X, Y, r);
    const B = vec.cross(X, Y);
    for (const t of samples(40)) {
      const f = curveFrame(c, t)!;
      const P = curvePoint(c, t);
      const toCentre = vec.scale(vec.sub(O, P), 1 / r);
      expect(vec.distance(f.n, toCentre)).toBeLessThanOrEqual(64 * EPS * 8);
      expect(vec.distance(f.b, B)).toBeLessThanOrEqual(64 * EPS * 8);
      expect(Math.abs(vec.dot(f.t, f.n))).toBeLessThanOrEqual(4 * EPS);
      expect(vec.distance(vec.cross(f.t, f.n), f.b)).toBeLessThanOrEqual(8 * EPS);
    }
    expect(curveFrame(line(O3, EX), 0.5)).toBeNull();
  });
});

describe('arc length', () => {
  it('is 2πr for full circles, clamped and periodic, at any radius', () => {
    for (const r of [0.001, 1, 300]) {
      for (const c of [circle(O3, EX, EY, r), periodicCircle(O3, EX, EY, r)]) {
        const L = curveLength(c);
        expect(L.converged).toBe(true);
        expect(Math.abs(L.value / (2 * Math.PI * r) - 1)).toBeLessThanOrEqual(LEN_REL);
        // The estimate the integrator stopped on is honest about its own target.
        expect(L.errorEstimate).toBeLessThanOrEqual(DEFAULT_TOLERANCES.quadRel * L.value);
      }
    }
  });

  it('is rθ for arcs and for partial ranges, signed for a reversed range', () => {
    const r = 3;
    for (const [a0, a1] of [
      [0, 1],
      [0.2, 3],
      [-2, 2.5],
      [0, 2 * Math.PI],
    ] as const) {
      const c = circleArc(O3, EX, EY, r, a0, a1);
      expect(Math.abs(curveLength(c).value / (r * (a1 - a0)) - 1)).toBeLessThanOrEqual(LEN_REL);
      const angle = (t: number): number => {
        const p = curvePoint(c, t);
        return Math.atan2(p.y, p.x);
      };
      for (const [t0, t1] of [
        [0.1, 0.3],
        [0.05, 0.95],
      ] as const) {
        let d = angle(t1) - angle(t0);
        if (d < 0) d += 2 * Math.PI;
        const L = curveLength(c, [t0, t1]).value;
        expect(Math.abs(L / (r * d) - 1)).toBeLessThanOrEqual(LEN_REL);
        expect(curveLength(c, [t1, t0]).value).toBe(-L);
      }
    }
  });

  it('spans several periods of a periodic curve', () => {
    const c = periodicCircle(O3, EX, EY, 2);
    const L = curveLength(c, [-0.25, 1.25]).value;
    expect(Math.abs(L / (1.5 * 4 * Math.PI) - 1)).toBeLessThanOrEqual(LEN_REL);
  });

  it('matches the parabola: ∫₀^X √(1+4x²) dx = X√(1+4X²)/2 + asinh(2X)/4', () => {
    for (const X of [0.5, 1, 3, 10]) {
      const c = bezierCurve(2, [0, 0, X / 2, 0, X, X * X]);
      const exact = (X * Math.sqrt(1 + 4 * X * X)) / 2 + Math.asinh(2 * X) / 4;
      expect(Math.abs(curveLength(c).value / exact - 1)).toBeLessThanOrEqual(LEN_REL);
    }
  });

  it('is exact on polylines (constant speed per span: GK is exact)', () => {
    const c = polyline([0, 0, 3, 4, 3, 10, -5, 10], 2);
    expect(Math.abs(curveLength(c).value - 19)).toBeLessThanOrEqual(19 * 8 * EPS);
  });

  it('honours the requested quadRel (error ≤ 10 · quadRel)', () => {
    const c = circleArc(O3, EX, EY, 1, 0, 3);
    for (const quadRel of [1e-4, 1e-7, 1e-10, 1e-13]) {
      const L = curveLength(c, undefined, { quadRel });
      expect(Math.abs(L.value / 3 - 1)).toBeLessThanOrEqual(10 * quadRel + 8 * EPS);
    }
  });

  it('rejects ranges outside a clamped domain', () => {
    const c = circleArc(O3, EX, EY, 1, 0, 1);
    expectCode(() => curveLength(c, [0, 1.5]), 'param-out-of-domain');
    expectCode(() => curveLength(c, [0, NaN]), 'non-finite');
  });
});

describe('arc-length table and its inverse', () => {
  const rng = mulberry32(17);
  const curves: NurbsCurve[] = [
    circleArc(O3, EX, EY, 5, 0, 4),
    periodicCircle({ x: 1, y: 1, z: 1 }, EX, EY, 0.5),
    randomCurve(rng, {
      dim: 3,
      degree: 3,
      count: 10,
      maxMult: 2,
      weightRange: [0.5, 2],
      domain: [2, 7],
    }),
    randomCurve(rng, { dim: 2, degree: 4, count: 9, kind: 'periodic', domain: [-1, 2] }),
    randomCurve(rng, { dim: 1, degree: 2, count: 6 }),
  ];

  it('totals the same bits as curveLength and starts and ends on the domain', () => {
    for (const c of curves) {
      const table = arcLengthTable(c);
      expect(table.total).toBe(curveLength(c).value);
      expect(table.t[0]).toBe(curveDomain(c)[0]);
      expect(table.t[table.t.length - 1]).toBe(curveDomain(c)[1]);
      expect(table.s[0]).toBe(0);
      for (let i = 1; i < table.s.length; i++)
        expect(table.s[i]!).toBeGreaterThanOrEqual(table.s[i - 1]!);
      for (const k of [0, Math.floor(table.t.length / 2)]) {
        expect(lengthAtParam(c, table, table.t[k]!)).toBe(table.s[k]);
      }
    }
  });

  it('lengthAtParam is the arc length on a circle (angle × r)', () => {
    const c = circleArc(O3, EX, EY, 5, 0, 4);
    const table = arcLengthTable(c);
    for (const t of samples(37)) {
      const p = curvePoint(c, t);
      let th = Math.atan2(p.y, p.x);
      if (th < -1e-12) th += 2 * Math.PI;
      if (t === 1) th = 4;
      expect(Math.abs(lengthAtParam(c, table, t) - 5 * th)).toBeLessThanOrEqual(
        LEN_REL * table.total,
      );
    }
  });

  it('paramAtLength inverts lengthAtParam to paramRel × domain', () => {
    for (const c of curves) {
      const table = arcLengthTable(c);
      const [a, b] = curveDomain(c);
      for (let i = 0; i < 40; i++) {
        const t = a + rng() * (b - a);
        const s = lengthAtParam(c, table, t);
        const back = paramAtLength(c, table, s);
        expect(Math.abs(back - t), `t ${t}`).toBeLessThanOrEqual(
          DEFAULT_TOLERANCES.paramRel * (b - a),
        );
      }
      expect(paramAtLength(c, table, 0)).toBe(a);
      if (c.basis.kind === 'clamped') expect(paramAtLength(c, table, table.total)).toBe(b);
    }
  });

  it('places points at equal arc length on a circle at equal angles', () => {
    const c = circle(O3, EX, EY, 2);
    const table = arcLengthTable(c);
    for (let k = 0; k < 12; k++) {
      const t = paramAtLength(c, table, (table.total * k) / 12);
      const p = curvePoint(c, t) as Point3;
      const expected = {
        x: 2 * Math.cos((2 * Math.PI * k) / 12),
        y: 2 * Math.sin((2 * Math.PI * k) / 12),
        z: 0,
      };
      expect(vec.distance(p, expected)).toBeLessThanOrEqual(LEN_REL * table.total * 4);
    }
  });

  it('wraps periodic lengths and parameters; rejects clamped ones outside the curve', () => {
    const c = curves[1]!;
    const table = arcLengthTable(c);
    expect(paramAtLength(c, table, table.total * 1.25)).toBeCloseTo(
      paramAtLength(c, table, table.total * 0.25),
      13,
    );
    expect(lengthAtParam(c, table, 1.5)).toBeCloseTo(lengthAtParam(c, table, 0.5), 13);
    const arc = curves[0]!;
    const at = arcLengthTable(arc);
    expectCode(() => paramAtLength(arc, at, at.total * 1.001), 'param-out-of-domain');
    expectCode(() => lengthAtParam(arc, at, 1.1), 'param-out-of-domain');
    expectCode(() => lengthAtParam(curves[2]!, at, 3), 'size-mismatch');
  });

  it('rejects a table built from another curve, even one with the same domain', () => {
    // Every primitive has domain [0, 1], so a domain check alone would accept the
    // unit circle's table for the radius-2 circle and return π (half of 2π) at
    // t = 0.5 instead of 2π. Identity is the only check that tells them apart.
    const O = { x: 0, y: 0 };
    const a = circle2(O, 1);
    const b = circle2(O, 2);
    const ta = arcLengthTable(a);
    const tb = arcLengthTable(b);
    expect(curveDomain(a)).toEqual(curveDomain(b));
    expect(ta.curve).toBe(a);
    expect(Math.abs(lengthAtParam(b, tb, 0.5) - 2 * Math.PI)).toBeLessThanOrEqual(
      LEN_REL * tb.total,
    );
    expectCode(() => lengthAtParam(b, ta, 0.5), 'size-mismatch');
    expectCode(() => paramAtLength(b, ta, 6), 'size-mismatch');
    // An equal copy is a different object: it needs its own table.
    const copy = reviveCurve(structuredClone(a));
    expectCode(() => lengthAtParam(copy, ta, 0.5), 'size-mismatch');
    expect(lengthAtParam(copy, arcLengthTable(copy), 0.5)).toBe(lengthAtParam(a, ta, 0.5));
    // A hand-made record that claims the curve but has the wrong breakpoints.
    expectCode(
      () => lengthAtParam(a, { ...ta, t: Float64Array.of(0, 0.5) }, 0.25),
      'size-mismatch',
    );
  });
});

describe('curveBounds', () => {
  it('bounds the control hull, hence the curve', () => {
    const rng = mulberry32(23);
    const c = randomCurve(rng, { dim: 3, degree: 3, count: 8, weightRange: [0.2, 5] });
    const box = curveBounds(c);
    for (const t of samples(200)) {
      const p = curvePoint(c, t) as Point3;
      // Convex hull property: a point is a convex combination of the control
      // points, so it lies in the box up to the rounding of that sum (4 ε · scale).
      for (const k of ['x', 'y', 'z'] as const) {
        const slack = 4 * EPS * Math.max(Math.abs(box.min[k]), Math.abs(box.max[k]));
        expect(p[k]).toBeGreaterThanOrEqual(box.min[k] - slack);
        expect(p[k]).toBeLessThanOrEqual(box.max[k] + slack);
      }
    }
    const flat = makeCurve({ dim: 2, basis: clampedBasis(1, [0, 0, 1, 1]), points: [1, 2, -3, 4] });
    expect(curveBounds(flat)).toEqual({ min: { x: -3, y: 2, z: 0 }, max: { x: 1, y: 4, z: 0 } });
  });
});
