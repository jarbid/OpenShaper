// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Point inversion and closest points (design §6.14, §11.2; oracle row
 * `project` of §16).
 *
 * Oracles, each independent of the code under test:
 *
 * - **Analytic feet.** A point built as `S(u*, v*) + d·n` with `|d|` below the
 *   smallest radius of curvature projects back to `(u*, v*)` at distance `|d|`
 *   (sphere, cylinder, torus). The foot is also checked against its closed
 *   form: radial on a sphere and a cylinder (axial coordinate clamped to the
 *   height beyond the ends), orthogonal and clamped on a plane, radial on a
 *   circle.
 * - **Brute force.** On random clamped and periodic, polynomial and rational
 *   curves and surfaces with C⁰ knot lines, the returned distance is never
 *   larger than the smallest of a dense uniform sampling (which bounds the
 *   true minimum from above), and no point a small parameter step away in any
 *   of the 8 directions is closer (a local minimum, also at a kink or a
 *   bound). The random surfaces are graph- and tube-like nets (control points
 *   at their Greville abscissae plus random offsets), the shapes a CAD model
 *   has; fully random nets fold into sheets a few hundredths apart, where
 *   sampling-based seeding misses the global minimum for ~2% of points
 *   (measured, geom-core.md §11.2).
 * - **Kinks.** Polylines (every knot C⁰) and a roof (a crease line) against
 *   segment-wise and face-wise closed forms.
 * - **Honesty.** `converged` is true only where the stationarity test holds,
 *   and the count a batch returns is the number of `false` flags.
 *
 * Tolerances (design §16 `project`):
 *
 * - parameters `1e-12` of the domain length: Newton stops at a step of
 *   `paramRel = 1e-12` of the domain after quadratic convergence, so the
 *   error left is far below that step; rounding of the input point moves the
 *   foot by ~ε·scale/|Su| ≈ 1e-15 of the domain on these well-shaped cases;
 * - distances `64 ε · scale` against closed forms: the surfaces themselves
 *   are exact to `64 ε r` (surface-primitives.test.ts), and a distance is
 *   first-order insensitive to a tangential error of the foot;
 * - feet `64 ε · scale + 4 · cosine · distance`: the zero-cosine stop leaves
 *   a tangential residual of `cosine · |r|`, which moves the foot by at most
 *   that over `1 − |d|·κ ≥ 1/2` (`|d|` at most half the radius of curvature);
 * - brute force `1e-12 · scale`: the dense minimum bounds the true one from
 *   above, so the only slack needed is rounding of the two distances;
 * - local-minimum probe: steps of `1e-6` of the domain raise the distance by
 *   ~|S′|²·1e-12 / (2d) at a smooth minimum (linearly at a kink), far above
 *   the `1e-14 · scale` allowed for rounding.
 */
import { describe, expect, it } from 'vitest';
import {
  circle,
  circle2,
  DEFAULT_TOLERANCES,
  polyline,
  clampedBasis,
  closestPointOnCurve,
  closestPointOnSurface,
  createScratch,
  curveDerivatives,
  curveDomain,
  curvePoint,
  curveEvalBatchInto,
  cylinder,
  DEFAULT_PROJECTION_SEEDING,
  isGeomError,
  line,
  makeCurve,
  makeSurface,
  periodicCircle,
  planeSurface,
  projectPointsToCurveInto,
  projectPointsToSurfaceInto,
  sphere,
  surfaceDomain,
  surfaceEvalGridInto,
  surfaceNormal,
  surfacePoint,
  torus,
  vec,
} from './index';
import type {
  GeomErrorCode,
  NurbsCurve,
  NurbsSurface,
  Point3,
  SurfaceProjection,
  UV,
} from './index';
import {
  mulberry32,
  randomClampedBasis,
  randomCurve,
  randomPeriodicBasis,
  randomSurface,
} from './testing';

const EPS = Number.EPSILON;
/** Parameter tolerance relative to the domain length (design §16). */
const PARAM_REL = 1e-12;
/** Brute-force agreement relative to the scale (design §16 asks 1e-9; rounding needs far less). */
const BRUTE_REL = 1e-12;
/**
 * The strict global oracle runs with denser seeding (4p + 1 samples per span,
 * 10 Newton starts); the default (2p + 1, 3 starts) is characterised against
 * it: at most `MAX_MISSES` of 40 points per net find another local minimum,
 * each a near-tie within `NEAR_TIE` (relative) of the global distance
 * (measured on this corpus; geom-core.md §11.2).
 */
const DENSE_SEEDING = { oversample: 4, starts: 10 } as const;
const MAX_MISSES = 1;
const NEAR_TIE = 0.01;
/** The foot tolerance of the header: closed-form rounding plus the zero-cosine residual. */
const footTol = (scale: number, dist: number): number =>
  64 * EPS * scale + 4 * DEFAULT_TOLERANCES.cosine * dist;
/** Local-minimum probe step, relative to the domain, and its rounding allowance relative to the scale. */
const PROBE_STEP = 1e-6;
const PROBE_SLACK = 1e-14;

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

/** Distance between two parameters of a direction with period `T` (or none). */
function paramGap(a: number, b: number, T?: number): number {
  const d = Math.abs(a - b);
  return T === undefined ? d : Math.min(d % T, T - (d % T));
}

function normalAt(s: NurbsSurface, u: number, v: number): Point3 {
  const n = surfaceNormal(s, u, v);
  if (n.kind !== 'regular') throw new Error(`degenerate normal at (${u}, ${v})`);
  return n.n;
}

/**
 * No point a small parameter step away (8 directions, clamped into the
 * domain, wrapped where periodic) is closer than the result: a local minimum,
 * whether smooth, at a kink or on a bound.
 */
function expectLocalMin(s: NurbsSurface, p: Point3, r: SurfaceProjection, scale: number): void {
  const { u: du, v: dv } = surfaceDomain(s);
  const hu = PROBE_STEP * (du[1] - du[0]);
  const hv = PROBE_STEP * (dv[1] - dv[0]);
  const fit = (x: number, b: NurbsSurface['u'], d: readonly [number, number]): number =>
    b.kind === 'periodic' ? x : Math.min(Math.max(x, d[0]), d[1]);
  for (const [a, b] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ] as const) {
    const q = surfacePoint(s, fit(r.uv.u + a * hu, s.u, du), fit(r.uv.v + b * hv, s.v, dv));
    expect(
      vec.distance(q, p),
      `probe (${a}, ${b}) at ${JSON.stringify(r.uv)}`,
    ).toBeGreaterThanOrEqual(r.distance - PROBE_SLACK * scale);
  }
}

/** Greville abscissae of a basis (control point i sits over the average of its p knots). */
function greville(b: NurbsCurve['basis']): Float64Array {
  const p = b.degree;
  const U = b.knots;
  const n = b.count;
  const g = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 1; j <= p; j++) {
      const k = i + j;
      if (b.kind === 'clamped') sum += U[k]!;
      else sum += U[k % n]! + Math.floor(k / n) * b.period;
    }
    g[i] = sum / p;
  }
  return g;
}

/** A graph-like random surface over `[0, 4] × [0, 3]` with C⁰ lines (multiplicity up to the degree). */
function graphSurface(rng: () => number, rational: boolean): NurbsSurface {
  const u = randomClampedBasis(rng, 3, 9, { maxMult: 3, minSpacing: 1 / 12 });
  const v = randomClampedBasis(rng, 2, 7, { maxMult: 2, minSpacing: 1 / 12 });
  const gu = greville(u);
  const gv = greville(v);
  const pts: number[] = [];
  const w: number[] = [];
  for (let i = 0; i < u.count; i++) {
    for (let j = 0; j < v.count; j++) {
      pts.push(4 * gu[i]! + 0.2 * (rng() - 0.5), 3 * gv[j]! + 0.2 * (rng() - 0.5), 0.6 * rng());
      w.push(rational ? 0.5 + 1.5 * rng() : 1);
    }
  }
  return makeSurface({ u, v, points: pts, weights: w });
}

/** A tube-like random surface: periodic u round the z axis (radius 1 ± 0.15), clamped v along it. */
function tubeSurface(rng: () => number, rational: boolean): NurbsSurface {
  const u = randomPeriodicBasis(rng, 2, 10, { maxMult: 2, minSpacing: 1 / 16 });
  const v = randomClampedBasis(rng, 3, 7, { maxMult: 2, minSpacing: 1 / 10 });
  const gu = greville(u);
  const gv = greville(v);
  const pts: number[] = [];
  const w: number[] = [];
  for (let i = 0; i < u.count; i++) {
    const a = 2 * Math.PI * gu[i]!;
    for (let j = 0; j < v.count; j++) {
      const r = 1 + 0.3 * (rng() - 0.5);
      pts.push(r * Math.cos(a), r * Math.sin(a), 3 * gv[j]!);
      w.push(rational ? 0.5 + 1.5 * rng() : 1);
    }
  }
  return makeSurface({ u, v, points: pts, weights: w });
}

// ---------------------------------------------------------------------------
// Surfaces: analytic cases
// ---------------------------------------------------------------------------

/**
 * A random cubic with C⁰ kinks (multiplicity up to the degree) that does not
 * fold: clamped, a wavy line along x over `[0, 4]`; periodic, a wavy loop of
 * radius 1 ± 0.15 round the z axis.
 */
function realisticCurve(
  rng: () => number,
  dim: 2 | 3,
  periodic: boolean,
  rational: boolean,
): NurbsCurve {
  const b = periodic
    ? randomPeriodicBasis(rng, 3, 12, { maxMult: 3, minSpacing: 1 / 20 })
    : randomClampedBasis(rng, 3, 12, { maxMult: 3, minSpacing: 1 / 20 });
  const g = greville(b);
  const pts: number[] = [];
  for (let i = 0; i < b.count; i++) {
    if (periodic) {
      const a = 2 * Math.PI * g[i]!;
      const r = 1 + 0.3 * (rng() - 0.5);
      pts.push(r * Math.cos(a), r * Math.sin(a));
    } else {
      pts.push(4 * g[i]! + 0.1 * (rng() - 0.5), 0.6 * (rng() - 0.5));
    }
    if (dim === 3) pts.push(0.6 * (rng() - 0.5));
  }
  const weights = rational ? Array.from({ length: b.count }, () => 0.5 + 1.5 * rng()) : undefined;
  return makeCurve({ dim, basis: b, points: pts, weights });
}

describe('closestPointOnSurface: analytic surfaces', () => {
  it('inverts points off a sphere to their own (u, v), radially', () => {
    const c = { x: 1, y: -2, z: 0.5 };
    const r = 3;
    const s = sphere(c, r);
    const scale = r + vec.norm(c);
    const rng = mulberry32(11);
    for (let k = 0; k < 200; k++) {
      const u = rng();
      // Away from the poles, where u is undefined (|Su| → 0).
      const v = 0.1 + 0.8 * rng();
      const d = k % 4 === 0 ? 0 : (rng() - 0.5) * r;
      const p = vec.add(surfacePoint(s, u, v), vec.scale(normalAt(s, u, v), d));
      const res = closestPointOnSurface(s, p);
      expect(res.converged).toBe(true);
      expect(res.onBoundary).toBe(false);
      expect(paramGap(res.uv.u, u, 1)).toBeLessThanOrEqual(PARAM_REL);
      expect(Math.abs(res.uv.v - v)).toBeLessThanOrEqual(PARAM_REL);
      expect(Math.abs(res.distance - Math.abs(d))).toBeLessThanOrEqual(64 * EPS * scale);
      // The closed-form foot: c + r·(p − c)/|p − c|.
      const pc = vec.sub(p, c);
      const foot = vec.add(c, vec.scale(pc, r / vec.norm(pc)));
      expect(vec.distance(res.point, foot)).toBeLessThanOrEqual(footTol(scale, Math.abs(d)));
    }
  });

  it('inverts points off a tilted cylinder; beyond its ends the foot is on the rim', () => {
    const base = { x: 0.5, y: 1, z: -1 };
    const axis = vec.normalize({ x: 1, y: 1, z: 2 })!;
    const r = 1.5;
    const h = 4;
    const s = cylinder(base, axis, r, h);
    const scale = r + h + vec.norm(base);
    const rng = mulberry32(12);
    for (let k = 0; k < 200; k++) {
      const u = rng();
      const v = rng();
      const d = (rng() - 0.5) * r;
      const p = vec.add(surfacePoint(s, u, v), vec.scale(normalAt(s, u, v), d));
      const res = closestPointOnSurface(s, p);
      expect(res.converged).toBe(true);
      expect(paramGap(res.uv.u, u, 1)).toBeLessThanOrEqual(PARAM_REL);
      expect(Math.abs(res.uv.v - v)).toBeLessThanOrEqual(PARAM_REL);
      expect(Math.abs(res.distance - Math.abs(d))).toBeLessThanOrEqual(64 * EPS * scale);
    }
    // Points anywhere, outside the axis: foot = radial direction at the clamped height.
    for (let k = 0; k < 200; k++) {
      const p = {
        x: base.x + 8 * (rng() - 0.5),
        y: base.y + 8 * (rng() - 0.5),
        z: base.z + 12 * (rng() - 0.3),
      };
      const rel = vec.sub(p, base);
      const z = vec.dot(rel, axis);
      const radial = vec.sub(rel, vec.scale(axis, z));
      const rho = vec.norm(radial);
      if (rho < 0.6 * r) continue; // inside, near the axis the foot is far from unique
      const zc = Math.min(Math.max(z, 0), h);
      const foot = vec.add(vec.add(base, vec.scale(axis, zc)), vec.scale(radial, r / rho));
      const res = closestPointOnSurface(s, p);
      expect(res.converged).toBe(true);
      expect(vec.distance(res.point, foot)).toBeLessThanOrEqual(footTol(scale, res.distance));
      expect(Math.abs(res.distance - vec.distance(p, foot))).toBeLessThanOrEqual(64 * EPS * scale);
      expect(res.onBoundary).toBe(z <= 0 ? 'v0' : z >= h ? 'v1' : false);
      expect(Math.abs(res.uv.v - zc / h)).toBeLessThanOrEqual(PARAM_REL);
    }
  });

  it('inverts points off a torus (both directions periodic)', () => {
    const c = { x: -1, y: 2, z: 0.25 };
    const R = 3;
    const r = 1;
    const s = torus(c, { x: 0.2, y: -0.3, z: 1 }, R, r);
    const scale = R + r + vec.norm(c);
    const rng = mulberry32(13);
    for (let k = 0; k < 200; k++) {
      const u = rng();
      const v = rng();
      // |d| < r/2: inside the focal surface (the largest curvature is 1/r).
      const d = (rng() - 0.5) * r;
      const p = vec.add(surfacePoint(s, u, v), vec.scale(normalAt(s, u, v), d));
      const res = closestPointOnSurface(s, p);
      expect(res.converged).toBe(true);
      expect(res.onBoundary).toBe(false);
      expect(paramGap(res.uv.u, u, 1)).toBeLessThanOrEqual(PARAM_REL);
      expect(paramGap(res.uv.v, v, 1)).toBeLessThanOrEqual(PARAM_REL);
      expect(Math.abs(res.distance - Math.abs(d))).toBeLessThanOrEqual(64 * EPS * scale);
    }
  });

  it('projects orthogonally onto a plane and clamps to its edges and corners', () => {
    const O = { x: 1, y: 2, z: 3 };
    const U = { x: 2, y: 0, z: 0 };
    const V = { x: 0, y: 0.5, z: 0 };
    const dom = { u: [-1, 2] as const, v: [0, 3] as const };
    const s = planeSurface(O, U, V, dom);
    const scale = 10;
    const rng = mulberry32(14);
    for (let k = 0; k < 300; k++) {
      const p = { x: 1 + 10 * (rng() - 0.5), y: 2 + 3 * (rng() - 0.3), z: 3 + 4 * (rng() - 0.5) };
      const uf = (p.x - O.x) / 2;
      const vf = (p.y - O.y) / 0.5;
      const u = Math.min(Math.max(uf, -1), 2);
      const v = Math.min(Math.max(vf, 0), 3);
      const res = closestPointOnSurface(s, p);
      expect(res.converged).toBe(true);
      expect(Math.abs(res.uv.u - u)).toBeLessThanOrEqual(PARAM_REL * 3);
      expect(Math.abs(res.uv.v - v)).toBeLessThanOrEqual(PARAM_REL * 3);
      const foot = { x: O.x + 2 * u, y: O.y + 0.5 * v, z: O.z };
      expect(Math.abs(res.distance - vec.distance(p, foot))).toBeLessThanOrEqual(64 * EPS * scale);
      const edge =
        uf <= -1 ? 'u0' : uf >= 2 ? 'u1' : vf <= 0 ? 'v0' : vf >= 3 ? 'v1' : (false as const);
      expect(res.onBoundary).toBe(edge);
    }
  });

  it('inverts points on a rational graph surface exactly', () => {
    const rng = mulberry32(15);
    const nu = 7;
    const nv = 6;
    const pts: number[] = [];
    const w: number[] = [];
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) {
        pts.push((10 * i) / (nu - 1), (6 * j) / (nv - 1), 2 * rng());
        w.push(0.6 + 0.8 * rng());
      }
    }
    const s = makeSurface({
      u: clampedBasis(3, [0, 0, 0, 0, 0.3, 0.5, 0.7, 1, 1, 1, 1]),
      v: clampedBasis(2, [0, 0, 0, 0.25, 0.5, 0.8, 1, 1, 1]),
      points: pts,
      weights: w,
    });
    for (let k = 0; k < 200; k++) {
      // Knot values and the domain edges included.
      const u = k < 5 ? [0, 0.3, 0.5, 0.7, 1][k]! : rng();
      const v = k < 5 ? [0, 0.25, 0.5, 0.8, 1][k]! : rng();
      const res = closestPointOnSurface(s, surfacePoint(s, u, v));
      expect(res.converged).toBe(true);
      expect(Math.abs(res.uv.u - u)).toBeLessThanOrEqual(PARAM_REL);
      expect(Math.abs(res.uv.v - v)).toBeLessThanOrEqual(PARAM_REL);
      expect(res.distance).toBeLessThanOrEqual(64 * EPS * 12);
    }
  });
});

// ---------------------------------------------------------------------------
// Surfaces: brute force on random geometry
// ---------------------------------------------------------------------------

/** The smallest distance from `p` to a dense uniform grid of `s` (`m` samples per unit of domain fraction). */
function denseMin(s: NurbsSurface, p: Point3, us: Float64Array, vs: Float64Array): number {
  const out = new Float64Array(us.length * vs.length * 3);
  surfaceEvalGridInto(s, us, vs, 0, out, createScratch({ maxDegree: 4, maxDerivs: 0 }));
  let best = Infinity;
  for (let k = 0; k < out.length; k += 3) {
    const dx = out[k]! - p.x;
    const dy = out[k + 1]! - p.y;
    const dz = out[k + 2]! - p.z;
    best = Math.min(best, Math.sqrt(dx * dx + dy * dy + dz * dz));
  }
  return best;
}

const grid = (a: number, b: number, n: number): Float64Array =>
  Float64Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);

describe('closestPointOnSurface: random surfaces against brute force', () => {
  for (const seed of [21, 22, 23, 24, 25, 26, 27, 28]) {
    it(`finds the global minimum, a local minimum on every side (seed ${seed})`, () => {
      const rng = mulberry32(seed);
      const tube = seed % 2 === 0;
      const s = tube ? tubeSurface(rng, seed % 4 === 0) : graphSurface(rng, seed % 4 === 1);
      const { u: du, v: dv } = surfaceDomain(s);
      const us = grid(du[0], du[1], 300);
      const vs = grid(dv[0], dv[1], 300);
      const scale = 5;
      let misses = 0;
      for (let k = 0; k < 40; k++) {
        // Even k: near the surface (offset along the normal); odd k: anywhere in the box.
        let p: Point3;
        if (k % 2 === 0) {
          const u = du[0] + (du[1] - du[0]) * rng();
          const v = dv[0] + (dv[1] - dv[0]) * rng();
          const n = surfaceNormal(s, u, v);
          const d = rng() - 0.5;
          p = vec.add(
            surfacePoint(s, u, v),
            n.kind === 'regular'
              ? vec.scale(n.n, d)
              : vec.scale(vec.normalize({ x: 1, y: 1, z: 1 })!, d),
          );
        } else {
          p = tube
            ? { x: 4 * (rng() - 0.5), y: 4 * (rng() - 0.5), z: 4 * rng() - 0.5 }
            : { x: 5 * rng() - 0.5, y: 4 * rng() - 0.5, z: 2.5 * rng() - 1 };
        }
        const what = `seed ${seed} point ${k}`;
        const dense = denseMin(s, p, us, vs);
        const strict = closestPointOnSurface(s, p, { seeding: DENSE_SEEDING });
        expect(strict.distance, what).toBeLessThanOrEqual(dense + BRUTE_REL * scale);
        const res = closestPointOnSurface(s, p);
        expect(res.converged, what).toBe(true);
        expectLocalMin(s, p, res, scale);
        expect(vec.distance(res.point, surfacePoint(s, res.uv.u, res.uv.v))).toBe(0);
        if (res.distance > dense + BRUTE_REL * scale) {
          misses++;
          expect((res.distance - dense) / dense, `${what}: not a near-tie`).toBeLessThanOrEqual(
            NEAR_TIE,
          );
        }
      }
      expect(misses, `default seeding misses (seed ${seed})`).toBeLessThanOrEqual(MAX_MISSES);
    });
  }

  it('finds a minimum on a crease (a C⁰ knot line) and on either face', () => {
    // A roof: two unit-slope faces meeting at the ridge x = 1 (degree 1, knot 0.5 in u).
    const s = makeSurface({
      u: clampedBasis(1, [0, 0, 0.5, 1, 1]),
      v: clampedBasis(1, [0, 0, 1, 1]),
      points: [0, 0, 0, 0, 2, 0, 1, 0, 1, 1, 2, 1, 2, 0, 0, 2, 2, 0],
    });
    // Each face is a rectangle with orthogonal axes: the foot is the clamped projection.
    const faces = [
      { o: { x: 0, y: 0, z: 0 }, a: { x: 1, y: 0, z: 1 }, b: { x: 0, y: 2, z: 0 } },
      { o: { x: 1, y: 0, z: 1 }, a: { x: 1, y: 0, z: -1 }, b: { x: 0, y: 2, z: 0 } },
    ];
    const rng = mulberry32(29);
    let onRidge = 0;
    for (let k = 0; k < 300; k++) {
      const p = { x: 3 * rng() - 0.5, y: 3 * rng() - 0.5, z: 3 * rng() - 1 };
      let best = Infinity;
      for (const f of faces) {
        const rel = vec.sub(p, f.o);
        const sa = Math.min(Math.max(vec.dot(rel, f.a) / vec.dot(f.a, f.a), 0), 1);
        const sb = Math.min(Math.max(vec.dot(rel, f.b) / vec.dot(f.b, f.b), 0), 1);
        best = Math.min(
          best,
          vec.distance(p, vec.add(f.o, vec.add(vec.scale(f.a, sa), vec.scale(f.b, sb)))),
        );
      }
      const res = closestPointOnSurface(s, p);
      expect(res.converged).toBe(true);
      expect(Math.abs(res.distance - best), `point ${k}`).toBeLessThanOrEqual(64 * EPS * 4);
      if (res.uv.u === 0.5) onRidge++;
    }
    expect(onRidge).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------
// Curves
// ---------------------------------------------------------------------------

describe('closestPointOnCurve', () => {
  it('finds the radial foot on a 3D circle (clamped and periodic)', () => {
    const c = { x: 0.5, y: -1, z: 2 };
    const X = { x: 1, y: 1, z: 0 };
    const Y = { x: 0, y: 1, z: 1 };
    const r = 2;
    const scale = r + vec.norm(c);
    const ex = vec.normalize(X)!;
    const ey = vec.normalize(vec.sub(Y, vec.scale(ex, vec.dot(Y, ex))))!;
    const rng = mulberry32(31);
    for (const curve of [circle(c, X, Y, r), periodicCircle(c, X, Y, r)]) {
      for (let k = 0; k < 200; k++) {
        const p = {
          x: c.x + 6 * (rng() - 0.5),
          y: c.y + 6 * (rng() - 0.5),
          z: c.z + 6 * (rng() - 0.5),
        };
        const rel = vec.sub(p, c);
        const a = vec.dot(rel, ex);
        const b = vec.dot(rel, ey);
        const rho = Math.hypot(a, b);
        if (rho < 0.1 * r) continue; // near the axis the foot is nearly arbitrary
        const foot = vec.add(
          c,
          vec.add(vec.scale(ex, (r * a) / rho), vec.scale(ey, (r * b) / rho)),
        );
        const res = closestPointOnCurve(curve, p);
        expect(res.converged).toBe(true);
        expect(vec.distance(res.point, foot)).toBeLessThanOrEqual(footTol(scale, res.distance));
        expect(Math.abs(res.distance - vec.distance(p, foot))).toBeLessThanOrEqual(
          64 * EPS * scale,
        );
      }
    }
  });

  it('finds the radial foot on a 2D circle and inverts its own points', () => {
    const c2 = circle2({ x: 1, y: 2 }, 1.5);
    const [a, b] = curveDomain(c2);
    const rng = mulberry32(32);
    for (let k = 0; k < 200; k++) {
      const t = a + (b - a) * rng();
      const q = curveDerivatives(c2, t, 1);
      const res = closestPointOnCurve(c2, q[0]!);
      // The 9-point circle starts and ends at the same point: compare points there.
      expect(vec.distance(res.point, q[0]!)).toBeLessThanOrEqual(64 * EPS * 4);
      if (t > 0.01 && t < 0.99) expect(Math.abs(res.t - t)).toBeLessThanOrEqual(PARAM_REL);
      const p = { x: 1 + 8 * (rng() - 0.5), y: 2 + 8 * (rng() - 0.5) };
      const rho = Math.hypot(p.x - 1, p.y - 2);
      if (rho < 0.1) continue;
      const r2 = closestPointOnCurve(c2, p);
      expect(Math.abs(r2.distance - Math.abs(rho - 1.5))).toBeLessThanOrEqual(64 * EPS * 6);
    }
  });

  it('projects onto a polyline (every knot a kink) like the closest of its segments', () => {
    const rng = mulberry32(33);
    const n = 9;
    const pts = Float64Array.from({ length: 3 * n }, (_, k) =>
      k % 3 === 0 ? k / 3 + 0.3 * rng() : 2 * (rng() - 0.5),
    );
    const c = polyline(pts, 3);
    for (let k = 0; k < 300; k++) {
      const p = { x: 9 * rng() - 0.5, y: 3 * (rng() - 0.5), z: 3 * (rng() - 0.5) };
      let best = Infinity;
      for (let i = 0; i + 1 < n; i++) {
        const A = { x: pts[3 * i]!, y: pts[3 * i + 1]!, z: pts[3 * i + 2]! };
        const B = { x: pts[3 * i + 3]!, y: pts[3 * i + 4]!, z: pts[3 * i + 5]! };
        const AB = vec.sub(B, A);
        const s = Math.min(Math.max(vec.dot(vec.sub(p, A), AB) / vec.dot(AB, AB), 0), 1);
        best = Math.min(best, vec.distance(p, vec.add(A, vec.scale(AB, s))));
      }
      const res = closestPointOnCurve(c, p);
      expect(res.converged).toBe(true);
      expect(Math.abs(res.distance - best), `point ${k}`).toBeLessThanOrEqual(64 * EPS * 10);
    }
  });

  it('clamps to the ends of a segment', () => {
    const l = line({ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 });
    expect(closestPointOnCurve(l, { x: -1, y: 1, z: 0 }).t).toBe(0);
    expect(closestPointOnCurve(l, { x: 5, y: 1, z: 0 }).t).toBe(1);
    const mid = closestPointOnCurve(l, { x: 0.5, y: 1, z: -2 });
    expect(Math.abs(mid.t - 0.25)).toBeLessThanOrEqual(4 * EPS);
    expect(Math.abs(mid.distance - Math.sqrt(5))).toBeLessThanOrEqual(8 * EPS);
  });

  for (const seed of [41, 42, 43, 44, 45, 46]) {
    it(`finds the global minimum on random curves (seed ${seed})`, () => {
      const rng = mulberry32(seed);
      const periodic = seed % 3 === 0;
      const rational = seed % 2 === 1;
      for (const dim of [2, 3] as const) {
        const c = realisticCurve(rng, dim, periodic, rational);
        const [a, b] = curveDomain(c);
        const ts = grid(a, b, 4000);
        const pts = new Float64Array(ts.length * dim);
        curveEvalBatchInto(c, ts, 0, pts, createScratch({ maxDegree: 3 }));
        const scale = 5;
        let misses = 0;
        for (let k = 0; k < 40; k++) {
          const q = periodic
            ? [3 * (rng() - 0.5), 3 * (rng() - 0.5), dim === 3 ? 2 * (rng() - 0.5) : 0]
            : [5 * rng() - 0.5, 2 * (rng() - 0.5), dim === 3 ? 2 * (rng() - 0.5) : 0];
          const p = dim === 2 ? { x: q[0]!, y: q[1]! } : { x: q[0]!, y: q[1]!, z: q[2]! };
          let dense = Infinity;
          for (let i = 0; i < ts.length; i++) {
            let d2 = 0;
            for (let j = 0; j < dim; j++) d2 += (pts[i * dim + j]! - q[j]!) ** 2;
            dense = Math.min(dense, Math.sqrt(d2));
          }
          const what = `seed ${seed} dim ${dim} point ${k}`;
          const cc = c as NurbsCurve<2>;
          const strict = closestPointOnCurve(cc, p as never, { seeding: DENSE_SEEDING });
          expect(strict.distance, what).toBeLessThanOrEqual(dense + BRUTE_REL * scale);
          const res = closestPointOnCurve(cc, p as never);
          expect(res.converged).toBe(true);
          if (res.distance > dense + BRUTE_REL * scale) {
            misses++;
            expect((res.distance - dense) / dense, `${what}: not a near-tie`).toBeLessThanOrEqual(
              NEAR_TIE,
            );
          }
          // A local minimum: neither neighbour (clamped or wrapped) is closer.
          for (const sgn of [-1, 1]) {
            let t = res.t + sgn * PROBE_STEP * (b - a);
            if (!periodic) t = Math.min(Math.max(t, a), b);
            const qn = curvePoint(c, t) as Point3 | { x: number; y: number };
            const dn = Math.hypot(qn.x - q[0]!, qn.y - q[1]!, ((qn as Point3).z ?? 0) - q[2]!);
            expect(dn).toBeGreaterThanOrEqual(res.distance - PROBE_SLACK * scale);
          }
        }
        expect(misses, `default seeding misses (seed ${seed})`).toBeLessThanOrEqual(MAX_MISSES);
      }
    });
  }

  it('stays finite and honest on folded random nets', () => {
    // Fully random control points: the curve folds back on itself; whatever is
    // found is a converged local minimum, and dense seeding finds the global one.
    const rng = mulberry32(47);
    for (const kind of ['clamped', 'periodic'] as const) {
      const c = randomCurve(rng, {
        dim: 3,
        degree: 3,
        count: 10,
        kind,
        maxMult: 3,
        weightRange: [0.5, 2],
      });
      const [a, b] = curveDomain(c);
      const ts = grid(a, b, 4000);
      const pts = new Float64Array(ts.length * 3);
      curveEvalBatchInto(c, ts, 0, pts, createScratch({ maxDegree: 3 }));
      for (let k = 0; k < 40; k++) {
        const p = { x: 3 * (rng() - 0.5), y: 3 * (rng() - 0.5), z: 3 * (rng() - 0.5) };
        let dense = Infinity;
        for (let i = 0; i < pts.length; i += 3) {
          dense = Math.min(dense, Math.hypot(pts[i]! - p.x, pts[i + 1]! - p.y, pts[i + 2]! - p.z));
        }
        const res = closestPointOnCurve(c as NurbsCurve<3>, p);
        expect(Number.isFinite(res.distance) && Number.isFinite(res.t)).toBe(true);
        expect(res.converged).toBe(true);
        for (const sgn of [-1, 1]) {
          let t = res.t + sgn * PROBE_STEP * (b - a);
          if (kind === 'clamped') t = Math.min(Math.max(t, a), b);
          expect(vec.distance(curvePoint(c as NurbsCurve<3>, t), p)).toBeGreaterThanOrEqual(
            res.distance - PROBE_SLACK * 2,
          );
        }
        const strict = closestPointOnCurve(c as NurbsCurve<3>, p, { seeding: DENSE_SEEDING });
        expect(strict.distance).toBeLessThanOrEqual(dense + BRUTE_REL * 2);
      }
    }
  });

  it('restricts the search to a range, also across a periodic seam', () => {
    const c = periodicCircle({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 1);
    // The point at angle 0 is t = 0; restricted to [0.2, 0.6] the closest is the end 0.2.
    const p = { x: 2, y: 0, z: 0 };
    expect(closestPointOnCurve(c, p).t).toBe(0);
    const r1 = closestPointOnCurve(c, p, { range: [0.2, 0.6] });
    expect(r1.t).toBe(0.2);
    expect(r1.converged).toBe(true);
    // Across the seam: [0.9, 1.1] contains angle 0, reported wrapped.
    const r2 = closestPointOnCurve(c, p, { range: [0.9, 1.1] });
    expect(paramGap(r2.t, 0, 1)).toBeLessThanOrEqual(PARAM_REL);
    expect(r2.t >= 0 && r2.t < 1).toBe(true);
    expectCode(() => closestPointOnCurve(c, p, { range: [0, 1.5] }), 'unsupported');
    const l = line({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
    expectCode(() => closestPointOnCurve(l, p, { range: [0.5, 1.2] }), 'param-out-of-domain');
    expectCode(() => closestPointOnCurve(l, p, { range: [0.5, 0.5] }), 'empty-domain');
  });

  it('returns the local minimum from a seed (a clamped end with an outward gradient)', () => {
    // A U shape; from (0.3, 2) the right end is the global minimum, the left end a local one.
    const u = makeCurve({
      dim: 2,
      basis: clampedBasis(2, [0, 0, 0, 1, 1, 1]),
      points: [-1, 1, 0, -1, 1, 1],
    });
    const p = { x: 0.3, y: 2 };
    const global = closestPointOnCurve(u, p);
    expect(global.t).toBe(1);
    const local = closestPointOnCurve(u, p, { seed: 0.05 });
    expect(local.t).toBe(0);
    expect(local.converged).toBe(true);
    expect(local.distance).toBeGreaterThan(global.distance);
  });
});

// ---------------------------------------------------------------------------
// Batches, honesty, errors
// ---------------------------------------------------------------------------

describe('batches', () => {
  it('warm-started surface batches agree with cold queries along a path', () => {
    const s = torus({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 3, 1);
    const n = 400;
    const pts = new Float64Array(3 * n);
    for (let i = 0; i < n; i++) {
      const a = (4 * Math.PI * i) / n; // two turns: the warm start crosses the seam
      pts[3 * i] = 3.6 * Math.cos(a);
      pts[3 * i + 1] = 3.6 * Math.sin(a);
      pts[3 * i + 2] = 0.3 * Math.sin(3 * a);
    }
    const uv = new Float64Array(2 * n);
    const dist = new Float64Array(n);
    expect(projectPointsToSurfaceInto(s, pts, uv, dist, { warmStart: true })).toBe(0);
    const uvc = new Float64Array(2 * n);
    const distc = new Float64Array(n);
    expect(projectPointsToSurfaceInto(s, pts, uvc, distc)).toBe(0);
    for (let i = 0; i < n; i++) {
      const p = { x: pts[3 * i]!, y: pts[3 * i + 1]!, z: pts[3 * i + 2]! };
      const one = closestPointOnSurface(s, p);
      expect(Math.abs(dist[i]! - one.distance)).toBeLessThanOrEqual(64 * EPS * 4);
      expect(distc[i]).toBe(one.distance);
      expect(paramGap(uv[2 * i]!, one.uv.u, 1)).toBeLessThanOrEqual(PARAM_REL * 10);
      expect(paramGap(uv[2 * i + 1]!, one.uv.v, 1)).toBeLessThanOrEqual(PARAM_REL * 10);
      expect(uv[2 * i]! >= 0 && uv[2 * i]! < 1).toBe(true);
    }
  });

  it('warm starts follow a branch within the continuity bound; seeds are local', () => {
    // A U-shaped curve: sweeping the point across x = 0 moves the global foot from
    // the left end to the right end; the warm batch stays on the left end, whose
    // distance grows slower than the point moves (the continuity bound holds).
    const c = makeCurve({
      dim: 2,
      basis: clampedBasis(2, [0, 0, 0, 1, 1, 1]),
      points: [-1, 1, 0, -1, 1, 1],
    });
    const n = 41;
    const step = 0.025;
    const pts = Float64Array.from({ length: 2 * n }, (_, k) =>
      k % 2 ? 2 : -0.5 + step * (k >> 1) + 0.001,
    );
    const t = new Float64Array(n);
    const d = new Float64Array(n);
    const tc = new Float64Array(n);
    const dc = new Float64Array(n);
    expect(projectPointsToCurveInto(c, pts, t, d, { warmStart: true })).toBe(0);
    expect(projectPointsToCurveInto(c, pts, tc, dc)).toBe(0);
    for (let i = 0; i < n; i++) {
      expect(tc[i]).toBe(pts[2 * i]! < 0 ? 0 : 1);
      expect(t[i]).toBe(0);
      expect(d[i]!).toBeGreaterThanOrEqual(dc[i]!);
      if (i > 0) expect(d[i]!).toBeLessThanOrEqual(d[i - 1]! + step + DEFAULT_TOLERANCES.point);
    }

    // On the surface, warm and cold agree: a distance within `point` is global.
    const tor = torus({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 3, 1);
    const m = 200;
    const onPts = new Float64Array(3 * m);
    for (let i = 0; i < m; i++) {
      const q = surfacePoint(tor, (2 * i) / m - Math.floor((2 * i) / m), 0.37);
      onPts.set([q.x, q.y, q.z], 3 * i);
    }
    const uvw = new Float64Array(2 * m);
    const dw = new Float64Array(m);
    const uvc = new Float64Array(2 * m);
    const dcc = new Float64Array(m);
    expect(projectPointsToSurfaceInto(tor, onPts, uvw, dw, { warmStart: true })).toBe(0);
    expect(projectPointsToSurfaceInto(tor, onPts, uvc, dcc)).toBe(0);
    for (let i = 0; i < m; i++) {
      expect(dw[i]!).toBeLessThanOrEqual(64 * EPS * 4);
      expect(paramGap(uvw[2 * i]!, uvc[2 * i]!, 1)).toBeLessThanOrEqual(PARAM_REL);
      expect(paramGap(uvw[2 * i + 1]!, 0.37, 1)).toBeLessThanOrEqual(PARAM_REL);
    }

    // Seeds are local projections: a converged start is kept, even on the far side.
    const tp = Float64Array.of(4.5, 0, 0.2);
    const uv = new Float64Array(2);
    const dist = new Float64Array(1);
    expect(
      projectPointsToSurfaceInto(tor, tp, uv, dist, { seeds: Float64Array.of(0.5, 0.5) }),
    ).toBe(0);
    const cold = closestPointOnSurface(tor, { x: 4.5, y: 0, z: 0.2 });
    expect(Math.abs(cold.distance - (Math.hypot(1.5, 0.2) - 1))).toBeLessThanOrEqual(64 * EPS * 5);
    expect(dist[0]!).toBeGreaterThanOrEqual(cold.distance);
    const local = closestPointOnSurface(
      tor,
      { x: 4.5, y: 0, z: 0.2 },
      { seed: { u: 0.5, v: 0.5 } },
    );
    expect(local.converged).toBe(true);
    expect(local.distance).toBe(dist[0]);

    // A converged seed on a plane: the clamped foot, whatever the seed.
    const s = planeSurface({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    const sp = Float64Array.of(0.25, 0.5, 1, 0.75, 0.5, -2);
    const uv2 = new Float64Array(4);
    const dist2 = new Float64Array(2);
    expect(
      projectPointsToSurfaceInto(s, sp, uv2, dist2, { seeds: Float64Array.of(0.9, 0.9, -3, 7) }),
    ).toBe(0);
    expect(Array.from(uv2)).toEqual([0.25, 0.5, 0.75, 0.5]);
    expect(Array.from(dist2)).toEqual([1, 2]);
  });

  it('reports non-converged points honestly', () => {
    const rng = mulberry32(51);
    const s = randomSurface(rng, {
      degreeU: 3,
      degreeV: 3,
      countU: 8,
      countV: 8,
      weightRange: [0.5, 2],
    });
    const n = 200;
    const pts = Float64Array.from({ length: 3 * n }, () => 3 * (rng() - 0.5));
    const uv = new Float64Array(2 * n);
    const dist = new Float64Array(n);
    const tol = { newtonMaxIter: 1 };
    const failed = projectPointsToSurfaceInto(s, pts, uv, dist, { tol });
    let flagged = 0;
    for (let i = 0; i < n; i++) {
      const p = { x: pts[3 * i]!, y: pts[3 * i + 1]!, z: pts[3 * i + 2]! };
      const one = closestPointOnSurface(s, p, { tol });
      expect(one.distance).toBe(dist[i]);
      if (!one.converged) flagged++;
      else expectLocalMin(s, p, one, 2);
    }
    expect(failed).toBe(flagged);
    expect(failed).toBeGreaterThan(0);
  });

  it('rejects malformed input', () => {
    const s = sphere({ x: 0, y: 0, z: 0 }, 1);
    const c = line({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
    const out = new Float64Array(8);
    expectCode(() => closestPointOnSurface(s, { x: NaN, y: 0, z: 0 }), 'non-finite');
    expectCode(() => closestPointOnCurve(c, { x: 0, y: Infinity, z: 0 }), 'non-finite');
    expectCode(() => projectPointsToSurfaceInto(s, new Float64Array(4), out, out), 'size-mismatch');
    expectCode(
      () => projectPointsToSurfaceInto(s, new Float64Array(9), new Float64Array(5), out),
      'size-mismatch',
    );
    expectCode(
      () =>
        projectPointsToSurfaceInto(s, new Float64Array(3), out, out, {
          seeds: Float64Array.of(NaN, 0),
        }),
      'non-finite',
    );
    expectCode(
      () => projectPointsToCurveInto(c, Float64Array.of(0, 0, NaN), out, out),
      'non-finite',
    );
    expectCode(
      () => closestPointOnSurface(s, { x: 0, y: 0, z: 2 }, { seeding: { oversample: 0 } }),
      'unsupported',
    );
    expectCode(
      () => closestPointOnCurve(c, { x: 0, y: 0, z: 2 }, { seeding: { starts: 1.5 } }),
      'unsupported',
    );
    expectCode(
      () => closestPointOnCurve(c, { x: 0, y: 0, z: 1 }, { seed: 3 }),
      'param-out-of-domain',
    );
    expect(Object.isFrozen(DEFAULT_PROJECTION_SEEDING)).toBe(true);
  });

  it('returns frozen, finite records and seeds an explicit start', () => {
    const s = sphere({ x: 0, y: 0, z: 0 }, 1);
    const seed: UV = { u: 0.3, v: 0.5 };
    const r = closestPointOnSurface(s, { x: 0, y: 3, z: 0 }, { seed });
    expect(Object.isFrozen(r) && Object.isFrozen(r.uv) && Object.isFrozen(r.point)).toBe(true);
    expect(Math.abs(r.distance - 2)).toBeLessThanOrEqual(8 * EPS);
    expect(r.iterations).toBeGreaterThan(0);
    // Exactly on the north pole: any u is right; v = 1 and the edge is reported.
    const pole = closestPointOnSurface(s, { x: 0, y: 0, z: 1 });
    expect(pole.distance).toBeLessThanOrEqual(8 * EPS);
    expect(pole.uv.v).toBe(1);
    expect(pole.onBoundary).toBe('v1');
  });
});
