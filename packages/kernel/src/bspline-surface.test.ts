// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * B-spline interpolation, against analytic oracles.
 *
 * There is no legacy oracle for any of this — BoardCAD-LE had no surface
 * representation and no STEP writer (see `docs/specs/ASSESSMENT.md`, domain I), so
 * the golden-data rule's porting phase does not apply. The same situation as
 * `rail-profile.ts`, and the same answer: pin the cases where the right answer is
 * known in closed form.
 *
 * The cases below are chosen so the expected result does not depend on how the
 * data happens to be parameterized — a constant sweep, a plane, a linear ramp, a
 * boundary identity. That keeps them honest: a fit that got the parameterization
 * wrong would still have to produce these exactly.
 */
import { describe, expect, it } from 'vitest';
import {
  CENTRIPETAL,
  CHORD,
  CUBIC,
  averageParams,
  averagedKnots,
  evalCurve,
  evalSurface,
  interpolateCurve,
  interpolateSurface,
  knotMultiplicities,
  pointParams,
  surfaceBoundaryCurve,
  surfaceNormal,
  type BSplineSurface,
} from './bspline-surface';
import type { Vert3 } from './loft';

const v3 = (x: number, y: number, z: number): Vert3 => ({ x, y, z });
const dist = (a: Vert3, b: Vert3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** A profile ring shape at station `x`, scaled by `s` and lifted by `z0`. */
const ring = (x: number, cols: number, s = 1, z0 = 0): Vert3[] =>
  Array.from({ length: cols }, (_, j) => {
    const t = (Math.PI * j) / (cols - 1); // half-turn: bottom centre → rail → deck centre
    return v3(x, s * Math.sin(t), z0 + s * (1 - Math.cos(t)));
  });

describe('interpolateCurve', () => {
  it('passes through every data point exactly', () => {
    const pts = [v3(0, 0, 0), v3(1, 2, 0), v3(3, 3, 1), v3(6, 1, 2), v3(8, -1, 1)];
    const c = interpolateCurve(pts, CUBIC, CENTRIPETAL);
    const params = pointParams(pts, CENTRIPETAL);
    for (let i = 0; i < pts.length; i++) {
      expect(dist(evalCurve(c, params[i]!), pts[i]!)).toBeLessThan(1e-12);
    }
  });

  it('reproduces a straight line exactly', () => {
    // Collinear data with chord-length parameters is a degree-1 polynomial in the
    // parameter, so a cubic interpolant must be that same line — not merely close.
    const pts = Array.from({ length: 7 }, (_, i) => v3(i, 2 * i, -i));
    const c = interpolateCurve(pts, CUBIC, CHORD);
    for (let k = 0; k <= 40; k++) {
      const t = k / 40;
      const p = evalCurve(c, t);
      expect(Math.abs(p.y - 2 * p.x)).toBeLessThan(1e-9);
      expect(Math.abs(p.z + p.x)).toBeLessThan(1e-9);
    }
  });

  it('drops degree rather than failing on short inputs', () => {
    const c = interpolateCurve([v3(0, 0, 0), v3(1, 1, 1)]);
    expect(c.degree).toBe(1);
    expect(dist(evalCurve(c, 0.5), v3(0.5, 0.5, 0.5))).toBeLessThan(1e-12);
  });

  it('survives coincident points instead of returning NaN', () => {
    const c = interpolateCurve([v3(0, 0, 0), v3(0, 0, 0), v3(0, 0, 0), v3(0, 0, 0)]);
    const p = evalCurve(c, 0.5);
    expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true);
  });
});

describe('interpolateCurve: convergence order', () => {
  // The discriminator for the whole module. Asserting "the error is small" cannot
  // tell a correct cubic interpolant from a lucky one; only the ORDER can, and a
  // cubic must be O(h^4) — halve the spacing, cut the error sixteenfold.
  //
  // It is tested here, on a smooth analytic curve, rather than on a board: the
  // lofted hull is piecewise LINEAR around the ring (`loftPoint` interpolates an
  // arc-length table), so it is only C0 and no high-order convergence against it is
  // possible or meaningful. The surface is a tensor product of exactly this
  // machinery in each direction, so the order established here is the order it has.
  // A GRAPH curve: x is monotone, so the fitted point's own x says exactly which
  // point of the true curve to compare against. That removes the nearest-point
  // search, and with it any chance of measuring the distance to a different part of
  // a curve that loops near itself — which floors the measurement and hides the
  // very convergence being tested.
  const SPAN = 3;
  const truth = (x: number): Vert3 => v3(x, Math.sin(x), 0.3 * x * x);

  const errAt = (n: number): number => {
    const pts = Array.from({ length: n + 1 }, (_, i) => truth((i / n) * SPAN));
    const c = interpolateCurve(pts, CUBIC, CENTRIPETAL);
    let worst = 0;
    for (let k = 0; k <= 400; k++) {
      const p = evalCurve(c, k / 400);
      const want = truth(p.x);
      worst = Math.max(worst, Math.hypot(p.y - want.y, p.z - want.z));
    }
    return worst;
  };

  it('is fourth-order on smooth data', () => {
    const e1 = errAt(8);
    const e2 = errAt(16);
    const e3 = errAt(32);
    // Theory says 16x per halving; 8 leaves room for the weaker boundary order that
    // clamped interpolation without end-derivative conditions has at the two ends.
    expect(e1 / e2).toBeGreaterThan(8);
    expect(e2 / e3).toBeGreaterThan(8);
  });
});

describe('averagedKnots', () => {
  it('is clamped and non-decreasing, with the right length', () => {
    const params = pointParams(
      Array.from({ length: 9 }, (_, i) => v3(i * i, 0, 0)),
      CHORD,
    );
    const U = averagedKnots(params, CUBIC);
    expect(U).toHaveLength(params.length + CUBIC + 1);
    for (let i = 1; i < U.length; i++) expect(U[i]!).toBeGreaterThanOrEqual(U[i - 1]!);
    expect(U.slice(0, 4)).toEqual([0, 0, 0, 0]);
    expect(U.slice(-4)).toEqual([1, 1, 1, 1]);
  });
});

describe('averageParams', () => {
  it('lands on exactly [0, 1] and stays strictly increasing', () => {
    const out = averageParams([
      [0, 0.1, 0.4, 1],
      [0, 0.5, 0.6, 1],
    ]);
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(1);
    for (let i = 1; i < out.length; i++) expect(out[i]!).toBeGreaterThan(out[i - 1]!);
  });
});

describe('interpolateSurface: analytic exactness', () => {
  const COLS = 12;

  it('makes a constant sweep a prism', () => {
    // Every row identical ⇒ every control row must be identical and the surface
    // must not vary with u at all. This isolates the u machinery: any
    // parameterization or solver asymmetry shows up immediately.
    //
    // The bound is round-off, not geometry. Interpolating a constant sequence has
    // the constant as its exact solution (the collocation rows are a partition of
    // unity), but recovering it through a general LU costs a couple of ulps, so
    // "identical" here means 1e-12 cm — four orders below the sampling floor of the
    // surface being fitted and eleven below anything a shaper could measure.
    const grid = Array.from({ length: 9 }, (_, r) => ring(r * 3, COLS));
    const s = interpolateSurface(grid);
    const first = s.ctrl[0]!;
    for (const row of s.ctrl) {
      for (let j = 0; j < first.length; j++) {
        expect(Math.abs(row[j]!.y - first[j]!.y)).toBeLessThan(1e-12);
        expect(Math.abs(row[j]!.z - first[j]!.z)).toBeLessThan(1e-12);
      }
    }
    for (const u of [0, 0.17, 0.5, 0.83, 1]) {
      const a = evalSurface(s, u, 0.37);
      const b = evalSurface(s, 0.5, 0.37);
      expect(Math.abs(a.y - b.y)).toBeLessThan(1e-12);
      expect(Math.abs(a.z - b.z)).toBeLessThan(1e-12);
    }
  });

  it('keeps a planar grid exactly planar', () => {
    const grid = Array.from({ length: 7 }, (_, r) =>
      Array.from({ length: COLS }, (_, c) => v3(r, c * c * 0.1, 0)),
    );
    const s = interpolateSurface(grid);
    for (const row of s.ctrl) for (const p of row) expect(p.z).toBe(0);
    for (let k = 0; k <= 30; k++) {
      expect(Math.abs(evalSurface(s, k / 30, (k % 7) / 7).z)).toBeLessThan(1e-12);
    }
  });

  it('reproduces a linear ramp as an exact ruled sweep', () => {
    // The section is constant but rides a rocker rising linearly with x, so the
    // height ABOVE the ramp, z - slope·x, must be the same at every station. A fit
    // that bent the ramp — or that let the section drift along the length — would
    // show up here immediately.
    const slope = 0.25;
    const grid = Array.from({ length: 9 }, (_, r) => ring(r * 3, COLS, 1, slope * r * 3));
    const s = interpolateSurface(grid);
    for (const v of [0.1, 0.4, 0.75]) {
      const ref = evalSurface(s, 0, v);
      const want = ref.z - slope * ref.x;
      for (let k = 0; k <= 25; k++) {
        const p = evalSurface(s, k / 25, v);
        expect(Math.abs(p.z - slope * p.x - want)).toBeLessThan(1e-9);
      }
    }
  });

  it('interpolates the four corners exactly', () => {
    const grid = Array.from({ length: 8 }, (_, r) => ring(r * 2.5, COLS, 1 + 0.1 * r));
    const s = interpolateSurface(grid);
    const corners: [number, number, Vert3][] = [
      [0, 0, grid[0]![0]!],
      [0, 1, grid[0]![COLS - 1]!],
      [1, 0, grid[7]![0]!],
      [1, 1, grid[7]![COLS - 1]!],
    ];
    for (const [u, v, want] of corners) {
      expect(dist(evalSurface(s, u, v), want)).toBeLessThan(1e-10);
    }
  });
});

describe('surfaceBoundaryCurve', () => {
  const grid = Array.from({ length: 8 }, (_, r) => ring(r * 2.5, 10, 1 + 0.1 * r));
  const s = interpolateSurface(grid);

  it('is the surface isocurve, exactly', () => {
    // The whole no-pcurve decision in the STEP writer rests on this identity: an
    // EDGE_CURVE can reference the surface's own control points because the
    // boundary curve IS the boundary control row over the same knot vector.
    for (const [edge, at] of [
      ['v0', (t: number) => evalSurface(s, t, 0)],
      ['v1', (t: number) => evalSurface(s, t, 1)],
      ['u0', (t: number) => evalSurface(s, 0, t)],
      ['u1', (t: number) => evalSurface(s, 1, t)],
    ] as const) {
      const c = surfaceBoundaryCurve(s, edge);
      for (let k = 0; k <= 50; k++) {
        const t = k / 50;
        expect(dist(evalCurve(c, t), at(t))).toBeLessThan(1e-13);
      }
    }
  });

  it('shares the surface control points by identity, not by value', () => {
    // The writer emits each CARTESIAN_POINT once and references it from both the
    // surface and its edges; that only works if these are the same objects.
    const c = surfaceBoundaryCurve(s, 'v0');
    expect(c.ctrl[0]).toBe(s.ctrl[0]![0]);
    expect(c.knots).toBe(s.uKnots);
  });
});

describe('interpolateSurface: creases via uBreaks', () => {
  const ROWS = 13;
  const COLS = 8;
  const KINK = 6;

  /** z is piecewise linear in the row index, with a genuine kink at row KINK. */
  const kinked = (): Vert3[][] =>
    Array.from({ length: ROWS }, (_, r) => {
      const z = r <= KINK ? r : KINK - 3 * (r - KINK);
      return Array.from({ length: COLS }, (_, c) => v3(r, c, z));
    });

  /** Max |z - piecewise-linear(x)| over a parameter sweep. */
  const kinkError = (s: BSplineSurface): number => {
    let worst = 0;
    for (let k = 0; k <= 200; k++) {
      const p = evalSurface(s, k / 200, 0.5);
      const want = p.x <= KINK ? p.x : KINK - 3 * (p.x - KINK);
      worst = Math.max(worst, Math.abs(p.z - want));
    }
    return worst;
  };

  it('reproduces the crease exactly when told where it is', () => {
    // Each strip's data is exactly linear, and a cubic interpolant of collinear
    // data under chord-length parameters is that line — so this is exact, not close.
    expect(kinkError(interpolateSurface(kinked(), { uBreaks: [KINK] }))).toBeLessThan(1e-9);
  });

  it('rounds the crease off without the break — which is why uBreaks exists', () => {
    // Guards the reason for the strip machinery: one smooth bicubic through a kink
    // smooths it, and a board cut from that surface would not match the mesh.
    expect(kinkError(interpolateSurface(kinked()))).toBeGreaterThan(0.05);
  });

  it('lands multiplicity `degree` on the break knot', () => {
    const s = interpolateSurface(kinked(), { uBreaks: [KINK] });
    const { values, mults } = knotMultiplicities(s.uKnots);
    expect(mults[0]).toBe(CUBIC + 1);
    expect(mults[mults.length - 1]).toBe(CUBIC + 1);
    // Exactly one interior knot carries multiplicity 3 — the crease.
    const creases = mults.slice(1, -1).filter((m) => m === CUBIC);
    expect(creases).toHaveLength(1);
    for (let i = 1; i < values.length; i++) expect(values[i]!).toBeGreaterThan(values[i - 1]!);
  });

  it('keeps the knot count consistent with the control net', () => {
    const s = interpolateSurface(kinked(), { uBreaks: [KINK] });
    expect(s.uKnots).toHaveLength(s.ctrl.length + s.uDegree + 1);
    expect(s.vKnots).toHaveLength(s.ctrl[0]!.length + s.vDegree + 1);
  });

  it('refuses a strip too short to carry the degree', () => {
    // Better a clear throw than a silently degree-reduced strip that cannot be
    // concatenated with its neighbours.
    expect(() => interpolateSurface(kinked(), { uBreaks: [2] })).toThrow(/needs 4/);
  });
});

describe('surfaceNormal', () => {
  it('points along +z for a grid in the z = const plane', () => {
    const grid = Array.from({ length: 6 }, (_, r) =>
      Array.from({ length: 6 }, (_, c) => v3(r, c, 4)),
    );
    const n = surfaceNormal(interpolateSurface(grid), 0.4, 0.6);
    expect(n).not.toBeNull();
    expect(Math.abs(Math.abs(n!.z) - 1)).toBeLessThan(1e-9);
  });
});
