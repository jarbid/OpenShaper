// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Global interpolation (design §6.12): curves through points (P&T A9.1), with
 * end derivatives (§9.2.2), closed periodic curves (the cyclic system), and
 * surfaces through a grid (A9.4 with A9.3's parameters).
 *
 * Each returns the measured `maxError`: the largest distance between a data
 * point and the result evaluated at that point's parameter (design §7: every
 * fitter reports what it achieved). It is at rounding level unless the data
 * make the collocation system ill-conditioned (strongly clustered
 * parameters), which the number then shows.
 *
 * The data are centred on their bounding-box centre before the solve (design
 * §7): point rows sum their basis values to 1, derivative rows to 0, so the
 * centre is added back to the control points exactly. Every row is scaled to
 * a largest entry of 1 before the pivoted band LU.
 */
import { createScratch } from '../array';
import { averageKnots, surfMeshParams } from '../book/fit';
import { curveEvalBatchInto, makeCurve } from '../curve';
import { fail } from '../errors';
import { bandLu, bandLuFactor, bandLuSet, bandLuSolve } from '../linalg/banded';
import type { BandLU } from '../linalg/banded';
import { makeSurface, surfaceEvalGridInto } from '../surface';
import { resolveTolerances } from '../tolerance';
import type { Tolerances } from '../tolerance';
import type {
  Basis,
  ClampedCurve,
  Dim,
  NurbsCurve,
  NurbsSurface,
  PeriodicCurve,
  PointOf,
  ReadonlyF64,
} from '../types';
import { collocate } from './assemble';
import type { Collocation } from './assemble';
import {
  exponentOf,
  isMethod,
  parameterize,
  periodicAveraged,
  pointCount,
  shiftParams,
  snappedClamped,
  snappedPeriodic,
} from './param';
import type { Parameterization } from './param';

/** A curve through the data, the parameter of each data point, and the measured error. */
export interface CurveInterpolation<C extends NurbsCurve = NurbsCurve> {
  readonly curve: C;
  /** The curve parameter of data point `k` (periodic: shifted with the knots, wrapped into `[0, 1)`). */
  readonly params: ReadonlyF64;
  /** `max_k |C(params[k]) − Q_k|`, measured on the result. */
  readonly maxError: number;
}

/** A surface through a grid, the grid's parameters per direction, and the measured error. */
export interface SurfaceInterpolation {
  readonly surface: NurbsSurface;
  /** Parameter of grid row `k` (u) and column `l` (v). */
  readonly paramsU: ReadonlyF64;
  readonly paramsV: ReadonlyF64;
  /** `max_{k,l} |S(paramsU[k], paramsV[l]) − Q_{k,l}|`, measured on the result. */
  readonly maxError: number;
}

// ---------------------------------------------------------------------------
// The square collocation solve (A9.1 / A9.4 core)
// ---------------------------------------------------------------------------

/** A factored square collocation system: rows scaled by `rowScale` before factoring. */
interface Square {
  readonly lu: BandLU;
  readonly rowScale: Float64Array;
}

/**
 * Factors the `n × n` system whose row `r` has entries `val[r·K + e]` in
 * columns `idx[r·K + e]`. Rows are equilibrated (largest entry 1), the band
 * is measured from the columns, and the LU pivots partially. Throws
 * `singular-system` naming the failing column.
 */
function factorSquare(
  n: number,
  K: number,
  idx: Int32Array,
  val: Float64Array,
  tol: Tolerances,
): Square {
  let ml = 0;
  let mu = 0;
  const rowScale = new Float64Array(n);
  for (let r = 0; r < n; r++) {
    let big = 0;
    for (let e = 0; e < K; e++) {
      const c = idx[r * K + e]!;
      if (val[r * K + e] === 0) continue;
      ml = Math.max(ml, r - c);
      mu = Math.max(mu, c - r);
      big = Math.max(big, Math.abs(val[r * K + e]!));
    }
    rowScale[r] = big > 0 ? 1 / big : 1;
  }
  const lu = bandLu(n, ml, mu);
  for (let r = 0; r < n; r++) {
    for (let e = 0; e < K; e++) {
      const v = val[r * K + e]!;
      if (v !== 0) bandLuSet(lu, r, idx[r * K + e]!, v * rowScale[r]!);
    }
  }
  const failed = bandLuFactor(lu, tol.pivotRel);
  if (failed >= 0) {
    fail(
      'singular-system',
      `the interpolation system is singular at control point ${failed} (parameters too clustered for the knots)`,
      { index: failed },
    );
  }
  return { lu, rowScale };
}

/**
 * Solves `A x = b` for the factored system, `b[o + r·stride]` (scaled by the
 * row scales first), in place.
 */
function solveSquare(sq: Square, b: Float64Array, o: number, stride: number): void {
  const n = sq.lu.n;
  for (let r = 0; r < n; r++) b[o + r * stride] = b[o + r * stride]! * sq.rowScale[r]!;
  bandLuSolve(sq.lu, b, o, stride);
}

/** Value rows (`k`-th derivative) of a collocation, copied as `K = p + 1` entries per row into `idx`/`val` at row `at`. */
function putRows(c: Collocation, k: number, idx: Int32Array, val: Float64Array, at: number): void {
  const { count, p1, nDer } = c;
  for (let r = 0; r < count; r++) {
    for (let j = 0; j < p1; j++) {
      idx[(at + r) * p1 + j] = c.cols[r * p1 + j]!;
      val[(at + r) * p1 + j] = c.vals[(r * (nDer + 1) + k) * p1 + j]!;
    }
  }
}

/** Centre of the bounding box of `count` points of stride `dim`. */
export function boxCentre(points: ArrayLike<number>, count: number, dim: number): Float64Array {
  const c = new Float64Array(dim);
  for (let d = 0; d < dim; d++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < count; k++) {
      const x = points[k * dim + d]!;
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
    c[d] = count > 0 ? 0.5 * (lo + hi) : 0;
  }
  return c;
}

/** `max_k |C(ts[k]) − Q_k|` for a curve of dimension `dim`. */
export function curveMaxError(
  c: NurbsCurve,
  ts: ReadonlyF64,
  points: ArrayLike<number>,
): { max: number; sumSq: number; errors: Float64Array } {
  const dim = c.dim;
  const out = new Float64Array(ts.length * dim);
  curveEvalBatchInto(c, ts, 0, out, createScratch({ maxDegree: c.basis.degree, maxDerivs: 0 }));
  const errors = new Float64Array(ts.length);
  let max = 0;
  let sumSq = 0;
  for (let k = 0; k < ts.length; k++) {
    let s = 0;
    for (let d = 0; d < dim; d++) {
      const e = out[k * dim + d]! - points[k * dim + d]!;
      s += e * e;
    }
    errors[k] = Math.sqrt(s);
    sumSq += s;
    if (errors[k]! > max) max = errors[k]!;
  }
  return { max, sumSq, errors };
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

/**
 * Interpolation parameters: explicit (validated: strictly increasing; clamped
 * `ū_0 = 0`, `ū_n = 1`; periodic inside `[0, 1)`) or by a method. Repeated
 * parameters (consecutive coincident points, or a closed list that repeats its
 * first point) violate Schoenberg–Whitney and throw.
 */
export function interpParams(
  points: ArrayLike<number>,
  dim: Dim,
  n: number,
  spec: ArrayLike<number> | Parameterization | undefined,
  closed: boolean,
): Float64Array {
  let ub: Float64Array;
  if (spec === undefined || isMethod(spec)) {
    ub = parameterize(points, dim, spec ?? 'centripetal', closed);
  } else {
    if (spec.length !== n) {
      fail('size-mismatch', `expected ${n} parameters; got ${spec.length}`, { value: spec.length });
    }
    ub = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const u = spec[k]!;
      if (!Number.isFinite(u))
        fail('non-finite', `parameter ${k} is not finite: ${u}`, { index: k });
      ub[k] = u;
    }
    const ok = closed ? ub[0]! >= 0 && ub[n - 1]! < 1 : ub[0] === 0 && ub[n - 1] === 1;
    if (!ok) {
      fail(
        'param-out-of-domain',
        closed
          ? 'periodic interpolation parameters must lie in [0, 1)'
          : 'interpolation parameters must run from exactly 0 to exactly 1',
        { value: closed ? ub[n - 1] : ub[0] },
      );
    }
  }
  for (let k = 1; k < n; k++) {
    if (!(ub[k]! > ub[k - 1]!)) {
      fail(
        'schoenberg-whitney',
        `parameters ${k - 1} and ${k} are not increasing (${ub[k - 1]}, ${ub[k]}): coincident consecutive points cannot be interpolated`,
        { index: k, value: ub[k] },
      );
    }
  }
  if (closed && !(ub[n - 1]! < 1)) {
    fail(
      'schoenberg-whitney',
      'the last point closes onto the first: list each point of a closed curve once',
      { index: n - 1 },
    );
  }
  return ub;
}

export function checkDegree(p: number): void {
  if (!Number.isInteger(p) || p < 1) {
    fail('invalid-degree', `degree must be an integer ≥ 1; got ${p}`, { value: p });
  }
}

/** The coordinates of a point of dimension `dim`, validated finite. */
export function pointValues<D extends Dim>(dim: D, x: PointOf<D>, what: string): Float64Array {
  const v =
    dim === 1
      ? [x as number]
      : dim === 2
        ? [(x as PointOf<2>).x, (x as PointOf<2>).y]
        : [(x as PointOf<3>).x, (x as PointOf<3>).y, (x as PointOf<3>).z];
  for (const c of v) {
    if (typeof c !== 'number' || !Number.isFinite(c)) {
      fail('non-finite', `${what} is not a finite point of dimension ${dim}`, { value: c });
    }
  }
  return Float64Array.from(v);
}

// ---------------------------------------------------------------------------
// Curves
// ---------------------------------------------------------------------------

/**
 * A9.1 GlobalCurveInterp: the clamped B-spline of `degree` (default 3) on
 * `[0, 1]` through `points` (stride `dim`) at `params` (default
 * `'centripetal'`), knots by averaging (eq. 9.8). `endDerivatives` adds
 * `C′(0) = D_0` and / or `C′(1) = D_n` (§9.2.2, eqs. 9.19–9.22): one extra
 * control point per derivative, and the knots average the parameter list with
 * the constrained end repeated (eq. 9.22 for both ends). Needs
 * `points + derivatives ≥ degree + 1`; derivatives need degree ≥ 2.
 */
export function interpolateCurve<D extends Dim>(
  points: ArrayLike<number>,
  dim: D,
  opts?: {
    readonly degree?: number;
    readonly params?: ArrayLike<number> | Parameterization;
    readonly endDerivatives?: readonly [PointOf<D> | null, PointOf<D> | null];
    readonly tol?: Partial<Tolerances>;
  },
): CurveInterpolation<ClampedCurve<D>> {
  const tol = resolveTolerances(opts?.tol);
  const n1 = pointCount(points, dim);
  const p = opts?.degree ?? 3;
  checkDegree(p);
  const ends = opts?.endDerivatives ?? [null, null];
  const d0 = ends[0] == null ? null : pointValues(dim, ends[0], 'start derivative');
  const dn = ends[1] == null ? null : pointValues(dim, ends[1], 'end derivative');
  const k = (d0 ? 1 : 0) + (dn ? 1 : 0);
  if (k > 0 && p < 2) {
    fail('unsupported', 'end derivatives need degree ≥ 2 (§9.2.2)', { value: p });
  }
  if (n1 < 2 || n1 + k < p + 1) {
    fail(
      'too-few-points',
      `degree ${p} interpolation needs points + end derivatives ≥ ${p + 1} (and ≥ 2 points); got ${n1} + ${k}`,
      { value: n1 },
    );
  }
  const ub = interpParams(points, dim, n1, opts?.params, false);
  const count = n1 + k;
  // Eq. 9.8 on the parameter list with each constrained end repeated (eq. 9.22).
  const ext = new Float64Array(count);
  let e = 0;
  ext[e++] = 0;
  if (d0) ext[e++] = 0;
  for (let i = 1; i < n1 - 1; i++) ext[e++] = ub[i]!;
  if (dn) ext[e++] = 1;
  ext[e++] = 1;
  const U = new Float64Array(count + p + 1);
  averageKnots(ext, count - 1, p, U);
  const basis = snappedClamped(p, U, tol);

  // Rows in the book's order: Q_0, [D_0], Q_1 … Q_{n−1}, [D_n], Q_n.
  const K = p + 1;
  const idx = new Int32Array(count * K);
  const val = new Float64Array(count * K);
  const rhs = new Float64Array(count * dim);
  const centre = boxCentre(points, n1, dim);
  const cp = collocate(basis, ub, 0);
  const pointRow = (q: number, row: number): void => {
    for (let j = 0; j < K; j++) {
      idx[row * K + j] = cp.cols[q * K + j]!;
      val[row * K + j] = cp.vals[q * K + j]!;
    }
    for (let c = 0; c < dim; c++) rhs[row * dim + c] = points[q * dim + c]! - centre[c]!;
  };
  const derivRow = (t: number, D: Float64Array, row: number): void => {
    putRows(collocate(basis, [t], 1), 1, idx, val, row);
    for (let c = 0; c < dim; c++) rhs[row * dim + c] = D[c]!;
  };
  let row = 0;
  pointRow(0, row++);
  if (d0) derivRow(0, d0, row++);
  for (let q = 1; q < n1 - 1; q++) pointRow(q, row++);
  if (dn) derivRow(1, dn, row++);
  pointRow(n1 - 1, row++);

  const sq = factorSquare(count, K, idx, val, tol);
  for (let c = 0; c < dim; c++) solveSquare(sq, rhs, c, dim);
  for (let i = 0; i < count; i++)
    for (let c = 0; c < dim; c++) rhs[i * dim + c] = rhs[i * dim + c]! + centre[c]!;
  const curve = makeCurve({ dim, basis, points: rhs }) as ClampedCurve<D>;
  const maxError = curveMaxError(curve, ub, points).max;
  return Object.freeze({ curve, params: ub, maxError });
}

/**
 * The closed interpolant: a periodic B-spline of `degree` (default 3) with one
 * control point per data point, period 1, C^(p−1) everywhere including the
 * seam. Parameters for the closed polygon (default `'centripetal'`); knots by
 * periodic averaging, shifted with the parameters so the domain is `[0, 1)`
 * (the data point at the seam is wherever the shift puts it: see `params`).
 * List each point once (do not repeat the first point at the end).
 */
export function interpolatePeriodic<D extends Dim>(
  points: ArrayLike<number>,
  dim: D,
  opts?: {
    readonly degree?: number;
    readonly params?: ArrayLike<number> | Parameterization;
    readonly tol?: Partial<Tolerances>;
  },
): CurveInterpolation<PeriodicCurve<D>> {
  const tol = resolveTolerances(opts?.tol);
  const n = pointCount(points, dim);
  const p = opts?.degree ?? 3;
  checkDegree(p);
  if (n < p + 1) {
    fail('too-few-points', `periodic degree ${p} interpolation needs ≥ ${p + 1} points; got ${n}`, {
      value: n,
    });
  }
  const raw = interpParams(points, dim, n, opts?.params, true);
  const { ub, basis } = interpolationBasis(raw, p, true, tol);
  const net = solvePeriodicOrClamped(basis, ub, points, n, dim, tol);
  const curve = makeCurve({ dim, basis, points: net }) as PeriodicCurve<D>;
  const maxError = curveMaxError(curve, ub, points).max;
  return Object.freeze({ curve, params: ub, maxError });
}

/** Solves the square collocation system of `basis` at `ub` for `n` points of stride `dim` (centred). */
function solvePeriodicOrClamped(
  basis: Basis,
  ub: Float64Array,
  points: ArrayLike<number>,
  n: number,
  dim: number,
  tol: Tolerances,
): Float64Array {
  const cp = collocate(basis, ub, 0);
  const sq = factorSquare(n, cp.p1, cp.cols, cp.vals, tol);
  const centre = boxCentre(points, n, dim);
  const rhs = new Float64Array(n * dim);
  for (let i = 0; i < n; i++)
    for (let c = 0; c < dim; c++) rhs[i * dim + c] = points[i * dim + c]! - centre[c]!;
  for (let c = 0; c < dim; c++) solveSquare(sq, rhs, c, dim);
  for (let i = 0; i < n; i++)
    for (let c = 0; c < dim; c++) rhs[i * dim + c] = rhs[i * dim + c]! + centre[c]!;
  return rhs;
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

/** One direction of a grid: parameters (shifted with a periodic basis) and the basis. */
export interface GridDir {
  readonly ub: Float64Array;
  readonly basis: Basis;
}

/**
 * The interpolation basis for strictly increasing parameters `raw` (clamped:
 * from exactly 0 to exactly 1; periodic: in `[0, 1)`): knots by averaging
 * (eq. 9.8), or by periodic averaging shifted to `[0, 1)` together with the
 * parameters.
 */
export function interpolationBasis(
  raw: Float64Array,
  p: number,
  periodic: boolean,
  tol: Tolerances,
): GridDir {
  const len = raw.length;
  if (periodic) {
    const { T, shift } = periodicAveraged(raw, p);
    return { ub: shiftParams(raw, shift), basis: snappedPeriodic(p, T, tol) };
  }
  const U = new Float64Array(len + p + 1);
  averageKnots(raw, len - 1, p, U);
  return { ub: raw, basis: snappedClamped(p, U, tol) };
}

/**
 * A9.3's parameters for one direction of a grid (lines that collapse to a
 * point are skipped), validated as interpolation parameters, and the basis by
 * {@link interpolationBasis}.
 */
export function gridDirection(
  grid: ArrayLike<number>,
  rows: number,
  cols: number,
  dir: 'u' | 'v',
  p: number,
  method: Parameterization,
  periodic: boolean,
  tol: Tolerances,
): GridDir {
  const len = dir === 'u' ? rows : cols;
  const raw = new Float64Array(len);
  if (surfMeshParams(grid, rows, cols, dir, exponentOf(method), periodic, raw) === 0) {
    fail(
      'too-few-points',
      `every ${dir === 'u' ? 'column' : 'row'} of the grid collapses to a point`,
    );
  }
  for (let k = 1; k < len; k++) {
    if (!(raw[k]! > raw[k - 1]!)) {
      fail(
        'schoenberg-whitney',
        `grid ${dir} parameters ${k - 1} and ${k} coincide: every line has coincident points there`,
        { index: k },
      );
    }
  }
  if (periodic && !(raw[len - 1]! < 1)) {
    fail('schoenberg-whitney', `the last grid ${dir} line closes onto the first: list it once`, {
      index: len - 1,
    });
  }
  return interpolationBasis(raw, p, periodic, tol);
}

/**
 * A9.4 GlobalSurfInterp: the tensor-product B-spline through a `rows × cols`
 * grid (u-major, stride 3: point `(k, l)` at `(k·cols + l)·3`; rows run along
 * u), degrees default 3, A9.3 parameters per direction (generalised to any
 * {@link Parameterization}, default `'centripetal'`), knots by averaging. A
 * periodic direction lists each line once and gets the closed interpolant.
 * Curves along u are interpolated through every column, then curves along v
 * through every row of the result; each direction's system is factored once.
 */
export function interpolateSurface(
  grid: ArrayLike<number>,
  rows: number,
  cols: number,
  opts?: {
    readonly degreeU?: number;
    readonly degreeV?: number;
    readonly paramU?: Parameterization;
    readonly paramV?: Parameterization;
    readonly periodicU?: boolean;
    readonly periodicV?: boolean;
    readonly tol?: Partial<Tolerances>;
  },
): SurfaceInterpolation {
  const tol = resolveTolerances(opts?.tol);
  for (const [name, x] of [
    ['rows', rows],
    ['cols', cols],
  ] as const) {
    if (!Number.isInteger(x) || x < 2) {
      fail('too-few-points', `grid ${name} must be an integer ≥ 2; got ${x}`, { value: x });
    }
  }
  if (pointCount(grid, 3, 'grid') !== rows * cols) {
    fail(
      'size-mismatch',
      `a ${rows} × ${cols} grid needs ${rows * cols * 3} values; got ${grid.length}`,
      {
        value: grid.length,
      },
    );
  }
  const p = opts?.degreeU ?? 3;
  const q = opts?.degreeV ?? 3;
  checkDegree(p);
  checkDegree(q);
  const pu = opts?.periodicU ?? false;
  const pv = opts?.periodicV ?? false;
  if (rows < p + 1 || cols < q + 1) {
    fail(
      'too-few-points',
      `degrees (${p}, ${q}) need a grid of ≥ ${p + 1} × ${q + 1} points; got ${rows} × ${cols}`,
      { value: rows < p + 1 ? rows : cols },
    );
  }
  const U = gridDirection(grid, rows, cols, 'u', p, opts?.paramU ?? 'centripetal', pu, tol);
  const V = gridDirection(grid, rows, cols, 'v', q, opts?.paramV ?? 'centripetal', pv, tol);

  const centre = boxCentre(grid, rows * cols, 3);
  const net = new Float64Array(rows * cols * 3);
  for (let i = 0; i < rows * cols; i++)
    for (let c = 0; c < 3; c++) net[i * 3 + c] = grid[i * 3 + c]! - centre[c]!;
  // Along u through every column l and coordinate c: entries (k·cols + l)·3 + c.
  const cu = collocate(U.basis, U.ub, 0);
  const su = factorSquare(rows, cu.p1, cu.cols, cu.vals, tol);
  for (let l = 0; l < cols; l++)
    for (let c = 0; c < 3; c++) solveSquare(su, net, l * 3 + c, cols * 3);
  // Along v through every row i: entries (i·cols + l)·3 + c.
  const cv = collocate(V.basis, V.ub, 0);
  const sv = factorSquare(cols, cv.p1, cv.cols, cv.vals, tol);
  for (let i = 0; i < rows; i++)
    for (let c = 0; c < 3; c++) solveSquare(sv, net, i * cols * 3 + c, 3);
  for (let i = 0; i < rows * cols; i++)
    for (let c = 0; c < 3; c++) net[i * 3 + c] = net[i * 3 + c]! + centre[c]!;
  const surface = makeSurface({ u: U.basis, v: V.basis, points: net });

  const out = new Float64Array(rows * cols * 3);
  surfaceEvalGridInto(
    surface,
    U.ub,
    V.ub,
    0,
    out,
    createScratch({ maxDegree: Math.max(p, q), maxDerivs: 0 }),
  );
  let maxError = 0;
  for (let i = 0; i < rows * cols; i++) {
    const dx = out[3 * i]! - grid[3 * i]!;
    const dy = out[3 * i + 1]! - grid[3 * i + 1]!;
    const dz = out[3 * i + 2]! - grid[3 * i + 2]!;
    maxError = Math.max(maxError, Math.sqrt(dx * dx + dy * dy + dz * dz));
  }
  return Object.freeze({ surface, paramsU: U.ub, paramsV: V.ub, maxError });
}

/** Re-exported for the skinning module: the square collocation solve on many right-hand sides. */
export { factorSquare, solveSquare };
