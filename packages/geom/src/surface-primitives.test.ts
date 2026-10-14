// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Exact surface primitives (design §16, `surface` and `primitives` rows):
 * every primitive satisfies its implicit equation at every sampled point,
 * including poles, seams and knot lines, to rounding.
 *
 * - sphere: `|S − c| = r`; pole rows collapsed bitwise; periodic u, clamped v;
 * - torus: distance from the tube-centre circle `= r`; doubly periodic;
 * - cylinder: distance from the axis `= r`, axial coordinate `= v·h`;
 * - plane and bilinear patch: the affine / `z = xy` closed forms;
 * - revolve: a line about an axis is a cone with the right half-angle; partial
 *   turns end at the rotated profile; extrude: `C(u) + v·dir`.
 *
 * Tolerance `64 ε · scale` (design: ~10 flops and one division per coordinate;
 * a wrong weight errs by ≥ 1e-3 of the radius), scale = radius plus the
 * distance of the centre from the origin (the coordinates' magnitude).
 */
import { describe, expect, it } from 'vitest';
import {
  bezierSurface,
  bilinearPatch,
  circleArc,
  curvePoint,
  cylinder,
  extrude,
  isGeomError,
  line,
  makeCurve,
  clampedBasis,
  periodicCircle,
  planeSurface,
  revolve,
  sphere,
  surfaceControlPoint,
  surfaceDerivatives,
  surfaceNormal,
  surfacePoint,
  torus,
  vec,
} from './index';
import type { GeomErrorCode, Point3 } from './index';

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

/** Parameters on a grid that includes every knot of the primitives (quarters) and the ends. */
const GRID = Array.from({ length: 33 }, (_, i) => i / 32);

describe('sphere', () => {
  for (const [c, r] of [
    [{ x: 0, y: 0, z: 0 }, 1],
    [{ x: 10, y: -3, z: 4.5 }, 2.75],
    [{ x: -120, y: 30, z: 0 }, 60],
  ] as const) {
    it(`|S − c| = r everywhere, poles collapsed (c = ${JSON.stringify(c)}, r = ${r})`, () => {
      const s = sphere(c, r);
      expect(s.u.kind).toBe('periodic');
      expect(s.v.kind).toBe('clamped');
      expect(s.rational).toBe(true);
      const tol = 64 * EPS * (r + vec.norm(c));
      for (const u of GRID) {
        for (const v of GRID) {
          expect(Math.abs(vec.distance(surfacePoint(s, u, v), c) - r)).toBeLessThanOrEqual(tol);
        }
      }
      // The pole rows are collapsed: one point each (to the ulp of w·x/w).
      for (let i = 0; i < s.u.count; i++) {
        expect(
          vec.distance(surfaceControlPoint(s, i, 0), { ...c, z: c.z - r }),
        ).toBeLessThanOrEqual(4 * EPS * (r + vec.norm(c)));
        expect(
          vec.distance(surfaceControlPoint(s, i, 4), { ...c, z: c.z + r }),
        ).toBeLessThanOrEqual(4 * EPS * (r + vec.norm(c)));
      }
      expect(vec.distance(surfacePoint(s, 0.3, 0), { ...c, z: c.z - r })).toBeLessThanOrEqual(tol);
      expect(vec.distance(surfacePoint(s, 0.8, 1), { ...c, z: c.z + r })).toBeLessThanOrEqual(tol);
      // u = 0 starts on +x, a quarter turn later on +y; v = ½ is the equator.
      expect(vec.distance(surfacePoint(s, 0, 0.5), { ...c, x: c.x + r })).toBeLessThanOrEqual(tol);
      expect(vec.distance(surfacePoint(s, 0.25, 0.5), { ...c, y: c.y + r })).toBeLessThanOrEqual(
        tol,
      );
    });
  }
});

describe('torus', () => {
  for (const [c, axis, R, r] of [
    [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 3, 1],
    [{ x: 5, y: -2, z: 1 }, { x: 1, y: 2, z: 2 }, 10, 4],
  ] as const) {
    it(`lies at distance r from its tube-centre circle (R = ${R}, r = ${r})`, () => {
      const s = torus(c, axis, R, r);
      expect(s.u.kind).toBe('periodic');
      expect(s.v.kind).toBe('periodic');
      const a = vec.normalize(axis)!;
      const tol = 64 * EPS * (R + r + vec.norm(c));
      for (const u of GRID) {
        for (const v of GRID) {
          const d = vec.sub(surfacePoint(s, u, v), c);
          const h = vec.dot(d, a);
          const rho = vec.norm(vec.sub(d, vec.scale(a, h)));
          expect(Math.abs(Math.sqrt((rho - R) ** 2 + h * h) - r)).toBeLessThanOrEqual(tol);
        }
      }
      // v = 0 is the outer equator; a quarter of the tube later the top.
      const p0 = vec.sub(surfacePoint(s, 0, 0), c);
      expect(Math.abs(vec.norm(p0) - (R + r))).toBeLessThanOrEqual(tol);
      expect(Math.abs(vec.dot(vec.sub(surfacePoint(s, 0, 0.25), c), a) - r)).toBeLessThanOrEqual(
        tol,
      );
    });
  }

  it('rejects R ≤ r and bad radii', () => {
    expectCode(() => torus({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 1, 1), 'unsupported');
    expectCode(() => torus({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 2, -1), 'unsupported');
    expectCode(() => torus({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 2, 1), 'dimension-mismatch');
  });
});

describe('cylinder, plane and bilinear patch', () => {
  it('cylinder: radius r about the axis, axial coordinate v·h, periodic u', () => {
    const base = { x: 1, y: 2, z: -3 };
    const axis = { x: 0.3, y: -1, z: 2 };
    const a = vec.normalize(axis)!;
    const s = cylinder(base, axis, 2.5, 8);
    expect(s.u.kind).toBe('periodic');
    const tol = 64 * EPS * (2.5 + 8 + vec.norm(base));
    for (const u of GRID) {
      for (const v of GRID) {
        const d = vec.sub(surfacePoint(s, u, v), base);
        const h = vec.dot(d, a);
        expect(Math.abs(h - 8 * v)).toBeLessThanOrEqual(tol);
        expect(Math.abs(vec.norm(vec.sub(d, vec.scale(a, h))) - 2.5)).toBeLessThanOrEqual(tol);
      }
    }
    expectCode(() => cylinder(base, axis, 1, 0), 'unsupported');
  });

  it('plane: origin + u·uAxis + v·vAxis over its domain', () => {
    const o = { x: 1, y: -2, z: 0.5 };
    const uA = { x: 0.5, y: 0.25, z: -1 };
    const vA = { x: 2, y: 0, z: 1 };
    const s = planeSurface(o, uA, vA, { u: [-2, 3], v: [1, 1.5] });
    expect(s.u.domain).toEqual([-2, 3]);
    for (let k = 0; k <= 20; k++) {
      const u = -2 + (5 * k) / 20;
      const v = 1 + (0.5 * ((k * 7) % 20)) / 20;
      const want = vec.add(o, vec.add(vec.scale(uA, u), vec.scale(vA, v)));
      expect(vec.distance(surfacePoint(s, u, v), want)).toBeLessThanOrEqual(64 * EPS * 10);
    }
    expectCode(() => planeSurface(o, uA, vec.scale(uA, 3)), 'dimension-mismatch');
    expectCode(() => planeSurface(o, uA, vA, { u: [1, 1], v: [0, 1] }), 'empty-domain');
  });

  it('bilinear patch through (0,0,0), (1,0,0), (0,1,0), (1,1,1) is z = xy', () => {
    const s = bilinearPatch(
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 1, y: 1, z: 1 },
    );
    for (const u of GRID) {
      for (const v of GRID) {
        expect(vec.distance(surfacePoint(s, u, v), { x: u, y: v, z: u * v })).toBeLessThanOrEqual(
          4 * EPS,
        );
      }
    }
  });

  it('bezierSurface has degree count − 1 per direction on [0, 1]²', () => {
    const s = bezierSurface(new Array(4 * 3 * 3).fill(0), 4, 3);
    expect([s.u.degree, s.v.degree, s.u.domain, s.v.domain]).toEqual([3, 2, [0, 1], [0, 1]]);
    expectCode(() => bezierSurface([0, 0, 0], 1, 1), 'too-few-points');
  });
});

describe('revolve (A8.1) and extrude', () => {
  it('a line about an axis is a cone with the right half-angle; n points away from the axis', () => {
    // From (1, 0, 0) to (2, 0, 1) about z: radius 1 + z, half-angle 45°.
    const s = revolve(
      line({ x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 1 }),
      { x: 0, y: 0, z: 0 },
      {
        x: 0,
        y: 0,
        z: 1,
      },
    );
    expect(s.u.kind).toBe('periodic');
    for (const u of GRID) {
      for (const v of GRID) {
        const p = surfacePoint(s, u, v);
        expect(Math.abs(Math.sqrt(p.x * p.x + p.y * p.y) - (1 + p.z))).toBeLessThanOrEqual(
          64 * EPS * 2,
        );
        const d = surfaceDerivatives(s, u, v, 1);
        expect(
          Math.abs(vec.angleBetween(d.Sv, { x: 0, y: 0, z: 1 }) - Math.PI / 4),
        ).toBeLessThanOrEqual(1e-13);
        const n = surfaceNormal(s, u, v);
        if (n.kind !== 'regular') throw new Error('cone normal degenerate');
        // Outward and downward: 135° from the axis, horizontal part along the radius.
        expect(
          Math.abs(vec.angleBetween(n.n, { x: 0, y: 0, z: 1 }) - (3 * Math.PI) / 4),
        ).toBeLessThanOrEqual(1e-13);
        expect(n.n.x * p.x + n.n.y * p.y).toBeGreaterThan(0);
      }
    }
  });

  it('partial turns are clamped and end on the profile rotated by the angle', () => {
    const profile = circleArc(
      { x: 3, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 },
      1,
      -1,
      2,
    );
    const axisO = { x: 0, y: 0, z: 0 };
    const axis = { x: 0, y: 0, z: 1 };
    for (const angle of [0.3, Math.PI / 2, 2, Math.PI, 4.5, 2 * Math.PI - 0.1]) {
      const s = revolve(profile, axisO, axis, angle);
      expect(s.u.kind).toBe('clamped');
      expect(s.v).toBe(profile.basis);
      for (const v of GRID) {
        const P = curvePoint(profile, v);
        const rot = (t: number): Point3 => ({
          x: P.x * Math.cos(t) - P.y * Math.sin(t),
          y: P.x * Math.sin(t) + P.y * Math.cos(t),
          z: P.z,
        });
        expect(vec.distance(surfacePoint(s, 0, v), P)).toBeLessThanOrEqual(64 * EPS * 5);
        expect(vec.distance(surfacePoint(s, 1, v), rot(angle))).toBeLessThanOrEqual(64 * EPS * 5);
        // Every point keeps its distance from the axis and its height.
        for (const u of [0.1, 0.5, 0.77]) {
          const q = surfacePoint(s, u, v);
          expect(Math.abs(Math.hypot(q.x, q.y) - Math.hypot(P.x, P.y))).toBeLessThanOrEqual(
            64 * EPS * 5,
          );
          expect(Math.abs(q.z - P.z)).toBeLessThanOrEqual(64 * EPS * 5);
        }
      }
    }
    expect(revolve(profile, axisO, axis, 2 * Math.PI).u.kind).toBe('periodic');
    expectCode(() => revolve(profile, axisO, axis, 0), 'empty-domain');
    expectCode(() => revolve(profile, axisO, axis, 7), 'param-out-of-domain');
    expectCode(() => revolve(profile, axisO, { x: 0, y: 0, z: 0 }), 'dimension-mismatch');
  });

  it('a periodic profile gives a periodic v; an on-axis control point collapses its row', () => {
    const tube = periodicCircle(
      { x: 4, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 },
      1,
    );
    const s = revolve(tube, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    expect(s.v).toBe(tube.basis);
    const fan = revolve(
      makeCurve({ dim: 3, basis: clampedBasis(1, [0, 0, 1, 1]), points: [0, 0, 1, 2, 0, 0] }),
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 },
    );
    for (let i = 0; i < fan.u.count; i++) {
      expect(surfaceControlPoint(fan, i, 0)).toEqual({ x: 0, y: 0, z: 1 });
    }
  });

  it('extrude is C(u) + v·dir with the curve’s basis', () => {
    const c = circleArc(
      { x: 1, y: 1, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      2,
      0,
      2.5,
    );
    const dir = { x: 0.5, y: -1, z: 3 };
    const s = extrude(c, dir);
    expect(s.u).toBe(c.basis);
    for (const u of GRID) {
      for (const v of GRID) {
        const want = vec.add(curvePoint(c, u), vec.scale(dir, v));
        expect(vec.distance(surfacePoint(s, u, v), want)).toBeLessThanOrEqual(64 * EPS * 6);
      }
    }
    expectCode(() => extrude(c, { x: 0, y: 0, z: 0 }), 'dimension-mismatch');
  });
});
