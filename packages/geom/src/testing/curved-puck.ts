// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * V5b, the curved puck (design §15.3 corpus): the board's three-face topology
 * with **curved** trimmed faces and a **skinned** band, so the B-rep, mass
 * properties, STEP writer and OCCT see the kind of geometry the board will have
 * rather than V5's tilted plane.
 *
 * - The **deck** is the height field `z = D(x, y)`, a quadratic (top, slope,
 *   rocker along x, crown across y), represented exactly by a degree (6, 4)
 *   B-spline with interior knots in both directions and a non-affine
 *   parameterisation (`x` cubic in `u`, `y` quadratic in `v`), produced by
 *   `approximateSurface` from samples (the data lie in the spline space, so the
 *   least-squares fit reproduces them to rounding; the fit's own report and a
 *   dense comparison with `D` measure that).
 * - The **bottom** is `z = B(x, y)`, another quadratic (rocker, slope, a curve
 *   across), as a bicubic with interior knots in both directions (affine
 *   parameterisation, so `B` is in the bicubic space), also by `approximateSurface`.
 * - The **band** is `skinCurves` through closed sections over the plan ellipse
 *   (semi-axes `a`, `b`): section `k` at blend `s_k` is the ellipse scaled by
 *   `ρ(s) = 1 + 4 · bulge · s (1 − s)` at height `(1 − s_k) B + s_k D` — a rail
 *   that bulges outward between the bottom's edge (`s = 0`) and the deck's
 *   (`s = 1`). Every section is an **exact** rational quartic: on each quarter
 *   of the 9-point circle `(c, s) = (C_w, S_w) / W` with quadratic Bernstein
 *   numerators, so a quadratic `z(c, s)` over the common denominator `W²` is a
 *   quartic, built with the Bernstein product rule. Equal weight vectors keep
 *   the skin's weights positive (`skinCurves`). The skin's `v` parameters are
 *   the blends `s_k` themselves, so it reproduces the band's definition between
 *   the sections too: every homogeneous control point is quadratic (`ρ`) or
 *   linear (height) in `s`, inside the cubic spline space the skin interpolates
 *   in, so the band is exactly `P(θ, s)` below with `v = s`. With `periodicBand` the same
 *   sections are written as periodic quartics (one period of knots, the
 *   duplicated closing control point dropped) and the band is periodic in `u`,
 *   the board's rail-band layout (board2 decision 7); the seam stays an edge.
 * - The edges are the first and last sections (exact: they lie on `B` and `D`
 *   exactly) and the band's seam iso-curve; the band's pcurves are its iso-lines;
 *   the **deck's and the bottom's pcurves are fitted** (`projectCurveToSurface`),
 *   so both trimmed faces carry a real, measured edge gap.
 *
 * The independent oracle ({@link curvedPuckOracle}) is computed from the spec
 * alone: no NURBS evaluation, no trims, no `integrate.ts`. The solid's boundary
 * is `D` and `B` over the exact ellipse plus the band
 * `P(θ, s) = (ρ(s) a cos θ, ρ(s) b sin θ, (1 − s) B + s D)` (heights at
 * `(a cos θ, b sin θ)`), so by the divergence theorem every volume integral is
 * a flux of a polynomial field through two graphs over an ellipse (polar
 * Gauss–Legendre × trapezoid) and through `P` (trapezoid in `θ` × Gauss–Legendre
 * in `s`), all exact for those polynomials; the areas are spectrally convergent
 * rules on the same grids. That the skinned band IS `P` is checked separately,
 * point by point (`curved-puck.test.ts`), which is all the oracle borrows from
 * the NURBS code: point evaluation (itself pinned by OCCT, step B6).
 */
import { approximateSurface } from '../fit/approximate';
import { skinCurves } from '../fit/skin';
import { clampedBasis, knotsFromBreaks, periodicBasis } from '../basis';
import { circle, line2 } from '../primitives';
import { controlPoint, curveFromHomogeneous } from '../curve';
import { isoCurve } from '../surface';
import { projectCurveToSurface } from '../edge-fit';
import type { EdgeFitSampling } from '../edge-fit';
import { gaussLegendre } from '../quadrature';
import { fail } from '../errors';
import type { Tolerances } from '../tolerance';
import { makeBrep, unwrapBrep } from '../brep/brep';
import type {
  Brep,
  BrepEdge,
  BrepFace,
  ClampedCurve,
  NurbsCurve,
  NurbsSurface,
  Point3,
  QuadratureResult,
} from '../types';

/** `z = c0 + cx x + cy y + cxx x² + cxy x y + cyy y²`. */
export interface HeightQuadratic {
  readonly c0: number;
  readonly cx: number;
  readonly cy: number;
  readonly cxx: number;
  readonly cxy: number;
  readonly cyy: number;
}

/** The curved puck's shape (model units, cm in the corpus). */
export interface CurvedPuckSpec {
  /** Semi-axes of the plan ellipse along x and y. */
  readonly a: number;
  readonly b: number;
  /** The deck `z = D(x, y)` and the bottom `z = B(x, y)`; `D > B` on the ellipse. */
  readonly deck: HeightQuadratic;
  readonly bottom: HeightQuadratic;
  /** Outward bulge of the band's mid-section, as a fraction of the semi-axes (`ρ(½) = 1 + bulge`). */
  readonly bulge: number;
}

/**
 * Quadratic height fields from shaper-style numbers: `top` (height at the
 * centre), `slope` (dz/dx), `rocker` (rise at `x = ±a` over the centre) and
 * `crown` (rise at `y = ±b`; negative for a domed deck).
 */
export function heightField(
  a: number,
  b: number,
  f: {
    readonly top: number;
    readonly slope: number;
    readonly rocker: number;
    readonly crown: number;
    readonly twist?: number;
  },
): HeightQuadratic {
  return Object.freeze({
    c0: f.top,
    cx: f.slope,
    cy: 0,
    cxx: f.rocker / (a * a),
    cxy: (f.twist ?? 0) / (a * b),
    cyy: f.crown / (b * b),
  });
}

/**
 * A board-sized V5b (cm): 180 × 54 cm plan, 7 cm thick at the centre, deck rocker
 * 3 cm with a 1 cm crown and a slight slope, bottom rocker 7 cm rising 0.9 cm more
 * at the +x end, a 0.5 cm curve across the bottom, the rail bulging 1.5 %.
 * Thickness at the ends 2.55 and 3.45 cm, at the widest point 5.5 cm.
 */
export const CURVED_PUCK_BOARD: CurvedPuckSpec = Object.freeze({
  a: 90,
  b: 27,
  deck: heightField(90, 27, { top: 7, slope: 0.005, rocker: 3, crown: -1 }),
  bottom: heightField(90, 27, { top: 0, slope: 0.01, rocker: 7, crown: 0.5 }),
  bulge: 0.015,
});

/** How far past the ellipse's bounding box the deck and bottom reach, as a fraction of a semi-axis. */
const MARGIN = 0.25;
/** Control fractions of the deck's non-affine `x(u)` (cubic) and `y(v)` (quadratic) Bézier maps. */
const DECK_X_FRACTIONS = [0, 0.15, 0.8, 1] as const;
const DECK_Y_FRACTIONS = [0, 0.35, 1] as const;
/** Interior knots (deliberately non-uniform) of the deck (degree 6 × 4) and the bottom (bicubic). */
const DECK_U_BREAKS = [0.2, 0.45, 0.7] as const;
const DECK_V_BREAKS = [0.3, 0.6] as const;
const BOTTOM_U_BREAKS = [0.18, 0.5, 0.71] as const;
const BOTTOM_V_BREAKS = [0.4] as const;
const DECK_DEGREES = [6, 4] as const;
const BOTTOM_DEGREES = [3, 3] as const;
/** Data samples per control point and direction for the surface fits (over-determined, as a converter fits). */
const SAMPLES_PER_CONTROL_POINT = 3;
/**
 * Blends `s` of the band's sections, bottom edge to deck edge (5 sections: a cubic skin with
 * an interior knot), also the skin's `v` parameters (so `v = s` on the whole band).
 */
const SECTION_BLENDS = [0, 0.25, 0.5, 0.75, 1] as const;

const evalQuadratic = (q: HeightQuadratic, x: number, y: number): number =>
  q.c0 + q.cx * x + q.cy * y + q.cxx * x * x + q.cxy * x * y + q.cyy * y * y;

/** `∂z/∂x`, `∂z/∂y` of a quadratic height field. */
const gradQuadratic = (q: HeightQuadratic, x: number, y: number): readonly [number, number] => [
  q.cx + 2 * q.cxx * x + q.cxy * y,
  q.cy + q.cxy * x + 2 * q.cyy * y,
];

/** Bernstein value of degree `n` with coefficients `c` at `t`. */
function bernstein(c: readonly number[], t: number): number {
  // de Casteljau, exact enough for a parameter map and independent of the B-spline code.
  const w = [...c];
  for (let r = 1; r < w.length; r++)
    for (let i = 0; i < w.length - r; i++) w[i] = (1 - t) * w[i]! + t * w[i + 1]!;
  return w[0]!;
}

/** Interior `breaks` with multiplicity 1 between clamped ends of multiplicity `p + 1`. */
function splineBasis(p: number, breaks: readonly number[]) {
  return clampedBasis(
    p,
    knotsFromBreaks([0, ...breaks, 1], [p + 1, ...breaks.map(() => 1), p + 1]),
  );
}

/**
 * A height field over `[−A, A] × [−B, B]` (`A = a (1 + MARGIN)`), sampled on a grid
 * through the maps `x(u)`, `y(v)` and fitted by `approximateSurface` with explicit
 * parameters, so the data lie in the spline space and the fit reproduces them.
 */
function fitHeightField(
  q: HeightQuadratic,
  degrees: readonly [number, number],
  uBreaks: readonly number[],
  vBreaks: readonly number[],
  xOf: (u: number) => number,
  yOf: (v: number) => number,
  tol: Partial<Tolerances> | undefined,
): { readonly surface: NurbsSurface; readonly maxError: number } {
  const bu = splineBasis(degrees[0], uBreaks);
  const bv = splineBasis(degrees[1], vBreaks);
  const nu = SAMPLES_PER_CONTROL_POINT * bu.count;
  const nv = SAMPLES_PER_CONTROL_POINT * bv.count;
  const points: number[] = [];
  const uv: number[] = [];
  for (let i = 0; i < nu; i++) {
    const u = i / (nu - 1);
    for (let j = 0; j < nv; j++) {
      const v = j / (nv - 1);
      const x = xOf(u);
      const y = yOf(v);
      points.push(x, y, evalQuadratic(q, x, y));
      uv.push(u, v);
    }
  }
  const r = approximateSurface(points, { uv }, { u: bu, v: bv, ...(tol ? { tol } : {}) });
  if (!r.ok) {
    fail('not-converged', `curvedPuckSolid: a height-field fit failed`, { issues: r.issues });
  }
  return { surface: r.value.surface, maxError: r.value.maxError };
}

/** Binomial coefficients `C(2, i)` and `C(4, k)`. */
const BINOM2 = [1, 2, 1] as const;
const BINOM4 = [1, 4, 6, 4, 1] as const;

/** Product of two quadratic Bernstein polynomials as a quartic one (`h_k = Σ C(2,i)C(2,j)/C(4,k) f_i g_j`). */
function product(f: readonly number[], g: readonly number[]): number[] {
  const h = [0, 0, 0, 0, 0];
  for (let i = 0; i <= 2; i++)
    for (let j = 0; j <= 2; j++)
      h[i + j]! += (BINOM2[i]! * BINOM2[j]! * f[i]! * g[j]!) / BINOM4[i + j]!;
  return h;
}

/**
 * The closed curve `(ρ a c, ρ b s, z(c, s))` over the 9-point unit circle `(c, s)`,
 * with `z = z(a c, b s)` the quadratic `q` evaluated on the unscaled ellipse: an
 * exact rational quartic, four Bézier arcs joined at knots of multiplicity 4.
 */
function ellipseSection(a: number, b: number, rho: number, q: HeightQuadratic): ClampedCurve<3> {
  const unit = circle({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 1);
  // Coefficients of z in (c, s): z = z0 + zc c + zs s + zcc c² + zcs c s + zss s².
  const zc = q.cx * a;
  const zs = q.cy * b;
  const zcc = q.cxx * a * a;
  const zcs = q.cxy * a * b;
  const zss = q.cyy * b * b;
  const cw: number[] = [];
  for (let arc = 0; arc < 4; arc++) {
    const C: number[] = [];
    const S: number[] = [];
    const W: number[] = [];
    for (let i = 0; i <= 2; i++) {
      const k = (2 * arc + i) * 4;
      C.push(unit.cw[k]!);
      S.push(unit.cw[k + 1]!);
      W.push(unit.cw[k + 3]!);
    }
    const CW = product(C, W);
    const SW = product(S, W);
    const WW = product(W, W);
    const CC = product(C, C);
    const CS = product(C, S);
    const SS = product(S, S);
    // Each arc's first point is the previous arc's last: skip it after the first arc.
    for (let k = arc === 0 ? 0 : 1; k <= 4; k++) {
      cw.push(
        rho * a * CW[k]!,
        rho * b * SW[k]!,
        q.c0 * WW[k]! + zc * CW[k]! + zs * SW[k]! + zcc * CC[k]! + zcs * CS[k]! + zss * SS[k]!,
        WW[k]!,
      );
    }
  }
  const basis = clampedBasis(4, knotsFromBreaks([0, 0.25, 0.5, 0.75, 1], [5, 4, 4, 4, 5]));
  return curveFromHomogeneous({ dim: 3, basis, cw }) as ClampedCurve<3>;
}

/**
 * The same closed curve as a periodic quartic: one period of knots (the four
 * arc joins, each of multiplicity 4 = the degree) and 16 unique control points.
 * With the periodic convention (basis function `i` multiplies control point
 * `i mod n`) a knot of multiplicity `p` at 0 puts `C(0)` on the last control
 * point, so the unique points are the clamped ones without the first (which
 * repeats the last), as in `periodicCircle`.
 */
function periodicSection(c: ClampedCurve<3>): NurbsCurve<3> {
  const basis = periodicBasis(4, knotsFromBreaks([0, 0.25, 0.5, 0.75], [4, 4, 4, 4]), 1);
  return curveFromHomogeneous({ dim: 3, basis, cw: c.cw.slice(4) });
}

/** The blend `(1 − s) B + s D` of two quadratics. */
const blend = (bq: HeightQuadratic, dq: HeightQuadratic, s: number): HeightQuadratic => ({
  c0: (1 - s) * bq.c0 + s * dq.c0,
  cx: (1 - s) * bq.cx + s * dq.cx,
  cy: (1 - s) * bq.cy + s * dq.cy,
  cxx: (1 - s) * bq.cxx + s * dq.cxx,
  cxy: (1 - s) * bq.cxy + s * dq.cxy,
  cyy: (1 - s) * bq.cyy + s * dq.cyy,
});

/** The parts of a curved puck, for tests that look inside the construction. */
export interface CurvedPuckParts {
  readonly brep: Brep;
  /** The band's sections (bottom edge first), exact rational quartics. */
  readonly sections: readonly ClampedCurve<3>[];
  /** `skinCurves`' reported error, and the two height-field fits' (data vs surface). */
  readonly skinError: number;
  readonly deckFitError: number;
  readonly bottomFitError: number;
  /** The fitted pcurves' reported 3D deviations (deck, bottom). */
  readonly deckPcurveDeviation: number;
  readonly bottomPcurveDeviation: number;
  /** The deck's and the bottom's maps from parameters to plan position. */
  readonly deckXY: (u: number, v: number) => readonly [number, number];
  readonly bottomXY: (u: number, v: number) => readonly [number, number];
}

/** Options of {@link curvedPuckParts}. */
export interface CurvedPuckOptions {
  /** Passed to the surface fits, `skinCurves` and the pcurve fits. */
  readonly tol?: Partial<Tolerances>;
  readonly sampling?: Partial<EdgeFitSampling>;
  /** Skin periodic sections: a band periodic in `u` (default: clamped closed sections). */
  readonly periodicBand?: boolean;
}

/**
 * Builds V5b (faces: band, bottom, deck; edges: bottom edge, deck edge, seam;
 * two vertices). `tol` and `sampling` go to the fits. Throws `not-converged`
 * when a fit fails or a pcurve does not fit within `tol.fit`.
 */
export function curvedPuckParts(spec: CurvedPuckSpec, opts?: CurvedPuckOptions): CurvedPuckParts {
  const { a, b } = spec;
  const A = a * (1 + MARGIN);
  const B = b * (1 + MARGIN);
  const deckXY = (u: number, v: number): readonly [number, number] => [
    -A + 2 * A * bernstein(DECK_X_FRACTIONS, u),
    -B + 2 * B * bernstein(DECK_Y_FRACTIONS, v),
  ];
  const bottomXY = (u: number, v: number): readonly [number, number] => [
    -A + 2 * A * u,
    -B + 2 * B * v,
  ];
  const deck = fitHeightField(
    spec.deck,
    DECK_DEGREES,
    DECK_U_BREAKS,
    DECK_V_BREAKS,
    (u) => deckXY(u, 0)[0],
    (v) => deckXY(0, v)[1],
    opts?.tol,
  );
  const bottom = fitHeightField(
    spec.bottom,
    BOTTOM_DEGREES,
    BOTTOM_U_BREAKS,
    BOTTOM_V_BREAKS,
    (u) => bottomXY(u, 0)[0],
    (v) => bottomXY(0, v)[1],
    opts?.tol,
  );
  const sections = SECTION_BLENDS.map((s) =>
    ellipseSection(a, b, 1 + 4 * spec.bulge * s * (1 - s), blend(spec.bottom, spec.deck, s)),
  );
  const skin = skinCurves(opts?.periodicBand ? sections.map(periodicSection) : sections, {
    degree: 3,
    params: SECTION_BLENDS,
    ...(opts?.tol ? { tol: opts.tol } : {}),
  });
  const band = skin.surface;
  const bottomEdge = sections[0]!;
  const deckEdge = sections[sections.length - 1]!;
  const seam = isoCurve(band, 'u', 0) as ClampedCurve<3>;
  const vb = controlPoint(bottomEdge, 0);
  const vt = controlPoint(deckEdge, 0);
  const edges: BrepEdge[] = [
    { curve: bottomEdge, start: 0, end: 0 },
    { curve: deckEdge, start: 1, end: 1 },
    { curve: seam, start: 0, end: 1 },
  ];
  const coedge = (edge: number, sense: boolean, pcurve: ClampedCurve<2>) => ({
    edge,
    sense,
    pcurve,
    master: 'curve3d' as const,
  });
  const bandFace: BrepFace = {
    surface: band,
    sameSense: true,
    outer: {
      coedges: [
        coedge(0, true, line2({ x: 0, y: 0 }, { x: 1, y: 0 })),
        coedge(2, true, line2({ x: 1, y: 0 }, { x: 1, y: 1 })),
        coedge(1, false, line2({ x: 0, y: 1 }, { x: 1, y: 1 })),
        coedge(2, false, line2({ x: 0, y: 0 }, { x: 0, y: 1 })),
      ],
    },
    holes: [],
  };
  const pcurveOn = (edge: ClampedCurve<3>, s: NurbsSurface, what: string) => {
    const fit = projectCurveToSurface(edge, s, opts?.tol, opts?.sampling);
    if (!fit.ok || !fit.value.withinTolerance) {
      fail('not-converged', `curvedPuckSolid: the ${what}'s pcurve did not fit within tolerance`, {
        issues: fit.issues,
        ...(fit.ok ? { value: fit.value.maxDeviation } : {}),
      });
    }
    return fit.value;
  };
  const bottomPc = pcurveOn(bottomEdge, bottom.surface, 'bottom');
  const deckPc = pcurveOn(deckEdge, deck.surface, 'deck');
  // The bottom's own normal points up, into the solid; its loop runs against the edge.
  const bottomFace: BrepFace = {
    surface: bottom.surface,
    sameSense: false,
    outer: { coedges: [coedge(0, false, bottomPc.pcurve)] },
    holes: [],
  };
  const deckFace: BrepFace = {
    surface: deck.surface,
    sameSense: true,
    outer: { coedges: [coedge(1, true, deckPc.pcurve)] },
    holes: [],
  };
  const faces = [bandFace, bottomFace, deckFace];
  const brep = unwrapBrep(
    makeBrep({
      vertices: [{ point: vb }, { point: vt }],
      edges,
      faces,
      shells: [{ faces: [0, 1, 2], closed: true }],
      solids: [{ outer: 0, genus: 0 }],
    }),
  );
  return Object.freeze({
    brep,
    sections: Object.freeze(sections),
    skinError: skin.maxError,
    deckFitError: deck.maxError,
    bottomFitError: bottom.maxError,
    deckPcurveDeviation: deckPc.maxDeviation,
    bottomPcurveDeviation: bottomPc.maxDeviation,
    deckXY,
    bottomXY,
  });
}

/** The V5b solid alone (see {@link curvedPuckParts}). */
export function curvedPuckSolid(spec: CurvedPuckSpec, opts?: CurvedPuckOptions): Brep {
  return curvedPuckParts(spec, opts).brep;
}

/** A quadrature value at two resolutions: the finer one, and their difference as its error estimate. */
function refined(coarse: number, fine: number): QuadratureResult {
  return Object.freeze({
    value: fine,
    errorEstimate: Math.abs(fine - coarse),
    evaluations: 0,
    converged: true,
  });
}

/** Polar Gauss–Legendre (radius) × trapezoid (angle) over the ellipse: `∬_E f(x, y) dx dy`. */
function overEllipse(
  a: number,
  b: number,
  f: (x: number, y: number) => number,
  radial: number,
  angular: number,
): number {
  const gl = gaussLegendre(radial);
  let sum = 0;
  for (let k = 0; k < angular; k++) {
    const t = (2 * Math.PI * k) / angular;
    const c = Math.cos(t);
    const s = Math.sin(t);
    for (let i = 0; i < radial; i++) {
      const r = 0.5 * (gl.nodes[i]! + 1);
      sum += 0.5 * gl.weights[i]! * r * f(a * r * c, b * r * s);
    }
  }
  return (sum * a * b * 2 * Math.PI) / angular;
}

/**
 * `∬ g(P, N) dθ ds` over the band's definition `P(θ, s)` (module comment) with
 * `N = P_θ × P_s` (outward: `θ` runs counter-clockwise seen from +z, `s` from the
 * bottom up), by the trapezoid rule in `θ` (`angular` points: exact for
 * trigonometric polynomials of degree below `angular`, spectral for smooth periodic
 * integrands) and Gauss–Legendre in `s` (`order` points: exact for polynomials of
 * degree below `2 · order`). Analytic derivatives; no NURBS code.
 */
function overBand(
  spec: CurvedPuckSpec,
  g: (P: Point3, N: Point3) => number,
  order: number,
  angular: number,
): number {
  const { a, b, deck, bottom, bulge } = spec;
  const gl = gaussLegendre(order);
  let sum = 0;
  for (let k = 0; k < angular; k++) {
    const t = (2 * Math.PI * k) / angular;
    const c = Math.cos(t);
    const sn = Math.sin(t);
    const x0 = a * c;
    const y0 = b * sn;
    // The edge's plan tangent d(x0, y0)/dθ, and the heights and their θ-derivatives there.
    const tx = -a * sn;
    const ty = b * c;
    const zb = evalQuadratic(bottom, x0, y0);
    const zd = evalQuadratic(deck, x0, y0);
    const [bx, by] = gradQuadratic(bottom, x0, y0);
    const [dx, dy] = gradQuadratic(deck, x0, y0);
    const zbT = bx * tx + by * ty;
    const zdT = dx * tx + dy * ty;
    for (let i = 0; i < order; i++) {
      const s = 0.5 * (gl.nodes[i]! + 1);
      const rho = 1 + 4 * bulge * s * (1 - s);
      const rhoS = 4 * bulge * (1 - 2 * s);
      const P = { x: rho * x0, y: rho * y0, z: (1 - s) * zb + s * zd };
      const Pt = { x: rho * tx, y: rho * ty, z: (1 - s) * zbT + s * zdT };
      const Ps = { x: rhoS * x0, y: rhoS * y0, z: zd - zb };
      const N = {
        x: Pt.y * Ps.z - Pt.z * Ps.y,
        y: Pt.z * Ps.x - Pt.x * Ps.z,
        z: Pt.x * Ps.y - Pt.y * Ps.x,
      };
      sum += 0.5 * gl.weights[i]! * g(P, N);
    }
  }
  return (sum * 2 * Math.PI) / angular;
}

const coord = (p: Point3, k: 0 | 1 | 2): number => (k === 0 ? p.x : k === 1 ? p.y : p.z);

/**
 * Independent oracle of V5b's volume, area and centroid, from the spec alone
 * (no NURBS evaluation, no trims, no `integrate.ts`):
 *
 * - By the divergence theorem every quantity is a flux through the boundary:
 *   volume `∮ z n_z dA`, first moments `∮ x_k²/2 n_k dA`. Over the deck and the
 *   bottom (graphs over the exact ellipse, outward `(−D_x, −D_y, 1) dx dy` and
 *   `(B_x, B_y, −1) dx dy`) these are polynomial integrands, integrated over the
 *   ellipse in polar coordinates: Gauss–Legendre in the radius (exact for the
 *   radial degree) and the trapezoid rule in the angle (exact for trigonometric
 *   polynomials of degree below the sample count). The volume terms also have
 *   the closed form `π a b (c0 + cxx a²/4 + cyy b²/4)`, reported separately.
 * - Over the band, the same fluxes through its definition `P(θ, s)` (module
 *   comment): polynomial in `s` and trigonometric polynomials in `θ`, so the
 *   trapezoid rule in `θ` and Gauss–Legendre in `s` are exact as well.
 * - Areas: deck and bottom `∬_E √(1 + |∇z|²) dx dy`, band `∬ |P_θ × P_s|`
 *   (analytic, spectrally convergent in both directions).
 *
 * Every quantity is computed at two resolutions (`radial`, `angular`, `order`
 * and finer), the difference reported as `errorEstimate`. `order` is the band's
 * Gauss–Legendre count in `s` (default 24: at 16 the board's band area is off
 * in the eleventh significant digit, at 24 refining moves it in the fourteenth).
 */
export function curvedPuckOracle(
  spec: CurvedPuckSpec,
  opts?: { readonly order?: number; readonly radial?: number; readonly angular?: number },
): {
  readonly volume: QuadratureResult;
  readonly area: QuadratureResult;
  readonly centroid: Point3;
  readonly faces: {
    readonly deckArea: QuadratureResult;
    readonly bottomArea: QuadratureResult;
    readonly bandArea: QuadratureResult;
  };
  /** `∬_E D dA − ∬_E B dA` in closed form, and the band's flux of `(0, 0, z)`. */
  readonly closedForm: { readonly graphs: number; readonly band: QuadratureResult };
  /**
   * An upper bound of the total length of the two fitted edges (the deck's and the
   * bottom's): each is a graph over the ellipse, no longer than its plan perimeter
   * (at most `π √(2 (a² + b²))`) times `√(1 + G²)`, `G` a bound of `|∇z|` on the
   * ellipse. The gap of a fitted trim leaks into the integrals in proportion to it.
   */
  readonly fittedEdgeLength: number;
} {
  const { a, b, deck, bottom } = spec;
  const order = opts?.order ?? 24;
  const radial = opts?.radial ?? 24;
  const angular = opts?.angular ?? 128;
  // Flux of F through the deck and the bottom over the ellipse (polar rule).
  const graphFlux = (F: (p: Point3) => Point3, R: number, M: number): number =>
    overEllipse(
      a,
      b,
      (x, y) => {
        const zd = evalQuadratic(deck, x, y);
        const [dx, dy] = gradQuadratic(deck, x, y);
        const fd = F({ x, y, z: zd });
        const zb = evalQuadratic(bottom, x, y);
        const [bx, by] = gradQuadratic(bottom, x, y);
        const fb = F({ x, y, z: zb });
        return -fd.x * dx - fd.y * dy + fd.z + (fb.x * bx + fb.y * by - fb.z);
      },
      R,
      M,
    );
  const bandFlux = (F: (p: Point3) => Point3, n: number, m: number): number =>
    overBand(
      spec,
      (P, N) => {
        const f = F(P);
        return f.x * N.x + f.y * N.y + f.z * N.z;
      },
      n,
      m,
    );
  const flux = (F: (p: Point3) => Point3): QuadratureResult =>
    refined(
      graphFlux(F, radial, angular) + bandFlux(F, order, angular),
      graphFlux(F, radial + 8, 2 * angular) + bandFlux(F, order + 8, 2 * angular),
    );
  const volume = flux((p) => ({ x: 0, y: 0, z: p.z }));
  const moments = ([0, 1, 2] as const).map((k) =>
    flux((p) => {
      const h = 0.5 * coord(p, k) * coord(p, k);
      return { x: k === 0 ? h : 0, y: k === 1 ? h : 0, z: k === 2 ? h : 0 };
    }),
  );
  const graphArea = (q: HeightQuadratic): QuadratureResult => {
    const f = (x: number, y: number): number => Math.hypot(1, ...gradQuadratic(q, x, y));
    return refined(
      overEllipse(a, b, f, radial, angular),
      overEllipse(a, b, f, radial + 8, 2 * angular),
    );
  };
  const deckArea = graphArea(deck);
  const bottomArea = graphArea(bottom);
  const bandAreaOf = (n: number, m: number): number =>
    overBand(spec, (_P, N) => Math.hypot(N.x, N.y, N.z), n, m);
  const bandArea = refined(bandAreaOf(order, angular), bandAreaOf(order + 8, 2 * angular));
  const sum = (...r: QuadratureResult[]): QuadratureResult =>
    Object.freeze({
      value: r.reduce((s, x) => s + x.value, 0),
      errorEstimate: r.reduce((s, x) => s + x.errorEstimate, 0),
      evaluations: 0,
      converged: true,
    });
  const ellipse = Math.PI * a * b;
  const meanOverEllipse = (q: HeightQuadratic): number =>
    q.c0 + (q.cxx * a * a) / 4 + (q.cyy * b * b) / 4;
  const zFlux = (p: Point3): Point3 => ({ x: 0, y: 0, z: p.z });
  // |∇q| ≤ |q_x| + |q_y|, each bounded term by term with |x| ≤ a, |y| ≤ b.
  const slopeBound = (q: HeightQuadratic): number =>
    Math.abs(q.cx) +
    Math.abs(q.cy) +
    2 * Math.abs(q.cxx) * a +
    Math.abs(q.cxy) * (a + b) +
    2 * Math.abs(q.cyy) * b;
  const planPerimeter = Math.PI * Math.sqrt(2 * (a * a + b * b));
  return Object.freeze({
    volume,
    area: sum(deckArea, bottomArea, bandArea),
    centroid: Object.freeze({
      x: moments[0]!.value / volume.value,
      y: moments[1]!.value / volume.value,
      z: moments[2]!.value / volume.value,
    }),
    faces: Object.freeze({ deckArea, bottomArea, bandArea }),
    closedForm: Object.freeze({
      graphs: ellipse * (meanOverEllipse(deck) - meanOverEllipse(bottom)),
      band: refined(bandFlux(zFlux, order, angular), bandFlux(zFlux, order + 8, 2 * angular)),
    }),
    fittedEdgeLength:
      planPerimeter * (Math.hypot(1, slopeBound(deck)) + Math.hypot(1, slopeBound(bottom))),
  });
}
