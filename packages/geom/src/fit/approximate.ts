// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Least-squares approximation (design §6.12, solve in §10): curves and
 * surfaces on a fixed or adaptively refined basis, with data weights, exact
 * linear constraints and parameter correction.
 *
 * - Curves follow P&T §9.4.1 (eqs. 9.63–9.69: the normal equations on knots
 *   from eqs. 9.68–9.69, centred: see `approxKnots`) and A9.6
 *   WCLeastSquaresCurve (weighted data, point and derivative constraints held
 *   exactly through Lagrange multipliers). One difference from §9.4.1: the
 *   book fixes `P_0 = Q_0` and `P_n = Q_m` and fits only the interior control
 *   points; here every control point is fitted, so a clamped result need not
 *   pass through the first and last data points (it is the closer fit). The
 *   book's curve is this fit with `point` constraints `C(0) = Q_0` and
 *   `C(1) = Q_m`, which a caller that needs the ends (an edge meeting a
 *   vertex) adds. The
 *   KKT system is solved in range space through the Schur complement
 *   (`lsq.ts`, design §10.4) rather than A9.6's dense inverse; the solution
 *   is the same. Tangent-direction constraints are the linear rows
 *   `n·C′(t) = 0` for the normals `n ⟂ d` (design §10.4: one row in 2D, two in
 *   3D).
 * - Surfaces generalise A9.7 GlobalSurfApproxFixednm: one tensor-product
 *   least-squares solve over all data (scattered or a grid), rather than the
 *   book's row-then-column passes, so weights and constraints apply.
 *
 * Every fit returns what it achieved, measured on the result (design §7):
 * `maxError` and `rmsError` are the largest and root-mean-square distances
 * between each data point of positive weight and the result at that point's
 * final parameter.
 *
 * Failures that valid input can produce are returned, not thrown (design §8):
 * a control point the data do not determine (`schoenberg-whitney`), knots the
 * data crowd together (the basis error), dependent constraints that disagree
 * (`inconsistent-constraints`). Dependent but consistent constraints and
 * residuals above `constraint` are warnings on a successful result.
 */
import { makeScratch } from '../array';
import { breakpoints, clampedBasis, periodicBasis, sanitizeParam } from '../basis';
import { surfMeshParams } from '../book/fit';
import { wrapParam } from '../book/periodic';
import { checkBasisShape, curveEvalInto, makeCurve } from '../curve';
import { errResult, fail, isGeomError, issueOf, okResult } from '../errors';
import { makeSurface, surfaceEvalInto } from '../surface';
import { resolveTolerances } from '../tolerance';
import type { Tolerances } from '../tolerance';
import type {
  Basis,
  Dim,
  GeomIssue,
  NurbsCurve,
  NurbsSurface,
  Point3,
  PointOf,
  ReadonlyF64,
  Result,
  UV,
} from '../types';
import { collocate, curveRows, surfaceRows } from './assemble';
import { boxCentre, checkDegree, pointValues } from './interpolate';
import { solveLsq } from './lsq';
import type { ConstraintRow, LsqOutcome } from './lsq';
import {
  exponentOf,
  isMethod,
  lsqKnots,
  parameterize,
  periodicLsq,
  pointCount,
  shiftParams,
  snappedClamped,
  snappedPeriodic,
} from './param';
import type { Parameterization } from './param';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * An exact linear condition on a fitted curve at parameter `t` (in the
 * curve's domain; periodic: wrapped). Derivatives at an interior knot are
 * right-hand limits. `tangentDirection` asks `C′(t) ∥ direction` (it also
 * admits `C′(t) = 0` and the opposite sense: the condition is linear).
 */
export type CurveConstraint<D extends Dim = Dim> =
  | { readonly kind: 'point'; readonly t: number; readonly value: PointOf<D> }
  | {
      readonly kind: 'derivative';
      readonly t: number;
      readonly order: 1 | 2;
      readonly value: PointOf<D>;
    }
  | { readonly kind: 'tangentDirection'; readonly t: number; readonly direction: PointOf<D> };

/**
 * An exact linear condition on a fitted surface at `uv`: `∂^(du+dv) S / ∂u^du
 * ∂v^dv (uv) = value` (`point` is `du = dv = 0`), on the coordinates selected
 * by the `axes` bitmask (x = 1, y = 2, z = 4; default 7, all three).
 */
export type SurfaceConstraint =
  | { readonly kind: 'point'; readonly uv: UV; readonly value: Point3; readonly axes?: number }
  | {
      readonly kind: 'derivative';
      readonly uv: UV;
      readonly du: 0 | 1 | 2;
      readonly dv: 0 | 1 | 2;
      readonly value: Point3;
      readonly axes?: number;
    };

/** A fitted curve and what it achieved. */
export interface CurveFit<D extends Dim = Dim> {
  readonly curve: NurbsCurve<D>;
  /** Final parameter of each data point (after any parameter correction). */
  readonly params: ReadonlyF64;
  /** Largest distance from a data point of positive weight to the curve at its parameter. */
  readonly maxError: number;
  /** Root mean square of the same distances. */
  readonly rmsError: number;
  /** `maxError ≤ tolerance`. */
  readonly withinTolerance: boolean;
  /**
   * Lagrange multipliers, one per constraint row (KKT form `H x + Cᵀλ = Aᵀ W q`):
   * `point` and `derivative` constraints give one row per coordinate,
   * `tangentDirection` gives `dim − 1` rows, in constraint order. Dependent rows: 0.
   */
  readonly multipliers: ReadonlyF64;
}

/** A fitted surface and what it achieved. */
export interface SurfaceFit {
  readonly surface: NurbsSurface;
  /** Final `(u, v)` of each data point, interleaved (after any parameter correction). */
  readonly params: ReadonlyF64;
  /** Largest distance from a data point of positive weight to the surface at its parameters. */
  readonly maxError: number;
  readonly rmsError: number;
  /** `maxError ≤ tol.fit`. */
  readonly withinTolerance: boolean;
  /** One per constraint row (one row per selected axis, in constraint order). */
  readonly multipliers: ReadonlyF64;
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

function checkWeights(w: ArrayLike<number> | undefined, n: number): Float64Array | null {
  if (w === undefined) return null;
  if (w.length !== n) {
    fail('size-mismatch', `expected ${n} data weights; got ${w.length}`, { value: w.length });
  }
  const out = new Float64Array(n);
  let any = false;
  for (let k = 0; k < n; k++) {
    const x = w[k]!;
    if (!Number.isFinite(x) || x < 0) {
      fail('weight-not-positive', `data weight ${k} must be finite and ≥ 0; got ${x}`, {
        index: k,
        value: x,
      });
    }
    out[k] = x;
    if (x > 0) any = true;
  }
  if (!any) fail('weight-not-positive', 'every data weight is 0: nothing to fit');
  return out;
}

/** Indices of the points of positive weight, or `null` when every point counts. */
function usedIndices(w: Float64Array | null): Int32Array | null {
  if (w === null || w.every((x) => x > 0)) return null;
  const out: number[] = [];
  for (let k = 0; k < w.length; k++) if (w[k]! > 0) out.push(k);
  return Int32Array.from(out);
}

/** The points (stride `dim`) at `used`. */
function pick(points: ArrayLike<number>, dim: number, used: Int32Array): Float64Array {
  const out = new Float64Array(used.length * dim);
  for (let i = 0; i < used.length; i++) {
    for (let c = 0; c < dim; c++) out[i * dim + c] = points[used[i]! * dim + c]!;
  }
  return out;
}

/**
 * Parameters for all `n` points from `uu`, the parameters of the points at
 * `used` (non-decreasing; periodic: in `[0, 1)`, period 1). A point of weight
 * 0 between two used points gets the value interpolated linearly in index;
 * clamped, one before the first (after the last) used point gets the first
 * (last) value; periodic, the interpolation runs across the seam, from the
 * last used point to the first plus one period, wrapped into `[0, 1)`. These
 * parameters place nothing (knots come from `uu`): they are only reported.
 */
function spreadParams(
  uu: Float64Array,
  used: Int32Array,
  n: number,
  periodic: boolean,
): Float64Array {
  const ub = new Float64Array(n);
  const last = used.length - 1;
  const first = used[0]!;
  const end = used[last]!;
  const between = (k: number, i0: number, u0: number, i1: number, u1: number): number =>
    u0 + ((k - i0) / (i1 - i0)) * (u1 - u0);
  for (let k = 0; k < first; k++) {
    ub[k] = periodic
      ? wrapParam(0, 1, between(k + n, end, uu[last]!, first + n, uu[0]! + 1))
      : uu[0]!;
  }
  for (let i = 0; i < last; i++) {
    const a = used[i]!;
    const b = used[i + 1]!;
    ub[a] = uu[i]!;
    for (let k = a + 1; k < b; k++) ub[k] = between(k, a, uu[i]!, b, uu[i + 1]!);
  }
  ub[end] = uu[last]!;
  for (let k = end + 1; k < n; k++) {
    ub[k] = periodic
      ? wrapParam(0, 1, between(k, end, uu[last]!, first + n, uu[0]! + 1))
      : uu[last]!;
  }
  return ub;
}

function checkCount(x: number | undefined, what: string, min: number): void {
  if (x !== undefined && (!Number.isInteger(x) || x < min)) {
    fail('too-few-points', `${what} must be an integer ≥ ${min}; got ${x}`, { value: x });
  }
}

function checkPositive(x: number, what: string): void {
  if (!Number.isFinite(x) || !(x > 0)) {
    fail('unsupported', `${what} must be finite and > 0; got ${x}`, { value: x });
  }
}

/**
 * A basis built from computed knots, or the failure as an issue: knots that
 * clustered data push closer than `knotRel` (or into a multiplicity above the
 * degree) are a data-dependent failure, not a contract violation.
 */
function tryBasis(build: () => Basis): Basis | GeomIssue {
  try {
    return build();
  } catch (e) {
    if (isGeomError(e)) return issueOf(e);
    throw e;
  }
}

function issue(
  code: GeomIssue['code'],
  severity: GeomIssue['severity'],
  message: string,
  index?: number,
  value?: number,
): GeomIssue {
  return {
    code,
    severity,
    message,
    ...(index !== undefined ? { at: { index } } : {}),
    ...(value !== undefined ? { value } : {}),
  };
}

/** The issue for normal equations that are singular or numerically so. */
function undetermined(out: LsqOutcome & { ok: false }): GeomIssue {
  if (out.column < 0) {
    return issue(
      'schoenberg-whitney',
      'error',
      `the data barely determine the control points on these knots (estimated reciprocal condition ${out.rcond} ≤ pivotRel): the solve would be unreliable; use fewer control points, other knots, or more data`,
      undefined,
      out.rcond,
    );
  }
  return issue(
    'schoenberg-whitney',
    'error',
    `control point ${out.column} is not determined by the data (too few data parameters in its support): use fewer control points, other knots, or more data`,
    out.column,
  );
}

/**
 * Checks the constraint outcome: dependent rows within `constraint` are a
 * warning, outside it an error; independent rows above it a warning.
 *
 * A row's residual is judged in length units, as `|C_r x − d_r| / max(1,
 * ‖C_r‖₂)`. Rounding leaves a residual of about `ε‖C_r‖‖x‖`, and a row of
 * derivative order `k` has norm about `(p/h)^k` for knot spacing `h`, so the
 * raw residual of a derivative row grows with the number of control points
 * and with the derivative's size: a C″ row at board scale (300 cm, 300
 * control points) has norm ~5e5 and leaves raw residuals of 4·10⁻⁹ from
 * rounding alone. Divided by its norm, the residual is the change in control
 * coordinates that would remove it, which `constraint` bounds at any scale.
 * Rows of norm ≤ 1, which include every point row (B-spline values sum to 1,
 * so their 2-norm is at most 1), are judged on the raw residual, so a point
 * constraint is never held more loosely than `constraint`. Issues report the
 * raw residual (caller units) as `value`.
 */
function constraintIssues(out: LsqOutcome & { ok: true }, tol: Tolerances): GeomIssue[] {
  const issues: GeomIssue[] = [];
  const dep = new Set(out.dependent);
  for (let k = 0; k < out.residual.length; k++) {
    const r = out.residual[k]!;
    const norm = Math.max(1, out.rowNorm[k]!);
    const judged = r / norm;
    const what = norm > 1 ? `residual ${r}; ${judged} per unit row norm` : `residual ${r}`;
    if (dep.has(k)) {
      issues.push(
        judged <= tol.constraint
          ? issue(
              'dependent-constraints',
              'warning',
              `constraint row ${k} depends on the others (consistent; ${what})`,
              k,
              r,
            )
          : issue(
              'inconsistent-constraints',
              'error',
              `constraint row ${k} depends on the others and contradicts them (${what})`,
              k,
              r,
            ),
      );
    } else if (judged > tol.constraint) {
      issues.push(
        issue(
          'constraint-residual',
          'warning',
          `constraint row ${k} holds only to ${what} (> constraint tolerance ${tol.constraint})`,
          k,
          r,
        ),
      );
    }
  }
  return issues;
}

/** Coordinate-major solution `x[c·N + i]` to Euclidean points (stride `dim`), centre added back. */
function toPoints(x: Float64Array, N: number, dim: number, centre: Float64Array): Float64Array {
  const pts = new Float64Array(N * dim);
  for (let i = 0; i < N; i++) {
    for (let c = 0; c < dim; c++) pts[i * dim + c] = x[c * N + i]! + centre[c]!;
  }
  return pts;
}

/** `[a, a + L]` of a basis: a clamped domain, or one period. */
function span01(b: Basis): readonly [number, number] {
  const [a, e] = b.domain;
  return [a, e - a];
}

// ---------------------------------------------------------------------------
// Curves
// ---------------------------------------------------------------------------

/** A validated curve constraint with its values as an array. */
interface CurveCons {
  readonly kind: 'point' | 'derivative' | 'tangentDirection';
  readonly t: number;
  readonly order: number;
  readonly value: Float64Array;
}

function checkCurveConstraints<D extends Dim>(
  cons: readonly CurveConstraint<D>[],
  dim: D,
  p: number,
): CurveCons[] {
  return cons.map((c, k) => {
    if (typeof c !== 'object' || c === null)
      fail('unsupported', `constraint ${k} is not an object`);
    if (!Number.isFinite(c.t)) {
      fail('non-finite', `constraint ${k} parameter is not finite: ${c.t}`, { index: k });
    }
    if (c.kind === 'point') {
      return {
        kind: c.kind,
        t: c.t,
        order: 0,
        value: pointValues(dim, c.value, `constraint ${k} value`),
      };
    }
    if (c.kind === 'derivative') {
      if (c.order !== 1 && c.order !== 2) {
        fail('unsupported', `constraint ${k}: derivative order must be 1 or 2; got ${c.order}`, {
          index: k,
        });
      }
      if (c.order > p) {
        fail('unsupported', `constraint ${k}: order ${c.order} exceeds degree ${p}`, { index: k });
      }
      return {
        kind: c.kind,
        t: c.t,
        order: c.order,
        value: pointValues(dim, c.value, `constraint ${k} value`),
      };
    }
    if (c.kind === 'tangentDirection') {
      if (dim === 1) {
        fail('unsupported', `constraint ${k}: a tangent direction needs dimension 2 or 3`, {
          index: k,
        });
      }
      const d = pointValues(dim, c.direction, `constraint ${k} direction`);
      let s = 0;
      for (let i = 0; i < dim; i++) s += d[i]! * d[i]!;
      if (!(s > 0)) fail('unsupported', `constraint ${k}: tangent direction is zero`, { index: k });
      const len = Math.sqrt(s);
      for (let i = 0; i < dim; i++) d[i] = d[i]! / len;
      return { kind: c.kind, t: c.t, order: 1, value: d };
    }
    return fail(
      'unsupported',
      `constraint ${k}: unknown kind ${JSON.stringify((c as { kind: unknown }).kind)}`,
      {
        index: k,
      },
    );
  });
}

/** Unit normals of a unit direction `d` (2D: one; 3D: two, orthonormal). */
function normalsOf(d: Float64Array): Float64Array[] {
  if (d.length === 2) return [Float64Array.of(-d[1]!, d[0]!)];
  // Cross with the axis of the smallest |component| (well away from parallel).
  const ax = Math.abs(d[0]!);
  const ay = Math.abs(d[1]!);
  const az = Math.abs(d[2]!);
  const a = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
  const e1 = Float64Array.of(
    d[1]! * a[2]! - d[2]! * a[1]!,
    d[2]! * a[0]! - d[0]! * a[2]!,
    d[0]! * a[1]! - d[1]! * a[0]!,
  );
  const l1 = Math.sqrt(e1[0]! * e1[0]! + e1[1]! * e1[1]! + e1[2]! * e1[2]!);
  for (let i = 0; i < 3; i++) e1[i] = e1[i]! / l1;
  const e2 = Float64Array.of(
    d[1]! * e1[2]! - d[2]! * e1[1]!,
    d[2]! * e1[0]! - d[0]! * e1[2]!,
    d[0]! * e1[1]! - d[1]! * e1[0]!,
  );
  return [e1, e2];
}

/** Constraint rows on coordinate-major unknowns for basis `b` (point values centred by `centre`). */
function curveConstraintRows(
  b: Basis,
  cons: readonly CurveCons[],
  dim: number,
  centre: Float64Array,
  tol: Tolerances,
): ConstraintRow[] {
  const N = b.count;
  const p1 = b.degree + 1;
  const rows: ConstraintRow[] = [];
  for (const c of cons) {
    const t = b.kind === 'clamped' ? checkClamped(b, c.t, tol) : c.t;
    const col = collocate(b, [t], c.order);
    const vals = col.vals.subarray(c.order * p1, (c.order + 1) * p1);
    if (c.kind === 'tangentDirection') {
      for (const nrm of normalsOf(c.value)) {
        const idx = new Int32Array(dim * p1);
        const val = new Float64Array(dim * p1);
        for (let cc = 0; cc < dim; cc++) {
          for (let j = 0; j < p1; j++) {
            idx[cc * p1 + j] = cc * N + col.cols[j]!;
            val[cc * p1 + j] = nrm[cc]! * vals[j]!;
          }
        }
        rows.push({ idx, val, rhs: 0 });
      }
      continue;
    }
    for (let cc = 0; cc < dim; cc++) {
      const idx = new Int32Array(p1);
      for (let j = 0; j < p1; j++) idx[j] = cc * N + col.cols[j]!;
      const rhs = c.kind === 'point' ? c.value[cc]! - centre[cc]! : c.value[cc]!;
      rows.push({ idx, val: vals.slice(), rhs });
    }
  }
  return rows;
}

function checkClamped(b: Basis, t: number, tol: Tolerances): number {
  const [a, e] = b.domain;
  const slack = tol.paramRel * (e - a);
  if (t < a - slack || t > e + slack) {
    fail('param-out-of-domain', `constraint parameter ${t} is outside the domain [${a}, ${e}]`, {
      t,
      value: t,
    });
  }
  return sanitizeParam(b, t);
}

/**
 * Data parameters of an approximation, in the basis domain when the basis is
 * given (`map`), otherwise on `[0, 1]` (clamped) or `[0, 1)` (periodic).
 * A method parameterises the points of positive weight (`used`) only; the
 * others get parameters by {@link spreadParams}.
 * Explicit parameters without a basis must be non-decreasing from exactly 0
 * (to exactly 1 when clamped, below 1 when periodic): they define the knots.
 * With a basis they may be in any order inside its domain.
 */
function approxParams(
  points: ArrayLike<number>,
  dim: Dim,
  n: number,
  spec: ArrayLike<number> | Parameterization | undefined,
  periodic: boolean,
  basis: Basis | null,
  used: Int32Array | null,
  tol: Tolerances,
): Float64Array {
  if (spec === undefined || isMethod(spec)) {
    const method = spec ?? 'centripetal';
    const ub =
      used === null
        ? parameterize(points, dim, method, periodic)
        : spreadParams(
            parameterize(pick(points, dim, used), dim, method, periodic),
            used,
            n,
            periodic,
          );
    if (basis === null) return ub;
    const [a, L] = span01(basis);
    return ub.map((u) => (basis.kind === 'clamped' && u === 1 ? basis.domain[1] : a + u * L));
  }
  if (spec.length !== n) {
    fail('size-mismatch', `expected ${n} parameters; got ${spec.length}`, { value: spec.length });
  }
  const ub = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const u = spec[k]!;
    if (!Number.isFinite(u)) fail('non-finite', `parameter ${k} is not finite: ${u}`, { index: k });
    ub[k] = u;
  }
  if (basis !== null) {
    if (basis.kind === 'periodic') return ub.map((u) => sanitizeParam(basis, u));
    const [a, e] = basis.domain;
    const slack = tol.paramRel * (e - a);
    for (let k = 0; k < n; k++) {
      if (ub[k]! < a - slack || ub[k]! > e + slack) {
        fail(
          'param-out-of-domain',
          `parameter ${k} = ${ub[k]} is outside the domain [${a}, ${e}]`,
          {
            index: k,
            value: ub[k],
          },
        );
      }
    }
    return ub.map((u) => sanitizeParam(basis, u));
  }
  for (let k = 1; k < n; k++) {
    if (ub[k]! < ub[k - 1]!) {
      fail(
        'knots-decreasing',
        `parameters must be non-decreasing; parameter ${k} = ${ub[k]} < ${ub[k - 1]}`,
        {
          index: k,
          value: ub[k],
        },
      );
    }
  }
  const ok = periodic ? ub[0] === 0 && ub[n - 1]! < 1 : ub[0] === 0 && ub[n - 1] === 1;
  if (!ok) {
    fail(
      'param-out-of-domain',
      periodic
        ? 'periodic approximation parameters must run from exactly 0 to below 1'
        : 'approximation parameters must run from exactly 0 to exactly 1',
      { value: periodic ? ub[n - 1] : ub[0] },
    );
  }
  return ub;
}

/** One weighted, constrained curve solve on a fixed basis, and its measured errors. */
interface CurveSolve {
  readonly basis: Basis;
  readonly x: Float64Array;
  readonly out: LsqOutcome & { ok: true };
  readonly curve: NurbsCurve;
  readonly errors: Float64Array;
  readonly maxError: number;
  readonly sumSq: number;
}

interface CurveProblem {
  readonly dim: Dim;
  readonly n: number;
  readonly points: ArrayLike<number>;
  readonly targets: Float64Array;
  readonly centre: Float64Array;
  readonly weights: Float64Array | null;
  readonly cons: readonly CurveCons[];
  readonly tol: Tolerances;
}

function solveCurve(P: CurveProblem, basis: Basis, ts: Float64Array): CurveSolve | GeomIssue {
  const data = curveRows(collocate(basis, ts, 0));
  const rows = curveConstraintRows(basis, P.cons, P.dim, P.centre, P.tol);
  const out = solveLsq(
    { N: basis.count, dim: P.dim, data, weights: P.weights, targets: P.targets, constraints: rows },
    P.tol.pivotRel,
  );
  if (!out.ok) return undetermined(out);
  const curve = makeCurve({
    dim: P.dim,
    basis,
    points: toPoints(out.x, basis.count, P.dim, P.centre),
  });
  const m = measureCurve(curve, ts, P.points, P.weights);
  return { basis, x: out.x, out, curve, ...m };
}

function measureCurve(
  c: NurbsCurve,
  ts: Float64Array,
  points: ArrayLike<number>,
  weights: Float64Array | null,
): { errors: Float64Array; maxError: number; sumSq: number } {
  const dim = c.dim;
  const s = makeScratch(c.basis.degree, 0);
  const pt = new Float64Array(dim);
  const errors = new Float64Array(ts.length);
  let maxError = 0;
  let sumSq = 0;
  for (let k = 0; k < ts.length; k++) {
    if (weights !== null && weights[k] === 0) continue;
    curveEvalInto(c, ts[k]!, 0, pt, 0, s);
    let e2 = 0;
    for (let d = 0; d < dim; d++) {
      const e = pt[d]! - points[k * dim + d]!;
      e2 += e * e;
    }
    errors[k] = Math.sqrt(e2);
    sumSq += e2;
    if (errors[k]! > maxError) maxError = errors[k]!;
  }
  return { errors, maxError, sumSq };
}

/**
 * Knots to add where the error exceeds `tolerance` (design §6.12, adaptive
 * insertion): spans are taken worst first; each gets one knot midway between
 * the two middle distinct parameters of positive weight it holds, so both
 * halves keep data.
 * A span with fewer than two distinct parameters, or whose new knot would be
 * within `knotRel` of a neighbour, is left alone. At most `budget` knots.
 */
function splitKnots(
  b: Basis,
  ts: Float64Array,
  weights: Float64Array | null,
  errors: Float64Array,
  tolerance: number,
  budget: number,
  tol: Tolerances,
): number[] {
  const br = breakpoints(b);
  const [a, L] = span01(b);
  const ends = br.length;
  const edges = new Float64Array(ends + (b.kind === 'periodic' ? 1 : 0));
  edges.set(br);
  if (b.kind === 'periodic') edges[ends] = a + L;
  const spans = edges.length - 1;
  const spanOfT = (t: number): number => {
    let lo = 0;
    let hi = spans;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (edges[mid]! <= t) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  const worst = new Float64Array(spans);
  const members: number[][] = Array.from({ length: spans }, () => []);
  for (let k = 0; k < ts.length; k++) {
    if (weights !== null && weights[k] === 0) continue;
    const s = spanOfT(ts[k]!);
    members[s]!.push(ts[k]!);
    if (errors[k]! > worst[s]!) worst[s] = errors[k]!;
  }
  const order = Array.from({ length: spans }, (_, s) => s)
    .filter((s) => worst[s]! > tolerance)
    .sort((x, y) => worst[y]! - worst[x]! || x - y);
  const gap = tol.knotRel * L;
  const added: number[] = [];
  for (const s of order) {
    if (added.length >= budget) break;
    const vals = Array.from(new Set(members[s]!)).sort((x, y) => x - y);
    if (vals.length < 2) continue;
    const i = (vals.length - 1) >> 1;
    const knot = 0.5 * (vals[i]! + vals[i + 1]!);
    if (!(knot - edges[s]! > gap && edges[s + 1]! - knot > gap)) continue;
    added.push(knot);
  }
  return added;
}

/** `b` with the knots `extra` inserted (sorted, each strictly inside a span). */
function withKnots(b: Basis, extra: readonly number[], tol: Tolerances): Basis | GeomIssue {
  const merged = Float64Array.from([...Array.from(b.knots), ...extra]).sort();
  return tryBasis(() =>
    b.kind === 'clamped'
      ? clampedBasis(b.degree, merged, tol)
      : periodicBasis(b.degree, merged, b.period, tol),
  );
}

/**
 * Parameter correction (Hoschek's intrinsic parameterisation; P&T §9.4.1
 * remarks): each data parameter moves to the foot point of its data point on
 * the current curve by Newton's iteration for `f(t) = C′(t)·(C(t) − Q) = 0`
 * (P&T §6.1, eq. 6.3), at most `newtonMaxIter` steps, stopping when a step is
 * below `paramRel × domain`. A move is kept only if it brings the point
 * closer, so the weighted sum of squares never grows across a pass.
 */
function correctCurveParams(
  c: NurbsCurve,
  ts: Float64Array,
  points: ArrayLike<number>,
  weights: Float64Array | null,
  tol: Tolerances,
): Float64Array {
  const dim = c.dim;
  const b = c.basis;
  const [a, L] = span01(b);
  const s = makeScratch(b.degree, 2);
  const f = new Float64Array(3 * dim);
  const next = ts.slice();
  const dist2 = (t: number, k: number): number => {
    curveEvalInto(c, t, 0, f, 0, s);
    let e2 = 0;
    for (let d = 0; d < dim; d++) {
      const e = f[d]! - points[k * dim + d]!;
      e2 += e * e;
    }
    return e2;
  };
  for (let k = 0; k < ts.length; k++) {
    if (weights !== null && weights[k] === 0) continue;
    let t = ts[k]!;
    for (let it = 0; it < tol.newtonMaxIter; it++) {
      curveEvalInto(c, t, 2, f, 0, s);
      let g = 0;
      let h = 0;
      for (let d = 0; d < dim; d++) {
        const r = f[d]! - points[k * dim + d]!;
        g += f[dim + d]! * r;
        h += f[2 * dim + d]! * r + f[dim + d]! * f[dim + d]!;
      }
      if (!(h > 0)) break;
      let tn = t - g / h;
      tn = b.kind === 'periodic' ? wrapParam(a, L, tn) : tn < a ? a : tn > a + L ? b.domain[1] : tn;
      const step = Math.abs(tn - t);
      t = tn;
      if (!(step > tol.paramRel * L)) break;
    }
    if (dist2(t, k) < dist2(ts[k]!, k)) next[k] = t;
  }
  return next;
}

/**
 * Weighted, constrained least-squares approximation of `points` (stride
 * `dim`) by a B-spline curve of `degree` (default 3); P&T §9.4.1 and A9.6,
 * generalised (see the module comment). Unlike §9.4.1, the end points are not
 * interpolated unless constrained: add `point` constraints at the domain ends
 * for the book's curve.
 *
 * The basis is one of: the given `knots` (clamped: a full clamped knot
 * vector; `periodic`: one period of a period-1 basis); `count` control points
 * on knots from eqs. 9.68–9.69, centred (periodic: their cyclic analogue,
 * whose shift moves the data parameters with it, as in `interpolatePeriodic`);
 * or, by default, adaptive: starting from `degree + 1` control points, knots are
 * inserted where the error exceeds `tolerance` (default `tol.fit`) until it
 * holds, `maxCount` (default: the number of points) is reached, no span can
 * be split, or the data stop determining the control points (the last good
 * fit is kept). Without given knots the domain is `[0, 1]` (periodic `[0, 1)`,
 * period 1).
 *
 * `params` (default `'centripetal'`) are mapped onto a given basis's domain.
 * `dataWeights` (≥ 0, default 1) weight each point's squared error. A point of
 * weight 0 is ignored: the result is the fit of the other points alone (the
 * same parameters, knots and control points), and the reported errors skip
 * it; its reported parameter is interpolated between its neighbours'
 * (explicit `params` are used as given, but knots come only from those of
 * positive weight). `constraints` hold exactly
 * (to `constraint` after one step of iterative refinement), provided the data
 * alone determine every control point. `parameterCorrection` passes (default
 * 0) re-project the data onto the curve and refit on the final basis.
 */
export function approximateCurve<D extends Dim>(
  points: ArrayLike<number>,
  dim: D,
  opts: {
    readonly degree?: number;
    readonly periodic?: boolean;
    readonly knots?: ArrayLike<number>;
    readonly count?: number;
    readonly tolerance?: number;
    readonly maxCount?: number;
    readonly params?: ArrayLike<number> | Parameterization;
    readonly dataWeights?: ArrayLike<number>;
    readonly constraints?: readonly CurveConstraint<D>[];
    readonly parameterCorrection?: number;
    readonly tol?: Partial<Tolerances>;
  } = {},
): Result<CurveFit<D>> {
  const tol = resolveTolerances(opts.tol);
  const n = pointCount(points, dim);
  const p = opts.degree ?? 3;
  checkDegree(p);
  const periodic = opts.periodic ?? false;
  const tolerance = opts.tolerance ?? tol.fit;
  checkPositive(tolerance, 'tolerance');
  checkCount(opts.count, 'count', p + 1);
  checkCount(opts.maxCount, 'maxCount', p + 1);
  checkCount(opts.parameterCorrection, 'parameterCorrection', 0);
  if (opts.knots !== undefined && opts.count !== undefined) {
    fail('unsupported', 'give either knots or count, not both');
  }
  if (n < p + 1) {
    fail('too-few-points', `degree ${p} approximation needs ≥ ${p + 1} points; got ${n}`, {
      value: n,
    });
  }
  const weights = checkWeights(opts.dataWeights, n);
  const used = usedIndices(weights);
  const nUsed = used === null ? n : used.length;
  if (nUsed < p + 1) {
    fail(
      'too-few-points',
      `degree ${p} approximation needs ≥ ${p + 1} points of positive weight; got ${nUsed}`,
      { value: nUsed },
    );
  }
  const cons = checkCurveConstraints(opts.constraints ?? [], dim, p);

  let basis: Basis | null = null;
  if (opts.knots !== undefined) {
    basis = periodic ? periodicBasis(p, opts.knots, 1, tol) : clampedBasis(p, opts.knots, tol);
  }
  let ts = approxParams(points, dim, n, opts.params, periodic, basis, used, tol);
  const centre =
    used === null ? boxCentre(points, n, dim) : boxCentre(pick(points, dim, used), nUsed, dim);
  const targets = new Float64Array(n * dim);
  for (let k = 0; k < n * dim; k++) targets[k] = points[k]! - centre[k % dim]!;
  const P: CurveProblem = { dim, n, points, targets, centre, weights, cons, tol };

  const adaptive = basis === null && opts.count === undefined;
  if (basis === null) {
    const count = opts.count ?? p + 1;
    if (count > nUsed) {
      fail(
        'too-few-points',
        `${count} control points need ≥ ${count} data points of positive weight; got ${nUsed}`,
        { value: count },
      );
    }
    // Knots from the parameters of positive weight only; clamped, the ends
    // stay at the domain's (explicit parameters may start or end at a point
    // of weight 0).
    const tsUsed = used === null ? ts : pick(ts, 1, used);
    let shift = 0;
    const built = tryBasis(() => {
      if (!periodic) {
        const U = lsqKnots(tsUsed, p, count);
        U.fill(ts[0]!, 0, p + 1);
        U.fill(ts[n - 1]!, count);
        return snappedClamped(p, U, tol);
      }
      const knots = periodicLsq(tsUsed, count, p);
      shift = knots.shift;
      return snappedPeriodic(p, knots.T, tol);
    });
    if ('code' in built) return errResult([built]);
    basis = built;
    ts = shiftParams(ts, shift);
  }
  const first = solveCurve(P, basis, ts);
  if ('code' in first) return errResult([first]);
  let best = first;
  const issues: GeomIssue[] = [];

  if (adaptive) {
    const maxCount = opts.maxCount ?? nUsed;
    while (best.maxError > tolerance && best.basis.count < maxCount) {
      const extra = splitKnots(
        best.basis,
        ts,
        weights,
        best.errors,
        tolerance,
        maxCount - best.basis.count,
        tol,
      );
      if (extra.length === 0) break;
      const nb = withKnots(best.basis, extra, tol);
      if ('code' in nb) break;
      const next = solveCurve(P, nb, ts);
      if ('code' in next) break;
      best = next;
    }
  }

  for (let pass = 0; pass < (opts.parameterCorrection ?? 0); pass++) {
    const moved = correctCurveParams(best.curve, ts, points, weights, tol);
    const next = solveCurve(P, best.basis, moved);
    if ('code' in next) {
      issues.push(
        issue(
          'not-converged',
          'warning',
          `parameter correction pass ${pass + 1} left a control point undetermined; kept the previous fit`,
        ),
      );
      break;
    }
    ts = moved;
    best = next;
  }

  const ci = constraintIssues(best.out, tol);
  if (ci.some((x) => x.severity === 'error')) return errResult(ci);
  issues.push(...ci);
  return okResult(
    Object.freeze({
      curve: best.curve as NurbsCurve<D>,
      params: ts,
      maxError: best.maxError,
      rmsError: Math.sqrt(best.sumSq / nUsed),
      withinTolerance: best.maxError <= tolerance,
      multipliers: best.out.lambda,
    }),
    issues,
  );
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

interface SurfCons {
  readonly u: number;
  readonly v: number;
  readonly du: number;
  readonly dv: number;
  readonly value: Float64Array;
  readonly axes: number;
}

function checkSurfaceConstraints(
  cons: readonly SurfaceConstraint[],
  bu: Basis,
  bv: Basis,
  tol: Tolerances,
): SurfCons[] {
  return cons.map((c, k) => {
    if (typeof c !== 'object' || c === null)
      fail('unsupported', `constraint ${k} is not an object`);
    const { u, v } = c.uv ?? ({} as UV);
    if (!Number.isFinite(u) || !Number.isFinite(v)) {
      fail('non-finite', `constraint ${k} parameters are not finite`, { index: k });
    }
    const axes = c.axes ?? 7;
    if (!Number.isInteger(axes) || axes < 1 || axes > 7) {
      fail('unsupported', `constraint ${k}: axes must be a bitmask in 1…7; got ${axes}`, {
        index: k,
      });
    }
    let du = 0;
    let dv = 0;
    if (c.kind === 'derivative') {
      du = c.du;
      dv = c.dv;
      for (const [d, deg, name] of [
        [du, bu.degree, 'du'],
        [dv, bv.degree, 'dv'],
      ] as const) {
        if (!(d === 0 || d === 1 || d === 2) || d > deg) {
          fail(
            'unsupported',
            `constraint ${k}: ${name} must be 0, 1 or 2 and ≤ the degree; got ${d}`,
            {
              index: k,
            },
          );
        }
      }
    } else if (c.kind !== 'point') {
      fail(
        'unsupported',
        `constraint ${k}: unknown kind ${JSON.stringify((c as { kind: unknown }).kind)}`,
        {
          index: k,
        },
      );
    }
    const value = pointValues(3, c.value, `constraint ${k} value`);
    const uu = bu.kind === 'clamped' ? checkClamped(bu, u, tol) : sanitizeParam(bu, u);
    const vv = bv.kind === 'clamped' ? checkClamped(bv, v, tol) : sanitizeParam(bv, v);
    return { u: uu, v: vv, du, dv, value, axes };
  });
}

function surfaceConstraintRows(
  bu: Basis,
  bv: Basis,
  cons: readonly SurfCons[],
  centre: Float64Array,
): ConstraintRow[] {
  const N = bu.count * bv.count;
  const rows: ConstraintRow[] = [];
  for (const c of cons) {
    const r = surfaceRows(
      collocate(bu, [c.u], c.du),
      collocate(bv, [c.v], c.dv),
      bv.count,
      c.du,
      c.dv,
    );
    for (let cc = 0; cc < 3; cc++) {
      if (!(c.axes & (1 << cc))) continue;
      const idx = r.idx.map((i) => cc * N + i);
      const rhs = c.du === 0 && c.dv === 0 ? c.value[cc]! - centre[cc]! : c.value[cc]!;
      rows.push({ idx, val: r.val.slice(), rhs });
    }
  }
  return rows;
}

/** Data parameters of a surface fit, interleaved `(u, v)`, in the bases' domains. */
function surfaceParams(
  points: ArrayLike<number>,
  n: number,
  layout: { readonly uv: ArrayLike<number> } | { readonly rows: number; readonly cols: number },
  bu: Basis,
  bv: Basis,
  method: Parameterization,
  tol: Tolerances,
): Float64Array {
  const uv = new Float64Array(2 * n);
  if ('uv' in layout) {
    const src = layout.uv;
    if (src.length !== 2 * n) {
      fail('size-mismatch', `expected ${2 * n} uv values; got ${src.length}`, {
        value: src.length,
      });
    }
    for (let k = 0; k < n; k++) {
      for (const [d, b] of [
        [0, bu],
        [1, bv],
      ] as const) {
        const x = src[2 * k + d]!;
        if (!Number.isFinite(x)) fail('non-finite', `uv ${k} is not finite`, { index: k });
        uv[2 * k + d] = b.kind === 'clamped' ? checkClamped(b, x, tol) : sanitizeParam(b, x);
      }
    }
    return uv;
  }
  const { rows, cols } = layout;
  if (
    !Number.isInteger(rows) ||
    !Number.isInteger(cols) ||
    rows < 2 ||
    cols < 2 ||
    rows * cols !== n
  ) {
    fail('size-mismatch', `a ${rows} × ${cols} grid does not match ${n} points`, { value: n });
  }
  const e = exponentOf(method);
  const pu = new Float64Array(rows);
  const pv = new Float64Array(cols);
  if (surfMeshParams(points, rows, cols, 'u', e, bu.kind === 'periodic', pu) === 0) {
    fail('too-few-points', 'every column of the grid collapses to a point');
  }
  if (surfMeshParams(points, rows, cols, 'v', e, bv.kind === 'periodic', pv) === 0) {
    fail('too-few-points', 'every row of the grid collapses to a point');
  }
  const map = (b: Basis, x: number): number => {
    if (b.kind === 'clamped' && x === 1) return b.domain[1];
    const [a, L] = span01(b);
    return sanitizeParam(b, a + x * L);
  };
  for (let k = 0; k < rows; k++) {
    for (let l = 0; l < cols; l++) {
      uv[2 * (k * cols + l)] = map(bu, pu[k]!);
      uv[2 * (k * cols + l) + 1] = map(bv, pv[l]!);
    }
  }
  return uv;
}

interface SurfaceSolve {
  readonly surface: NurbsSurface;
  readonly out: LsqOutcome & { ok: true };
  readonly maxError: number;
  readonly sumSq: number;
}

function measureSurface(
  S: NurbsSurface,
  uv: Float64Array,
  points: ArrayLike<number>,
  weights: Float64Array | null,
): { maxError: number; sumSq: number } {
  const s = makeScratch(Math.max(S.u.degree, S.v.degree), 0);
  const pt = new Float64Array(3);
  let maxError = 0;
  let sumSq = 0;
  for (let k = 0; k < uv.length / 2; k++) {
    if (weights !== null && weights[k] === 0) continue;
    surfaceEvalInto(S, uv[2 * k]!, uv[2 * k + 1]!, 0, pt, 0, s);
    const dx = pt[0]! - points[3 * k]!;
    const dy = pt[1]! - points[3 * k + 1]!;
    const dz = pt[2]! - points[3 * k + 2]!;
    const e2 = dx * dx + dy * dy + dz * dz;
    sumSq += e2;
    maxError = Math.max(maxError, Math.sqrt(e2));
  }
  return { maxError, sumSq };
}

/**
 * Parameter correction for surfaces: Newton's iteration for the foot point
 * (P&T §6.1, eqs. 6.5–6.7) from each data point's current `(u, v)`; the same
 * stopping rule and acceptance test as the curve version.
 */
function correctSurfaceParams(
  S: NurbsSurface,
  uv: Float64Array,
  points: ArrayLike<number>,
  weights: Float64Array | null,
  tol: Tolerances,
): Float64Array {
  const s = makeScratch(Math.max(S.u.degree, S.v.degree), 2);
  const f = new Float64Array(18);
  const next = uv.slice();
  const [au, Lu] = span01(S.u);
  const [av, Lv] = span01(S.v);
  const clampTo = (b: Basis, a: number, L: number, x: number): number =>
    b.kind === 'periodic' ? wrapParam(a, L, x) : x < a ? a : x > a + L ? b.domain[1] : x;
  const dist2 = (u: number, v: number, k: number): number => {
    surfaceEvalInto(S, u, v, 0, f, 0, s);
    const dx = f[0]! - points[3 * k]!;
    const dy = f[1]! - points[3 * k + 1]!;
    const dz = f[2]! - points[3 * k + 2]!;
    return dx * dx + dy * dy + dz * dz;
  };
  const dot = (i: number, j: number): number =>
    f[i]! * f[j]! + f[i + 1]! * f[j + 1]! + f[i + 2]! * f[j + 2]!;
  for (let k = 0; k < uv.length / 2; k++) {
    if (weights !== null && weights[k] === 0) continue;
    let u = uv[2 * k]!;
    let v = uv[2 * k + 1]!;
    for (let it = 0; it < tol.newtonMaxIter; it++) {
      surfaceEvalInto(S, u, v, 2, f, 0, s);
      // r = S − Q; slots of f: S 0, Su 3, Sv 6, Suu 9, Suv 12, Svv 15.
      const rx = f[0]! - points[3 * k]!;
      const ry = f[1]! - points[3 * k + 1]!;
      const rz = f[2]! - points[3 * k + 2]!;
      const rd = (i: number): number => rx * f[i]! + ry * f[i + 1]! + rz * f[i + 2]!;
      const a11 = dot(3, 3) + rd(9);
      const a12 = dot(3, 6) + rd(12);
      const a22 = dot(6, 6) + rd(15);
      const g1 = rd(3);
      const g2 = rd(6);
      const det = a11 * a22 - a12 * a12;
      if (!(det > 0) || !(a11 > 0)) break;
      const du = (a22 * g1 - a12 * g2) / det;
      const dv = (a11 * g2 - a12 * g1) / det;
      const un = clampTo(S.u, au, Lu, u - du);
      const vn = clampTo(S.v, av, Lv, v - dv);
      const small =
        !(Math.abs(un - u) > tol.paramRel * Lu) && !(Math.abs(vn - v) > tol.paramRel * Lv);
      u = un;
      v = vn;
      if (small) break;
    }
    if (dist2(u, v, k) < dist2(uv[2 * k]!, uv[2 * k + 1]!, k)) {
      next[2 * k] = u;
      next[2 * k + 1] = v;
    }
  }
  return next;
}

/**
 * Weighted, constrained least-squares approximation of 3D `points` by a
 * B-spline surface on the fixed bases `u` and `v` (A9.7 generalised; see the
 * module comment). `layout` gives each point's `(u, v)` (interleaved, in the
 * bases' domains), or says the points are a `rows × cols` grid (u-major, as
 * `interpolateSurface`), whose parameters come from A9.3 by `params` (default
 * `'centripetal'`) mapped onto the bases' domains. Weights, constraints
 * (`axes` select coordinates) and `parameterCorrection` passes as in
 * {@link approximateCurve}, except that a grid's A9.3 parameters come from
 * every grid point, weight 0 included (A9.3 needs whole lines; give `uv` to
 * choose the parameters yourself). `withinTolerance` compares with `tol.fit`.
 */
export function approximateSurface(
  points: ArrayLike<number>,
  layout: { readonly uv: ArrayLike<number> } | { readonly rows: number; readonly cols: number },
  opts: {
    readonly u: Basis;
    readonly v: Basis;
    readonly params?: Parameterization;
    readonly dataWeights?: ArrayLike<number>;
    readonly constraints?: readonly SurfaceConstraint[];
    readonly parameterCorrection?: number;
    readonly tol?: Partial<Tolerances>;
  },
): Result<SurfaceFit> {
  const tol = resolveTolerances(opts.tol);
  const n = pointCount(points, 3);
  const bu = opts.u;
  const bv = opts.v;
  checkBasisShape(bu);
  checkBasisShape(bv);
  checkCount(opts.parameterCorrection, 'parameterCorrection', 0);
  const weights = checkWeights(opts.dataWeights, n);
  const used = usedIndices(weights);
  let uv = surfaceParams(points, n, layout, bu, bv, opts.params ?? 'centripetal', tol);
  const cons = checkSurfaceConstraints(opts.constraints ?? [], bu, bv, tol);
  const centre =
    used === null ? boxCentre(points, n, 3) : boxCentre(pick(points, 3, used), used.length, 3);
  const targets = new Float64Array(n * 3);
  for (let k = 0; k < n * 3; k++) targets[k] = points[k]! - centre[k % 3]!;
  const crows = surfaceConstraintRows(bu, bv, cons, centre);
  const N = bu.count * bv.count;

  const solve = (params: Float64Array): SurfaceSolve | GeomIssue => {
    const us = new Float64Array(n);
    const vs = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      us[k] = params[2 * k]!;
      vs[k] = params[2 * k + 1]!;
    }
    const data = surfaceRows(collocate(bu, us, 0), collocate(bv, vs, 0), bv.count, 0, 0);
    const out = solveLsq({ N, dim: 3, data, weights, targets, constraints: crows }, tol.pivotRel);
    if (!out.ok) return undetermined(out);
    const surface = makeSurface({ u: bu, v: bv, points: toPoints(out.x, N, 3, centre) });
    return { surface, out, ...measureSurface(surface, params, points, weights) };
  };

  const first = solve(uv);
  if ('code' in first) return errResult([first]);
  let best = first;
  const issues: GeomIssue[] = [];
  for (let pass = 0; pass < (opts.parameterCorrection ?? 0); pass++) {
    const moved = correctSurfaceParams(best.surface, uv, points, weights, tol);
    const next = solve(moved);
    if ('code' in next) {
      issues.push(
        issue(
          'not-converged',
          'warning',
          `parameter correction pass ${pass + 1} left a control point undetermined; kept the previous fit`,
        ),
      );
      break;
    }
    uv = moved;
    best = next;
  }
  const ci = constraintIssues(best.out, tol);
  if (ci.some((x) => x.severity === 'error')) return errResult(ci);
  issues.push(...ci);
  return okResult(
    Object.freeze({
      surface: best.surface,
      params: uv,
      maxError: best.maxError,
      rmsError: Math.sqrt(best.sumSq / (used === null ? n : used.length)),
      withinTolerance: best.maxError <= tol.fit,
      multipliers: best.out.lambda,
    }),
    issues,
  );
}
