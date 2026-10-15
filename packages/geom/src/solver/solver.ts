// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The constrained fair solver (design §6.13, formulation §10): direct
 * manipulation of a curve or surface. Basis and weights stay fixed; the
 * Euclidean control points `x` move so that
 *
 *     ½ Σ ω_k |S(ξ_k) − q_k|²  +  ½ yᵀ F y  +  ½ Σ_i μ_i |x_i − x_ref,i|²
 *
 * is least, subject to the structural rules of the DOF map (`x = T z + x_fixed`,
 * exact by construction) and the hard linear constraints `C x = d` (drag
 * handles, tangent directions, raw rows), where `y = x − x_ref` (fairness on
 * the displacement, the default for edits: existing rocker or concave is
 * never flattened) or `y = x` (on the shape). `F` is `fairness.ts`'s matrix
 * with the reference's speeds.
 *
 * **Unknowns are displacements.** Everything is assembled for
 * `δ = x − x_ref = T z + δ_f` (`δ_f = x_fixed − x_ref`, zero wherever the
 * target satisfies the rules), so a zero move gives `z = 0` and returns the
 * target bit for bit, and right-hand sides are small numbers (no cancellation
 * against the coordinates; this replaces the centring of §7). The data term's
 * targets become `q − S_ref(ξ)`, shape fairness contributes the force
 * `−F x_ref`.
 *
 * **Range-space KKT** (decision 20, §10.4). With `K = Tᵀ H T` (`H = Hs ⊗ I`,
 * `Hs = AᵀWA + F + diag μ`), `g′ = Tᵀ(g − H δ_f)` and unit-norm constraint rows
 * `C′ = C T`:
 *
 * 1. structure: `K` assembled sparse, ordered by reverse Cuthill–McKee and
 *    factored by envelope Cholesky (`linalg/`), accepted only when its pivots
 *    pass `pivotRel` and its estimated reciprocal condition (diagonally
 *    scaled, 1-norm) exceeds `pivotRel`;
 * 2. pointer-down (`prepareFairSolver`): `z₀ = K⁻¹ g′`, `Y = K⁻¹ C′ᵀ` (each
 *    column's forward solve starts at its first non-zero), `S = C′ Y`,
 *    pivoted Cholesky of `S`: rows with pivots at most `pivotRel ×` the
 *    largest are dependent and dropped;
 * 3. each move (`solveFairInto`, only `d` changes): `λ = S⁻¹ (C′ z₀ − e′)`,
 *    `z = z₀ − Y λ` with `e′ = d − C x_fixed`, then one refinement step on
 *    the constraint residual (`r = C′ z − e′`, `z −= Y S⁻¹ r`), scatter
 *    `x = x_fixed + T z`, and the exact rules (`copy`, coordinate-plane
 *    `mirror`) re-applied from their masters. O(m² + n·m) plus the report's
 *    residuals (one product with `Hs`);
 * 4. dependent rows are reported per solve: `dependent` when the solution
 *    meets them anyway (per-row test `|C_r x − d_r| / max(1, ‖C_r‖) ≤
 *    constraint`, as the fitters judge rows), `inconsistent` otherwise.
 *
 * **When `K` alone is singular** (no stiffness, no data: the affine motions
 * cost no fairness energy) the constraints may still determine the solution
 * (§10.1). The factor is then of `K_ρ = K + ρ C′ᵀ C′`, which has the same
 * KKT solution (the added term vanishes on the constraint set) and is
 * positive definite exactly when the constrained problem has a unique
 * solution; `ρ` balances the largest diagonals of `K` and `C′ᵀC′`. It is
 * not regularisation (decision 24): the solution is unchanged. On the
 * constraint set of the independent rows `ρ |C′ z|²` is constant (dependent
 * rows are combinations `C′_D = Γ C′_I` of them, `Γ = S_DI S_II⁻¹`), so the
 * per-move formula is the same as without it, and a contradictory dependent
 * row cannot pull the solution. Only the multipliers change, by
 * `ρ (C′_I z + Γᵀ C′_D z)`, which the solve adds back.
 *
 * Separable problems (every rule axis-diagonal, every row on one axis) give a
 * `K` that is block-diagonal by axis; RCM numbers the blocks one after the
 * other, so the envelope factor costs what three per-axis factors cost.
 */
import { makeScratch } from '../array';
import { checkParam, spanOf } from '../basis';
import { checkCurveShape, curveFromHomogeneous } from '../curve';
import { errResult, fail, okResult } from '../errors';
import { checkCurveConstraints, checkSurfaceConstraints, normalsOf } from '../fit/approximate';
import type { CurveConstraint, SurfaceConstraint } from '../fit/approximate';
import { pivotedCholesky, pivotedCholeskySolve } from '../linalg/dense';
import type { PivotedCholesky } from '../linalg/dense';
import {
  envCholFactor,
  envCholSolve,
  envelopeCopy,
  envelopeFromCsr,
  envRcond,
} from '../linalg/envelope';
import type { Envelope } from '../linalg/envelope';
import { invertPerm, rcmOrder } from '../linalg/rcm';
import { coo, cooAdd, cooToCsr, csrMulStrided } from '../linalg/sparse';
import type { Csr } from '../linalg/sparse';
import { checkSurfaceShape, surfaceFromHomogeneous } from '../surface';
import { resolveTolerances } from '../tolerance';
import type { Tolerances } from '../tolerance';
import type {
  Basis,
  GeomIssue,
  NurbsCurve,
  NurbsSurface,
  ReadonlyF64,
  ReadonlyI32,
  Result,
} from '../types';
import { derivedOps } from './dof';
import type { DerivedOp, DofMap } from './dof';
import { checkFairness, euclidean, fairnessMatrixOf } from './fairness';
import type { FairnessWeights } from './fairness';
import { curveLocal, surfaceLocal } from './local';

/** A hard linear condition: a curve or surface constraint, or a raw row on control coordinates. */
export type LinearConstraint =
  | CurveConstraint
  | SurfaceConstraint
  | {
      readonly kind: 'raw';
      readonly terms: readonly {
        readonly cp: number;
        readonly axis: 0 | 1 | 2;
        readonly coeff: number;
      }[];
      readonly rhs: number;
    };

export interface FairProblem {
  /** Basis and weights fixed; its control points are `x_ref`. */
  readonly target: NurbsCurve | NurbsSurface;
  readonly dof: DofMap;
  readonly fairness: FairnessWeights;
  /** μ ≥ 0: one value, or one per control point (the falloff). */
  readonly stiffness: number | ArrayLike<number>;
  /** Soft targets: curve `t` (surface `(u, v)` interleaved) per point, points (stride dim), weights ≥ 0. */
  readonly data?: {
    readonly params: ArrayLike<number>;
    readonly points: ArrayLike<number>;
    readonly weights?: ArrayLike<number>;
  };
  /** Hard. Only their kind, location and axes are read: the values come with each solve. */
  readonly constraints: readonly LinearConstraint[];
}

export interface FairSolver {
  readonly dofCount: number;
  /** Scalar constraint rows (a point constraint gives one per selected axis). */
  readonly constraintCount: number;
  /** Independent rows. */
  readonly rank: number;
  readonly separable: boolean;
}

export interface SolveReport {
  /** Largest `|C_r x − d_r|` over the rows not reported inconsistent. */
  readonly constraintResidual: number;
  /** `‖Tᵀ (∇E + Cᵀ λ)‖∞` at the solution (first-order optimality in the free unknowns). */
  readonly stationarityResidual: number;
  /** The objective (module comment, with its ½ factors). */
  readonly energy: number;
  /** Dependent rows the solution meets (dropped from the solve). */
  readonly dependent: ReadonlyI32;
  /** Dependent rows it does not meet (dropped; see `residuals`). */
  readonly inconsistent: ReadonlyI32;
  /** One per row, for the caller's (unscaled) rows: `H x + Cᵀ λ = g`. Dropped rows: 0. */
  readonly multipliers: ReadonlyF64;
  /** `|C_r x − d_r|` per row. */
  readonly residuals: ReadonlyF64;
}

/** The solver's internals (opaque to callers). */
interface SolverImpl extends FairSolver {
  readonly target: NurbsCurve | NurbsSurface;
  readonly surface: boolean;
  readonly n: number;
  readonly dim: number;
  readonly xRef: Float64Array;
  readonly fixed: ReadonlyF64;
  /** `T` with columns renumbered into the factor's order. */
  readonly T: Csr;
  readonly Hs: Csr;
  /** δ-space right-hand side `g` (interleaved). */
  readonly g: Float64Array;
  readonly energy0: number;
  readonly m: number;
  /** Rows: x-space sparse (interleaved indices), unscaled. */
  readonly rowIdx: readonly Int32Array[];
  readonly rowVal: readonly Float64Array[];
  readonly rowNorm: Float64Array;
  /** Where each row's value comes from: `values[src·3 + comp]`, or −1 for a zero right-hand side. */
  readonly rowValue: Int32Array;
  readonly rowSrc: Int32Array;
  readonly rowComp: Int32Array;
  /** `C_r · x_fixed / ‖C_r‖`. */
  readonly cfix: Float64Array;
  /** C′ rows in z (factor order), scaled. */
  readonly cpIdx: readonly Int32Array[];
  readonly cpVal: readonly Float64Array[];
  readonly z0: Float64Array;
  /** `Y`, column `k` at `[k·nz, (k+1)·nz)`. */
  readonly Y: Float64Array;
  readonly S: Float64Array;
  readonly F: PivotedCholesky;
  readonly independent: Uint8Array;
  readonly cz0: Float64Array;
  readonly rho: number;
  readonly derived: readonly DerivedOp[];
  /** `constraints.length` of the problem (values has 3 per constraint). */
  readonly ncons: number;
  /** The `constraint` tolerance used to classify dependent rows. */
  readonly tolConstraint: number;
  // Work buffers (a solver is drag-session state; solves are synchronous).
  readonly wz: Float64Array;
  readonly wx: Float64Array;
  readonly wx2: Float64Array;
  readonly wm: Float64Array;
  readonly wm2: Float64Array;
  readonly wm3: Float64Array;
  readonly wm4: Float64Array;
}

function isSurface(g: NurbsCurve | NurbsSurface): g is NurbsSurface {
  return (g as NurbsSurface).u !== undefined;
}

function issue(
  code: GeomIssue['code'],
  severity: GeomIssue['severity'],
  message: string,
  value?: number,
  index?: number,
): GeomIssue {
  return {
    code,
    severity,
    message,
    ...(index !== undefined ? { at: { index } } : {}),
    ...(value !== undefined ? { value } : {}),
  };
}

function checkNonNeg(x: number, what: string, index?: number): number {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < 0) {
    fail('unsupported', `${what} must be a finite number ≥ 0; got ${String(x)}`, {
      index,
      value: x,
    });
  }
  return x;
}

/** Constraint rows in x-space (interleaved indices), with where each right-hand side comes from. */
interface Rows {
  idx: Int32Array[];
  val: Float64Array[];
  src: number[];
  comp: number[];
  /** `values[src·3 + comp]`, or −1: a zero right-hand side (tangent direction). */
  value: number[];
}

function buildCurveRows(
  c: NurbsCurve,
  cons: readonly LinearConstraint[],
  tol: Tolerances,
  rows: Rows,
): void {
  const b = c.basis;
  const p1 = b.degree + 1;
  const dim = c.dim;
  const s = makeScratch(b.degree, 3);
  const R = new Float64Array(4 * p1);
  const li = new Int32Array(p1);
  cons.forEach((k0, k) => {
    if (k0.kind === 'raw') return;
    const [cc] = checkCurveConstraints([k0 as CurveConstraint], dim, b.degree);
    const t = checkParam(b, cc!.t, undefined, tol);
    const span = spanOf(b, t, false);
    curveLocal(b, c.cw, dim + 1, c.rational, t, span, cc!.order, s, li, R);
    const vals = R.subarray(cc!.order * p1, (cc!.order + 1) * p1);
    if (cc!.kind === 'tangentDirection') {
      for (const nrm of normalsOf(cc!.value)) {
        const idx = new Int32Array(dim * p1);
        const val = new Float64Array(dim * p1);
        for (let a = 0; a < dim; a++) {
          for (let j = 0; j < p1; j++) {
            idx[a * p1 + j] = li[j]! * dim + a;
            val[a * p1 + j] = nrm[a]! * vals[j]!;
          }
        }
        rows.idx.push(idx);
        rows.val.push(val);
        rows.src.push(k);
        rows.comp.push(-1);
        rows.value.push(-1);
      }
      return;
    }
    for (let a = 0; a < dim; a++) {
      rows.idx.push(Int32Array.from(li, (i) => i * dim + a));
      rows.val.push(vals.slice());
      rows.src.push(k);
      rows.comp.push(a);
      rows.value.push(k * 3 + a);
    }
  });
}

function buildSurfaceRows(
  sf: NurbsSurface,
  cons: readonly LinearConstraint[],
  tol: Tolerances,
  rows: Rows,
): void {
  const K = (sf.u.degree + 1) * (sf.v.degree + 1);
  const s = makeScratch(Math.max(sf.u.degree, sf.v.degree), 3);
  const R = new Float64Array(9 * K);
  const li = new Int32Array(K);
  cons.forEach((k0, k) => {
    if (k0.kind === 'raw') return;
    if (k0.kind !== 'point' && k0.kind !== 'derivative') {
      fail(
        'unsupported',
        `constraint ${k}: kind '${String(k0.kind)}' does not apply to a surface`,
        { index: k },
      );
    }
    const [c] = checkSurfaceConstraints([k0 as SurfaceConstraint], sf.u, sf.v, tol);
    const su = spanOf(sf.u, c!.u, false);
    const sv = spanOf(sf.v, c!.v, false);
    surfaceLocal(sf.u, sf.v, sf.cw, sf.rational, c!.u, c!.v, su, sv, c!.du, c!.dv, s, li, R);
    const o = (c!.du * (c!.dv + 1) + c!.dv) * K;
    for (let a = 0; a < 3; a++) {
      if (!(c!.axes & (1 << a))) continue;
      rows.idx.push(Int32Array.from(li, (i) => i * 3 + a));
      rows.val.push(R.slice(o, o + K));
      rows.src.push(k);
      rows.comp.push(a);
      rows.value.push(k * 3 + a);
    }
  });
}

function buildRawRows(
  cons: readonly LinearConstraint[],
  n: number,
  dim: number,
  rows: Rows,
  order: number[],
): void {
  cons.forEach((c, k) => {
    if (c.kind !== 'raw') return;
    if (!Array.isArray(c.terms) || c.terms.length === 0) {
      fail('unsupported', `constraint ${k}: a raw row needs at least one term`, { index: k });
    }
    const idx = new Int32Array(c.terms.length);
    const val = new Float64Array(c.terms.length);
    c.terms.forEach((t, e) => {
      if (!Number.isInteger(t.cp) || t.cp < 0 || t.cp >= n) {
        fail('size-mismatch', `constraint ${k}: control point ${t.cp} is out of range`, {
          index: k,
        });
      }
      if (!Number.isInteger(t.axis) || t.axis < 0 || t.axis >= dim) {
        fail(
          'size-mismatch',
          `constraint ${k}: axis ${t.axis} is out of range for dimension ${dim}`,
          { index: k },
        );
      }
      if (!Number.isFinite(t.coeff))
        fail('non-finite', `constraint ${k}: coefficient is not finite`, { index: k });
      idx[e] = t.cp * dim + t.axis;
      val[e] = t.coeff;
    });
    rows.idx.push(idx);
    rows.val.push(val);
    rows.src.push(k);
    rows.comp.push(0);
    rows.value.push(k * 3);
    order.push(rows.idx.length - 1);
  });
}

/** Data rows: the local basis at each data parameter (indices are control points). */
function dataRows(
  target: NurbsCurve | NurbsSurface,
  params: ArrayLike<number>,
  count: number,
  tol: Tolerances,
): { K: number; idx: Int32Array; val: Float64Array } {
  if (isSurface(target)) {
    const K = (target.u.degree + 1) * (target.v.degree + 1);
    const s = makeScratch(Math.max(target.u.degree, target.v.degree), 3);
    const R = new Float64Array(K);
    const li = new Int32Array(K);
    const idx = new Int32Array(count * K);
    const val = new Float64Array(count * K);
    for (let k = 0; k < count; k++) {
      const u = checkParam(target.u, params[2 * k]!, undefined, tol);
      const v = checkParam(target.v, params[2 * k + 1]!, undefined, tol);
      surfaceLocal(
        target.u,
        target.v,
        target.cw,
        target.rational,
        u,
        v,
        spanOf(target.u, u, false),
        spanOf(target.v, v, false),
        0,
        0,
        s,
        li,
        R,
      );
      idx.set(li, k * K);
      val.set(R, k * K);
    }
    return { K, idx, val };
  }
  const b = target.basis;
  const K = b.degree + 1;
  const s = makeScratch(b.degree, 3);
  const R = new Float64Array(K);
  const li = new Int32Array(K);
  const idx = new Int32Array(count * K);
  const val = new Float64Array(count * K);
  for (let k = 0; k < count; k++) {
    const t = checkParam(b, params[k]!, undefined, tol);
    curveLocal(b, target.cw, target.dim + 1, target.rational, t, spanOf(b, t, false), 0, s, li, R);
    idx.set(li, k * K);
    val.set(R, k * K);
  }
  return { K, idx, val };
}

/**
 * `K = Tᵀ (Hs ⊗ I_dim) T` in CSR (symmetric, both triangles). The matrices'
 * arrays are read into locals: `Csr` records reach here with different
 * shapes (DOF map, COO conversion), and property loads in the inner loop
 * would go megamorphic.
 */
function reduce(T: Csr, Hs: Csr, dim: number, nz: number): Csr {
  const tPtr = T.rowPtr;
  const tCol = T.col;
  const tVal = T.val;
  const hPtr = Hs.rowPtr;
  const hCol = Hs.col;
  const hVal = Hs.val;
  // Column access to T: for each z, the x rows it touches.
  const cnt = new Int32Array(nz + 1);
  for (let p = 0; p < tCol.length; p++) cnt[tCol[p]! + 1]!++;
  for (let a = 0; a < nz; a++) cnt[a + 1] = cnt[a + 1]! + cnt[a]!;
  const pos = cnt.slice(0, nz);
  const tr = new Int32Array(tCol.length);
  const tv = new Float64Array(tCol.length);
  for (let r = 0; r < T.rows; r++) {
    for (let p = tPtr[r]!; p < tPtr[r + 1]!; p++) {
      const q = pos[tCol[p]!]!++;
      tr[q] = r;
      tv[q] = tVal[p]!;
    }
  }
  const acc = new Float64Array(nz);
  const mark = new Int32Array(nz).fill(-1);
  const list = new Int32Array(nz);
  const rowPtr = new Int32Array(nz + 1);
  let cols = new Int32Array(Math.max(16, hCol.length * dim));
  let vals = new Float64Array(cols.length);
  let nnz = 0;
  for (let a = 0; a < nz; a++) {
    let len = 0;
    for (let q = cnt[a]!; q < cnt[a + 1]!; q++) {
      const r = tr[q]!;
      const ta = tv[q]!;
      const i = (r / dim) | 0;
      const c = r - i * dim;
      for (let p = hPtr[i]!; p < hPtr[i + 1]!; p++) {
        const s = hCol[p]! * dim + c;
        const h = ta * hVal[p]!;
        for (let e = tPtr[s]!; e < tPtr[s + 1]!; e++) {
          const b = tCol[e]!;
          if (mark[b] !== a) {
            mark[b] = a;
            acc[b] = 0;
            list[len++] = b;
          }
          acc[b] = acc[b]! + h * tVal[e]!;
        }
      }
    }
    list.subarray(0, len).sort(); // numeric for typed arrays
    if (nnz + len > cols.length) {
      const c2 = new Int32Array(Math.max(2 * cols.length, nnz + len));
      const v2 = new Float64Array(c2.length);
      c2.set(cols.subarray(0, nnz));
      v2.set(vals.subarray(0, nnz));
      cols = c2;
      vals = v2;
    }
    for (let k = 0; k < len; k++) {
      const b = list[k]!;
      cols[nnz] = b;
      vals[nnz++] = acc[b]!;
    }
    rowPtr[a + 1] = nnz;
  }
  return { rows: nz, cols: nz, rowPtr, col: cols.slice(0, nnz), val: vals.slice(0, nnz) };
}

/** `K + ρ Σ_k c_k c_kᵀ` for sparse rows `c_k` (z-space). */
function augment(
  K: Csr,
  idx: readonly Int32Array[],
  val: readonly Float64Array[],
  rho: number,
): Csr {
  const b = coo(K.rows, K.cols, K.val.length + idx.reduce((s, r) => s + r.length * r.length, 0));
  for (let i = 0; i < K.rows; i++) {
    for (let p = K.rowPtr[i]!; p < K.rowPtr[i + 1]!; p++) cooAdd(b, i, K.col[p]!, K.val[p]!);
  }
  for (let k = 0; k < idx.length; k++) {
    const ri = idx[k]!;
    const rv = val[k]!;
    for (let a = 0; a < ri.length; a++) {
      for (let c = 0; c < ri.length; c++) cooAdd(b, ri[a]!, ri[c]!, rho * rv[a]! * rv[c]!);
    }
  }
  return cooToCsr(b);
}

function maxDiag(A: Csr): number {
  let m = 0;
  for (let i = 0; i < A.rows; i++) {
    for (let p = A.rowPtr[i]!; p < A.rowPtr[i + 1]!; p++)
      if (A.col[p] === i) m = Math.max(m, A.val[p]!);
  }
  return m;
}

/** Orders, factors and checks `A`; `null` with the failing original index or the condition. */
function factor(
  A: Csr,
  tol: Tolerances,
):
  | { ok: true; L: Envelope; perm: Int32Array; iperm: Int32Array }
  | { ok: false; index: number; rcond: number } {
  const perm = rcmOrder(A);
  const iperm = invertPerm(perm);
  const A0 = envelopeFromCsr(A, perm, iperm);
  const L = envelopeCopy(A0);
  const failed = envCholFactor(L, tol.pivotRel);
  if (failed >= 0) return { ok: false, index: perm[failed]!, rcond: 0 };
  const rcond = A.rows > 0 ? envRcond(A0, L) : 1;
  if (!(rcond > tol.pivotRel)) return { ok: false, index: -1, rcond };
  return { ok: true, L, perm, iperm };
}

/** Everything a solve is built from, shared with the test-only reference solver. */
export interface FairAssembly {
  readonly target: NurbsCurve | NurbsSurface;
  readonly surf: boolean;
  readonly dim: number;
  readonly n: number;
  readonly nz: number;
  readonly dof: DofMap;
  readonly xRef: Float64Array;
  /** `Hs = AᵀWA + F + diag μ` (scalar, over control points). */
  readonly Hs: Csr;
  /** δ-space right-hand side (interleaved). */
  readonly g: Float64Array;
  /** `g − H δ_f`. */
  readonly gx: Float64Array;
  readonly energy0: number;
  /** `T` as given by the DOF map. */
  readonly T0: Csr;
  /** Constraint rows in x-space (interleaved indices), unscaled, in constraint order. */
  readonly rowIdx: readonly Int32Array[];
  readonly rowVal: readonly Float64Array[];
  readonly rowSrc: readonly number[];
  readonly rowComp: readonly number[];
  /** `values[...]` index of each row's right-hand side, or −1 for 0. */
  readonly rowValue: readonly number[];
  readonly ncons: number;
}

/** Validates a {@link FairProblem} and assembles it (internal; module comment). */
export function assembleFair(p: FairProblem, tol: Tolerances): FairAssembly {
  if (typeof p !== 'object' || p === null) fail('unsupported', 'problem must be an object');
  const target = p.target;
  const surf = isSurface(target);
  if (surf) checkSurfaceShape(target);
  else checkCurveShape(target);
  const dim = surf ? 3 : (target as NurbsCurve).dim;
  const n = surf ? target.u.count * target.v.count : (target as NurbsCurve).basis.count;
  const dof = p.dof;
  if (typeof dof !== 'object' || dof === null || dof.cpCount !== n || dof.dim !== dim) {
    fail(
      'size-mismatch',
      `the DOF map is for ${String(dof?.cpCount)} points of dimension ${String(dof?.dim)}; the target has ${n} of dimension ${dim}`,
    );
  }
  const fw = checkFairness(p.fairness, surf ? 'surface' : 'curve', 'displacement');
  const xRef = euclidean(target.cw, n, dim);
  const nr = n * dim;
  const nz = dof.dofCount;

  // Stiffness.
  const mu = new Float64Array(n);
  if (typeof p.stiffness === 'number') mu.fill(checkNonNeg(p.stiffness, 'stiffness'));
  else {
    if (p.stiffness === null || typeof p.stiffness !== 'object' || p.stiffness.length !== n) {
      fail('size-mismatch', `stiffness must be a number or ${n} values`);
    }
    for (let i = 0; i < n; i++) mu[i] = checkNonNeg(p.stiffness[i]!, 'stiffness', i);
  }

  // Hs = AᵀWA + F + diag μ, and the δ-space right-hand side g.
  const H = coo(n, n, n * 16);
  const g = new Float64Array(nr);
  let energy0 = 0;
  for (let i = 0; i < n; i++) if (mu[i]! > 0) cooAdd(H, i, i, mu[i]!);
  if (p.data !== undefined) {
    const { params, points, weights } = p.data;
    const count = points.length / dim;
    if (!Number.isInteger(count) || params.length !== (surf ? 2 : 1) * count) {
      fail(
        'size-mismatch',
        `data: ${points.length} coordinates and ${params.length} parameters do not match`,
      );
    }
    if (weights !== undefined && weights.length !== count) {
      fail('size-mismatch', `data: expected ${count} weights; got ${weights.length}`);
    }
    for (let k = 0; k < points.length; k++) {
      if (!Number.isFinite(points[k]!))
        fail('non-finite', `data point coordinate ${k} is not finite`, { index: k });
    }
    const rows = dataRows(target, params, count, tol);
    const K = rows.K;
    for (let k = 0; k < count; k++) {
      const w = weights === undefined ? 1 : checkNonNeg(weights[k]!, 'data weight', k);
      if (w === 0) continue;
      const o = k * K;
      // Residual of the reference: q − S_ref(ξ).
      let r2 = 0;
      const res = [0, 0, 0];
      for (let c = 0; c < dim; c++) {
        let s = 0;
        for (let a = 0; a < K; a++) s += rows.val[o + a]! * xRef[rows.idx[o + a]! * dim + c]!;
        res[c] = points[k * dim + c]! - s;
        r2 += res[c]! * res[c]!;
      }
      energy0 += 0.5 * w * r2;
      for (let a = 0; a < K; a++) {
        const ia = rows.idx[o + a]!;
        const wa = w * rows.val[o + a]!;
        if (wa === 0) continue;
        for (let b = 0; b < K; b++) cooAdd(H, ia, rows.idx[o + b]!, wa * rows.val[o + b]!);
        for (let c = 0; c < dim; c++) g[ia * dim + c] = g[ia * dim + c]! + wa * res[c]!;
      }
    }
  }
  if (fw.stretch > 0 || fw.bend > 0 || fw.jerk > 0) {
    const Fm = fairnessMatrixOf(target, fw, target, tol);
    for (let i = 0; i < n; i++) {
      for (let q = Fm.rowPtr[i]!; q < Fm.rowPtr[i + 1]!; q++) cooAdd(H, i, Fm.col[q]!, Fm.val[q]!);
    }
    if (fw.on === 'shape') {
      const Fx = new Float64Array(nr);
      csrMulStrided(Fm, xRef, Fx, dim);
      for (let i = 0; i < nr; i++) {
        g[i] = g[i]! - Fx[i]!;
        energy0 += 0.5 * xRef[i]! * Fx[i]!;
      }
    }
  }
  const Hs = cooToCsr(H);

  // T, and δ_f = x_fixed − x_ref.
  const T0: Csr = {
    rows: nr,
    cols: nz,
    rowPtr: dof.rowPtr as Int32Array,
    col: dof.col as Int32Array,
    val: dof.val as Float64Array,
  };
  const df = new Float64Array(nr);
  let anyDf = false;
  for (let i = 0; i < nr; i++) {
    df[i] = dof.fixed[i]! - xRef[i]!;
    if (df[i] !== 0) anyDf = true;
  }
  const gx = g.slice();
  if (anyDf) {
    const Hd = new Float64Array(nr);
    csrMulStrided(Hs, df, Hd, dim);
    for (let i = 0; i < nr; i++) gx[i] = gx[i]! - Hd[i]!;
  }

  // Constraint rows.
  const cons = p.constraints;
  if (!Array.isArray(cons)) fail('unsupported', 'constraints must be an array');
  const rows: Rows = { idx: [], val: [], src: [], comp: [], value: [] };
  // Build in constraint order: geometric constraints and raw rows interleaved by index.
  const geo: Rows = { idx: [], val: [], src: [], comp: [], value: [] };
  if (surf) buildSurfaceRows(target, cons, tol, geo);
  else buildCurveRows(target as NurbsCurve, cons, tol, geo);
  const raw: Rows = { idx: [], val: [], src: [], comp: [], value: [] };
  buildRawRows(cons, n, dim, raw, []);
  {
    let a = 0;
    let b = 0;
    while (a < geo.idx.length || b < raw.idx.length) {
      const fromGeo = b >= raw.idx.length || (a < geo.idx.length && geo.src[a]! < raw.src[b]!);
      const src = fromGeo ? geo : raw;
      const k = fromGeo ? a++ : b++;
      rows.idx.push(src.idx[k]!);
      rows.val.push(src.val[k]!);
      rows.src.push(src.src[k]!);
      rows.comp.push(src.comp[k]!);
      rows.value.push(src.value[k]!);
    }
  }
  return {
    target,
    surf,
    dim,
    n,
    nz,
    dof,
    xRef,
    Hs,
    g,
    gx,
    energy0,
    T0,
    rowIdx: rows.idx,
    rowVal: rows.val,
    rowSrc: rows.src,
    rowComp: rows.comp,
    rowValue: rows.value,
    ncons: cons.length,
  };
}

/**
 * Prepares a drag: assembles, orders and factors the reduced system and the
 * Schur complement of the constraints (module comment, steps 1–2). Contract
 * violations throw; a system the data, stiffness and constraints do not
 * determine is an error result (`not-positive-definite`, or
 * `singular-system` with the condition estimate); dependent rows are a
 * `dependent-constraints` warning.
 */
export function prepareFairSolver(p: FairProblem, tolIn?: Partial<Tolerances>): Result<FairSolver> {
  const tol = resolveTolerances(tolIn);
  const A = assembleFair(p, tol);
  const { target, surf, dim, n, nz, dof, xRef, Hs, g, gx, energy0, T0 } = A;
  const nr = n * dim;
  const rows = { idx: A.rowIdx, val: A.rowVal, src: A.rowSrc, comp: A.rowComp, value: A.rowValue };
  const Kc = reduce(T0, Hs, dim, nz);
  const m = rows.idx.length;
  const rowNorm = new Float64Array(m);
  const cfix = new Float64Array(m);
  const cpIdxZ: Int32Array[] = [];
  const cpValZ: Float64Array[] = [];
  {
    const acc = new Float64Array(nz);
    const mark = new Int32Array(nz).fill(-1);
    for (let k = 0; k < m; k++) {
      const idx = rows.idx[k]!;
      const val = rows.val[k]!;
      let s2 = 0;
      for (let e = 0; e < val.length; e++) s2 += val[e]! * val[e]!;
      const nrm = Math.sqrt(s2);
      if (!(nrm > 0)) {
        fail(
          'unsupported',
          `constraint ${rows.src[k]!}: its row is zero (the condition does not involve any control point)`,
          {
            index: rows.src[k]!,
          },
        );
      }
      rowNorm[k] = nrm;
      let cf = 0;
      const list: number[] = [];
      for (let e = 0; e < idx.length; e++) {
        const r = idx[e]!;
        const v = val[e]! / nrm;
        cf += v * dof.fixed[r]!;
        for (let q = T0.rowPtr[r]!; q < T0.rowPtr[r + 1]!; q++) {
          const zc = T0.col[q]!;
          if (mark[zc] !== k) {
            mark[zc] = k;
            acc[zc] = 0;
            list.push(zc);
          }
          acc[zc] = acc[zc]! + v * T0.val[q]!;
        }
      }
      cfix[k] = cf;
      list.sort((x, y) => x - y);
      cpIdxZ.push(Int32Array.from(list));
      cpValZ.push(Float64Array.from(list, (zc) => acc[zc]!));
    }
  }

  // Factor K, or K + ρ C′ᵀC′ when K alone is singular.
  let rho = 0;
  let fac = factor(Kc, tol);
  if (!fac.ok && m > 0) {
    let cdiag = 0;
    const d = new Float64Array(nz);
    for (let k = 0; k < m; k++) {
      const ri = cpIdxZ[k]!;
      const rv = cpValZ[k]!;
      for (let e = 0; e < ri.length; e++) d[ri[e]!] = d[ri[e]!]! + rv[e]! * rv[e]!;
    }
    for (let i = 0; i < nz; i++) cdiag = Math.max(cdiag, d[i]!);
    const kd = maxDiag(Kc);
    rho = cdiag > 0 ? (kd > 0 ? kd / cdiag : 1) : 0;
    if (rho > 0) fac = factor(augment(Kc, cpIdxZ, cpValZ, rho), tol);
  }
  if (!fac.ok) {
    if (fac.index >= 0) {
      return errResult([
        issue(
          'not-positive-definite',
          'error',
          `the system does not determine unknown ${fac.index}: stiffness, data or constraints must fix every degree of freedom (fairness alone leaves the affine motions free)`,
          undefined,
          fac.index,
        ),
      ]);
    }
    return errResult([
      issue(
        'singular-system',
        'error',
        `the system is numerically singular: estimated reciprocal condition ${fac.rcond}`,
        fac.rcond,
      ),
    ]);
  }
  const { L, iperm } = fac;

  // Renumber z into the factor's order: T's columns, C′ rows, g′.
  const T: Csr = {
    rows: nr,
    cols: nz,
    rowPtr: T0.rowPtr,
    col: Int32Array.from(T0.col, (c) => iperm[c]!),
    val: T0.val,
  };
  const cpIdx = cpIdxZ.map((r) => Int32Array.from(r, (c) => iperm[c]!));
  const cpVal = cpValZ;
  const gp = new Float64Array(nz);
  for (let r = 0; r < nr; r++) {
    for (let q = T.rowPtr[r]!; q < T.rowPtr[r + 1]!; q++)
      gp[T.col[q]!] = gp[T.col[q]!]! + T.val[q]! * gx[r]!;
  }
  const z0 = gp;
  envCholSolve(L, z0);
  const Y = new Float64Array(m * nz);
  for (let k = 0; k < m; k++) {
    const y = Y.subarray(k * nz, (k + 1) * nz);
    const ri = cpIdx[k]!;
    let start = nz;
    for (let e = 0; e < ri.length; e++) {
      y[ri[e]!] = cpVal[k]![e]!;
      if (ri[e]! < start) start = ri[e]!;
    }
    if (start < nz) envCholSolve(L, y, start);
  }
  const S = new Float64Array(m * m);
  const cz0 = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const ri = cpIdx[i]!;
    const rv = cpVal[i]!;
    let c0 = 0;
    for (let e = 0; e < ri.length; e++) c0 += rv[e]! * z0[ri[e]!]!;
    cz0[i] = c0;
    for (let j = 0; j <= i; j++) {
      let s = 0;
      const oj = j * nz;
      for (let e = 0; e < ri.length; e++) s += rv[e]! * Y[oj + ri[e]!]!;
      S[i * m + j] = s;
      S[j * m + i] = s;
    }
  }
  // Symmetrise: S_ij and S_ji are computed from different columns; average them.
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < i; j++) {
      const ri = cpIdx[j]!;
      const rv = cpVal[j]!;
      let s = 0;
      const oi = i * nz;
      for (let e = 0; e < ri.length; e++) s += rv[e]! * Y[oi + ri[e]!]!;
      const v = 0.5 * (S[i * m + j]! + s);
      S[i * m + j] = v;
      S[j * m + i] = v;
    }
  }
  const PF = pivotedCholesky(m, S, tol.pivotRel);
  const independent = new Uint8Array(m);
  for (let k = 0; k < PF.rank; k++) independent[PF.perm[k]!] = 1;

  // Separable: T separable and every C′ row on one axis.
  let separable = dof.separable;
  if (separable && m > 0) {
    const axisOf = new Int32Array(nz).fill(-1);
    for (let r = 0; r < nr; r++) {
      for (let q = T.rowPtr[r]!; q < T.rowPtr[r + 1]!; q++) axisOf[T.col[q]!] = r % dim;
    }
    for (let k = 0; k < m && separable; k++) {
      const ri = cpIdx[k]!;
      for (let e = 1; e < ri.length; e++) if (axisOf[ri[e]!] !== axisOf[ri[0]!]) separable = false;
    }
  }

  const issues: GeomIssue[] = [];
  if (PF.rank < m) {
    const dep: number[] = [];
    for (let k = PF.rank; k < m; k++) dep.push(PF.perm[k]!);
    dep.sort((a, b) => a - b);
    issues.push(
      issue(
        'dependent-constraints',
        'warning',
        `constraint rows ${dep.join(', ')} depend on the others; each solve reports whether they are met`,
        dep.length,
        dep[0],
      ),
    );
  }
  const impl: SolverImpl = {
    dofCount: nz,
    constraintCount: m,
    rank: PF.rank,
    separable,
    target,
    surface: surf,
    n,
    dim,
    xRef,
    fixed: dof.fixed,
    T,
    Hs,
    g,
    energy0,
    m,
    rowIdx: rows.idx,
    rowVal: rows.val,
    rowNorm,
    rowValue: Int32Array.from(rows.value),
    rowSrc: Int32Array.from(rows.src),
    rowComp: Int32Array.from(rows.comp),
    cfix,
    cpIdx,
    cpVal,
    z0,
    Y,
    S,
    F: PF,
    independent,
    cz0,
    rho,
    derived: derivedOps(dof),
    ncons: A.ncons,
    tolConstraint: tol.constraint,
    wz: new Float64Array(nz),
    wx: new Float64Array(nr),
    wx2: new Float64Array(nr),
    wm: new Float64Array(m),
    wm2: new Float64Array(m),
    wm3: new Float64Array(m),
    wm4: new Float64Array(m),
  };
  return okResult(Object.freeze(impl) as FairSolver, issues);
}

function implOf(s: FairSolver): SolverImpl {
  const impl = s as SolverImpl;
  if (typeof s !== 'object' || s === null || !(impl.Y instanceof Float64Array)) {
    fail('unsupported', 'not a solver from prepareFairSolver');
  }
  return impl;
}

/** `e′_k`: the scaled right-hand side of row `k` in z (`(d − C x_fixed)/‖C_r‖`). */
function rhsInto(s: SolverImpl, values: ArrayLike<number>, out: Float64Array): void {
  for (let k = 0; k < s.m; k++) {
    const vi = s.rowValue[k]!;
    const d = vi < 0 ? 0 : values[vi]!;
    out[k] = d / s.rowNorm[k]! - s.cfix[k]!;
  }
}

/** `z −= Y w` (m columns). */
function subY(s: SolverImpl, w: Float64Array, z: Float64Array): void {
  const nz = s.dofCount;
  for (let k = 0; k < s.m; k++) {
    const l = w[k]!;
    if (l === 0) continue;
    const o = k * nz;
    for (let i = 0; i < nz; i++) z[i] = z[i]! - s.Y[o + i]! * l;
  }
}

/**
 * One move (module comment, step 3): writes the new homogeneous control net
 * (the target's layout and weights) into `outCw` and reports. Throws only on
 * a contract violation (`values` shorter than `3 × constraints`, a
 * non-finite value, `outCw` too small); never on the data.
 */
export function solveFairInto(
  solver: FairSolver,
  values: ArrayLike<number>,
  outCw: Float64Array,
): SolveReport {
  const s = implOf(solver);
  const { m, dim, n, dofCount: nz } = s;
  const h = dim + 1;
  const ncons = s.ncons;
  if (values.length < 3 * ncons) {
    fail(
      'size-mismatch',
      `values: expected ${3 * ncons} (3 per constraint); got ${values.length}`,
      { value: values.length },
    );
  }
  for (let k = 0; k < m; k++) {
    const vi = s.rowValue[k]!;
    if (vi >= 0 && !Number.isFinite(values[vi]!))
      fail('non-finite', `value ${vi} is not finite`, { index: vi });
  }
  if (outCw.length < n * h) {
    fail('scratch-too-small', `outCw needs ${n * h} entries; got ${outCw.length}`, {
      value: outCw.length,
    });
  }
  const e = s.wm;
  const lam = s.wm2;
  const w = s.wm3;
  const z = s.wz;
  z.set(s.z0);
  rhsInto(s, values, e);
  if (m > 0) {
    // λ = S⁻¹ (C′ z₀ − e′) on the independent rows, z = z₀ − Y λ. With the
    // augmented factor this is the same point (the added term is constant on
    // the constraint set); its multipliers are recovered below.
    for (let k = 0; k < m; k++) w[k] = s.independent[k] ? s.cz0[k]! - e[k]! : 0;
    pivotedCholeskySolve(s.F, w, lam);
    subY(s, lam, z);
    // Refinement on the constraint residual: Δλ = S⁻¹ (C′_I z − e′_I), z −= Y Δλ.
    for (let k = 0; k < m; k++) {
      if (!s.independent[k]) {
        w[k] = 0;
        continue;
      }
      const ri = s.cpIdx[k]!;
      const rv = s.cpVal[k]!;
      let c = 0;
      for (let q = 0; q < ri.length; q++) c += rv[q]! * z[ri[q]!]!;
      w[k] = c - e[k]!;
    }
    const dl = e; // e′ is no longer needed
    pivotedCholeskySolve(s.F, w, dl);
    subY(s, dl, z);
    for (let k = 0; k < m; k++) lam[k] = lam[k]! + dl[k]!;
    if (s.rho > 0) {
      // K_ρ z + C′_Iᵀ λ′ = g′ and ρ C′ᵀC′ z = ρ C′_Iᵀ (C′_I z + Γᵀ C′_D z)
      // (C′_D = Γ C′_I, Γᵀ = S_II⁻¹ S_ID), so the multipliers of K are
      // λ_I = λ′_I + ρ (C′_I z + S_II⁻¹ S_ID C′_D z).
      const cz = s.wm4;
      for (let k = 0; k < m; k++) {
        const ri = s.cpIdx[k]!;
        const rv = s.cpVal[k]!;
        let c = 0;
        for (let q = 0; q < ri.length; q++) c += rv[q]! * z[ri[q]!]!;
        cz[k] = c;
      }
      for (let i = 0; i < m; i++) {
        let v = 0;
        if (s.independent[i]) {
          for (let d = 0; d < m; d++) if (!s.independent[d]) v += s.S[i * m + d]! * cz[d]!;
        }
        w[i] = v;
      }
      pivotedCholeskySolve(s.F, w, dl);
      for (let k = 0; k < m; k++) {
        if (s.independent[k]) lam[k] = lam[k]! + s.rho * (cz[k]! + dl[k]!);
      }
    }
  }

  // Scatter x = x_fixed + T z, then the exact rules.
  const x = s.wx;
  const { T } = s;
  for (let r = 0; r < n * dim; r++) {
    let v = 0;
    for (let q = T.rowPtr[r]!; q < T.rowPtr[r + 1]!; q++) v += T.val[q]! * z[T.col[q]!]!;
    x[r] = T.rowPtr[r + 1] === T.rowPtr[r] ? s.fixed[r]! : s.fixed[r]! + v;
  }
  for (const op of s.derived) {
    const a = op.cp * dim;
    const b = op.master * dim;
    if (op.kind === 'copy') {
      for (let c = 0; c < dim; c++)
        x[a + c] = op.offset[c] === 0 ? x[b + c]! : x[b + c]! + op.offset[c]!;
    } else if (op.kind === 'mirrorAxis') {
      for (let c = 0; c < dim; c++) x[a + c] = c === op.axis ? 2 * op.plane - x[b + c]! : x[b + c]!;
    } else {
      for (let c = 0; c < dim; c++) {
        let v = op.t[c]!;
        for (let cc = 0; cc < dim; cc++) v += op.R[c * dim + cc]! * x[b + cc]!;
        x[a + c] = v;
      }
    }
  }
  const cw0 = s.target.cw;
  for (let i = 0; i < n; i++) {
    const wt = cw0[i * h + dim]!;
    for (let c = 0; c < dim; c++) {
      const v = x[i * dim + c]!;
      outCw[i * h + c] = v === s.xRef[i * dim + c] ? cw0[i * h + c]! : wt === 1 ? v : wt * v;
    }
    outCw[i * h + dim] = wt;
  }

  // Report: residuals per row, classification, multipliers, stationarity and energy.
  const residuals = new Float64Array(m);
  const multipliers = new Float64Array(m);
  const dep: number[] = [];
  const inc: number[] = [];
  let cres = 0;
  for (let k = 0; k < m; k++) {
    const ri = s.rowIdx[k]!;
    const rv = s.rowVal[k]!;
    let v = 0;
    for (let q = 0; q < ri.length; q++) v += rv[q]! * x[ri[q]!]!;
    const vi = s.rowValue[k]!;
    const res = Math.abs(v - (vi < 0 ? 0 : values[vi]!));
    residuals[k] = res;
    if (!s.independent[k]) {
      if (res / Math.max(1, s.rowNorm[k]!) <= s.tolConstraint) dep.push(k);
      else {
        inc.push(k);
        continue;
      }
    }
    if (res > cres) cres = res;
    multipliers[k] = s.independent[k] ? lam[k]! / s.rowNorm[k]! : 0;
  }
  // ∇E = H δ − g with δ = x − x_ref; energy = ½ δᵀHδ − gᵀδ + E₀.
  const d = s.wx2;
  for (let i = 0; i < n * dim; i++) d[i] = x[i]! - s.xRef[i]!;
  const Hd = x; // x is no longer needed once δ is formed
  csrMulStrided(s.Hs, d, Hd, dim);
  let energy = s.energy0;
  for (let i = 0; i < n * dim; i++) {
    energy += 0.5 * d[i]! * Hd[i]! - s.g[i]! * d[i]!;
    Hd[i] = Hd[i]! - s.g[i]!;
  }
  for (let k = 0; k < m; k++) {
    const l = multipliers[k]!;
    if (l === 0) continue;
    const ri = s.rowIdx[k]!;
    const rv = s.rowVal[k]!;
    for (let q = 0; q < ri.length; q++) Hd[ri[q]!] = Hd[ri[q]!]! + rv[q]! * l;
  }
  z.fill(0);
  for (let r = 0; r < n * dim; r++) {
    for (let q = T.rowPtr[r]!; q < T.rowPtr[r + 1]!; q++)
      z[T.col[q]!] = z[T.col[q]!]! + T.val[q]! * Hd[r]!;
  }
  let stat = 0;
  for (let i = 0; i < nz; i++) stat = Math.max(stat, Math.abs(z[i]!));
  return Object.freeze({
    constraintResidual: cres,
    stationarityResidual: stat,
    energy,
    dependent: Int32Array.from(dep),
    inconsistent: Int32Array.from(inc),
    multipliers,
    residuals,
  });
}

/** {@link solveFairInto} into a new curve or surface on the target's bases and weights. */
export function solveFair<G extends NurbsCurve | NurbsSurface>(
  solver: FairSolver,
  values: ArrayLike<number>,
): { readonly result: G; readonly report: SolveReport } {
  const s = implOf(solver);
  const cw = new Float64Array(s.target.cw.length);
  const report = solveFairInto(solver, values, cw);
  const t = s.target;
  const result = isSurface(t)
    ? surfaceFromHomogeneous({ u: t.u, v: t.v, cw })
    : curveFromHomogeneous({ dim: t.dim, basis: t.basis as Basis, cw });
  return Object.freeze({ result: result as G, report });
}

/**
 * `∂x/∂value` for component `axis` of constraint `constraint`: the
 * displacement of every control coordinate (interleaved, `dim · cpCount`)
 * per unit move of that value (design §10.4 step 6). Zero when that
 * component is not a row (an axis a surface constraint does not select, a
 * tangent direction) or is a dependent row.
 */
export function fairInfluenceInto(
  solver: FairSolver,
  constraint: number,
  axis: 0 | 1 | 2,
  out: Float64Array,
): void {
  const s = implOf(solver);
  const { m, n, dim, dofCount: nz } = s;
  if (out.length < n * dim) {
    fail('scratch-too-small', `out needs ${n * dim} entries; got ${out.length}`, {
      value: out.length,
    });
  }
  out.fill(0, 0, n * dim);
  let row = -1;
  for (let k = 0; k < m; k++)
    if (s.rowSrc[k] === constraint && s.rowComp[k] === axis && s.rowValue[k]! >= 0) row = k;
  if (row < 0 || !s.independent[row]) return;
  const e = new Float64Array(m);
  e[row] = 1 / s.rowNorm[row]!;
  const u = new Float64Array(m);
  pivotedCholeskySolve(s.F, e, u);
  const wz = new Float64Array(nz);
  for (let k = 0; k < m; k++) {
    const l = u[k]!;
    if (l === 0) continue;
    for (let i = 0; i < nz; i++) wz[i] = wz[i]! + s.Y[k * nz + i]! * l;
  }
  const { T } = s;
  for (let r = 0; r < n * dim; r++) {
    let v = 0;
    for (let q = T.rowPtr[r]!; q < T.rowPtr[r + 1]!; q++) v += T.val[q]! * wz[T.col[q]!]!;
    out[r] = v;
  }
}
