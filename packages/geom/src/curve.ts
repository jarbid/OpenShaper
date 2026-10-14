// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * B-spline and NURBS curves: factories, accessors, copy-on-write edits and
 * evaluation (design §6.3).
 *
 * Storage is P&T's homogeneous Pw (decision 2); the API speaks Euclidean points
 * plus separate weights (decision 3). `rational` is derived by the factory
 * (decision 4). Evaluation runs A2.2 / A2.3 and A3.1 / A3.2 on Pw, then A4.2.
 *
 * - Allocating evaluators (`curvePoint`, `curveDerivatives`) validate the
 *   parameter: they throw beyond `paramRel` slack outside a clamped domain and
 *   wrap periodic parameters.
 * - `*Into` kernels clamp or wrap and never throw on the parameter (decision
 *   11); they check buffer sizes (O(1)) and allocate nothing.
 * - Default side at an interior knot is the right-hand limit; at a clamped
 *   domain end the inner side is used.
 */
import { checkOut, makeScratch, scratchFor, toF64, toNumbers } from './array';
import type { Scratch, ScratchImpl } from './array';
import { checkParam, clampedBasis, evalBasisAt, reviveBasis, sanitizeParam, spanOf } from './basis';
import { curveDerivsH, curvePointH, polyCurveDerivs, ratCurveDerivs } from './book/curve';
import { gatherPoints, periodicSpan } from './book/periodic';
import { findSpan as a21 } from './book/basis';
import { curveKnotIns } from './book/refine';
import { fail } from './errors';
import { resolveTolerances } from './tolerance';
import type { Tolerances } from './tolerance';
import type {
  Affine2,
  Affine3,
  Basis,
  ClampedCurve,
  Dim,
  Interval,
  NumArray,
  NurbsCurve,
  PointOf,
  ReadonlyF64,
  Side,
} from './types';

/** A curve as plain JSON-safe arrays: Euclidean points and, if rational, weights. */
export interface CurveJSON {
  readonly dim: Dim;
  readonly kind: 'clamped' | 'periodic';
  readonly degree: number;
  readonly knots: readonly number[];
  readonly period?: number;
  readonly points: readonly number[];
  readonly weights?: readonly number[];
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

function checkDim(dim: unknown): asserts dim is Dim {
  if (dim !== 1 && dim !== 2 && dim !== 3) {
    fail('dimension-mismatch', `curve dimension must be 1, 2 or 3; got ${String(dim)}`, {
      value: dim,
    });
  }
}

/** O(1) structural check that a basis is consistent (it was validated by its factory). */
export function checkBasisShape(b: Basis): void {
  const ok =
    typeof b === 'object' &&
    b !== null &&
    (b.kind === 'clamped' || b.kind === 'periodic') &&
    b.knots instanceof Float64Array &&
    b.knots.length === (b.kind === 'clamped' ? b.count + b.degree + 1 : b.count);
  if (!ok)
    fail('size-mismatch', 'basis is not a validated Basis (use clampedBasis or periodicBasis)');
}

/** Builds Pw from Euclidean points (stride `dim`) and optional weights, validating both. */
export function buildCw(
  dim: number,
  count: number,
  points: ArrayLike<number>,
  weights: ArrayLike<number> | undefined,
): { cw: Float64Array; rational: boolean } {
  if (points.length !== count * dim) {
    fail(
      'size-mismatch',
      `expected ${count} points of dimension ${dim} (${count * dim} values); got ${points.length}`,
      {
        value: points.length,
      },
    );
  }
  if (weights !== undefined && weights.length !== count) {
    fail('size-mismatch', `expected ${count} weights; got ${weights.length}`, {
      value: weights.length,
    });
  }
  const h = dim + 1;
  const cw = new Float64Array(count * h);
  let rational = false;
  for (let i = 0; i < count; i++) {
    const w = weights === undefined ? 1 : weights[i]!;
    checkWeight(w, i);
    if (w !== 1) rational = true;
    for (let c = 0; c < dim; c++) {
      const x = points[i * dim + c]!;
      if (!Number.isFinite(x))
        fail('non-finite', `control point ${i} is not finite`, { index: i, value: x });
      cw[i * h + c] = w * x;
    }
    cw[i * h + dim] = w;
  }
  return { cw, rational };
}

export function checkWeight(w: number, i: number): void {
  if (!Number.isFinite(w))
    fail('non-finite', `weight ${i} is not finite: ${w}`, { index: i, value: w });
  if (!(w > 0))
    fail('weight-not-positive', `weight ${i} must be > 0; got ${w}`, { index: i, value: w });
}

function freezeCurve<D extends Dim, B extends Basis>(
  dim: D,
  basis: B,
  cw: Float64Array,
  rational: boolean,
): NurbsCurve<D> & { readonly basis: B } {
  return Object.freeze({ dim, basis, cw, rational }) as unknown as NurbsCurve<D> & {
    readonly basis: B;
  };
}

/**
 * A curve from Euclidean control points (stride `dim`) and optional weights
 * (default 1: a polynomial B-spline). Validates and copies; `rational` is
 * `false` iff every weight is exactly 1. The basis is kept by reference.
 */
export function makeCurve<D extends Dim, B extends Basis>(spec: {
  readonly dim: D;
  readonly basis: B;
  readonly points: ArrayLike<number>;
  readonly weights?: ArrayLike<number>;
}): NurbsCurve<D> & { readonly basis: B } {
  checkDim(spec.dim);
  checkBasisShape(spec.basis);
  const { cw, rational } = buildCw(spec.dim, spec.basis.count, spec.points, spec.weights);
  return freezeCurve(spec.dim, spec.basis, cw, rational);
}

/** A curve from homogeneous control points `[w·x, …, w]` (stride `dim + 1`). Validates and copies. */
export function curveFromHomogeneous<D extends Dim, B extends Basis>(spec: {
  readonly dim: D;
  readonly basis: B;
  readonly cw: ArrayLike<number>;
}): NurbsCurve<D> & { readonly basis: B } {
  checkDim(spec.dim);
  checkBasisShape(spec.basis);
  const h = spec.dim + 1;
  const count = spec.basis.count;
  if (spec.cw.length !== count * h) {
    fail('size-mismatch', `expected ${count * h} homogeneous values; got ${spec.cw.length}`, {
      value: spec.cw.length,
    });
  }
  const cw = toF64(spec.cw);
  return freezeCurve(spec.dim, spec.basis, cw, checkHomogeneous(cw, count, spec.dim));
}

/**
 * Validates homogeneous control points (stride `dim + 1`): finite coordinates,
 * finite positive weights. Returns `rational` (some weight is not exactly 1).
 */
export function checkHomogeneous(cw: ReadonlyF64, count: number, dim: number): boolean {
  const h = dim + 1;
  let rational = false;
  for (let i = 0; i < count; i++) {
    const w = cw[i * h + dim]!;
    checkWeight(w, i);
    if (w !== 1) rational = true;
    for (let c = 0; c < dim; c++) {
      if (!Number.isFinite(cw[i * h + c]!)) {
        fail('non-finite', `control point ${i} is not finite`, { index: i, value: cw[i * h + c] });
      }
    }
  }
  return rational;
}

/** A Bézier curve of degree `count − 1` on `[0, 1]` (one span, clamped). */
export function bezierCurve<D extends Dim>(
  dim: D,
  points: ArrayLike<number>,
  weights?: ArrayLike<number>,
): ClampedCurve<D> {
  checkDim(dim);
  const count = points.length / dim;
  if (!Number.isInteger(count)) {
    fail('size-mismatch', `${points.length} values do not form points of dimension ${dim}`);
  }
  if (count < 2)
    fail('too-few-points', `a Bézier curve needs ≥ 2 control points; got ${count}`, {
      value: count,
    });
  const knots = new Float64Array(2 * count);
  knots.fill(1, count);
  return makeCurve({ dim, basis: clampedBasis(count - 1, knots), points, weights });
}

/** Last index of the run of knots equal to `U[i]`. */
function runEnd(U: ReadonlyF64, i: number): number {
  let j = i;
  while (j + 1 < U.length && U[j + 1] === U[i]) j++;
  return j;
}
/** First index of the run of knots equal to `U[i]`. */
function runStart(U: ReadonlyF64, i: number): number {
  let j = i;
  while (j > 0 && U[j - 1] === U[i]) j--;
  return j;
}

/**
 * Converts an unclamped (non-periodic) B-spline or NURBS curve on its domain
 * `[knots[p], knots[count]]` to the identical clamped curve, exactly: each
 * domain end is inserted (P&T A5.1) until its multiplicity reaches `p`, then the
 * knots and control points outside the domain are dropped. A clamped input
 * comes back unchanged.
 */
export function clampUnclamped<D extends Dim>(spec: {
  readonly dim: D;
  readonly degree: number;
  readonly knots: ArrayLike<number>;
  readonly points: ArrayLike<number>;
  readonly weights?: ArrayLike<number>;
  readonly tol?: Partial<Tolerances>;
}): ClampedCurve<D> {
  const { dim, degree: p } = spec;
  checkDim(dim);
  if (!Number.isInteger(p) || p < 1)
    fail('invalid-degree', `degree must be an integer ≥ 1; got ${p}`);
  const tol = resolveTolerances(spec.tol);
  const U0 = spec.knots;
  if (U0.length < 2 * (p + 1))
    fail('knot-count', `degree ${p} needs ≥ ${2 * (p + 1)} knots; got ${U0.length}`);
  let U: Float64Array = new Float64Array(U0.length);
  for (let i = 0; i < U0.length; i++) {
    const x = U0[i]!;
    if (!Number.isFinite(x)) fail('non-finite', `knot ${i} is not finite: ${x}`, { index: i });
    if (i > 0 && x < U[i - 1]!)
      fail('knots-decreasing', `knots must be non-decreasing at ${i}`, { index: i });
    U[i] = x;
  }
  const count = U.length - p - 1;
  const a = U[p]!;
  const b = U[count]!;
  if (!(b > a)) fail('empty-domain', `domain [${a}, ${b}] has no length`);
  for (let i = 0; i < U.length; i = runEnd(U, i) + 1) {
    const len = runEnd(U, i) - i + 1;
    const inside = U[i]! > a && U[i]! < b;
    if (len > p + 1 || (inside && len > p)) {
      fail('knot-multiplicity', `knot ${U[i]} has multiplicity ${len}`, { index: i, value: len });
    }
    if (i > 0 && U[i]! - U[i - 1]! < tol.knotRel * (b - a)) {
      fail(
        'knots-near-coincident',
        `knots ${U[i - 1]} and ${U[i]} are closer than knotRel × domain`,
        {
          index: i,
        },
      );
    }
  }
  const h = dim + 1;
  let Pw: Float64Array = buildCw(dim, count, spec.points, spec.weights).cw;
  let n = count - 1;
  // Clamp the start: insert a until its multiplicity is p.
  let k = runEnd(U, p);
  let s = k - runStart(U, p) + 1;
  if (s < p) {
    const ins = curveKnotIns(n, p, U, Pw, h, a, k, s, p - s);
    U = ins.UQ;
    Pw = ins.Qw;
    n += p - s;
    k += p - s;
  }
  const L = k; // last index of the a-run, now of multiplicity ≥ p
  // Clamp the end: insert b until its multiplicity is p. The new knots go after
  // the b-run's first index F, which therefore stays put.
  const F = runStart(U, n + 1);
  const bEnd = runEnd(U, F);
  s = bEnd - F + 1;
  if (s < p) {
    const ins = curveKnotIns(n, p, U, Pw, h, b, bEnd, s, p - s);
    U = ins.UQ;
    Pw = ins.Qw;
    n += p - s;
  }
  // Keep knots L − p … F + p and control points L − p … F − 1: the only ones
  // whose basis functions reach [a, b]; the outermost knot of each end is
  // outside every such support on [a, b], so it is set to a (b) exactly.
  const first = L - p;
  const last = F - 1;
  const knots = U.slice(first, F + p + 1);
  knots[0] = a;
  knots[knots.length - 1] = b;
  const cw = Pw.slice(first * h, (last + 1) * h);
  return curveFromHomogeneous({
    dim,
    basis: clampedBasis(p, knots, spec.tol),
    cw,
  }) as ClampedCurve<D>;
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;
const isArrayLike = (x: unknown): x is ArrayLike<number> =>
  isRecord(x) && typeof (x as { length?: unknown }).length === 'number';

/**
 * Validates an untrusted value back into a curve: a structured clone of a
 * `NurbsCurve` (from a worker) or a {@link CurveJSON}. Everything is
 * re-validated and derived fields (`count`, `domain`, `rational`) are
 * recomputed. The basis is rebuilt, so it is not shared with other curves.
 */
export function reviveCurve(x: unknown): NurbsCurve {
  if (!isRecord(x)) fail('size-mismatch', 'reviveCurve expects a curve object');
  const dim = x.dim;
  checkDim(dim);
  const basisOf = reviveBasis;
  if ('cw' in x) {
    const b = x.basis;
    if (!isRecord(b) || !isArrayLike(x.cw)) fail('size-mismatch', 'cloned curve is malformed');
    return curveFromHomogeneous({
      dim,
      basis: basisOf(b.kind, b.degree, b.knots, b.period),
      cw: x.cw,
    });
  }
  if (!isArrayLike(x.points)) fail('size-mismatch', 'curve JSON has no points');
  if (x.weights !== undefined && !isArrayLike(x.weights))
    fail('size-mismatch', 'curve JSON weights malformed');
  return makeCurve({
    dim,
    basis: basisOf(x.kind, x.degree, x.knots, x.period),
    points: x.points,
    weights: x.weights as ArrayLike<number> | undefined,
  });
}

/**
 * Plain arrays for JSON: Euclidean points and, for a rational curve, weights.
 * `reviveCurve(curveToJSON(c))` is bitwise for polynomial curves; a rational
 * one may differ by an ulp per coordinate (`(w·x)/w·w` rounding).
 */
export function curveToJSON(c: NurbsCurve): CurveJSON {
  const b = c.basis;
  const points = new Float64Array(b.count * c.dim);
  controlPointsInto(c, points);
  const json: CurveJSON = {
    dim: c.dim,
    kind: b.kind,
    degree: b.degree,
    knots: toNumbers(b.knots),
    ...(b.kind === 'periodic' ? { period: b.period } : {}),
    points: toNumbers(points),
    ...(c.rational ? { weights: toNumbers(weightsOf(c)) } : {}),
  };
  return Object.freeze(json);
}

// ---------------------------------------------------------------------------
// Accessors and copy-on-write edits
// ---------------------------------------------------------------------------

function checkIndex(c: NurbsCurve, i: number): void {
  if (!Number.isInteger(i) || i < 0 || i >= c.basis.count) {
    fail('size-mismatch', `control point ${i} is outside [0, ${c.basis.count})`, { index: i });
  }
}

/** Reads a point of dimension `dim` from `a[o …]` as a {@link PointOf}. */
export function pointAt<D extends Dim>(dim: D, a: ArrayLike<number>, o: number): PointOf<D> {
  if (dim === 1) return a[o]! as PointOf<D>;
  if (dim === 2) return { x: a[o]!, y: a[o + 1]! } as PointOf<D>;
  return { x: a[o]!, y: a[o + 1]!, z: a[o + 2]! } as PointOf<D>;
}

/** Euclidean control point `i` (`Pw / w`). */
export function controlPoint<D extends Dim>(c: NurbsCurve<D>, i: number): PointOf<D> {
  checkIndex(c, i);
  const h = c.dim + 1;
  const w = c.cw[i * h + c.dim]!;
  const q = i * h;
  if (c.dim === 1) return (c.cw[q]! / w) as PointOf<D>;
  if (c.dim === 2) return { x: c.cw[q]! / w, y: c.cw[q + 1]! / w } as PointOf<D>;
  return { x: c.cw[q]! / w, y: c.cw[q + 1]! / w, z: c.cw[q + 2]! / w } as PointOf<D>;
}

/** Weight of control point `i`. */
export function controlWeight(c: NurbsCurve, i: number): number {
  checkIndex(c, i);
  return c.cw[i * (c.dim + 1) + c.dim]!;
}

/** All Euclidean control points, stride `dim`, into `out[o …]`. */
export function controlPointsInto(c: NurbsCurve, out: Float64Array, o = 0): void {
  const { dim } = c;
  const n = c.basis.count;
  checkOut(out, o, n * dim, 'controlPointsInto');
  const h = dim + 1;
  for (let i = 0; i < n; i++) {
    const w = c.cw[i * h + dim]!;
    for (let k = 0; k < dim; k++)
      out[o + i * dim + k] = c.rational ? c.cw[i * h + k]! / w : c.cw[i * h + k]!;
  }
}

/** All weights into `out[o …]`. */
export function weightsInto(c: NurbsCurve, out: Float64Array, o = 0): void {
  const n = c.basis.count;
  checkOut(out, o, n, 'weightsInto');
  const h = c.dim + 1;
  for (let i = 0; i < n; i++) out[o + i] = c.cw[i * h + c.dim]!;
}

function weightsOf(c: NurbsCurve): Float64Array {
  const w = new Float64Array(c.basis.count);
  weightsInto(c, w);
  return w;
}

/** Validates an optional index list against `count`; returns it as numbers. */
export function checkIndices(indices: ArrayLike<number>, count: number): void {
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k]!;
    if (!Number.isInteger(i) || i < 0 || i >= count) {
      fail('size-mismatch', `index ${i} is outside [0, ${count})`, { index: k, value: i });
    }
  }
}

/**
 * A copy with new Euclidean control points, keeping weights and the basis (by
 * reference). Without `indices`, `points` holds all `count · dim` values; with
 * them, `points[k·dim …]` replaces control point `indices[k]` (the last entry
 * wins for a repeated index).
 */
export function withControlPoints<C extends NurbsCurve>(
  c: C,
  points: ArrayLike<number>,
  indices?: ArrayLike<number>,
): C {
  const cw = replacePoints(c.cw, c.dim, c.basis.count, points, indices);
  return Object.freeze({ ...c, cw }) as C;
}

/**
 * A copy of the net `cw0` (stride `dim + 1`, `count` points) with new Euclidean
 * points, keeping weights: all of them, or `points[k·dim …]` for control point
 * `indices[k]` (the last entry wins for a repeated index). Validates.
 */
export function replacePoints(
  cw0: ReadonlyF64,
  dim: number,
  count: number,
  points: ArrayLike<number>,
  indices: ArrayLike<number> | undefined,
): Float64Array {
  const h = dim + 1;
  const rows = indices === undefined ? count : indices.length;
  if (points.length !== rows * dim) {
    fail('size-mismatch', `expected ${rows * dim} values; got ${points.length}`, {
      value: points.length,
    });
  }
  if (indices !== undefined) checkIndices(indices, count);
  const cw = Float64Array.from(cw0 as Float64Array);
  for (let k = 0; k < rows; k++) {
    const i = indices === undefined ? k : indices[k]!;
    const w = cw[i * h + dim]!;
    for (let d = 0; d < dim; d++) {
      const x = points[k * dim + d]!;
      if (!Number.isFinite(x))
        fail('non-finite', `control point ${i} is not finite`, { index: i, value: x });
      cw[i * h + d] = w * x;
    }
  }
  return cw;
}

/**
 * A copy with new weights, keeping the Euclidean control points and the basis.
 * Without `indices`, `weights` holds all `count` values; with them,
 * `weights[k]` replaces the weight of control point `indices[k]`. `rational`
 * is re-derived.
 */
export function withWeights<C extends NurbsCurve>(
  c: C,
  weights: ArrayLike<number>,
  indices?: ArrayLike<number>,
): C {
  const { cw, rational } = replaceWeights(c.cw, c.dim, c.basis.count, weights, indices);
  return Object.freeze({ ...c, cw, rational }) as C;
}

/** {@link replacePoints} for weights: Euclidean points kept, `rational` re-derived. */
export function replaceWeights(
  cw0: ReadonlyF64,
  dim: number,
  count: number,
  weights: ArrayLike<number>,
  indices: ArrayLike<number> | undefined,
): { cw: Float64Array; rational: boolean } {
  const h = dim + 1;
  const rows = indices === undefined ? count : indices.length;
  if (weights.length !== rows)
    fail('size-mismatch', `expected ${rows} weights; got ${weights.length}`);
  if (indices !== undefined) checkIndices(indices, count);
  const cw = Float64Array.from(cw0 as Float64Array);
  for (let k = 0; k < rows; k++) {
    const i = indices === undefined ? k : indices[k]!;
    const w = weights[k]!;
    checkWeight(w, i);
    const w0 = cw[i * h + dim]!;
    for (let d = 0; d < dim; d++) cw[i * h + d] = (cw[i * h + d]! / w0) * w;
    cw[i * h + dim] = w;
  }
  let rational = false;
  for (let i = 0; i < count; i++) if (cw[i * h + dim] !== 1) rational = true;
  return { cw, rational };
}

/** The parameter domain: `[a, b]` (clamped) or `[t_0, t_0 + T)` (periodic). */
export function curveDomain(c: NurbsCurve): Interval {
  return c.basis.domain;
}

/**
 * True for a periodic curve, and for a clamped curve whose end points coincide
 * within `point` (closed C⁰). Closed is a query, not a form (design §4.4).
 */
export function isClosed(c: NurbsCurve, tol?: Partial<Tolerances>): boolean {
  if (c.basis.kind === 'periodic') return true;
  const t = resolveTolerances(tol);
  const { dim } = c;
  const h = dim + 1;
  const last = (c.basis.count - 1) * h;
  let d2 = 0;
  for (let k = 0; k < dim; k++) {
    const e = c.cw[k]! / c.cw[dim]! - c.cw[last + k]! / c.cw[last + dim]!;
    d2 += e * e;
  }
  return Math.sqrt(d2) <= t.point;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * The evaluation core: `C` and derivatives to `nDer` at a sanitized `t` in
 * `span`, into `s.f[s.oC …]` (stride `dim`). A2.2 / A2.3 → A3.1 / A3.2 on Pw →
 * A4.2. Periodic spans that wrap gather their control points first.
 */
export function evalCurveSpan(
  c: NurbsCurve,
  t: number,
  span: number,
  nDer: number,
  s: ScratchImpl,
): void {
  const b = c.basis;
  const p = b.degree;
  const dim = c.dim;
  const h = dim + 1;
  const f = s.f;
  evalBasisAt(b, t, span, nDer, s);
  let P: ReadonlyF64 = c.cw;
  let po = (span - p) * h;
  if (po < 0) {
    gatherPoints(c.cw, b.count, h, span, p, f, s.oPw);
    P = f;
    po = s.oPw;
  }
  if (nDer === 0) curvePointH(p, f, s.oN, P, po, h, f, s.oH);
  else curveDerivsH(p, nDer, f, s.oN, P, po, h, f, s.oH);
  if (c.rational) ratCurveDerivs(f, s.oH, dim, nDer, f, s.oC);
  else polyCurveDerivs(f, s.oH, dim, nDer, f, s.oC);
}

function checkNDer(nDer: number): void {
  if (!(nDer === 0 || nDer === 1 || nDer === 2 || nDer === 3)) {
    fail('unsupported', `derivative order must be 0, 1, 2 or 3; got ${nDer}`, { value: nDer });
  }
}

/**
 * Evaluates `[C, C′, …]` to order `nDer` (`dim` values each) into `out[o …]`.
 * Clamps (clamped) or wraps (periodic) `t` and never throws on it; a NaN
 * parameter evaluates at the domain start. Checks scratch and output sizes.
 */
export function curveEvalInto(
  c: NurbsCurve,
  t: number,
  nDer: 0 | 1 | 2 | 3,
  out: Float64Array,
  o: number,
  s: Scratch,
  side?: Side,
): void {
  checkNDer(nDer);
  const sc = scratchFor(s, c.basis.degree, nDer);
  const dim = c.dim;
  checkOut(out, o, (nDer + 1) * dim, 'curveEvalInto');
  const u = sanitizeParam(c.basis, t);
  evalCurveSpan(c, u, spanOf(c.basis, u, side === 'left'), nDer, sc);
  const f = sc.f;
  for (let k = 0; k < (nDer + 1) * dim; k++) out[o + k] = f[sc.oC + k]!;
}

/**
 * The span of a sanitized `t`, walking forward from the previous span `hint`
 * (amortised O(1) for ascending parameters); identical to {@link spanOf}'s
 * right-hand span.
 */
export function spanFromHint(b: Basis, t: number, hint: number): number {
  const U = b.knots;
  if (b.kind === 'clamped') {
    const n = b.count - 1;
    if (hint < b.degree || !(U[hint]! <= t)) return a21(n, b.degree, t, U);
    let k = hint;
    while (k < n && t >= U[k + 1]!) k++;
    return k;
  }
  const n = b.count;
  if (hint < 0 || !(U[hint]! <= t)) return periodicSpan(U, n, t);
  let k = hint;
  while (k < n - 1 && t >= U[k + 1]!) k++;
  return k;
}

/**
 * Evaluates every parameter of `ts` (any order; ascending is amortised O(1)
 * per span search) into `out`, consecutively: sample `i` starts at
 * `i · (nDer + 1) · dim`. Same values as {@link curveEvalInto}, bit for bit
 * (a `Float32Array` output receives them rounded). Right-hand limits.
 */
export function curveEvalBatchInto(
  c: NurbsCurve,
  ts: ReadonlyF64,
  nDer: 0 | 1 | 2 | 3,
  out: NumArray,
  s: Scratch,
): void {
  checkNDer(nDer);
  const sc = scratchFor(s, c.basis.degree, nDer);
  const stride = (nDer + 1) * c.dim;
  checkOut(out, 0, ts.length * stride, 'curveEvalBatchInto');
  const f = sc.f;
  const b = c.basis;
  let span = -1;
  for (let i = 0; i < ts.length; i++) {
    const u = sanitizeParam(b, ts[i]!);
    span = spanFromHint(b, u, span);
    evalCurveSpan(c, u, span, nDer, sc);
    for (let k = 0; k < stride; k++) out[i * stride + k] = f[sc.oC + k]!;
  }
}

/** A3.1 / A4.1: the point at `t`. Throws outside a clamped domain (beyond `paramRel`); wraps periodic. */
export function curvePoint<D extends Dim>(c: NurbsCurve<D>, t: number): PointOf<D> {
  const u = checkParam(c.basis, t, undefined, resolveTolerances());
  const s = makeScratch(c.basis.degree, 0);
  evalCurveSpan(c, u, spanOf(c.basis, u, false), 0, s);
  return pointAt(c.dim, s.f, s.oC);
}

/**
 * A3.2 + A4.2: `[C, C′, …, C^(order)]` at `t`, from the given side of a knot
 * (default right; the inner side at a clamped end). Throws outside a clamped
 * domain or for an explicit side that does not exist there.
 */
export function curveDerivatives<D extends Dim>(
  c: NurbsCurve<D>,
  t: number,
  order: 1 | 2 | 3,
  side?: Side,
): readonly PointOf<D>[] {
  if (!(order === 1 || order === 2 || order === 3)) {
    fail('unsupported', `derivative order must be 1, 2 or 3; got ${order}`, { value: order });
  }
  const u = checkParam(c.basis, t, side, resolveTolerances());
  const s = makeScratch(c.basis.degree, order);
  evalCurveSpan(c, u, spanOf(c.basis, u, side === 'left'), order, s);
  const out: PointOf<D>[] = [];
  for (let k = 0; k <= order; k++) out.push(pointAt(c.dim, s.f, s.oC + k * c.dim));
  return Object.freeze(out);
}

// ---------------------------------------------------------------------------
// Affine maps (NURBS are affinely invariant: map the control points)
// ---------------------------------------------------------------------------

export function checkAffine(m: ArrayLike<number>, len: number): void {
  if (m.length !== len) fail('size-mismatch', `affine map needs ${len} entries; got ${m.length}`);
  for (let i = 0; i < len; i++) {
    if (!Number.isFinite(m[i]!))
      fail('non-finite', `affine map entry ${i} is not finite`, { index: i });
  }
}

/** The image of a 3D curve under a row-major 3×4 affine map; weights and basis kept. */
export function transformCurve<C extends NurbsCurve<3>>(c: C, m: Affine3): C {
  if (c.dim !== 3)
    fail('dimension-mismatch', `transformCurve needs a 3D curve; got dimension ${c.dim}`);
  checkAffine(m, 12);
  const cw = new Float64Array(c.cw.length);
  for (let i = 0; i < c.basis.count; i++) {
    const q = i * 4;
    const [x, y, z, w] = [c.cw[q]!, c.cw[q + 1]!, c.cw[q + 2]!, c.cw[q + 3]!];
    cw[q] = m[0] * x + m[1] * y + m[2] * z + m[3] * w;
    cw[q + 1] = m[4] * x + m[5] * y + m[6] * z + m[7] * w;
    cw[q + 2] = m[8] * x + m[9] * y + m[10] * z + m[11] * w;
    cw[q + 3] = w;
  }
  return Object.freeze({ ...c, cw }) as C;
}

/** The image of a 2D curve under a row-major 2×3 affine map; weights and basis kept. */
export function transformCurve2<C extends NurbsCurve<2>>(c: C, m: Affine2): C {
  if (c.dim !== 2)
    fail('dimension-mismatch', `transformCurve2 needs a 2D curve; got dimension ${c.dim}`);
  checkAffine(m, 6);
  const cw = new Float64Array(c.cw.length);
  for (let i = 0; i < c.basis.count; i++) {
    const q = i * 3;
    const [x, y, w] = [c.cw[q]!, c.cw[q + 1]!, c.cw[q + 2]!];
    cw[q] = m[0] * x + m[1] * y + m[2] * w;
    cw[q + 1] = m[3] * x + m[4] * y + m[5] * w;
    cw[q + 2] = w;
  }
  return Object.freeze({ ...c, cw }) as C;
}
