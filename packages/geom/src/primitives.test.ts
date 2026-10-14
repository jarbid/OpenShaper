// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Primitive oracles (design §16, `primitives` row): exactness of lines,
 * polylines and circles; the A7.1 segment count and knot vector; the conic
 * segment against its exact implicit equation for every ρ (ellipse, parabola,
 * hyperbola) and ρ's defining property (the shoulder point divides the chord
 * midpoint–apex segment in ratio ρ).
 *
 * Tolerance `64 ε · scale` (design §16): ~10 flops and one division per
 * coordinate; `scale` is the largest coordinate magnitude involved.
 */
import { describe, expect, it } from 'vitest';
import {
  circle,
  circle2,
  circleArc,
  conicArc,
  controlPoint,
  controlWeight,
  curveDerivatives,
  curvePoint,
  isClosed,
  isGeomError,
  line,
  line2,
  periodicCircle,
  polyline,
  vec,
} from './index';
import type { GeomErrorCode, Point3 } from './index';

const EPS = Number.EPSILON;
const O = { x: 0, y: 0, z: 0 };
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

describe('lines and polylines', () => {
  it('line runs from a to b linearly on [0, 1]', () => {
    const a = { x: 1, y: -2, z: 3 };
    const b = { x: 5, y: 2, z: -1 };
    const l = line(a, b);
    expect(l.basis.degree).toBe(1);
    expect(l.rational).toBe(false);
    expect(curvePoint(l, 0)).toEqual(a);
    expect(curvePoint(l, 1)).toEqual(b);
    expect(curvePoint(l, 0.25)).toEqual({ x: 2, y: -1, z: 2 });
    expect(curveDerivatives(l, 0.7, 2)[1]).toEqual({ x: 4, y: 4, z: -4 });
    expect(curvePoint(line2({ x: 0, y: 0 }, { x: 2, y: 4 }), 0.5)).toEqual({ x: 1, y: 2 });
  });

  it('polyline passes through its vertices at t = i/m and can close', () => {
    const pts = [0, 0, 0, 1, 0, 0, 1, 2, 0, 0, 2, 1];
    const p = polyline(pts, 3);
    for (let i = 0; i < 4; i++) {
      expect(curvePoint(p, i / 3)).toEqual({ x: pts[3 * i], y: pts[3 * i + 1], z: pts[3 * i + 2] });
    }
    const closed = polyline(pts, 3, true);
    expect(isClosed(closed)).toBe(true);
    expect(curvePoint(closed, 1)).toEqual({ x: 0, y: 0, z: 0 });
    expectCode(() => polyline([0, 0], 2), 'too-few-points');
    expectCode(() => polyline([0, 0, 1, 1], 2, true), 'too-few-points');
    expectCode(() => polyline([0, 0, 1], 2), 'size-mismatch');
  });
});

describe('circles and arcs (P&T A7.1)', () => {
  it('splits arcs into 1–4 segments of sweep ≤ π/2 with double interior knots', () => {
    const cases: [number, number[]][] = [
      [Math.PI / 2, [0, 0, 0, 1, 1, 1]],
      [Math.PI, [0, 0, 0, 0.5, 0.5, 1, 1, 1]],
      [1.5 * Math.PI, [0, 0, 0, 1 / 3, 1 / 3, 2 / 3, 2 / 3, 1, 1, 1]],
      [2 * Math.PI, [0, 0, 0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1, 1, 1]],
    ];
    for (const [sweep, knots] of cases) {
      const c = circleArc(O, EX, EY, 1, 0, sweep);
      expect(Array.from(c.basis.knots)).toEqual(knots);
      expect(controlWeight(c, 1)).toBe(Math.cos(sweep / (knots.length - 4)));
    }
    expect(circleArc(O, EX, EY, 1, 0, Math.PI / 2 + 1e-9).basis.count).toBe(5);
  });

  it('starts and ends at the requested angles, on the circle, in any frame', () => {
    const C = { x: 10, y: -20, z: 5 };
    const X = { x: 0, y: 3, z: 0 }; // not unit: normalised
    const Y = { x: 1, y: 1, z: 1 }; // not perpendicular: Gram–Schmidt
    const r = 7;
    const scale = vec.norm(C) + r;
    const Xn = { x: 0, y: 1, z: 0 };
    const Yn = vec.normalize({ x: 1, y: 0, z: 1 })!;
    for (const [a0, a1] of [
      [0, Math.PI / 2], // the quarter circle: one rational quadratic segment
      [0, 1],
      [-3, 0.5],
      [1, 1 + 2 * Math.PI],
    ] as const) {
      const c = circleArc(C, X, Y, r, a0, a1);
      const at = (a: number): Point3 =>
        vec.add(C, vec.add(vec.scale(Xn, r * Math.cos(a)), vec.scale(Yn, r * Math.sin(a))));
      expect(vec.distance(curvePoint(c, 0), at(a0))).toBeLessThanOrEqual(64 * EPS * scale);
      expect(vec.distance(curvePoint(c, 1), at(a1))).toBeLessThanOrEqual(64 * EPS * scale);
      for (let s = 0; s <= 100; s++) {
        const p = curvePoint(c, s / 100);
        expect(Math.abs(vec.distance(p, C) - r)).toBeLessThanOrEqual(64 * EPS * scale);
        // In the plane spanned by the axes.
        expect(Math.abs(vec.dot(vec.sub(p, C), vec.cross(Xn, Yn)))).toBeLessThanOrEqual(
          64 * EPS * scale,
        );
      }
    }
  });

  it('the 9-point circle has exact square control points and corner weights √2/2', () => {
    const c = circle({ x: 1, y: 2, z: 3 }, EX, EY, 2);
    expect(controlPoint(c, 0)).toEqual({ x: 3, y: 2, z: 3 });
    expect(controlPoint(c, 1)).toEqual({ x: 3, y: 4, z: 3 });
    expect(controlWeight(c, 1)).toBe(Math.SQRT1_2);
    expect(controlWeight(c, 2)).toBe(1);
    expect(curvePoint(c, 0)).toEqual({ x: 3, y: 2, z: 3 });
    expect(curvePoint(c, 1)).toEqual({ x: 3, y: 2, z: 3 });
    for (const [t, p] of [
      [0.25, { x: 1, y: 4, z: 3 }],
      [0.5, { x: -1, y: 2, z: 3 }],
      [0.75, { x: 1, y: 0, z: 3 }],
    ] as const) {
      expect(vec.distance(curvePoint(c, t), p)).toBeLessThanOrEqual(64 * EPS * 4);
    }
  });

  it('the periodic circle starts at center + r·X and passes the axis points at quarters', () => {
    const c = periodicCircle(O, EX, EY, 1);
    expect(c.basis.kind).toBe('periodic');
    expect(c.basis.count).toBe(8);
    expect(curvePoint(c, 0)).toEqual({ x: 1, y: 0, z: 0 });
    expect(controlPoint(c, 7)).toEqual({ x: 1, y: 0, z: 0 });
    for (const [t, p] of [
      [0.25, { x: 0, y: 1, z: 0 }],
      [0.5, { x: -1, y: 0, z: 0 }],
      [0.75, { x: 0, y: -1, z: 0 }],
    ] as const) {
      expect(vec.distance(curvePoint(c, t), p)).toBeLessThanOrEqual(64 * EPS);
    }
    // G1 and in fact C1 at the seam (equal-sweep quarters on equal knot spans).
    const [, dl] = curveDerivatives(c, 0, 1, 'left');
    const [, dr] = curveDerivatives(c, 0, 1, 'right');
    expect(vec.distance(dl!, dr!)).toBeLessThanOrEqual(64 * EPS * vec.norm(dr!));
  });

  it('circle2 turns counter-clockwise; arcs follow the given angles', () => {
    const c = circle2({ x: 1, y: 1 }, 2);
    expect(curvePoint(c, 0.25)).toEqual({ x: 1, y: 3 });
    const a = circle2({ x: 0, y: 0 }, 1, [Math.PI / 2, Math.PI]);
    const p = curvePoint(a, 1);
    expect(Math.abs(p.x + 1) + Math.abs(p.y)).toBeLessThanOrEqual(64 * EPS);
  });

  it('rejects invalid radii, sweeps and frames', () => {
    expectCode(() => circle(O, EX, EY, 0), 'unsupported');
    expectCode(() => circle(O, EX, EY, NaN), 'non-finite');
    expectCode(() => circleArc(O, EX, EY, 1, 1, 1), 'empty-domain');
    expectCode(() => circleArc(O, EX, EY, 1, 0, 7), 'param-out-of-domain');
    expectCode(() => circle(O, EX, { x: 2, y: 0, z: 0 }, 1), 'dimension-mismatch');
    expectCode(() => circle(O, O, EY, 1), 'dimension-mismatch');
    expectCode(() => periodicCircle({ x: NaN, y: 0, z: 0 }, EX, EY, 1), 'non-finite');
  });
});

describe('conicArc', () => {
  // Symmetric conic: p0 = (−1, 0), apex = (0, 1), p2 = (1, 0). Tangency at p0, p2 towards
  // the apex and the shoulder point (0, ρ) fix the implicit form
  // x² + k y² + 2y − 1 = 0 with k = (1 − 2ρ)/ρ²: an ellipse for ρ < ½ (k > 0), a
  // parabola at ρ = ½ (k = 0), a hyperbola for ρ > ½ (k < 0); a circle when k = 1,
  // i.e. ρ = √2 − 1.
  const p0 = { x: -1, y: 0, z: 0 };
  const apex = { x: 0, y: 1, z: 0 };
  const p2 = { x: 1, y: 0, z: 0 };

  it('satisfies its implicit equation for every ρ', () => {
    for (const rho of [0.1, 0.3, Math.SQRT2 - 1, 0.5, 0.6, 0.9]) {
      const c = conicArc(p0, apex, p2, rho);
      const k = (1 - 2 * rho) / (rho * rho);
      for (let s = 0; s <= 100; s++) {
        const { x, y } = curvePoint(c, s / 100);
        // Terms are O(max(1, |k|)); 64 ε of that.
        expect(Math.abs(x * x + k * y * y + 2 * y - 1), `ρ ${rho}`).toBeLessThanOrEqual(
          64 * EPS * Math.max(1, Math.abs(k)),
        );
      }
    }
  });

  it('puts the shoulder point at M + ρ(apex − M) and is a parabola at ρ = ½', () => {
    for (const rho of [0.2, 0.5, 0.75]) {
      const c = conicArc({ x: 1, y: 2, z: 3 }, { x: 4, y: 6, z: 3 }, { x: 7, y: 2, z: 1 }, rho);
      const M = { x: 4, y: 2, z: 2 };
      const S = vec.add(M, vec.scale(vec.sub({ x: 4, y: 6, z: 3 }, M), rho));
      expect(vec.distance(curvePoint(c, 0.5), S)).toBeLessThanOrEqual(64 * EPS * 8);
    }
    const par = conicArc(p0, apex, p2, 0.5);
    expect(par.rational).toBe(false);
    expect(curvePoint(par, 0.25)).toEqual({ x: -0.5, y: 0.375, z: 0 });
  });

  it('with ρ = √2 − 1 is the quarter circle about (0, −1) of radius √2', () => {
    const c = conicArc(p0, apex, p2, Math.SQRT2 - 1);
    for (let s = 0; s <= 50; s++) {
      const p = curvePoint(c, s / 50);
      expect(Math.abs(vec.distance(p, { x: 0, y: -1, z: 0 }) - Math.SQRT2)).toBeLessThanOrEqual(
        64 * EPS * 2,
      );
    }
  });

  it('rejects ρ outside (0, 1)', () => {
    expectCode(() => conicArc(p0, apex, p2, 0), 'weight-not-positive');
    expectCode(() => conicArc(p0, apex, p2, 1), 'weight-not-positive');
    expectCode(() => conicArc(p0, apex, p2, NaN), 'non-finite');
  });
});
