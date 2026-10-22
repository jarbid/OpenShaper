// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Second derivatives and principal curvatures, against oracles that do not depend
 * on the code under test.
 *
 *  1. **Exact polynomials.** A cubic B-spline reproduces any polynomial of degree
 *     three or less in each parameter exactly, and its control net can be written
 *     down in closed form from the polynomial's blossom (polar form) — no fitting,
 *     no tolerance. With x = u and y = v the surface is the graph z = f(x, y), whose
 *     curvatures have textbook closed forms. So every number checked here is known
 *     to rounding.
 *  2. **Finite differences on a fitted surface** — a real interpolated net with
 *     uneven knots and creases, where nothing is known in closed form but the
 *     first derivatives are independently implemented and can be differenced.
 *  3. **Orientation** on the fitted board: which way the normal points on each
 *     hull patch, and that the two mirrored halves report the same curvature.
 */
import { describe, expect, it } from 'vitest';
import { HULL_ORIENTATION, fitBoardSurface } from './board-surface';
import {
  evalSurfaceDeriv,
  evalSurfaceDeriv2,
  interpolateSurface,
  principalCurvatures,
  type BSplineSurface,
  type KnotSide,
} from './bspline-surface';
import type { Vert3 } from './loft';
import { curvyBoard } from './test-support/synthetic-boards';

// --- exact polynomial surfaces from their blossoms ---

/**
 * Blossom of the monomial t^a for degree 3: the symmetric multi-affine function
 * that agrees with t^a on the diagonal. Control point i of a clamped cubic with
 * knots U is the blossom at (U[i+1], U[i+2], U[i+3]) (de Boor / Ramshaw).
 */
const monomialBlossom = (a: number, t: readonly [number, number, number]): number => {
  const [t1, t2, t3] = t;
  switch (a) {
    case 0:
      return 1;
    case 1:
      return (t1 + t2 + t3) / 3;
    case 2:
      return (t1 * t2 + t1 * t3 + t2 * t3) / 3;
    case 3:
      return t1 * t2 * t3;
    default:
      throw new Error('degree 3 only');
  }
};

/** z = Σ c[a][b] u^a v^b, as a coefficient table indexed [power of u][power of v]. */
type Poly = readonly (readonly number[])[];

const polyEval = (c: Poly, u: number, v: number) => {
  let f = 0;
  let fu = 0;
  let fv = 0;
  let fuu = 0;
  let fuv = 0;
  let fvv = 0;
  c.forEach((row, a) =>
    row.forEach((k, b) => {
      if (k === 0) return;
      const ua = u ** a;
      const vb = v ** b;
      f += k * ua * vb;
      if (a >= 1) fu += k * a * u ** (a - 1) * vb;
      if (b >= 1) fv += k * b * ua * v ** (b - 1);
      if (a >= 2) fuu += k * a * (a - 1) * u ** (a - 2) * vb;
      if (a >= 1 && b >= 1) fuv += k * a * b * u ** (a - 1) * v ** (b - 1);
      if (b >= 2) fvv += k * b * (b - 1) * ua * v ** (b - 2);
    }),
  );
  return { f, fu, fv, fuu, fuv, fvv };
};

const blossomAt = (U: readonly number[], i: number): [number, number, number] => [
  U[i + 1]!,
  U[i + 2]!,
  U[i + 3]!,
];

/**
 * The cubic B-spline surface (x, y, z) = (u, v, f(u, v)) over the given clamped
 * knot vectors — exact, for any knots, interior multiplicities included.
 *
 * `pieces` lets the u direction change polynomial at given knots (each entry
 * covers u-control indices up to and including `upTo`): a triple knot between two
 * pieces that agree in value there is exactly a C0 crease.
 */
const polySurface = (
  uKnots: readonly number[],
  vKnots: readonly number[],
  pieces: readonly { poly: Poly; upTo: number }[],
): BSplineSurface => {
  const nu = uKnots.length - 4;
  const nv = vKnots.length - 4;
  const ctrl: Vert3[][] = [];
  for (let i = 0; i < nu; i++) {
    const poly = pieces.find((p) => i <= p.upTo)!.poly;
    const bu = blossomAt(uKnots, i);
    const row: Vert3[] = [];
    for (let j = 0; j < nv; j++) {
      const bv = blossomAt(vKnots, j);
      let z = 0;
      poly.forEach((r, a) =>
        r.forEach((k, b) => {
          z += k * monomialBlossom(a, bu) * monomialBlossom(b, bv);
        }),
      );
      row.push({ x: monomialBlossom(1, bu), y: monomialBlossom(1, bv), z });
    }
    ctrl.push(row);
  }
  return { uDegree: 3, vDegree: 3, ctrl, uKnots, vKnots };
};

const BEZIER = [0, 0, 0, 0, 1, 1, 1, 1];

/**
 * Curvature of the graph z = f(x, y), against the upward normal (-f_x, -f_y, 1)/W,
 * in this module's convention (positive = bending away from the normal).
 */
const graphCurvature = (d: ReturnType<typeof polyEval>) => {
  const W2 = 1 + d.fu * d.fu + d.fv * d.fv;
  const W = Math.sqrt(W2);
  const gaussian = (d.fuu * d.fvv - d.fuv * d.fuv) / (W2 * W2);
  const mean =
    -((1 + d.fv * d.fv) * d.fuu - 2 * d.fu * d.fv * d.fuv + (1 + d.fu * d.fu) * d.fvv) /
    (2 * W2 * W);
  return { gaussian, mean };
};

const close = (got: number, want: number, rel = 1e-9) =>
  expect(Math.abs(got - want)).toBeLessThanOrEqual(rel * Math.max(1, Math.abs(want)));

describe('evalSurfaceDeriv2 — exact on polynomials', () => {
  // Interior knots of every multiplicity a cubic can carry, unevenly spaced.
  const U = [0, 0, 0, 0, 0.2, 0.45, 0.45, 0.7, 0.7, 0.7, 1, 1, 1, 1];
  const V = [0, 0, 0, 0, 0.3, 0.55, 1, 1, 1, 1];
  // A generic bicubic with every cross term: nothing here is special to a knot.
  const poly: Poly = [
    [0.3, -0.4, 0.25, 0.1],
    [0.5, 0.2, -0.3, 0.05],
    [-0.7, 0.15, 0.4, -0.2],
    [0.35, -0.25, 0.1, 0.3],
  ];
  const s = polySurface(U, V, [{ poly, upTo: Infinity }]);

  it('matches the polynomial and its derivatives everywhere, knots included', () => {
    const us = [0, 0.1, 0.2, 0.33, 0.45, 0.6, 0.7, 0.85, 1];
    const vs = [0, 0.17, 0.3, 0.55, 0.8, 1];
    for (const u of us) {
      for (const v of vs) {
        for (const uSide of ['below', 'above'] as KnotSide[]) {
          const d = evalSurfaceDeriv2(s, u, v, { uSide });
          const p = polyEval(poly, u, v);
          close(d.point.x, u);
          close(d.point.y, v);
          close(d.point.z, p.f);
          close(d.du.z, p.fu);
          close(d.dv.z, p.fv);
          close(d.duu.z, p.fuu);
          close(d.duv.z, p.fuv);
          close(d.dvv.z, p.fvv);
          // x = u, y = v: the planar components are the identity's derivatives.
          close(d.du.x, 1);
          close(d.dv.y, 1);
          for (const k of [d.duu, d.duv, d.dvv]) {
            close(k.x, 0);
            close(k.y, 0);
          }
        }
      }
    }
  });

  it('agrees with evalSurfaceDeriv on the point and first derivatives', () => {
    for (const [u, v] of [
      [0.13, 0.62],
      [0.5, 0.05],
      [0.91, 0.4],
    ] as const) {
      const a = evalSurfaceDeriv(s, u, v);
      const b = evalSurfaceDeriv2(s, u, v);
      for (const k of ['x', 'y', 'z'] as const) {
        close(b.point[k], a.point[k], 1e-12);
        close(b.du[k], a.du[k], 1e-12);
        close(b.dv[k], a.dv[k], 1e-12);
      }
    }
  });

  it('reports zero second derivative along a direction of degree one', () => {
    // A two-column net is linear in v: S_vv must be exactly zero, not garbage.
    const lin: BSplineSurface = {
      uDegree: 3,
      vDegree: 1,
      uKnots: BEZIER,
      vKnots: [0, 0, 1, 1],
      ctrl: [0, 1, 2, 3].map((i) => [
        { x: i, y: 0, z: i * i },
        { x: i, y: 1, z: i * i },
      ]),
    };
    const d = evalSurfaceDeriv2(lin, 0.4, 0.7);
    expect([d.dvv.x, d.dvv.y, d.dvv.z]).toEqual([0, 0, 0]);
    expect(d.duu.z).not.toBe(0);
  });
});

describe('principalCurvatures — closed-form cases', () => {
  it('z = a·x² has curvature 2a across the vertex and 0 along it', () => {
    const a = 0.8;
    // z = a (u - 1/2)²: vertex line at u = 1/2.
    const s = polySurface(BEZIER, BEZIER, [{ poly: [[a / 4], [-a], [a]], upTo: Infinity }]);
    for (const v of [0, 0.3, 1]) {
      // The upward normal looks into the cup: the surface bends toward it.
      const up = principalCurvatures(s, 0.5, v)!;
      close(up.k1, 0);
      close(up.k2, -2 * a);
      close(up.mean, -a);
      close(up.gaussian, 0);
      close(up.normal.z, 1);
      // From below the same cup is convex.
      const down = principalCurvatures(s, 0.5, v, { orientation: -1 })!;
      close(down.k1, 2 * a);
      close(down.k2, 0);
      close(down.mean, a);
      close(down.normal.z, -1);
    }
  });

  it('a paraboloid of vertex radius R reads as a sphere of radius R at the vertex', () => {
    const R = 7.5;
    // z = ((u - 1/2)² + (v - 1/2)²) / 2R
    const c = 1 / (2 * R);
    const s = polySurface(BEZIER, BEZIER, [
      {
        poly: [
          [c / 2, -c, c],
          [-c, 0, 0],
          [c, 0, 0],
        ],
        upTo: Infinity,
      },
    ]);
    const k = principalCurvatures(s, 0.5, 0.5, { orientation: -1 })!;
    close(k.k1, 1 / R);
    close(k.k2, 1 / R);
    close(k.mean, 1 / R);
    close(k.gaussian, 1 / (R * R));
  });

  it('a saddle has negative Gaussian curvature, whichever way the normal points', () => {
    const a = 0.6;
    const b = 1.4;
    // z = a (u - 1/2)² - b (v - 1/2)²
    const s = polySurface(BEZIER, BEZIER, [
      {
        poly: [
          [(a - b) / 4, b, -b],
          [-a, 0, 0],
          [a, 0, 0],
        ],
        upTo: Infinity,
      },
    ]);
    for (const orientation of [1, -1] as const) {
      const k = principalCurvatures(s, 0.5, 0.5, { orientation })!;
      close(k.gaussian, -4 * a * b);
      expect(k.k1).toBeGreaterThan(0);
      expect(k.k2).toBeLessThan(0);
      close(k.mean, -orientation * (a - b));
    }
  });

  it('matches the graph formulas at arbitrary points of a generic multi-span surface', () => {
    const U = [0, 0, 0, 0, 0.25, 0.5, 0.5, 0.75, 1, 1, 1, 1];
    const V = [0, 0, 0, 0, 0.4, 1, 1, 1, 1];
    const poly: Poly = [
      [0, 0.2, -0.5, 0.3],
      [0.4, -0.6, 0.2, 0],
      [-0.9, 0.3, 0, 0.2],
      [0.5, 0, -0.4, 0.1],
    ];
    const s = polySurface(U, V, [{ poly, upTo: Infinity }]);
    for (let i = 0; i <= 12; i++) {
      for (let j = 0; j <= 9; j++) {
        const u = i / 12;
        const v = j / 9;
        const k = principalCurvatures(s, u, v)!;
        const want = graphCurvature(polyEval(poly, u, v));
        close(k.gaussian, want.gaussian);
        close(k.mean, want.mean);
        close(k.k1 + k.k2, 2 * want.mean);
        close(k.k1 * k.k2, want.gaussian, 1e-8);
        expect(k.k1).toBeGreaterThanOrEqual(k.k2);
      }
    }
  });
});

describe('one-sided limits at a crease', () => {
  // Two different polynomials meeting in value (not slope) at a triple knot u = k:
  // left  z = a (u - k)² + g(v),  right z = b (u - k)² + c (u - k) + g(v).
  const k = 0.4;
  const a = 1.5;
  const b = -0.7;
  const c = 0.9;
  const g = [0.1, -0.2, 0.6]; // g(v) = 0.1 - 0.2 v + 0.6 v²
  const leftPoly: Poly = [[g[0]! + a * k * k, g[1]!, g[2]!], [-2 * a * k], [a]];
  const rightPoly: Poly = [[g[0]! + b * k * k - c * k, g[1]!, g[2]!], [-2 * b * k + c], [b]];
  const U = [0, 0, 0, 0, k, k, k, 1, 1, 1, 1];
  // Control points 0..3 belong to the left span (3 is shared), 4..6 to the right.
  const s = polySurface(U, BEZIER, [
    { poly: leftPoly, upTo: 3 },
    { poly: rightPoly, upTo: Infinity },
  ]);

  it('builds a genuine C0 crease (the shared control point agrees)', () => {
    const fromLeft = polyEval(leftPoly, k, 0.3);
    const fromRight = polyEval(rightPoly, k, 0.3);
    close(fromLeft.f, fromRight.f);
    expect(Math.abs(fromLeft.fu - fromRight.fu)).toBeGreaterThan(0.5);
  });

  it('answers from the span below or above as asked', () => {
    for (const v of [0, 0.35, 1]) {
      const below = principalCurvatures(s, k, v, { uSide: 'below' })!;
      const above = principalCurvatures(s, k, v, { uSide: 'above' })!;
      const fallback = principalCurvatures(s, k, v)!;
      const wantBelow = graphCurvature(polyEval(leftPoly, k, v));
      const wantAbove = graphCurvature(polyEval(rightPoly, k, v));
      close(below.mean, wantBelow.mean);
      close(below.gaussian, wantBelow.gaussian);
      close(above.mean, wantAbove.mean);
      close(above.gaussian, wantAbove.gaussian);
      expect(fallback).toEqual(above);
      // The two limits really are different numbers here.
      expect(Math.abs(below.mean - above.mean)).toBeGreaterThan(0.1);
    }
  });

  it('below and above agree off the knots and at the ends', () => {
    for (const u of [0, 0.2, 0.7, 1]) {
      const below = evalSurfaceDeriv2(s, u, 0.5, { uSide: 'below' });
      const above = evalSurfaceDeriv2(s, u, 0.5, { uSide: 'above' });
      close(below.duu.z, above.duu.z);
      close(below.du.z, above.du.z);
    }
  });
});

describe('second derivatives against finite differences on a fitted surface', () => {
  // A real interpolated net: centripetal v, chord u, creases, uneven knots.
  const rows = 14;
  const cols = 11;
  const grid: Vert3[][] = Array.from({ length: rows }, (_, r) => {
    const x = r * 9 + 0.6 * r * r;
    // Half-width bends differently in each strip, so the creases are real ones.
    const w =
      20 +
      (r <= 5
        ? 0.3 * r * r
        : r <= 9
          ? 7.5 + 3 * (r - 5) - 0.4 * (r - 5) ** 2
          : 13.1 + (r - 9) + 0.5 * (r - 9) ** 2);
    return Array.from({ length: cols }, (_, j) => {
      const t = (Math.PI * j) / (cols - 1);
      return { x, y: w * Math.sin(t), z: 3 + 0.02 * x + 4 * (1 - Math.cos(t)) + 0.3 * Math.sin(r) };
    });
  });
  const s = interpolateSurface(grid, { uBreaks: [5, 9] });
  const knotsU = new Set(s.uKnots);
  const knotsV = new Set(s.vKnots);
  const h = 1e-5;
  const nearKnot = (t: number, knots: Set<number>) =>
    [...knots].some((k) => Math.abs(k - t) < 4 * h);

  it('S_uu, S_uv, S_vv match centred differences of the first derivatives', () => {
    let checked = 0;
    for (let i = 1; i < 40; i++) {
      for (let j = 1; j < 25; j++) {
        const u = i / 40 + 0.0037;
        const v = j / 25 + 0.0021;
        if (u >= 1 - h || v >= 1 - h || nearKnot(u, knotsU) || nearKnot(v, knotsV)) continue;
        const d = evalSurfaceDeriv2(s, u, v);
        const up = evalSurfaceDeriv(s, u + h, v);
        const um = evalSurfaceDeriv(s, u - h, v);
        const vp = evalSurfaceDeriv(s, u, v + h);
        const vm = evalSurfaceDeriv(s, u, v - h);
        for (const c of ['x', 'y', 'z'] as const) {
          const scale = Math.max(1, Math.abs(d.duu[c]), Math.abs(d.dvv[c]), Math.abs(d.duv[c]));
          const tol = 1e-5 * scale;
          expect(Math.abs((up.du[c] - um.du[c]) / (2 * h) - d.duu[c])).toBeLessThan(tol);
          expect(Math.abs((vp.dv[c] - vm.dv[c]) / (2 * h) - d.dvv[c])).toBeLessThan(tol);
          // The mixed partial both ways round: they must agree with each other too.
          expect(Math.abs((up.dv[c] - um.dv[c]) / (2 * h) - d.duv[c])).toBeLessThan(tol);
          expect(Math.abs((vp.du[c] - vm.du[c]) / (2 * h) - d.duv[c])).toBeLessThan(tol);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  it('the second derivative jumps across a crease but not across a simple knot', () => {
    // Simple knots are C2: S_uu, and so the curvature, run straight through them.
    // A crease is C0: the two sides are different polynomials.
    const interior = [...new Set(s.uKnots)].filter((k) => k > 0 && k < 1);
    const mult = (k: number) => s.uKnots.filter((x) => x === k).length;
    const sides = (k: number, v: number) => [
      evalSurfaceDeriv2(s, k, v, { uSide: 'below' }),
      evalSurfaceDeriv2(s, k, v, { uSide: 'above' }),
    ];
    const duuJump = (k: number, v: number) => {
      const [b, a] = sides(k, v);
      const d = Math.hypot(b!.duu.x - a!.duu.x, b!.duu.y - a!.duu.y, b!.duu.z - a!.duu.z);
      return d / Math.max(1e-9, Math.hypot(a!.duu.x, a!.duu.y, a!.duu.z));
    };
    const meanJump = (k: number, v: number) => {
      const b = principalCurvatures(s, k, v, { uSide: 'below' })!;
      const a = principalCurvatures(s, k, v, { uSide: 'above' })!;
      return Math.abs(b.mean - a.mean) / Math.max(1e-9, Math.abs(a.mean));
    };
    const creases = interior.filter((k) => mult(k) === 3);
    const simple = interior.filter((k) => mult(k) === 1);
    expect(creases).toHaveLength(2);
    expect(simple.length).toBeGreaterThan(0);
    for (const v of [0.2, 0.5, 0.8]) {
      for (const k of simple) {
        expect(duuJump(k, v)).toBeLessThan(1e-8);
        expect(meanJump(k, v)).toBeLessThan(1e-8);
      }
      for (const k of creases) {
        expect(duuJump(k, v)).toBeGreaterThan(1e-2);
        expect(meanJump(k, v)).toBeGreaterThan(1e-4);
      }
    }
  });
});

describe('orientation on the fitted board hull', () => {
  const model = fitBoardSurface(curvyBoard(), { lengthRows: 24, ringCols: 20 });

  /** The ring parameter of the widest point at `u`: the rail apex. */
  const apexV = (s: BSplineSurface, u: number) => {
    let best = 0;
    let bestY = -Infinity;
    for (let j = 0; j <= 400; j++) {
      const y = Math.abs(evalSurfaceDeriv2(s, u, j / 400).point.y);
      if (y > bestY) {
        bestY = y;
        best = j / 400;
      }
    }
    return best;
  };

  it('HULL_ORIENTATION turns both patches outward', () => {
    for (const u of [0.3, 0.5, 0.7]) {
      const v = apexV(model.plus, u);
      const plus = principalCurvatures(model.plus, u, v, { orientation: HULL_ORIENTATION.plus })!;
      const minus = principalCurvatures(model.minus, u, v, {
        orientation: HULL_ORIENTATION.minus,
      })!;
      // At the apex the outward normal is lateral, away from the stringer.
      expect(plus.normal.y).toBeGreaterThan(0.9);
      expect(minus.normal.y).toBeLessThan(-0.9);
      // Bottom centre faces down, deck centre faces up — on both halves.
      for (const [s, o] of [
        [model.plus, HULL_ORIENTATION.plus],
        [model.minus, HULL_ORIENTATION.minus],
      ] as const) {
        expect(principalCurvatures(s, u, 0, { orientation: o })!.normal.z).toBeLessThan(-0.9);
        expect(principalCurvatures(s, u, 1, { orientation: o })!.normal.z).toBeGreaterThan(0.9);
      }
    }
  });

  it('outward signs read as a shaper would: the rail apex is convex', () => {
    for (const u of [0.3, 0.5, 0.7]) {
      const v = apexV(model.plus, u);
      const k = principalCurvatures(model.plus, u, v, { orientation: HULL_ORIENTATION.plus })!;
      expect(k.k1).toBeGreaterThan(0);
      expect(k.mean).toBeGreaterThan(0);
    }
  });

  it('the mirrored halves report identical curvature, and flipping the normal flips only the signed parts', () => {
    for (let i = 1; i < 10; i++) {
      for (let j = 0; j <= 10; j++) {
        const u = i / 10;
        const v = j / 10;
        const p = principalCurvatures(model.plus, u, v, { orientation: HULL_ORIENTATION.plus })!;
        const m = principalCurvatures(model.minus, u, v, {
          orientation: HULL_ORIENTATION.minus,
        })!;
        close(m.mean, p.mean);
        close(m.gaussian, p.gaussian);
        close(m.k1, p.k1);
        close(m.k2, p.k2);
        close(m.normal.y, -p.normal.y);

        const q = principalCurvatures(model.plus, u, v, {
          orientation: -HULL_ORIENTATION.plus as 1 | -1,
        })!;
        close(q.mean, -p.mean);
        close(q.gaussian, p.gaussian);
        close(q.k1, -p.k2);
        close(q.k2, -p.k1);
      }
    }
  });
});
