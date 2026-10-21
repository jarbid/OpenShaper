// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * V5b, the curved puck (design §15.3, Phase 2 step G2): the board's three-face
 * topology with a **curved** trimmed deck (degree 6 × 4, interior knots, a
 * non-affine parameterisation, from `approximateSurface`), a curved trimmed
 * bottom (bicubic, interior knots, `approximateSurface`) and a **skinned**
 * rational band (`skinCurves` through five exact sections; clamped, or periodic
 * in `u` like the board's rail band). Both trims are fitted pcurves.
 *
 * Oracles (none of them the code under test):
 *
 * - **Construction.** Every piece reproduces its definition at seeded random
 *   parameters: the sections lie on the scaled ellipse at the blended height
 *   (exact rational quartics: rounding), the deck and bottom equal their
 *   quadratics through the parameter maps (the data lie in the spline space:
 *   the least-squares solve's rounding), and the band, boundary and interior,
 *   is its definition `P(θ, s)` with `v = s` (the skin's parameters are the
 *   blends, and its control points are polynomial in `s` of degree ≤ 2, inside
 *   the cubic spline space: the interpolation solve's rounding).
 * - **Volume, area and centroid** from {@link curvedPuckOracle}, computed from
 *   the spec alone: the divergence theorem over the exact ellipse and the
 *   band's definition (Gauss–Legendre × trapezoid with analytic derivatives,
 *   exact for the polynomial fluxes, and a closed form for the volume's graph
 *   terms). It evaluates no NURBS, no trims and nothing of `integrate.ts`; the
 *   only link to the code under test is the construction check above, which
 *   uses point evaluation (pinned against OCCT, step B6). The oracle is itself
 *   checked against closed forms (planar deck and bottom, no bulge: `π a b h`,
 *   and the band's area `h ×` the ellipse's perimeter by the AGM).
 * - **The gap's leak.** A fitted trim's boundary is off the true edge by at most
 *   `g = maxEdgeGap`, so each integral can move by at most `g · L · R / 3`
 *   (volume, `L` the fitted edges' length bound, `R` the reach from the mass
 *   reference corner), `g · L` (area), `g · L · R² / (2 V)` (centroid): the
 *   bounds the solid is held to, with the quadrature's own error estimate on
 *   top. They must shrink as the fit tightens (convergence).
 * - **Honesty of the gap**: positive, within `tol.fit`, and at least what
 *   independent seeded samples see; the STEP uncertainty is twice it.
 */
import { describe, expect, it } from 'vitest';
import {
  checkBrep,
  createScratch,
  curveEvalInto,
  curveOnSurfaceEvalInto,
  curvePoint,
  DEFAULT_TOLERANCES,
  isoCurve,
  massProperties,
  skinCurves,
  surfacePoint,
  tessellateBrep,
  transformBrep,
  writeStep,
} from '../index';
import type { Affine3, Brep, BrepMesh, NurbsSurface, Tolerances } from '../index';
import {
  checksum,
  CURVED_PUCK_BOARD,
  curvedPuckOracle,
  curvedPuckParts,
  heightField,
  mulberry32,
  readStepSubset,
} from '../testing';
import type { CurvedPuckSpec, HeightQuadratic } from '../testing';

const EPS = Number.EPSILON;
/**
 * `quadMaxSplits` for the planar regression (G2): enough for every face's real integrals
 * there (16 suffices, 8 does not: measured), low enough that a moment refining on noise
 * (without the absolute target) reaches it in seconds (6.5 s measured) and fails
 * `centroidConverged` instead of timing out (88 s at 256).
 */
const QUAD_CAP = 64;

/** The perimeter of an ellipse in closed form (Gauss–Kummer: `2π/AGM(a, b) · (a² − Σ 2ⁿ⁻¹ c_n²)`). */
function ellipsePerimeter(a: number, b: number): number {
  let an = Math.max(a, b);
  let bn = Math.min(a, b);
  let sum = 0.5 * (an * an - bn * bn);
  let weight = 0.5;
  // The c_n fall quadratically: stop when one no longer changes the sum (then a_n has
  // converged to the AGM to rounding, its error being of order c_n² / a).
  for (;;) {
    const cn = 0.5 * (an - bn);
    const gn = Math.sqrt(an * bn);
    an = 0.5 * (an + bn);
    bn = gn;
    weight *= 2;
    const term = weight * cn * cn;
    if (sum + term === sum) break;
    sum += term;
  }
  return (2 * Math.PI * (Math.max(a, b) ** 2 - sum)) / an;
}
const SPEC = CURVED_PUCK_BOARD;
/** The deck's and bottom's control nets reach 1.25 a: the coordinate scale for rounding bounds (cm). */
const SCALE = 1.25 * SPEC.a;
/** Blends of the five sections (must match the construction's). */
const BLENDS = [0, 0.25, 0.5, 0.75, 1] as const;

const q = (h: HeightQuadratic, x: number, y: number): number =>
  h.c0 + h.cx * x + h.cy * y + h.cxx * x * x + h.cxy * x * y + h.cyy * y * y;

/** Diagonal of the bounding box of every face's control points: the reach of `massProperties`' reference corner. */
function controlNetDiagonal(b: Brep): number {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const f of b.faces) {
    const cw = f.surface.cw;
    for (let i = 0; i < cw.length; i += 4) {
      for (let k = 0; k < 3; k++) {
        const x = cw[i + k]! / cw[i + 3]!;
        lo[k] = Math.min(lo[k]!, x);
        hi[k] = Math.max(hi[k]!, x);
      }
    }
  }
  return Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!);
}

/** `|E(t) − S(P(t))|` of face `fi`'s single coedge at `n` seeded random parameters. */
function independentGap(b: Brep, fi: number, seed: number, n = 997): number {
  const face = b.faces[fi]!;
  const coedge = face.outer.coedges[0]!;
  const edge = b.edges[coedge.edge]!;
  const rng = mulberry32(seed);
  const [t0, t1] = edge.curve.basis.domain;
  const sc = createScratch({ maxDegree: 6, maxDerivs: 2 });
  const p = new Float64Array(3);
  const r = new Float64Array(3);
  let worst = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + rng() * (t1 - t0);
    curveEvalInto(edge.curve, t, 0, p, 0, sc);
    curveOnSurfaceEvalInto({ surface: face.surface, pcurve: coedge.pcurve }, t, 0, r, 0, sc);
    worst = Math.max(worst, Math.hypot(p[0]! - r[0]!, p[1]! - r[1]!, p[2]! - r[2]!));
  }
  return worst;
}

/**
 * `|S(u, v) − P(θ, v)|` for the band `S`, `P` its definition (`curved-puck.ts`) at the
 * angle of `S`'s own plan position (so only the distance off the definition counts).
 */
function bandDeviation(band: NurbsSurface, spec: CurvedPuckSpec, u: number, v: number): number {
  const p = surfacePoint(band, u, v);
  const rho = 1 + 4 * spec.bulge * v * (1 - v);
  const t = Math.atan2(p.y / (rho * spec.b), p.x / (rho * spec.a));
  const x0 = spec.a * Math.cos(t);
  const y0 = spec.b * Math.sin(t);
  const z = (1 - v) * q(spec.bottom, x0, y0) + v * q(spec.deck, x0, y0);
  return Math.hypot(p.x - rho * x0, p.y - rho * y0, p.z - z);
}

/**
 * The band is its definition `P(θ, s)` with `v = s`, at seeded random parameters: the
 * skin's interpolation solve (5 sections, centred homogeneous coordinates) leaves rounding.
 * Measured 5.7e-14 cm (2.3 ε × SCALE over 20,000 samples, clamped and periodic); held to
 * 64 ε × SCALE (1.6e-12 cm), ten orders below what the centripetal skin is off (0.09 cm,
 * the negative control).
 */
function expectBandIsDefinition(band: NurbsSurface, spec: CurvedPuckSpec, seed: number): void {
  const rng = mulberry32(seed);
  for (let i = 0; i < 1000; i++) {
    const u = rng();
    const v = rng();
    expect(bandDeviation(band, spec, u, v), `(${u}, ${v})`).toBeLessThan(64 * EPS * SCALE);
  }
}

/** Interior knot values (distinct) of a clamped or periodic direction. */
function interiorBreaks(k: NurbsSurface['u']): number[] {
  const [a, z] = k.domain;
  return [...new Set(Array.from(k.knots))].filter((x) => x > a && x < z);
}

/**
 * Holds `m` to the oracle within the leak of the gap `g` plus the quadrature
 * estimates (see the file comment).
 */
function expectWithinLeak(
  b: Brep,
  spec: CurvedPuckSpec,
  g: number,
  tol?: Partial<Tolerances>,
): {
  dV: number;
  vBound: number;
} {
  const o = curvedPuckOracle(spec);
  const m = massProperties(b, tol);
  expect(m.volume.converged && m.area.converged).toBe(true);
  // Every moment integral converged too (G2: the z-moment of a vertical wall is noise).
  expect(m.centroidConverged).toBe(true);
  const L = o.fittedEdgeLength;
  const R = controlNetDiagonal(b);
  const V = o.volume.value;
  const vBound = (g * L * R) / 3 + m.volume.errorEstimate + o.volume.errorEstimate;
  const aBound = g * L + m.area.errorEstimate + o.area.errorEstimate;
  // Moments carry the same leak with R² / 2; the volume divides through. The quadrature
  // estimates enter as relative errors of the moments, bounded via the volume's.
  const cBound = (g * L * R * R) / (2 * V) + (R * vBound) / V;
  // The reported centroid error is inside that bound (it carries the quadrature part only).
  for (const k of ['x', 'y', 'z'] as const) expect(m.centroidError[k]).toBeLessThanOrEqual(cBound);
  const dV = m.volume.value - V;
  expect(Math.abs(dV)).toBeLessThanOrEqual(vBound);
  expect(Math.abs(m.area.value - o.area.value)).toBeLessThanOrEqual(aBound);
  expect(Math.abs(m.centroid.x - o.centroid.x)).toBeLessThanOrEqual(cBound);
  expect(Math.abs(m.centroid.y - o.centroid.y)).toBeLessThanOrEqual(cBound);
  expect(Math.abs(m.centroid.z - o.centroid.z)).toBeLessThanOrEqual(cBound);
  // The bound must mean something: under a percent of the volume at the loosest fit tested
  // (1e-3 cm; 2.4e-5 at the default fit).
  expect(vBound / V).toBeLessThan(1e-2);
  return { dV, vBound };
}

describe('V5b is built from the pieces the board needs', () => {
  const parts = curvedPuckParts(SPEC);
  const b = parts.brep;

  it('deck degree 6 × 4 and bottom bicubic, both multi-span with interior knots; a skinned rational band', () => {
    const [band, bottom, deck] = b.faces.map((f) => f.surface);
    expect([deck!.u.degree, deck!.v.degree]).toEqual([6, 4]);
    expect([bottom!.u.degree, bottom!.v.degree]).toEqual([3, 3]);
    for (const s of [deck!, bottom!]) {
      expect(s.rational).toBe(false);
      expect(interiorBreaks(s.u).length).toBeGreaterThanOrEqual(3);
      expect(interiorBreaks(s.v).length).toBeGreaterThanOrEqual(1);
    }
    // Band: u along the sections (rational quartic arcs), v across five sections (cubic, one knot).
    expect(band!.rational).toBe(true);
    expect([band!.u.degree, band!.v.degree]).toEqual([4, 3]);
    expect(interiorBreaks(band!.v)).toHaveLength(1);
    // Both trims are fitted polynomial pcurves with many spans; the band's are iso-lines.
    for (const fi of [1, 2]) {
      const pc = b.faces[fi]!.outer.coedges[0]!.pcurve;
      expect(pc.rational).toBe(false);
      expect(pc.basis.count).toBeGreaterThan(20);
    }
    expect(Object.isFrozen(b)).toBe(true);
    expect(checksum(curvedPuckParts(SPEC).brep)).toBe(checksum(b));
  });

  it('reproduces its definition: sections exact, deck and bottom equal their quadratics, band = P(θ, s)', () => {
    const rng = mulberry32(11);
    // Exact constructions: rounding only, 64 ε × the coordinate scale.
    const exact = 64 * EPS * SCALE;
    parts.sections.forEach((c, k) => {
      const s = BLENDS[k]!;
      const rho = 1 + 4 * SPEC.bulge * s * (1 - s);
      for (let i = 0; i < 200; i++) {
        const p = curvePoint(c, rng());
        const x = p.x / rho;
        const y = p.y / rho;
        // On the scaled ellipse (a dimensionless residual of order ε) …
        expect(Math.abs((x / SPEC.a) ** 2 + (y / SPEC.b) ** 2 - 1)).toBeLessThan(64 * EPS);
        // … at the blended height.
        const z = (1 - s) * q(SPEC.bottom, x, y) + s * q(SPEC.deck, x, y);
        expect(Math.abs(p.z - z)).toBeLessThan(exact);
      }
    });
    // The fitted surfaces: the data lie in the spline space, so only the least-squares solve's
    // rounding remains, ε × scale × the normal equations' condition. Measured 3.5e-12 cm
    // (140 ε × scale) on the degree-6 deck; held to 1e4 ε × scale = 2.5e-10 cm, five orders
    // below the fit tolerance, so for the oracle the faces are the quadratics.
    const solve = 1e4 * EPS * SCALE;
    expect(parts.deckFitError).toBeLessThan(solve);
    expect(parts.bottomFitError).toBeLessThan(solve);
    const [band, bottom, deck] = b.faces.map((f) => f.surface);
    for (let i = 0; i < 1000; i++) {
      const u = rng();
      const v = rng();
      const d = surfacePoint(deck!, u, v);
      const [xd, yd] = parts.deckXY(u, v);
      expect(Math.hypot(d.x - xd, d.y - yd, d.z - q(SPEC.deck, xd, yd))).toBeLessThan(solve);
      const e = surfacePoint(bottom!, u, v);
      const [xb, yb] = parts.bottomXY(u, v);
      expect(Math.hypot(e.x - xb, e.y - yb, e.z - q(SPEC.bottom, xb, yb))).toBeLessThan(solve);
    }
    // The skin interpolates its first and last sections (homogeneous control points: exact).
    expect(parts.skinError).toBeLessThan(exact);
    for (const [k, v] of [
      [0, 0],
      [4, 1],
    ] as const) {
      const iso = isoCurve(band!, 'v', v);
      for (let i = 0; i < 200; i++) {
        const t = rng();
        const p = curvePoint(iso, t);
        const r = curvePoint(parts.sections[k]!, t);
        expect(Math.hypot(p.x - r.x, p.y - r.y, p.z - r.z)).toBeLessThan(exact);
      }
    }
    expectBandIsDefinition(band!, SPEC, 13);
  });

  it('a periodic band: the same sections as periodic quartics, the same boundary and interior', () => {
    const per = curvedPuckParts(SPEC, { periodicBand: true });
    const band = per.brep.faces[0]!.surface;
    expect(band.u.kind).toBe('periodic');
    expect(band.v.kind).toBe('clamped');
    const rng = mulberry32(12);
    for (const [k, v] of [
      [0, 0],
      [4, 1],
    ] as const) {
      const iso = isoCurve(band, 'v', v);
      for (let i = 0; i < 200; i++) {
        const t = rng();
        const p = curvePoint(iso, t);
        const r = curvePoint(parts.sections[k]!, t);
        expect(Math.hypot(p.x - r.x, p.y - r.y, p.z - r.z)).toBeLessThan(64 * EPS * SCALE);
      }
    }
    expectBandIsDefinition(band, SPEC, 14);
    expect(checkBrep(per.brep).issues).toEqual([]);
  });

  it('the band check can fail: a centripetal skin (the default) is a different surface inside', () => {
    // The same sections skinned at skinCurves' default parameters: the same boundary, but v is
    // no longer s, so the check (and the oracle, which integrates P) would see the difference.
    const band = skinCurves(parts.sections, { degree: 3 }).surface;
    const rng = mulberry32(15);
    let worst = 0;
    for (let i = 0; i < 200; i++) worst = Math.max(worst, bandDeviation(band, SPEC, rng(), rng()));
    // Measured 0.09 cm: 1e-3 cm is far above the check's rounding and far below that.
    expect(worst).toBeGreaterThan(1e-3);
  });

  it('reports the fitted gaps honestly: positive, within the fit, at least what independent samples see', () => {
    const r = checkBrep(b);
    expect(r.issues).toEqual([]);
    expect(r.euler).toMatchObject({ V: 2, E: 3, F: 3, holds: true });
    // Edge 2 is the seam, an exact iso-curve of the band: rounding.
    expect(r.edgeGaps[2]!).toBeLessThan(64 * EPS * SCALE);
    // Edges 0 (bottom) and 1 (deck) carry the pcurve fits.
    for (const [edge, fi] of [
      [0, 1],
      [1, 2],
    ] as const) {
      const g = r.edgeGaps[edge]!;
      expect(g).toBeGreaterThan(1e-9);
      expect(g).toBeLessThanOrEqual(DEFAULT_TOLERANCES.fit);
      // The check samples densely; seeded random samples (none of its) see at most that, and
      // (dense enough) within 5 % of it.
      for (const seed of [1, 2]) {
        const seen = independentGap(b, fi, seed);
        expect(seen).toBeLessThanOrEqual(g * (1 + 1e-9) + 64 * EPS * SCALE);
        expect(seen).toBeGreaterThan(0.95 * g);
      }
    }
    expect(parts.deckPcurveDeviation).toBeCloseTo(r.edgeGaps[1]!, 6);
    expect(parts.bottomPcurveDeviation).toBeCloseTo(r.edgeGaps[0]!, 6);
  });
});

describe('the oracle', () => {
  it('equals the closed form π a b h on a planar deck and bottom with no bulge (and its areas π a b √(1 + s²))', () => {
    const a = 30;
    const bb = 10;
    const flat: CurvedPuckSpec = {
      a,
      b: bb,
      deck: heightField(a, bb, { top: 5, slope: 0.05, rocker: 0, crown: 0 }),
      bottom: heightField(a, bb, { top: 1, slope: -0.05, rocker: 0, crown: 0 }),
      bulge: 0,
    };
    // A valid spec: D − B = 4 + 0.1 x ≥ 1 on the ellipse (the deck above the bottom).
    expect(4 - 0.1 * a).toBeGreaterThan(0);
    const parts = curvedPuckParts(flat);
    const o = curvedPuckOracle(flat);
    const ab = Math.PI * a * bb;
    // The band is vertical (its sections share x, y): no z-flux, only rounding.
    expect(Math.abs(o.closedForm.band.value)).toBeLessThan(1e-12 * ab);
    // Polynomial rules, exact: rounding of a few thousand terms.
    expect(Math.abs(o.volume.value / (ab * 4) - 1)).toBeLessThan(1e-13);
    expect(Math.abs(o.closedForm.graphs / (ab * 4) - 1)).toBeLessThan(1e-14);
    expect(Math.abs(o.faces.deckArea.value / (ab * Math.hypot(1, 0.05)) - 1)).toBeLessThan(1e-13);
    expect(Math.abs(o.faces.bottomArea.value / (ab * Math.hypot(1, 0.05)) - 1)).toBeLessThan(1e-13);
    // The vertical band's area is ∮ (D − B) ds = 4 · perimeter (the slope term 0.1 x
    // integrates to zero by symmetry): the trapezoid rule on a smooth periodic integrand
    // against the AGM closed form, to rounding.
    expect(Math.abs(ellipsePerimeter(1, 1) / (2 * Math.PI) - 1)).toBeLessThan(4 * EPS);
    expect(Math.abs(o.faces.bandArea.value / (4 * ellipsePerimeter(a, bb)) - 1)).toBeLessThan(
      1e-13,
    );
    // And massProperties agrees within the gap's leak.
    // The vertical band's z-moment is rounding noise: massProperties needs its absolute
    // target (G2 fix). A cap of QUAD_CAP splits per integral keeps a regression a failed
    // centroidConverged in about a second rather than a hang (nested rules on noise reach the
    // cap at both levels).
    expectWithinLeak(parts.brep, flat, checkBrep(parts.brep).maxEdgeGap, {
      quadMaxSplits: QUAD_CAP,
    });
  });

  it('agrees with itself: the polar rule = closed form + band flux; refinement changes nothing that matters', () => {
    const o = curvedPuckOracle(SPEC);
    // Two independent routes to the volume (the graphs' closed form, the polar quadrature).
    const V = o.volume.value;
    expect(Math.abs(o.closedForm.graphs + o.closedForm.band.value - V)).toBeLessThan(1e-13 * V);
    expect(o.volume.errorEstimate).toBeLessThan(1e-13 * V);
    expect(o.area.errorEstimate).toBeLessThan(1e-12 * o.area.value);
    // The rocker, crown, slope and bulge all count: V is not π a b × (mean thickness at the centre).
    expect(Math.abs(V / (Math.PI * SPEC.a * SPEC.b * 7) - 1)).toBeGreaterThan(0.1);
    // A finer oracle (more radial, angular and band points) agrees to rounding.
    const fine = curvedPuckOracle(SPEC, {
      order: 32,
      radial: 32,
      angular: 256,
    });
    expect(Math.abs(fine.volume.value - V)).toBeLessThan(1e-13 * V);
    expect(Math.abs(fine.area.value - o.area.value)).toBeLessThan(1e-12 * o.area.value);
  });
});

describe('massProperties of V5b against the oracle', () => {
  it('the board-size puck: volume, area and centroid within the leak of its measured gap', () => {
    const b = curvedPuckParts(SPEC).brep;
    expectWithinLeak(b, SPEC, checkBrep(b).maxEdgeGap);
  });

  it('with a periodic band', () => {
    const b = curvedPuckParts(SPEC, { periodicBand: true }).brep;
    expectWithinLeak(b, SPEC, checkBrep(b).maxEdgeGap);
  });

  it('a stronger, twisted shape with a 8 % bulge', () => {
    const a = 30;
    const bb = 10;
    const spec: CurvedPuckSpec = {
      a,
      b: bb,
      deck: heightField(a, bb, { top: 4, slope: 0.05, rocker: 2, crown: -0.8, twist: 0.4 }),
      bottom: heightField(a, bb, { top: 0, slope: -0.02, rocker: 3, crown: 0.6, twist: -0.3 }),
      bulge: 0.08,
    };
    const b = curvedPuckParts(spec).brep;
    expect(checkBrep(b).issues).toEqual([]);
    expectWithinLeak(b, spec, checkBrep(b).maxEdgeGap);
  });

  it('converges as the fit tightens: the gap tracks tol.fit and the error shrinks inside its bound', () => {
    const errors: number[] = [];
    for (const fit of [1e-3, 1e-5]) {
      const b = curvedPuckParts(SPEC, { tol: { fit } }).brep;
      const r = checkBrep(b, { fit: Math.max(fit, DEFAULT_TOLERANCES.fit) });
      expect(r.issues).toEqual([]);
      expect(r.maxEdgeGap).toBeLessThanOrEqual(fit);
      errors.push(Math.abs(expectWithinLeak(b, SPEC, r.maxEdgeGap).dV));
    }
    // Two orders of fit buy more than two orders of volume (measured 4.6: the leak is second order).
    expect(errors[1]!).toBeLessThan(1e-2 * errors[0]!);
  });

  it('a rigid motion moves the centroid with it and keeps the volume', () => {
    const b = curvedPuckParts(SPEC).brep;
    const move: Affine3 = [0, -1, 0, 20, 1, 0, 0, -7, 0, 0, 1, 3];
    const m0 = massProperties(b);
    const m1 = massProperties(transformBrep(b, move));
    expect(Math.abs(m1.volume.value - m0.volume.value)).toBeLessThan(1e-9 * m0.volume.value);
    // Rounding-level against the moments' magnitudes (R ~ 100 cm): 1e-9 relative of the reach.
    const tol = 1e-9 * controlNetDiagonal(b);
    expect(Math.abs(m1.centroid.x - (20 - m0.centroid.y))).toBeLessThan(tol);
    expect(Math.abs(m1.centroid.y - (-7 + m0.centroid.x))).toBeLessThan(tol);
    expect(Math.abs(m1.centroid.z - (3 + m0.centroid.z))).toBeLessThan(tol);
  });
});

describe('V5b through STEP and the mesh', () => {
  const b = curvedPuckParts(SPEC).brep;
  const per = curvedPuckParts(SPEC, { periodicBand: true }).brep;

  it('declares twice the measured gap; re-reads bitwise (polynomial faces and pcurves) with the same gaps', () => {
    for (const solid of [b, per]) {
      const r = checkBrep(solid);
      const mm = writeStep(solid);
      expect(mm.stats.maxEdgeGap).toBeCloseTo(10 * r.maxEdgeGap, 9);
      expect(mm.stats.uncertainty).toBeCloseTo(20 * r.maxEdgeGap, 9);
      const cm = writeStep(solid, { fileUnit: 'cm' });
      const back = readStepSubset(cm.text);
      for (const fi of [1, 2]) {
        expect(Array.from(back.faces[fi]!.surface.cw)).toEqual(
          Array.from(solid.faces[fi]!.surface.cw),
        );
        expect(Array.from(back.faces[fi]!.outer.coedges[0]!.pcurve.cw)).toEqual(
          Array.from(solid.faces[fi]!.outer.coedges[0]!.pcurve.cw),
        );
      }
      // The periodic band comes back clamped (the writer clamps it), the same surface.
      expect(back.faces[0]!.surface.u.kind).toBe('clamped');
      const rb = checkBrep(back);
      expect(rb.issues).toEqual([]);
      // Rational edges pass through x = cw / w and back: rounding on SCALE-sized coordinates.
      // (The reader numbers edges in file order: compare the sorted gaps.)
      const was = Array.from(r.edgeGaps).sort((x, y) => x - y);
      const now = Array.from(rb.edgeGaps).sort((x, y) => x - y);
      now.forEach((g, e) => expect(Math.abs(g - was[e]!)).toBeLessThan(64 * EPS * SCALE));
      expect(Math.abs(rb.signedVolume / r.signedVolume - 1)).toBeLessThan(1e-9);
    }
  });

  function volumeOf(m: BrepMesh): number {
    const p = m.positions;
    let v = 0;
    for (let t = 0; t < m.indices.length; t += 3) {
      const [a, c, d] = [0, 1, 2].map((k) => m.indices[t + k]! * 3) as [number, number, number];
      v +=
        (p[a]! * (p[c + 1]! * p[d + 2]! - p[c + 2]! * p[d + 1]!) -
          p[a + 1]! * (p[c]! * p[d + 2]! - p[c + 2]! * p[d]!) +
          p[a + 2]! * (p[c]! * p[d + 1]! - p[c + 1]! * p[d]!)) /
        6;
    }
    return v;
  }

  it('meshes watertight, and the mesh volume is within area × (chord error + gap) of the oracle', () => {
    const o = curvedPuckOracle(SPEC);
    const r = tessellateBrep(b, { chordTol: 0.05, angleTol: 0.2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const m = r.value;
    const dir = new Map<string, number>();
    for (let t = 0; t < m.indices.length; t += 3) {
      const w = [0, 1, 2].map((k) => m.weld[m.indices[t + k]!]!);
      for (let e = 0; e < 3; e++) {
        const key = `${w[e]},${w[(e + 1) % 3]}`;
        dir.set(key, (dir.get(key) ?? 0) + 1);
      }
    }
    for (const [key, n] of dir) {
      const [x, y] = key.split(',');
      expect(n, `edge ${key}`).toBe(1);
      expect(dir.get(`${y},${x}`), `opposite of ${key}`).toBe(1);
    }
    expect(new Set(m.weld).size - dir.size / 2 + m.indices.length / 3).toBe(2);
    const gap = checkBrep(b).maxEdgeGap;
    expect(m.maxChordError).toBeLessThanOrEqual(0.05 * 1.0000001);
    expect(Math.abs(volumeOf(m) - o.volume.value)).toBeLessThanOrEqual(
      o.area.value * (m.maxChordError + gap),
    );
  });
});
