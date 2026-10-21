// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The plan loop (docs/design/board2.md §3.2, §3.3, decisions 3, 4, 12): the
 * apex loop's plan projection, one periodic cubic B-spline of period 1 with
 * `u = 0` at the tail centre and `u = ½` at the nose centre, counter-clockwise
 * seen from +z.
 *
 * Everything here works on the loop's **Bézier pieces** cut at the tail
 * (`toClamped` at u = 0, then `decomposeBezier`: exact), with the loop
 * parameter measured from the tail, `u ∈ [0, 1]`. On a piece the hodograph
 * is a quadratic Bézier, so the exact questions have closed forms:
 *
 * - the standard-tail certificate (invariant 2): the sign of x′ between its
 *   closed-form roots;
 * - the side certificate (a simple loop): y monotone between the closed-form
 *   roots of y′, so its sign is read at the interval ends;
 * - the exact x and y extremes (length, width, the domain check): roots of x′, y′;
 * - the area inside the loop by Green's theorem: `x y′ − y x′` has degree 5, so a
 *   three-point Gauss–Legendre rule per piece is exact.
 *
 * The plan radius (invariant 3) has no closed form; it is measured on each piece
 * by sampling and golden-section refinement ({@link PLAN_RADIUS_SAMPLING}).
 *
 * Frames and σ: the rail-local frame (`t̂`, inward `n̂ = ẑ × t̂`) and the
 * arc-length fraction σ from the tail centre (§3.2). On a symmetric board the
 * self-mirrored stations u = 0 and ½ get their frames exactly (not computed),
 * and σ is computed on the −y half and mirrored: σ(0) = 0 and σ(½) = ½
 * exactly, and `σ(w) = 1 − σ(1 − w)` bit for bit on (½, 1) (where `1 − w` is
 * exact). A partner station's parameter is the rounded `1 − u` of its master,
 * so a builder that needs the pair bitwise assigns the partner `1 − σ_master`.
 */
import {
  arcLengthTable,
  controlPointsInto,
  curveTangent,
  decomposeBezier,
  gaussLegendre,
  lengthAtParam,
  makeCurve,
  paramAtLength,
  periodicBasis,
  resolveTolerances,
  toClamped,
} from '@openshaper/geom';
import type {
  ArcLengthTable,
  PeriodicBasis,
  PeriodicCurve,
  Point3,
  Tolerances,
} from '@openshaper/geom';
import { PLAN_RADIUS_SAMPLING } from './params';
import type { PlanLoopJSON } from './types';

/** The plan loop as a geom curve. Throws geom's error on a basis geom refuses. */
export function planCurve(plan: PlanLoopJSON, tol?: Partial<Tolerances>): PeriodicCurve<2> {
  const basis: PeriodicBasis = periodicBasis(plan.degree, plan.knots, 1, tol);
  return makeCurve({ dim: 2, basis, points: plan.points });
}

/** Wraps a loop parameter into `[0, 1)` (the frame of "u from the tail"). */
export function wrapUnit(u: number): number {
  if (u >= 0 && u < 1) return u;
  let r = u % 1;
  if (r < 0) r += 1;
  return r < 1 ? r : 0;
}

// ---------------------------------------------------------------------------
// Bézier pieces from the tail
// ---------------------------------------------------------------------------

/**
 * One cubic Bézier piece of the loop: loop parameters `[u0, u1]` measured from
 * the tail (`0 ≤ u0 < u1 ≤ 1`) and its four control points `x0, y0, …, x3, y3`.
 */
export interface PlanPiece {
  readonly u0: number;
  readonly u1: number;
  readonly p: Float64Array;
}

/**
 * The loop cut at the tail centre into its Bézier pieces, in order from u = 0
 * to u = 1 (exact: knot insertion). The first piece starts at u = 0 and the last
 * ends at u = 1 exactly.
 */
export function planPieces(c: PeriodicCurve<2>, tol?: Partial<Tolerances>): readonly PlanPiece[] {
  const [t0] = c.basis.domain;
  const T = c.basis.period;
  // The tail (u = 0) inside the stored period [t0, t0 + T).
  let seam = 0;
  while (seam < t0) seam += T;
  while (seam >= t0 + T) seam -= T;
  const bz = decomposeBezier(toClamped(c, seam, tol));
  const out: PlanPiece[] = [];
  for (const piece of bz) {
    const p = new Float64Array(8);
    controlPointsInto(piece, p, 0);
    const [a, b] = piece.basis.domain;
    out.push(Object.freeze({ u0: (a - seam) / T, u1: (b - seam) / T, p }));
  }
  return Object.freeze(out);
}

/** A cubic Bézier coordinate (`k` = 0 for x, 1 for y) at local `s ∈ [0, 1]`. */
function bez(p: Float64Array, k: number, s: number): number {
  const r = 1 - s;
  return (
    r * r * r * p[k]! +
    3 * r * r * s * p[2 + k]! +
    3 * r * s * s * p[4 + k]! +
    s * s * s * p[6 + k]!
  );
}

/** The hodograph's Bernstein coefficients for coordinate `k` (`dC/ds / 3`). */
function hodo(p: Float64Array, k: number): readonly [number, number, number] {
  return [p[2 + k]! - p[k]!, p[4 + k]! - p[2 + k]!, p[6 + k]! - p[4 + k]!];
}

/** A quadratic Bernstein polynomial at `s`. */
function quad(d: readonly [number, number, number], s: number): number {
  const r = 1 - s;
  return r * r * d[0] + 2 * r * s * d[1] + s * s * d[2];
}

/**
 * The roots in the open interval (0, 1) of the quadratic with Bernstein
 * coefficients `d`, ascending (closed form, with the cancellation-free
 * companion root). A polynomial that is identically zero has no isolated roots
 * and returns none (callers see its zero value).
 */
export function quadraticRoots(d: readonly [number, number, number]): number[] {
  // Power form A s² + B s + C.
  const A = d[0] - 2 * d[1] + d[2];
  const B = 2 * (d[1] - d[0]);
  const C = d[0];
  const roots: number[] = [];
  if (A === 0) {
    if (B !== 0) roots.push(-C / B);
  } else {
    const disc = B * B - 4 * A * C;
    if (disc === 0) roots.push(-B / (2 * A));
    else if (disc > 0) {
      const q = -0.5 * (B + (B >= 0 ? Math.sqrt(disc) : -Math.sqrt(disc)));
      roots.push(q / A);
      if (q !== 0) roots.push(C / q);
    }
  }
  return roots.filter((r) => r > 0 && r < 1).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Invariant 2: the standard-tail certificate
// ---------------------------------------------------------------------------

/**
 * Certifies plan invariant 2 (§3.3, §3.8): x′(u) > 0 on (0, ½) and x′(u) < 0
 * on (½, 1). On each piece x′ is a quadratic; its closed-form roots, the piece
 * ends and u = ½ cut the loop into intervals on which x′ has one sign, read at
 * each interval's midpoint. Intervals within `paramRel` of a tip (u = 0, ½, 1),
 * where x′ vanishes by design, are not judged.
 *
 * Returns `null` when the certificate holds, else the start of the first
 * interval that breaks it (the first u where x′ stops having the sign its half
 * needs; a piece on which x′ is identically zero, a straight transom, fails at
 * its start).
 */
export function standardTailViolation(
  pieces: readonly PlanPiece[],
  tol?: Partial<Tolerances>,
): number | null {
  const slack = resolveTolerances(tol).paramRel;
  const nearTip = (a: number, b: number): boolean =>
    b <= slack || a >= 1 - slack || (a >= 0.5 - slack && b <= 0.5 + slack);
  for (const piece of pieces) {
    const d = hodo(piece.p, 0);
    const h = piece.u1 - piece.u0;
    const cuts = [0, ...quadraticRoots(d), 1];
    // u = ½ splits a piece that straddles it, so each half is judged alone.
    const half = (0.5 - piece.u0) / h;
    if (half > 0 && half < 1) cuts.push(half);
    cuts.sort((a, b) => a - b);
    for (let k = 0; k + 1 < cuts.length; k++) {
      const a = piece.u0 + cuts[k]! * h;
      const b = piece.u0 + cuts[k + 1]! * h;
      if (!(b > a) || nearTip(a, b)) continue;
      const v = quad(d, 0.5 * (cuts[k]! + cuts[k + 1]!));
      const mid = 0.5 * (a + b);
      if (mid < 0.5 ? !(v > 0) : !(v < 0)) return a;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The halves on their own sides of the stringer (a simple loop)
// ---------------------------------------------------------------------------

/**
 * Certifies that the −y half stays on the −y side and the +y half on the +y
 * side: y(u) < 0 on (0, ½) and y(u) > 0 on (½, 1). With the standard-tail
 * certificate (each half a graph over x on the same x-range) this proves the
 * loop **simple**: the halves are the graphs `y = f(x) < 0 < g(x)` and meet only
 * at the tips. It is what §3.2's "u ∈ (0, ½) is the −y side" asks of the data.
 *
 * Exact on the Bézier pieces: the closed-form roots of y′ (a quadratic), the
 * piece ends and u = ½ cut the loop into intervals on which y is monotone, so y
 * has its side on an interval exactly when both ends do. An end at a tip
 * (within `paramRel` of u = 0, ½, 1) sits on the stringer by design, where y
 * is 0 up to rounding: it may be at most `Tolerances.point` on the wrong side.
 * An interval with both ends at tips (a half lying on the stringer) fails, and
 * intervals entirely within `paramRel` of a tip are not judged (as in
 * {@link standardTailViolation}).
 *
 * Returns `null` when the certificate holds, else a loop parameter at which y
 * is on the wrong side (an end of the first interval that breaks it).
 */
export function planSideViolation(
  pieces: readonly PlanPiece[],
  tol?: Partial<Tolerances>,
): number | null {
  const t = resolveTolerances(tol);
  const slack = t.paramRel;
  const atTip = (u: number): boolean => u <= slack || u >= 1 - slack || Math.abs(u - 0.5) <= slack;
  const nearTip = (a: number, b: number): boolean =>
    b <= slack || a >= 1 - slack || (a >= 0.5 - slack && b <= 0.5 + slack);
  for (const piece of pieces) {
    const h = piece.u1 - piece.u0;
    const cuts = [0, ...quadraticRoots(hodo(piece.p, 1)), 1];
    const half = (0.5 - piece.u0) / h;
    if (half > 0 && half < 1) cuts.push(half);
    cuts.sort((a, b) => a - b);
    for (let k = 0; k + 1 < cuts.length; k++) {
      const a = piece.u0 + cuts[k]! * h;
      const b = piece.u0 + cuts[k + 1]! * h;
      if (!(b > a) || nearTip(a, b)) continue;
      // +1 where y must be positive (the +y half), −1 on the −y half.
      const side = 0.5 * (a + b) < 0.5 ? -1 : 1;
      const tipA = atTip(a);
      const tipB = atTip(b);
      if (tipA && tipB) return a;
      const ends: readonly (readonly [number, number, boolean])[] = [
        [a, cuts[k]!, tipA],
        [b, cuts[k + 1]!, tipB],
      ];
      for (const [u, s, tip] of ends) {
        const v = side * bez(piece.p, 1, s);
        if (tip ? !(v >= -t.point) : !(v > 0)) return u;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Exact extremes and area
// ---------------------------------------------------------------------------

/** The loop's exact plan extent and where each extreme is (loop parameter from the tail). */
export interface PlanExtent {
  readonly xMin: number;
  readonly xMax: number;
  readonly yMin: number;
  readonly yMax: number;
  readonly uXMin: number;
  readonly uXMax: number;
  readonly uYMin: number;
  readonly uYMax: number;
}

/**
 * The exact extremes of x and y over the loop: every piece's ends and the
 * closed-form roots of x′ and y′ are the only candidates (rounding only).
 */
export function planExtent(pieces: readonly PlanPiece[]): PlanExtent {
  const ext = { xMin: Infinity, xMax: -Infinity, yMin: Infinity, yMax: -Infinity };
  const at = { uXMin: 0, uXMax: 0, uYMin: 0, uYMax: 0 };
  for (const piece of pieces) {
    const h = piece.u1 - piece.u0;
    for (let k = 0; k < 2; k++) {
      for (const s of [0, ...quadraticRoots(hodo(piece.p, k)), 1]) {
        const v = bez(piece.p, k, s);
        const u = piece.u0 + s * h;
        if (k === 0) {
          if (v < ext.xMin) [ext.xMin, at.uXMin] = [v, u];
          if (v > ext.xMax) [ext.xMax, at.uXMax] = [v, u];
        } else {
          if (v < ext.yMin) [ext.yMin, at.uYMin] = [v, u];
          if (v > ext.yMax) [ext.yMax, at.uYMax] = [v, u];
        }
      }
    }
  }
  return Object.freeze({ ...ext, ...at });
}

/**
 * The signed area inside the loop, `½ ∮ (x dy − y dx)` (Green's theorem):
 * positive for a counter-clockwise loop. Exact to rounding: per piece the
 * integrand `x y′ − y x′` is a polynomial of degree 5 in the local parameter,
 * which the three-point Gauss–Legendre rule integrates exactly.
 */
export function planSignedArea(pieces: readonly PlanPiece[]): number {
  const gl = gaussLegendre(3);
  let sum = 0;
  for (const piece of pieces) {
    const p = piece.p;
    const dx = hodo(p, 0);
    const dy = hodo(p, 1);
    let acc = 0;
    for (let g = 0; g < gl.nodes.length; g++) {
      const s = 0.5 * (gl.nodes[g]! + 1);
      // dC/ds = 3 · (hodograph); the ½ of the GL map and the ½ of Green's formula.
      acc += gl.weights[g]! * (bez(p, 0, s) * 3 * quad(dy, s) - bez(p, 1, s) * 3 * quad(dx, s));
    }
    sum += 0.25 * acc;
  }
  return sum;
}

// ---------------------------------------------------------------------------
// Invariant 3: the plan radius
// ---------------------------------------------------------------------------

/** |κ| of a piece at local `s` (∞ where the speed is exactly zero: a cusp). */
function absCurvature(p: Float64Array, s: number): number {
  const r = 1 - s;
  const ax = p[2]! - p[0]!;
  const ay = p[3]! - p[1]!;
  const bx = p[4]! - p[2]!;
  const by = p[5]! - p[3]!;
  const cx = p[6]! - p[4]!;
  const cy = p[7]! - p[5]!;
  const d1x = 3 * (r * r * ax + 2 * r * s * bx + s * s * cx);
  const d1y = 3 * (r * r * ay + 2 * r * s * by + s * s * cy);
  const d2x = 6 * (r * (bx - ax) + s * (cx - bx));
  const d2y = 6 * (r * (by - ay) + s * (cy - by));
  const speed2 = d1x * d1x + d1y * d1y;
  if (speed2 === 0) return Infinity;
  return Math.abs(d1x * d2y - d1y * d2x) / (speed2 * Math.sqrt(speed2));
}

/** The smallest radius of curvature of the loop and where it is (loop parameter from the tail). */
export interface PlanRadius {
  readonly radius: number;
  readonly u: number;
}

/**
 * The smallest plan radius of curvature, `1 / max |κ|` (§3.3 invariant 3):
 * `samplesPerPiece` samples of |κ| per Bézier piece, then a golden-section
 * search between the neighbours of every sample that is a local maximum
 * ({@link PLAN_RADIUS_SAMPLING}). `Infinity` for a loop with no curvature.
 */
export function planMinRadius(
  pieces: readonly PlanPiece[],
  sampling: {
    readonly samplesPerPiece: number;
    readonly refineSteps: number;
  } = PLAN_RADIUS_SAMPLING,
): PlanRadius {
  const n = sampling.samplesPerPiece;
  const phi = (Math.sqrt(5) - 1) / 2;
  let best = 0;
  let bestU = 0;
  const ks = new Float64Array(n);
  for (const piece of pieces) {
    const h = piece.u1 - piece.u0;
    for (let k = 0; k < n; k++) ks[k] = absCurvature(piece.p, k / (n - 1));
    for (let k = 0; k < n; k++) {
      const v = ks[k]!;
      const left = k > 0 ? ks[k - 1]! : -Infinity;
      const right = k < n - 1 ? ks[k + 1]! : -Infinity;
      if (!(v >= left && v >= right)) continue;
      let s = k / (n - 1);
      let m = v;
      if (Number.isFinite(v)) {
        // Golden-section search for the maximum on the neighbours' bracket.
        let a = Math.max(0, (k - 1) / (n - 1));
        let b = Math.min(1, (k + 1) / (n - 1));
        let x1 = b - phi * (b - a);
        let x2 = a + phi * (b - a);
        let f1 = absCurvature(piece.p, x1);
        let f2 = absCurvature(piece.p, x2);
        for (let it = 0; it < sampling.refineSteps; it++) {
          if (f1 >= f2) {
            b = x2;
            x2 = x1;
            f2 = f1;
            x1 = b - phi * (b - a);
            f1 = absCurvature(piece.p, x1);
          } else {
            a = x1;
            x1 = x2;
            f1 = f2;
            x2 = a + phi * (b - a);
            f2 = absCurvature(piece.p, x2);
          }
        }
        if (f1 > m) [m, s] = [f1, x1];
        if (f2 > m) [m, s] = [f2, x2];
      }
      if (m > best) {
        best = m;
        bestU = piece.u0 + s * h;
      }
    }
  }
  return Object.freeze({ radius: best > 0 ? 1 / best : Infinity, u: bestU });
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/** The rail-local frame at a loop parameter (§3.2): unit plan tangent and inward normal. */
export interface PlanFrame {
  readonly tangent: Point3;
  readonly inward: Point3;
}

const TAIL_FRAME: PlanFrame = Object.freeze({
  tangent: Object.freeze({ x: 0, y: -1, z: 0 }),
  inward: Object.freeze({ x: 1, y: 0, z: 0 }),
});
const NOSE_FRAME: PlanFrame = Object.freeze({
  tangent: Object.freeze({ x: 0, y: 1, z: 0 }),
  inward: Object.freeze({ x: -1, y: 0, z: 0 }),
});

/**
 * The frame at loop parameter `u`: `t̂ = C′/|C′|`, `n̂ = ẑ × t̂ = (−t_y, t_x)`
 * (inward on a counter-clockwise loop). On a symmetric board the stations
 * exactly at u = 0 and ½ get the exact frames (outward `ô = −n̂` = −x̂ at the
 * tail, +x̂ at the nose; §3.2), so rows built on them stay on y = 0 bitwise.
 * `null` where the tangent is degenerate.
 */
export function planFrame(c: PeriodicCurve<2>, u: number, symmetric: boolean): PlanFrame | null {
  const w = wrapUnit(u);
  if (symmetric && w === 0) return TAIL_FRAME;
  if (symmetric && w === 0.5) return NOSE_FRAME;
  const t = curveTangent(c, w);
  if (t === null) return null;
  return Object.freeze({
    tangent: Object.freeze({ x: t.x, y: t.y, z: 0 }),
    inward: Object.freeze({ x: -t.y, y: t.x, z: 0 }),
  });
}

// ---------------------------------------------------------------------------
// σ ↔ u
// ---------------------------------------------------------------------------

/** The plan loop with its arc-length table, for σ ↔ u (§3.2). */
export interface PlanArc {
  readonly curve: PeriodicCurve<2>;
  readonly table: ArcLengthTable;
  readonly symmetric: boolean;
  /** Arc length from the stored domain start to the tail (u = 0). */
  readonly start: number;
  /** Arc length of the loop, and of its −y half (tail to nose). */
  readonly total: number;
  readonly half: number;
}

/** Builds the arc-length data of a plan loop (geom's adaptive table, to `quadRel`). */
export function planArc(
  c: PeriodicCurve<2>,
  symmetric: boolean,
  tol?: Partial<Tolerances>,
): PlanArc {
  const table = arcLengthTable(c, tol);
  const start = lengthAtParam(c, table, 0);
  const total = table.total;
  const ahead = (u: number): number => {
    const s = lengthAtParam(c, table, u) - start;
    return s < 0 ? s + total : s;
  };
  return Object.freeze({ curve: c, table, symmetric, start, total, half: ahead(0.5) });
}

/** Arc length from the tail to `u` (in `[0, total)`). */
function lengthFromTail(a: PlanArc, u: number): number {
  const s = lengthAtParam(a.curve, a.table, u) - a.start;
  return s < 0 ? s + a.total : s;
}

/**
 * σ(u): the arc-length fraction of the loop from the tail centre (§3.2).
 * Symmetric: `ℓ(u) / (2 ℓ(½))` on [0, ½] and `1 − σ(1 − u)` beyond (`1 − u`
 * is exact there), so σ(0) = 0 and σ(½) = ½ exactly and the +y half is the
 * mirror of the −y half bit for bit.
 */
export function sigmaAt(a: PlanArc, u: number): number {
  const w = wrapUnit(u);
  if (!a.symmetric) return lengthFromTail(a, w) / a.total;
  if (w <= 0.5) return w === 0 ? 0 : lengthFromTail(a, w) / (2 * a.half);
  return 1 - sigmaAt(a, 1 - w);
}

/**
 * u(σ), the inverse of {@link sigmaAt} (geom's bracketed Newton on the table,
 * to `paramRel`), in `[0, 1)`. Symmetric: σ = 0 and ½ map to 0 and ½ exactly,
 * and `u(1 − σ) = 1 − u(σ)`.
 */
export function paramAtSigma(a: PlanArc, sigma: number, tol?: Partial<Tolerances>): number {
  const s = wrapUnit(sigma);
  if (a.symmetric) {
    if (s === 0) return 0;
    if (s === 0.5) return 0.5;
    if (s > 0.5) return 1 - paramAtSigma(a, 1 - s, tol);
    return wrapUnit(paramAtLength(a.curve, a.table, a.start + s * 2 * a.half, tol));
  }
  return wrapUnit(paramAtLength(a.curve, a.table, a.start + s * a.total, tol));
}
