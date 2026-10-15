// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Continuity measures (design §6.18, definitions in §11.4, decision 31).
 *
 * geom **measures**; it never decides what is acceptable. Acceptance limits
 * (0.1° at the apex, a curvature jump a shaper can feel) are product decisions
 * and reach {@link classifyContinuity} as required thresholds with no defaults.
 *
 * **Across an edge between two faces.** The edge is a 3D curve `C(t)`; each
 * side is a surface `S_X` with either a same-parameter pcurve `p_X(t)`
 * ({@link edgeContinuity}) or one of its natural boundaries
 * ({@link boundaryContinuity}). At each sample:
 *
 * - **Gap (G0)** = the largest of `|S_A − S_B|`, `|C − S_A|`, `|C − S_B|`.
 * - **Normal angle (G1)** between the faces' oriented normals
 *   `n_X = σ_X · Su × Sv / |Su × Sv|` (`σ_X = +1` when `sameSense`, else −1),
 *   as `atan2(|n_A × n_B|, n_A · n_B)` (accurate at 0 and π, unlike `acos`).
 * - **Curvature mismatch (G2)** = `|κ_A − κ_B|`, with `κ_X = σ_X · II(b, b)/I(b, b)`
 *   the normal curvature of face X across the edge, in the direction
 *   `b_X = n_X × t̂` (`t̂` the edge's unit tangent; positive where the face
 *   bends towards its oriented normal, design §4.7). Across a G1 edge the
 *   tangent planes coincide, so the faces' normal curvatures along the edge
 *   agree already and G2 holds iff the cross-edge ones do; the sign of `b` is
 *   irrelevant (`II` is quadratic). Using each face's own `b_X` equals §11.4's
 *   `b = n_A × t̂` projected into B's tangent plane (both are the unit vector
 *   of that plane perpendicular to `t̂`), and stays defined at a 90° crease.
 * - **Curvature** = `max(|κ_A|, |κ_B|)`, the scale for a relative threshold.
 *
 * A sample where a normal is degenerate (a pole, a collapsed edge), the edge's
 * tangent is at its rounding floor, or `t̂` is within `angle` of a normal is
 * flagged `SAMPLE_DEGENERATE`; its angle, mismatch and curvature read 0 and are
 * left out of the maxima and RMS values (the gap is always measured).
 *
 * **Sampling.** `samplesPerSpan` Gauss–Legendre points on every span of the
 * union of the curves' breakpoints (edge and both pcurves; for boundaries, A's
 * and B's mapped onto the edge by projection) and, for pcurves, of the
 * parameters where a pcurve crosses an interior knot line of its surface
 * (found on the pcurve's Bézier pieces, as trimming does): `S(p(t))` is only
 * piecewise smooth across such a crossing, so one Gauss rule must not span
 * it. A periodic pcurve contributes its own knots only. The arrays hold these
 * samples in ascending `t`. The **RMS** of each measure is weighted by arc length,
 * `√(Σ wᵢ |C′(tᵢ)| mᵢ² / Σ wᵢ |C′(tᵢ)|)` with the Gauss weights `wᵢ`: the
 * quadrature of `√(∫ m² ds / ∫ ds)`, so it does not depend on the edge's
 * parameterisation and converges as the samples increase (on a collapsed edge,
 * where the arc length is 0, the gap RMS is weighted by parameter instead).
 * With `refineMax`
 * the **maximum** is also taken at both ends of the edge (its vertices) and
 * refined by golden-section search round the worst sample, between its
 * neighbours; it is then ≥ every array entry, and still a lower bound of the
 * true supremum (a search, not a certificate). For {@link boundaryContinuity}
 * the maximum **gap** is also taken from B's boundary to A's (see there), so
 * it does not depend on the order of the sides.
 *
 * **Along a curve.** {@link knotContinuity} compares one-sided derivatives at a
 * parameter of one curve (parametric C^k and geometric G^k);
 * {@link curveJoinContinuity} measures where one curve's end meets another's
 * start. G2 for curves means equal **curvature vectors**
 * `K = (C″ − (C″·T)T)/|C′|²`, so the curvature jump is `|K⁺ − K⁻|`: in the
 * plane, with a common tangent, the jump of signed curvature.
 */
import { makeScratch } from './array';
import type { ScratchImpl } from './array';
import { breakpoints, checkParam, sanitizeParam, spanOf } from './basis';
import { curvePoint, evalCurveSpan } from './curve';
import { curveOnSurface } from './curve-on-surface';
import { speedFloor } from './curve-measure';
import { fail } from './errors';
import { closestPointOnCurve, projectPointsToCurveInto } from './project';
import { bezierPieces, crossings, ctrl } from './pieces';
import { gaussLegendre, GL_MAX_ORDER } from './quadrature';
import { boundaryCurve, checkSurfaceShape, evalSurfaceSpan, localMagnitude } from './surface';
import { MEASURE_FORMS, MEASURE_N, SAMPLE_DEGENERATE, surfaceMeasureAt } from './surface-measure';
import { resolveTolerances } from './tolerance';
import type { Tolerances } from './tolerance';
import type {
  Basis,
  ClampedCurve,
  NurbsCurve,
  NurbsSurface,
  ReadonlyF64,
  ReadonlyU8,
  Side,
  SurfaceEdge,
} from './types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One face along an edge: its surface, its same-parameter pcurve and orientation. */
export interface EdgeSide {
  readonly surface: NurbsSurface;
  /** `p(t)` in the surface's (u, v), on the same parameter domain as the edge curve. */
  readonly pcurve: NurbsCurve<2>;
  /** Whether the face's outward normal is `+Su × Sv` (design §4.7). */
  readonly sameSense: boolean;
  /**
   * The side of the pcurve the face lies on, looking along increasing `t` in
   * (u, v). It picks the one-sided surface limit where the pcurve runs along a
   * knot line of the surface, which matters where the surface is not C² there.
   * Default: the side the pcurve moves into (right-hand limits, as
   * `curveOnSurfaceEvalInto`). A natural boundary has one side only, so it
   * needs none.
   */
  readonly interior?: Side;
}

/** One face along an edge that is one of its surface's natural boundaries. */
export interface BoundarySide {
  readonly surface: NurbsSurface;
  /** The natural boundary (its fixed direction must be clamped). */
  readonly edge: SurfaceEdge;
  /** Whether the face's outward normal is `+Su × Sv`. */
  readonly sameSense: boolean;
}

/** Sampling options of the edge measures (§11.4). */
export interface ContinuitySampling {
  /**
   * Gauss–Legendre points per span, 1 … `GL_MAX_ORDER`. Default for
   * {@link edgeContinuity}: `D + 1` (capped at `GL_MAX_ORDER`), `D` the highest
   * degree of the polynomial curves the gap is made of: the edge and
   * `S_X(p_X(t))`, of degree `(deg_u + deg_v) · deg p_X` for a polynomial surface
   * (a tensor product of degrees `deg_u`, `deg_v` composed with a pcurve of
   * degree `deg p_X`). `n = D + 1` points integrate the square of such a
   * degree-`D` polynomial exactly, so the RMS gap of polynomial sides is exact
   * (when the speed is also polynomial, i.e. the edge runs straight in a
   * coordinate); for rational sides, `√` and the normal-dependent measures it
   * converges as `n` grows, it is not exact. Default for
   * {@link boundaryContinuity}: the highest surface degree + 1.
   */
  readonly samplesPerSpan?: number;
  /** Refine the maxima (ends and golden-section search). Default `true`. */
  readonly refineMax?: boolean;
  /** Golden-section steps per refined maximum. Default 40 (see {@link DEFAULT_CONTINUITY_SAMPLING}). */
  readonly refineSteps?: number;
  readonly tol?: Partial<Tolerances>;
}

/**
 * Defaults of {@link ContinuitySampling} that are not derived from the input
 * (`samplesPerSpan` is: composed degree + 1, see {@link ContinuitySampling}).
 *
 * - `refineMax: true`: a maximum between samples is the number a caller
 *   compares with a threshold; refining it costs ~3 · 40 evaluations.
 * - `refineSteps: 40`: each golden-section step keeps 0.618 of the bracket,
 *   so 40 steps leave 0.618⁴⁰ ≈ 4·10⁻⁹ of two sample spacings. Round a smooth
 *   maximum the value error is quadratic in that (≈ 10⁻¹⁷ relative: rounding);
 *   at a kink of slope `s` it is ≈ 4·10⁻⁹ · spacing · s.
 */
export const DEFAULT_CONTINUITY_SAMPLING = Object.freeze({
  refineMax: true,
  refineSteps: 40,
} as const);

/** The four measures, as one record (maxima, their parameters, RMS values). */
export interface ContinuityMeasures {
  readonly gap: number;
  readonly normalAngle: number;
  readonly curvatureMismatch: number;
  readonly curvature: number;
}

/** The measures sampled along an edge and their summaries (module comment). */
export interface ContinuityProfile {
  /** Sample parameters, ascending (Gauss points of every span). */
  readonly t: ReadonlyF64;
  readonly gap: ReadonlyF64;
  /** Radians, in [0, π]. */
  readonly normalAngle: ReadonlyF64;
  readonly curvatureMismatch: ReadonlyF64;
  /** `max(|κ_A|, |κ_B|)` across the edge. */
  readonly curvature: ReadonlyF64;
  /** `SAMPLE_DEGENERATE` where the angle and curvatures are undefined (they read 0). */
  readonly flags: ReadonlyU8;
  /** Number of flagged samples. */
  readonly degenerate: number;
  /** Largest value (samples, and with `refineMax` the ends and the refinement). */
  readonly max: ContinuityMeasures;
  /** Edge parameter of each maximum. */
  readonly argmax: ContinuityMeasures;
  /** Arc-length-weighted RMS over the samples. */
  readonly rms: ContinuityMeasures;
}

/** Where one curve's end meets another's start. */
export interface JoinContinuity {
  readonly gap: number;
  /** Radians, in [0, π]; 0 where `degenerate`. */
  readonly tangentAngle: number;
  /** `|K_b − K_a|` of the curvature vectors; 0 where `degenerate`. */
  readonly curvatureMismatch: number;
  /** A tangent is at its rounding floor (a cusp or collapsed points): no G1/G2 measure. */
  readonly degenerate: boolean;
}

/** Continuity of one curve at a parameter, from its one-sided derivatives. */
export interface KnotContinuity {
  /** Number of one-sided derivatives (1 … 3) that agree: C^k, capped at 3. */
  readonly parametric: 0 | 1 | 2 | 3;
  /** G^k: 1 when the unit tangents agree within `angle`, 2 when the curvature vectors also agree. */
  readonly geometric: 0 | 1 | 2;
  readonly jumps: {
    /** `|C′⁺ − C′⁻|`, `|C″⁺ − C″⁻|`, `|C‴⁺ − C‴⁻|`. */
    readonly d1: number;
    readonly d2: number;
    readonly d3: number;
    /** Angle between the one-sided unit tangents (0 where `degenerate`). */
    readonly tangentAngle: number;
    /** `|K⁺ − K⁻|` (0 where `degenerate`). */
    readonly curvature: number;
  };
  /** A one-sided tangent is at its rounding floor: `geometric` is 0, angle and curvature unmeasured. */
  readonly degenerate: boolean;
}

/** Acceptance thresholds: required, geom has no defaults (decision 31). */
export interface ContinuityThresholds {
  /** Largest gap still G0 (length). */
  readonly gap: number;
  /** Largest normal or tangent angle still G1 (radians). */
  readonly angle: number;
  /** Curvature mismatch still G2 relative to `curvature` … */
  readonly curvatureRel: number;
  /** … or absolute (1/length); the larger of the two applies. */
  readonly curvatureAbs: number;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function checkCurveShape(c: NurbsCurve, dims: readonly number[], what: string): void {
  if (typeof c !== 'object' || c === null) fail('size-mismatch', `${what}: expected a curve`);
  const b = c.basis;
  const ok =
    typeof b === 'object' &&
    b !== null &&
    (b.kind === 'clamped' || b.kind === 'periodic') &&
    b.knots instanceof Float64Array &&
    b.knots.length === (b.kind === 'clamped' ? b.count + b.degree + 1 : b.count);
  if (!ok) fail('size-mismatch', `${what}: basis is not a validated Basis`);
  if (!dims.includes(c.dim)) {
    fail('dimension-mismatch', `${what} needs dimension ${dims.join(' or ')}; got ${c.dim}`, {
      value: c.dim,
    });
  }
  if (!(c.cw instanceof Float64Array) || c.cw.length !== b.count * (c.dim + 1)) {
    fail('size-mismatch', `${what}: curve net does not match its basis (use makeCurve)`);
  }
}

function checkSampling(
  o: ContinuitySampling | undefined,
  maxDeg: number,
): { n: number; refine: boolean; steps: number; tol: Tolerances } {
  const n = o?.samplesPerSpan ?? Math.min(maxDeg + 1, GL_MAX_ORDER);
  if (!Number.isInteger(n) || n < 1 || n > GL_MAX_ORDER) {
    fail('unsupported', `samplesPerSpan must be an integer in [1, ${GL_MAX_ORDER}]; got ${n}`, {
      value: n,
    });
  }
  const steps = o?.refineSteps ?? DEFAULT_CONTINUITY_SAMPLING.refineSteps;
  if (!Number.isInteger(steps) || steps < 0) {
    fail('unsupported', `refineSteps must be an integer ≥ 0; got ${steps}`, { value: steps });
  }
  return {
    n,
    refine: o?.refineMax ?? DEFAULT_CONTINUITY_SAMPLING.refineMax,
    steps,
    tol: resolveTolerances(o?.tol),
  };
}

// ---------------------------------------------------------------------------
// One sample across an edge
// ---------------------------------------------------------------------------

/** One side, prepared: a pcurve side, or a boundary side whose parameter is found by projection. */
interface SideCtx {
  readonly s: NurbsSurface;
  readonly sigma: number;
  /** Pcurve side. */
  readonly pcurve: NurbsCurve<2> | null;
  readonly interior: Side | undefined;
  /** Boundary side: its boundary curve (parameter = the running direction's). */
  readonly curve: NurbsCurve<3> | null;
  readonly fixedU: boolean;
  readonly fixedValue: number;
  readonly fixedLeft: boolean;
}

interface EdgeCtx {
  readonly edge: NurbsCurve<3>;
  readonly a: SideCtx;
  readonly b: SideCtx;
  readonly tol: Tolerances;
  readonly sc: ScratchImpl;
  /** Per-side results: S, Su, Sv, n (oriented), E F G L M N: 18 values each. */
  readonly ra: Float64Array;
  readonly rb: Float64Array;
  /** The edge point `C(t)`. */
  readonly rc: Float64Array;
}

/** Offsets inside a side's result block. */
const R_S = 0;
const R_SU = 3;
const R_SV = 6;
const R_N = 9;
const R_FORMS = 12;
const R_LEN = 18;

/** Offsets of one sample's measures in a 6-value block. */
const M_GAP = 0;
const M_ANGLE = 1;
const M_MISMATCH = 2;
const M_CURV = 3;
const M_SPEED = 4;
const M_FLAG = 5;
const M_LEN = 6;

const hasLeft = (b: Basis, x: number): boolean => b.kind === 'periodic' || x > b.domain[0];
/** Right-hand derivatives say the curve moves to smaller values. */
const movesBack = (d1: number, d2: number): boolean => d1 < 0 || (d1 === 0 && d2 < 0);
/** Left-hand derivatives (end of a clamped pcurve) say it came from smaller values. */
const cameFromBelow = (d1: number, d2: number): boolean => d1 > 0 || (d1 === 0 && d2 < 0);

/**
 * Evaluates `SKL` at sanitized `(u, v)` from the given sides and writes S, Su,
 * Sv, the oriented normal and the forms into `r`; returns the measure flags.
 */
function evalSurfaceSide(
  side: SideCtx,
  u: number,
  v: number,
  leftU: boolean,
  leftV: boolean,
  sc: ScratchImpl,
  tol: Tolerances,
  r: Float64Array,
): number {
  const s = side.s;
  evalSurfaceSpan(s, u, v, spanOf(s.u, u, leftU), spanOf(s.v, v, leftV), 2, sc);
  const Mloc = localMagnitude(s.cw, s.u.degree, s.v.degree, sc.iw, 0, sc.iw, sc.maxDegree + 1);
  const flags = surfaceMeasureAt(
    sc.f,
    sc.oS,
    2,
    tol.degenerateRel * Mloc,
    s.u.domain[1] - s.u.domain[0],
    s.v.domain[1] - s.v.domain[0],
    tol.degenerateRel,
    tol.umbilicRel,
    sc.oM,
  );
  const f = sc.f;
  for (let k = 0; k < 9; k++) r[R_S + k] = f[sc.oS + k]!;
  for (let k = 0; k < 3; k++) r[R_N + k] = side.sigma * f[sc.oM + MEASURE_N + k]!;
  for (let k = 0; k < 6; k++) r[R_FORMS + k] = f[sc.oM + MEASURE_FORMS + k]!;
  return flags;
}

/** A pcurve side at edge parameter `t`. */
function evalPcurveSide(
  side: SideCtx,
  t: number,
  sc: ScratchImpl,
  tol: Tolerances,
  r: Float64Array,
): number {
  const pc = side.pcurve!;
  const pb = pc.basis;
  const s = side.s;
  const tt = sanitizeParam(pb, t);
  evalCurveSpan(pc, tt, spanOf(pb, tt, false), 2, sc);
  const f = sc.f;
  const c = sc.oC;
  const u = sanitizeParam(s.u, f[c]!);
  const v = sanitizeParam(s.v, f[c + 1]!);
  const du = f[c + 2]!;
  const dv = f[c + 3]!;
  const ddu = f[c + 4]!;
  const ddv = f[c + 5]!;
  const motion = pb.kind === 'clamped' && tt >= pb.domain[1] ? cameFromBelow : movesBack;
  let leftU = motion(du, ddu);
  let leftV = motion(dv, ddv);
  if (side.interior !== undefined) {
    // The face lies along the pcurve's left normal (−v′, u′), or its negation.
    const k = side.interior === 'left' ? 1 : -1;
    const fu = -k * dv;
    const fv = k * du;
    if (fu !== 0) leftU = fu < 0;
    if (fv !== 0) leftV = fv < 0;
  }
  return evalSurfaceSide(
    side,
    u,
    v,
    leftU && hasLeft(s.u, u),
    leftV && hasLeft(s.v, v),
    sc,
    tol,
    r,
  );
}

/** A boundary side at running parameter `x` of its boundary curve. */
function evalBoundarySide(
  side: SideCtx,
  x: number,
  sc: ScratchImpl,
  tol: Tolerances,
  r: Float64Array,
): number {
  const s = side.s;
  if (side.fixedU) {
    return evalSurfaceSide(
      side,
      side.fixedValue,
      sanitizeParam(s.v, x),
      side.fixedLeft,
      false,
      sc,
      tol,
      r,
    );
  }
  return evalSurfaceSide(
    side,
    sanitizeParam(s.u, x),
    side.fixedValue,
    false,
    side.fixedLeft,
    sc,
    tol,
    r,
  );
}

const dist3 = (a: Float64Array, ao: number, b: Float64Array, bo: number): number =>
  Math.hypot(a[ao]! - b[bo]!, a[ao + 1]! - b[bo + 1]!, a[ao + 2]! - b[bo + 2]!);

/**
 * The normal curvature of a side across the edge, `σ · II(b, b)/I(b, b)` with
 * `b = n × t̂` (its oriented normal), or NaN when `t̂` is within `angle` of
 * the normal (no cross direction). `b = α·Su + β·Sv` from the 2×2 normal
 * equations (EG − F² as |Su × Sv|², without cancellation).
 */
function crossCurvature(
  r: Float64Array,
  sigma: number,
  tx: number,
  ty: number,
  tz: number,
  sinAngle: number,
): number {
  const nx = r[R_N]!;
  const ny = r[R_N + 1]!;
  const nz = r[R_N + 2]!;
  let bx = ny * tz - nz * ty;
  let by = nz * tx - nx * tz;
  let bz = nx * ty - ny * tx;
  const bn = Math.hypot(bx, by, bz);
  if (!(bn > sinAngle)) return NaN;
  bx /= bn;
  by /= bn;
  bz /= bn;
  const [ux, uy, uz] = [r[R_SU]!, r[R_SU + 1]!, r[R_SU + 2]!];
  const [vx, vy, vz] = [r[R_SV]!, r[R_SV + 1]!, r[R_SV + 2]!];
  const E = r[R_FORMS]!;
  const F = r[R_FORMS + 1]!;
  const G = r[R_FORMS + 2]!;
  const L = r[R_FORMS + 3]!;
  const M = r[R_FORMS + 4]!;
  const N = r[R_FORMS + 5]!;
  const cx = uy * vz - uz * vy;
  const cy = uz * vx - ux * vz;
  const cz = ux * vy - uy * vx;
  const det = cx * cx + cy * cy + cz * cz;
  const bu = bx * ux + by * uy + bz * uz;
  const bv = bx * vx + by * vy + bz * vz;
  const al = (G * bu - F * bv) / det;
  const be = (E * bv - F * bu) / det;
  const I = E * al * al + 2 * F * al * be + G * be * be;
  return (sigma * (L * al * al + 2 * M * al * be + N * be * be)) / I;
}

/**
 * Measures one sample at edge parameter `t` into `out[o …]` (6 values:
 * gap, angle, mismatch, curvature, speed, flag). `xb` is side B's boundary
 * parameter when it is already known; NaN projects `C(t)` onto B's boundary
 * curve (global seeding).
 */
function measureSample(ctx: EdgeCtx, t: number, xb: number, out: Float64Array, o: number): void {
  const { edge, sc, tol, ra, rb } = ctx;
  const eb = edge.basis;
  const te = sanitizeParam(eb, t);
  const span = spanOf(eb, te, false);
  evalCurveSpan(edge, te, span, 1, sc);
  const f = sc.f;
  const c = sc.oC;
  const rc = ctx.rc;
  for (let k = 0; k < 3; k++) rc[k] = f[c + k]!;
  let tx = f[c + 3]!;
  let ty = f[c + 4]!;
  let tz = f[c + 5]!;
  const speed = Math.hypot(tx, ty, tz);
  const tangentOk = speed > speedFloor(edge, span, tol);
  // Side A: its pcurve, or (boundary mode) its own boundary, whose curve is the edge.
  const flagsA =
    ctx.a.pcurve !== null
      ? evalPcurveSide(ctx.a, t, sc, tol, ra)
      : evalBoundarySide(ctx.a, te, sc, tol, ra);
  let flagsB: number;
  if (ctx.b.pcurve !== null) flagsB = evalPcurveSide(ctx.b, t, sc, tol, rb);
  else {
    let x = xb;
    if (Number.isNaN(x)) {
      x = closestPointOnCurve(ctx.b.curve!, { x: rc[0]!, y: rc[1]!, z: rc[2]! }, { tol }).t;
    }
    flagsB = evalBoundarySide(ctx.b, x, sc, tol, rb);
  }
  out[o + M_GAP] = Math.max(dist3(ra, R_S, rb, R_S), dist3(rc, 0, ra, R_S), dist3(rc, 0, rb, R_S));
  out[o + M_SPEED] = speed;
  let ok = tangentOk && !(flagsA & SAMPLE_DEGENERATE) && !(flagsB & SAMPLE_DEGENERATE);
  let angle = 0;
  let mismatch = 0;
  let curv = 0;
  if (ok) {
    tx /= speed;
    ty /= speed;
    tz /= speed;
    const sinA = Math.sin(tol.angle);
    // L, M, N are taken against +Su × Sv: σ orients the normal curvatures.
    const ka = crossCurvature(ra, ctx.a.sigma, tx, ty, tz, sinA);
    const kb = crossCurvature(rb, ctx.b.sigma, tx, ty, tz, sinA);
    if (Number.isNaN(ka) || Number.isNaN(kb)) ok = false;
    else {
      // The stored normals are the oriented ones.
      const [ax, ay, az] = [ra[R_N]!, ra[R_N + 1]!, ra[R_N + 2]!];
      const [bx, by, bz] = [rb[R_N]!, rb[R_N + 1]!, rb[R_N + 2]!];
      const cross = Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
      angle = Math.atan2(cross, ax * bx + ay * by + az * bz);
      mismatch = Math.abs(ka - kb);
      curv = Math.max(Math.abs(ka), Math.abs(kb));
    }
  }
  out[o + M_ANGLE] = ok ? angle : 0;
  out[o + M_MISMATCH] = ok ? mismatch : 0;
  out[o + M_CURV] = ok ? curv : 0;
  out[o + M_FLAG] = ok ? 0 : SAMPLE_DEGENERATE;
}

// ---------------------------------------------------------------------------
// Sampling an edge
// ---------------------------------------------------------------------------

/** Sorted distinct values of `xs` inside `[a, b]`, with `a` and `b`, closer than `minGap` merged. */
function spanBreaks(xs: readonly number[], a: number, b: number, minGap: number): number[] {
  const inside = xs.filter((x) => x > a && x < b).sort((p, q) => p - q);
  const out = [a];
  for (const x of inside) if (x - out[out.length - 1]! > minGap && b - x > minGap) out.push(x);
  out.push(b);
  return out;
}

const MEASURES = [M_GAP, M_ANGLE, M_MISMATCH, M_CURV] as const;

/** Samples, summarises and (optionally) refines; `boundaryParams` maps sample parameters to side B's boundary parameters (boundary mode). */
function profileOf(
  ctx: EdgeCtx,
  breaks: readonly number[],
  n: number,
  refine: boolean,
  steps: number,
  boundaryParams: ((ts: Float64Array) => Float64Array) | null,
  reverseGap: (() => { readonly value: number; readonly t: number }) | null = null,
): ContinuityProfile {
  const rule = gaussLegendre(n);
  const spans = breaks.length - 1;
  const N = spans * n;
  const ts = new Float64Array(N);
  const wq = new Float64Array(N);
  for (let i = 0; i < spans; i++) {
    const a = breaks[i]!;
    const b = breaks[i + 1]!;
    const mid = 0.5 * (a + b);
    const half = 0.5 * (b - a);
    for (let j = 0; j < n; j++) {
      ts[i * n + j] = mid + half * rule.nodes[j]!;
      wq[i * n + j] = half * rule.weights[j]!;
    }
  }
  const xb = boundaryParams ? boundaryParams(ts) : null;
  const m = new Float64Array(N * M_LEN);
  for (let i = 0; i < N; i++) measureSample(ctx, ts[i]!, xb ? xb[i]! : NaN, m, i * M_LEN);

  const arrays = MEASURES.map((k) => {
    const a = new Float64Array(N);
    for (let i = 0; i < N; i++) a[i] = m[i * M_LEN + k]!;
    return a;
  });
  const flags = new Uint8Array(N);
  let degenerate = 0;
  for (let i = 0; i < N; i++) {
    flags[i] = m[i * M_LEN + M_FLAG]!;
    if (flags[i]) degenerate++;
  }

  // Arc-length-weighted RMS (the gap over every sample, the others over regular
  // ones). On a collapsed edge (no arc length at all) the gap, which is still
  // measured, is weighted by parameter instead; the others have no samples.
  const rms = MEASURES.map((k) => {
    for (const byArc of k === M_GAP ? [true, false] : [true]) {
      let num = 0;
      let den = 0;
      for (let i = 0; i < N; i++) {
        if (k !== M_GAP && flags[i]) continue;
        const w = byArc ? wq[i]! * m[i * M_LEN + M_SPEED]! : wq[i]!;
        const x = m[i * M_LEN + k]!;
        num += w * x * x;
        den += w;
      }
      if (den > 0) return Math.sqrt(num / den);
    }
    return 0;
  });

  // Maxima over the samples, then the ends and golden-section refinement.
  const [t0, t1] = [breaks[0]!, breaks[spans]!];
  const one = new Float64Array(M_LEN);
  const valueAt = (t: number, k: number): number => {
    measureSample(ctx, t, NaN, one, 0);
    return k !== M_GAP && one[M_FLAG] ? -Infinity : one[k]!;
  };
  const max = [0, 0, 0, 0];
  const argmax = [t0, t0, t0, t0];
  MEASURES.forEach((k, q) => {
    let best = -Infinity;
    let bi = -1;
    for (let i = 0; i < N; i++) {
      if (k !== M_GAP && flags[i]) continue;
      const x = m[i * M_LEN + k]!;
      if (x > best) {
        best = x;
        bi = i;
      }
    }
    let bt = bi >= 0 ? ts[bi]! : t0;
    if (refine) {
      for (const te of [t0, t1]) {
        const x = valueAt(te, k);
        if (x > best) {
          best = x;
          bt = te;
        }
      }
      if (bi >= 0) {
        const r = goldenMax(
          (t) => valueAt(t, k),
          bi > 0 ? ts[bi - 1]! : t0,
          bi < N - 1 ? ts[bi + 1]! : t1,
          steps,
        );
        if (r.value > best) {
          best = r.value;
          bt = r.t;
        }
      }
    }
    if (k === M_GAP && reverseGap) {
      const r = reverseGap();
      if (r.value > best) {
        best = r.value;
        bt = r.t;
      }
    }
    max[q] = best > 0 ? best : 0;
    argmax[q] = bt;
  });

  const rec = (x: readonly number[]): ContinuityMeasures =>
    Object.freeze({ gap: x[0]!, normalAngle: x[1]!, curvatureMismatch: x[2]!, curvature: x[3]! });
  return Object.freeze({
    t: ts,
    gap: arrays[0]!,
    normalAngle: arrays[1]!,
    curvatureMismatch: arrays[2]!,
    curvature: arrays[3]!,
    flags,
    degenerate,
    max: rec(max),
    argmax: rec(argmax),
    rms: rec(rms),
  });
}

/** Golden ratio conjugate `(√5 − 1)/2`: the bracket fraction kept per step. */
const GOLDEN = (Math.sqrt(5) - 1) / 2;

/** Golden-section search for the largest value of `f` on `[lo, hi]` (best point seen). */
function goldenMax(
  f: (t: number) => number,
  lo: number,
  hi: number,
  steps: number,
): { readonly t: number; readonly value: number } {
  let a = lo;
  let b = hi;
  let x1 = b - GOLDEN * (b - a);
  let x2 = a + GOLDEN * (b - a);
  let f1 = f(x1);
  let f2 = f(x2);
  let bt = f1 >= f2 ? x1 : x2;
  let bv = Math.max(f1, f2);
  for (let i = 0; i < steps; i++) {
    if (f1 >= f2) {
      b = x2;
      x2 = x1;
      f2 = f1;
      x1 = b - GOLDEN * (b - a);
      f1 = f(x1);
      if (f1 > bv) {
        bv = f1;
        bt = x1;
      }
    } else {
      a = x1;
      x1 = x2;
      f1 = f2;
      x2 = a + GOLDEN * (b - a);
      f2 = f(x2);
      if (f2 > bv) {
        bv = f2;
        bt = x2;
      }
    }
  }
  return { t: bt, value: bv };
}

// ---------------------------------------------------------------------------
// Public edge measures
// ---------------------------------------------------------------------------

function pcurveSide(side: EdgeSide, what: string, tol: Tolerances): SideCtx {
  if (typeof side !== 'object' || side === null) fail('size-mismatch', `${what}: expected a side`);
  checkSurfaceShape(side.surface);
  checkCurveShape(side.pcurve, [2], `${what} pcurve`);
  if (typeof side.sameSense !== 'boolean')
    fail('unsupported', `${what}: sameSense must be a boolean`);
  if (side.interior !== undefined && side.interior !== 'left' && side.interior !== 'right') {
    fail(
      'unsupported',
      `${what}: interior must be 'left' or 'right'; got ${String(side.interior)}`,
    );
  }
  // Validates that the pcurve stays in the surface's clamped directions.
  curveOnSurface(side.surface, side.pcurve, tol);
  return {
    s: side.surface,
    sigma: side.sameSense ? 1 : -1,
    pcurve: side.pcurve,
    interior: side.interior,
    curve: null,
    fixedU: false,
    fixedValue: 0,
    fixedLeft: false,
  };
}

function checkSameDomain(edge: NurbsCurve, c: NurbsCurve, what: string, tol: Tolerances): void {
  const [a, b] = edge.basis.domain;
  const [ca, cb] = c.basis.domain;
  const slack = tol.paramRel * (b - a);
  if (Math.abs(ca - a) > slack || Math.abs(cb - b) > slack) {
    fail(
      'param-out-of-domain',
      `${what} runs over [${ca}, ${cb}]; a same-parameter edge needs the edge's [${a}, ${b}]`,
      { value: ca },
    );
  }
}

/**
 * The parameters where a clamped pcurve crosses an interior knot line of its
 * surface (the surface is only piecewise smooth across it, so these are span
 * breaks of the sampling). Found on the pcurve's Bézier pieces by the
 * certified search of trimming (`crossings`, `minWidth` in `t`). In a periodic
 * surface direction the knot lines repeat every period. A periodic pcurve
 * yields none (its own knots are breaks already).
 */
function surfaceKnotCrossings(side: EdgeSide, minWidth: number): number[] {
  const out: number[] = [];
  const pc = side.pcurve;
  if (pc.basis.kind !== 'clamped') return out;
  const dirs = [side.surface.u, side.surface.v];
  for (const piece of bezierPieces(pc as ClampedCurve<2>)) {
    for (let k = 0; k < 2; k++) {
      const b = dirs[k]!;
      const br = Array.from(breakpoints(b));
      let lo = Infinity;
      let hi = -Infinity;
      for (let j = 0; j <= piece.p; j++) {
        lo = Math.min(lo, ctrl(piece, j, k));
        hi = Math.max(hi, ctrl(piece, j, k));
      }
      if (b.kind === 'clamped') {
        for (const x of br)
          if (x > b.domain[0] && x < b.domain[1]) crossings(piece, k, x, minWidth, out);
      } else {
        // The lines x + m·period of one period's breakpoints that the piece's box reaches.
        const T = b.period;
        for (const x of br) {
          if (x >= b.domain[0] + T) continue;
          for (let m = Math.floor((lo - x) / T); x + m * T <= hi; m++) {
            if (x + m * T > lo) crossings(piece, k, x + m * T, minWidth, out);
          }
        }
      }
    }
  }
  return out;
}

/**
 * Continuity across an edge `C(t)` between two faces given by same-parameter
 * pcurves (module comment): gap, normal angle, cross-edge curvature mismatch
 * and curvature, per sample and summarised (max with its parameter, RMS).
 * Each pcurve must run over the edge's domain (within `paramRel`) and stay in
 * its surface's clamped directions.
 */
export function edgeContinuity(
  edge: NurbsCurve<3>,
  a: EdgeSide,
  b: EdgeSide,
  opts?: ContinuitySampling,
): ContinuityProfile {
  checkCurveShape(edge, [3], 'edgeContinuity edge');
  const tol = resolveTolerances(opts?.tol);
  const A = pcurveSide(a, 'edgeContinuity side a', tol);
  const B = pcurveSide(b, 'edgeContinuity side b', tol);
  checkSameDomain(edge, a.pcurve, 'side a pcurve', tol);
  checkSameDomain(edge, b.pcurve, 'side b pcurve', tol);
  // Scratch order: the highest basis degree. Default Gauss order: the composed
  // degree D of the gap (see ContinuitySampling.samplesPerSpan).
  const P = Math.max(
    edge.basis.degree,
    a.pcurve.basis.degree,
    b.pcurve.basis.degree,
    a.surface.u.degree,
    a.surface.v.degree,
    b.surface.u.degree,
    b.surface.v.degree,
  );
  const composed = (s: EdgeSide): number =>
    (s.surface.u.degree + s.surface.v.degree) * s.pcurve.basis.degree;
  const o = checkSampling(opts, Math.max(edge.basis.degree, composed(a), composed(b)));
  const [t0, t1] = edge.basis.domain;
  const minGap = o.tol.paramRel * (t1 - t0);
  const breaks = spanBreaks(
    [
      ...breakpoints(edge.basis),
      ...breakpoints(a.pcurve.basis),
      ...breakpoints(b.pcurve.basis),
      ...surfaceKnotCrossings(a, minGap),
      ...surfaceKnotCrossings(b, minGap),
    ],
    t0,
    t1,
    minGap,
  );
  const ctx: EdgeCtx = {
    edge,
    a: A,
    b: B,
    tol: o.tol,
    sc: makeScratch(P, 2),
    ra: new Float64Array(R_LEN),
    rb: new Float64Array(R_LEN),
    rc: new Float64Array(3),
  };
  return profileOf(ctx, breaks, o.n, o.refine, o.steps, null);
}

/** The iso-line pcurve side of a natural boundary, and its exact edge curve. */
function boundarySetup(
  side: BoundarySide,
  what: string,
): {
  readonly fixedU: boolean;
  readonly fixedValue: number;
  readonly fixedLeft: boolean;
  readonly curve: NurbsCurve<3>;
} {
  if (typeof side !== 'object' || side === null) fail('size-mismatch', `${what}: expected a side`);
  checkSurfaceShape(side.surface);
  if (typeof side.sameSense !== 'boolean')
    fail('unsupported', `${what}: sameSense must be a boolean`);
  const curve = boundaryCurve(side.surface, side.edge); // validates the edge name and clamping
  const fixedU = side.edge[0] === 'u';
  const fb = fixedU ? side.surface.u : side.surface.v;
  const last = side.edge[1] === '1';
  return { fixedU, fixedValue: last ? fb.domain[1] : fb.domain[0], fixedLeft: last, curve };
}

/**
 * Continuity where two faces meet along natural boundaries: `a.edge` of
 * `a.surface` against `b.edge` of `b.surface` (in either direction, with any
 * parameterisation). The edge is A's boundary curve (exact); side B's point
 * for each sample is the closest point on B's boundary curve (globally
 * seeded projection), so the per-sample `gap` is the distance from A's
 * boundary to B's, measured from A. Breaks are A's boundary knots and B's
 * mapped onto A by the same projection.
 *
 * `max.gap` is the **symmetric** distance between the boundaries (the larger of
 * the two directed Hausdorff estimates): it also covers the distance from B's
 * boundary, sampled at its ends, breakpoints and `samplesPerSpan` Gauss points
 * per span, to A's, so a B that overhangs A (or only partly shares the edge)
 * does not read G0 just because A was passed first. `argmax.gap` is then the
 * parameter of A's closest point; `gap` arrays and `rms.gap` stay measured
 * from A.
 */
export function boundaryContinuity(
  a: BoundarySide,
  b: BoundarySide,
  opts?: ContinuitySampling,
): ContinuityProfile {
  const sa = boundarySetup(a, 'boundaryContinuity side a');
  const sb = boundarySetup(b, 'boundaryContinuity side b');
  const A: SideCtx = {
    s: a.surface,
    sigma: a.sameSense ? 1 : -1,
    pcurve: null,
    interior: undefined,
    curve: sa.curve,
    fixedU: sa.fixedU,
    fixedValue: sa.fixedValue,
    fixedLeft: sa.fixedLeft,
  };
  const B: SideCtx = {
    s: b.surface,
    sigma: b.sameSense ? 1 : -1,
    pcurve: null,
    interior: undefined,
    curve: sb.curve,
    fixedU: sb.fixedU,
    fixedValue: sb.fixedValue,
    fixedLeft: sb.fixedLeft,
  };
  const edge = sa.curve;
  const P = Math.max(
    a.surface.u.degree,
    a.surface.v.degree,
    b.surface.u.degree,
    b.surface.v.degree,
  );
  const o = checkSampling(opts, P);
  const [t0, t1] = edge.basis.domain;
  const mapped: number[] = [];
  for (const x of breakpoints(sb.curve.basis)) {
    const [e0, e1] = sb.curve.basis.domain;
    const xs = x === e0 ? [e0, e1] : [x];
    for (const y of xs) {
      const p = curvePoint(sb.curve, y);
      mapped.push(closestPointOnCurve(edge, p, { tol: o.tol }).t);
    }
  }
  const breaks = spanBreaks(
    [...breakpoints(edge.basis), ...mapped],
    t0,
    t1,
    o.tol.paramRel * (t1 - t0),
  );
  const ctx: EdgeCtx = {
    edge,
    a: A,
    b: B,
    tol: o.tol,
    sc: makeScratch(P, 2),
    ra: new Float64Array(R_LEN),
    rb: new Float64Array(R_LEN),
    rc: new Float64Array(3),
  };
  const project = (ts: Float64Array): Float64Array => {
    const pts = new Float64Array(3 * ts.length);
    const e = makeScratch(edge.basis.degree, 0);
    for (let i = 0; i < ts.length; i++) {
      const t = sanitizeParam(edge.basis, ts[i]!);
      evalCurveSpan(edge, t, spanOf(edge.basis, t, false), 0, e);
      for (let k = 0; k < 3; k++) pts[3 * i + k] = e.f[e.oC + k]!;
    }
    const xb = new Float64Array(ts.length);
    // Global seeding per point: the samples are too sparse for a warm start's
    // continuity bound to exclude a wrong local foot on a wavy boundary.
    projectPointsToCurveInto(sb.curve, pts, xb, new Float64Array(ts.length), { tol: o.tol });
    return xb;
  };
  // The reverse direction: B's boundary onto A's (ends, breakpoints, Gauss points).
  const reverse = (): { readonly value: number; readonly t: number } => {
    const bb = sb.curve.basis;
    const rule = gaussLegendre(o.n);
    const br = Array.from(breakpoints(bb));
    const xs: number[] = [...br];
    for (let i = 0; i + 1 < br.length; i++) {
      const [lo, hi] = [br[i]!, br[i + 1]!];
      for (let j = 0; j < o.n; j++) xs.push(0.5 * (lo + hi) + 0.5 * (hi - lo) * rule.nodes[j]!);
    }
    let value = 0;
    let at = t0;
    for (const x of xs) {
      const r = closestPointOnCurve(edge, curvePoint(sb.curve, x), { tol: o.tol });
      if (r.distance > value) {
        value = r.distance;
        at = r.t;
      }
    }
    return { value, t: at };
  };
  return profileOf(ctx, breaks, o.n, o.refine, o.steps, project, reverse);
}

// ---------------------------------------------------------------------------
// Along curves
// ---------------------------------------------------------------------------

/** One side of a curve at a parameter: `[C, C′, C″, C‴]` (stride `dim`) and the rounding floors of the derivatives. */
interface OneSide {
  readonly d: Float64Array;
  /** `floor[k]` for `C^(k)`, k = 1 … 3 (index 0 unused). */
  readonly floor: Float64Array;
  /** The speed floor of `speedFloor` (degenerate tangent). */
  readonly speedFloor: number;
}

/**
 * Evaluates one side at a sanitized `t` to third order. The rounding floor of
 * `C^(k)` is `degenerateRel · M · ρ · Σⱼ |N_j^(k)(t)|`: the derivative is a sum
 * of the span's control points (magnitude `M`, largest absolute Euclidean
 * coordinate, as `speedFloor`) times the basis derivatives, so its rounding
 * scales with that sum; `ρ` (max/min weight of the span, 1 when polynomial)
 * bounds the growth through the quotient rule.
 */
function evalSide(
  c: NurbsCurve,
  t: number,
  left: boolean,
  tol: Tolerances,
  sc: ScratchImpl,
): OneSide {
  const b = c.basis;
  const p = b.degree;
  const span = spanOf(b, t, left);
  evalCurveSpan(c, t, span, 3, sc);
  const dim = c.dim;
  const d = Float64Array.from(sc.f.subarray(sc.oC, sc.oC + 4 * dim));
  const h = dim + 1;
  let M = 0;
  let wmin = Infinity;
  let wmax = 0;
  for (let j = 0; j <= p; j++) {
    let i = span - p + j;
    if (i < 0) i += b.count;
    const w = c.cw[i * h + dim]!;
    if (w < wmin) wmin = w;
    if (w > wmax) wmax = w;
    for (let k = 0; k < dim; k++) M = Math.max(M, Math.abs(c.cw[i * h + k]!) / w);
  }
  const floor = new Float64Array(4);
  for (let k = 1; k <= 3; k++) {
    let sum = 0;
    for (let j = 0; j <= p; j++) sum += Math.abs(sc.f[sc.oN + k * (p + 1) + j]!);
    floor[k] = tol.degenerateRel * M * (wmax / wmin) * sum;
  }
  return { d, floor, speedFloor: speedFloor(c, span, tol) };
}

/** `|x − y|` of the k-th derivatives of two sides. */
function jump(x: Float64Array, y: Float64Array, k: number, dim: number): number {
  let s = 0;
  for (let i = 0; i < dim; i++) {
    const e = x[k * dim + i]! - y[k * dim + i]!;
    s += e * e;
  }
  return Math.sqrt(s);
}

/** Unit tangent and curvature vector `(C″ − (C″·T)T)/|C′|²` (3 + 3 values; 2D padded with z = 0). */
function frameOf(d: Float64Array, dim: number): { T: number[]; K: number[]; speed: number } {
  const v = [0, 0, 0];
  const a = [0, 0, 0];
  for (let i = 0; i < dim; i++) {
    v[i] = d[dim + i]!;
    a[i] = d[2 * dim + i]!;
  }
  const speed = Math.hypot(v[0]!, v[1]!, v[2]!);
  const T = v.map((x) => x / speed);
  const at = a[0]! * T[0]! + a[1]! * T[1]! + a[2]! * T[2]!;
  const K = a.map((x, i) => (x - at * T[i]!) / (speed * speed));
  return { T, K, speed };
}

function angle3(a: readonly number[], b: readonly number[]): number {
  const cx = a[1]! * b[2]! - a[2]! * b[1]!;
  const cy = a[2]! * b[0]! - a[0]! * b[2]!;
  const cz = a[0]! * b[1]! - a[1]! * b[0]!;
  return Math.atan2(Math.hypot(cx, cy, cz), a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!);
}

const dist = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

/**
 * Continuity of `c` (2D or 3D) at `t` from its one-sided derivatives (both
 * sides must exist: an interior parameter, or any parameter of a periodic
 * curve, whose seam is `t_0`). A derivative "agrees" when its jump is within
 * the rounding floor of the two sides' derivatives (`evalSide`), so a designed
 * C^k join reads C^k exactly and any real jump does not. Geometric: G1 when
 * the unit tangents agree within `angle` or within the rounding floor of the
 * tangent, `max floor(C′) / min |C′|` (a G1 join whose speed changes is G1,
 * not C1; a C1 join is always G1), G2 when the curvature vectors also agree within the floor
 * propagated from the derivatives' (`(f₂ + 2|C″| f₁/|C′|)/|C′|²`).
 */
export function knotContinuity(
  c: NurbsCurve<2> | NurbsCurve<3>,
  t: number,
  tol?: Partial<Tolerances>,
): KnotContinuity {
  checkCurveShape(c, [2, 3], 'knotContinuity');
  const T = resolveTolerances(tol);
  const b = c.basis;
  const x = checkParam(b, t, undefined, T);
  if (b.kind === 'clamped' && (x === b.domain[0] || x === b.domain[1])) {
    fail('side-unavailable', `knotContinuity needs both sides; ${x} is a clamped end`, { t: x });
  }
  const sc = makeScratch(b.degree, 3);
  const L = evalSide(c, x, true, T, sc);
  const R = evalSide(c, x, false, T, sc);
  const dim = c.dim;
  const d1 = jump(L.d, R.d, 1, dim);
  const d2 = jump(L.d, R.d, 2, dim);
  const d3 = jump(L.d, R.d, 3, dim);
  const ds = [d1, d2, d3];
  let parametric = 0;
  while (
    parametric < 3 &&
    ds[parametric]! <= Math.max(L.floor[parametric + 1]!, R.floor[parametric + 1]!)
  ) {
    parametric++;
  }
  const fl = frameOf(L.d, dim);
  const fr = frameOf(R.d, dim);
  const degenerate = !(fl.speed > L.speedFloor) || !(fr.speed > R.speedFloor);
  let tangentAngle = 0;
  let curvature = 0;
  let geometric: 0 | 1 | 2 = 0;
  if (!degenerate) {
    tangentAngle = angle3(fl.T, fr.T);
    curvature = dist(fl.K, fr.K);
    const kFloor = (s: OneSide, f: { speed: number }): number => {
      const acc = Math.hypot(...Array.from(s.d.subarray(2 * dim, 3 * dim)));
      return (s.floor[2]! + (2 * acc * s.floor[1]!) / f.speed) / (f.speed * f.speed);
    };
    // G1 within `angle` or the rounding of the tangents: a C1 join (jump within
    // the derivatives' floor) is G1 however far from the origin the curve is.
    const angleFloor = Math.max(L.floor[1]!, R.floor[1]!) / Math.min(fl.speed, fr.speed);
    if (tangentAngle <= Math.max(T.angle, angleFloor)) {
      geometric = curvature <= Math.max(kFloor(L, fl), kFloor(R, fr)) ? 2 : 1;
    }
  }
  return Object.freeze({
    parametric: parametric as 0 | 1 | 2 | 3,
    geometric,
    jumps: Object.freeze({ d1, d2, d3, tangentAngle, curvature }),
    degenerate,
  });
}

/**
 * Where curve `a`'s end meets curve `b`'s start (same dimension, 2 or 3): the
 * gap, the angle between the end tangents and the jump of the curvature
 * vectors (module comment). `a` is evaluated from the left at its domain end,
 * `b` from the right at its start; a periodic curve's end is its seam.
 */
export function curveJoinContinuity(
  a: NurbsCurve<2> | NurbsCurve<3>,
  b: NurbsCurve<2> | NurbsCurve<3>,
  tol?: Partial<Tolerances>,
): JoinContinuity {
  checkCurveShape(a, [2, 3], 'curveJoinContinuity a');
  checkCurveShape(b, [2, 3], 'curveJoinContinuity b');
  if (a.dim !== b.dim) {
    fail('dimension-mismatch', `curveJoinContinuity: dimensions differ (${a.dim}, ${b.dim})`);
  }
  const T = resolveTolerances(tol);
  const dim = a.dim;
  const sa = evalSide(a, a.basis.domain[1], true, T, makeScratch(a.basis.degree, 3));
  const sb = evalSide(b, b.basis.domain[0], false, T, makeScratch(b.basis.degree, 3));
  const pa = [sa.d[0]!, sa.d[1]!, dim === 3 ? sa.d[2]! : 0];
  const pb = [sb.d[0]!, sb.d[1]!, dim === 3 ? sb.d[2]! : 0];
  const fa = frameOf(sa.d, dim);
  const fb = frameOf(sb.d, dim);
  const degenerate = !(fa.speed > sa.speedFloor) || !(fb.speed > sb.speedFloor);
  return Object.freeze({
    gap: dist(pa, pb),
    tangentAngle: degenerate ? 0 : angle3(fa.T, fb.T),
    curvatureMismatch: degenerate ? 0 : dist(fa.K, fb.K),
    degenerate,
  });
}

function checkThreshold(x: number, what: string): void {
  if (!Number.isFinite(x)) fail('non-finite', `${what} is not finite: ${x}`, { value: x });
  if (!(x >= 0)) fail('unsupported', `${what} must be ≥ 0; got ${x}`, { value: x });
}

/**
 * Classifies measured continuity against the caller's thresholds (required:
 * acceptance limits are product decisions, decision 31): `'none'` when
 * `gap > th.gap`, `'G0'` when `angle > th.angle`, `'G1'` when
 * `curvatureMismatch > max(th.curvatureAbs, th.curvatureRel · curvature)`,
 * else `'G2'`. Feed it a profile's `max` (`normalAngle` as `angle`), or a
 * join's measures with the larger end curvature.
 */
export function classifyContinuity(
  m: {
    readonly gap: number;
    readonly angle: number;
    readonly curvatureMismatch: number;
    readonly curvature: number;
  },
  th: ContinuityThresholds,
): 'none' | 'G0' | 'G1' | 'G2' {
  for (const k of ['gap', 'angle', 'curvatureRel', 'curvatureAbs'] as const) {
    checkThreshold(th[k], `threshold ${k}`);
  }
  for (const k of ['gap', 'angle', 'curvatureMismatch', 'curvature'] as const) {
    checkThreshold(m[k], `measure ${k}`);
  }
  if (m.gap > th.gap) return 'none';
  if (m.angle > th.angle) return 'G0';
  if (m.curvatureMismatch > Math.max(th.curvatureAbs, th.curvatureRel * m.curvature)) return 'G1';
  return 'G2';
}
