// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Weighted, constrained linear least squares on a fixed basis (internal): the
 * solve behind `approximateCurve` and `approximateSurface` (P&T §9.4.1–9.4.3,
 * A9.6 generalised; design §10.1 and §10.4 without the DOF map and fairness).
 *
 * Unknowns are the Euclidean control coordinates, coordinate-major:
 * `x[c·N + i]` is coordinate `c` of control point `i`. With data rows `A`
 * (basis values at the data parameters), weights `W` and targets `q`:
 *
 *     minimise ½ Σ_k ω_k |A_k x − q_k|²   subject to   C x = d
 *
 * `H = Aᵀ W A` is the same band matrix for every coordinate; its Cholesky
 * factor is computed once. `H` is accepted only when its estimated reciprocal
 * condition (1-norm, diagonally scaled: `bandCholRcond`) exceeds `pivotRel`:
 * a pivot test alone passes matrices whose condition reaches 1e17 (a knot
 * vector that crowds a knot onto an end parameter), and the normal equations
 * then return control points with no correct digit while the fit at the data
 * still looks plausible. Constraints are solved in range space through the
 * Schur complement (§10.4 steps 2–4): `Y = H⁻¹ Cᵀ`, `S = C Y` factored by
 * pivoted Cholesky (rows with pivots ≤ `pivotRel` are dependent and dropped),
 * `λ = S⁻¹ (C x₀ − d)`, `x = x₀ − Y λ`, then one step of iterative refinement on
 * the KKT residual. Constraint rows are scaled to unit 2-norm first, so rank
 * decisions compare like with like; multipliers are returned for the
 * caller's (unscaled) rows: the KKT system is `H x + Cᵀ λ = Aᵀ W q`, `C x = d`.
 *
 * The caller centres the data (design §7); `H` depends only on the basis and
 * the weights, not on coordinates, so scaling the data by the box extent (§7)
 * would scale `x` and every residual by the same factor and change nothing
 * else. What does depend on scale is how a residual compares with the
 * `constraint` tolerance: rounding leaves `|C_r x − d_r| ≈ ε‖C_r‖‖x‖`, and a
 * derivative row's norm grows as `(p/h)^k` with the knot spacing `h`, so
 * {@link LsqOutcome} returns each row's 2-norm for the caller to judge the
 * residual in length units (`residual / max(1, rowNorm)`, `approximate.ts`).
 */
import {
  bandCholFactor,
  bandCholRcond,
  bandCholSolve,
  bandSym,
  bandSymAdd,
  bandSymCopy,
  bandSymMul,
} from '../linalg/banded';
import { pivotedCholesky, pivotedCholeskySolve } from '../linalg/dense';
import type { DesignRows } from './assemble';
import { rowBandwidth } from './assemble';

/** One scalar constraint row: `Σ val[e] · x[idx[e]] = rhs` over coordinate-major unknowns. */
export interface ConstraintRow {
  readonly idx: Int32Array;
  readonly val: Float64Array;
  readonly rhs: number;
}

export interface LsqProblem {
  /** Control points. */
  readonly N: number;
  readonly dim: number;
  readonly data: DesignRows;
  /** One per data row, or `null` for unit weights. */
  readonly weights: ArrayLike<number> | null;
  /** `rows × dim` targets. */
  readonly targets: ArrayLike<number>;
  readonly constraints: readonly ConstraintRow[];
}

export type LsqOutcome =
  | {
      readonly ok: false;
      /**
       * The control point whose Cholesky pivot failed (`H` is not positive
       * definite), or −1 when the factorisation succeeded but `rcond` is too small.
       */
      readonly column: number;
      /** The estimated reciprocal condition of the scaled `H`; 0 when a pivot failed. */
      readonly rcond: number;
    }
  | {
      readonly ok: true;
      /** `dim × N`, coordinate-major. */
      readonly x: Float64Array;
      /** One per constraint row, for the unscaled rows. Dependent rows: 0. */
      readonly lambda: Float64Array;
      /** Constraint rows found dependent on the others (dropped from the solve). */
      readonly dependent: Int32Array;
      /** `|C_r x − d_r|` per constraint row, after refinement. */
      readonly residual: Float64Array;
      /** `‖C_r‖₂` per constraint row (the caller's rows, unscaled). */
      readonly rowNorm: Float64Array;
    };

function rowDot(r: ConstraintRow, x: Float64Array): number {
  let s = 0;
  for (let e = 0; e < r.idx.length; e++) s += r.val[e]! * x[r.idx[e]!]!;
  return s;
}

/** Solves {@link LsqProblem}; see the module comment. */
export function solveLsq(prob: LsqProblem, pivotRel: number): LsqOutcome {
  const { N, dim, data } = prob;
  const { rows, K, idx, val } = data;
  const H = bandSym(N, rowBandwidth(data));
  const g = new Float64Array(dim * N);
  for (let r = 0; r < rows; r++) {
    const w = prob.weights === null ? 1 : prob.weights[r]!;
    if (w === 0) continue;
    const o = r * K;
    for (let a = 0; a < K; a++) {
      const ia = idx[o + a]!;
      const wa = w * val[o + a]!;
      if (wa === 0) continue;
      for (let b = 0; b < K; b++) {
        const ib = idx[o + b]!;
        if (ib <= ia) bandSymAdd(H, ia, ib, wa * val[o + b]!);
      }
      for (let c = 0; c < dim; c++)
        g[c * N + ia] = g[c * N + ia]! + wa * prob.targets[r * dim + c]!;
    }
  }
  const H0 = bandSymCopy(H);
  const failed = bandCholFactor(H, pivotRel);
  if (failed >= 0) return { ok: false, column: failed, rcond: 0 };
  const rcond = bandCholRcond(H0, H);
  if (!(rcond > pivotRel)) return { ok: false, column: -1, rcond };
  const solveAll = (v: Float64Array): void => {
    for (let c = 0; c < dim; c++) bandCholSolve(H, v, c * N);
  };
  const x = g.slice();
  solveAll(x);

  const cons = prob.constraints;
  const m = cons.length;
  const lambda = new Float64Array(m);
  const residual = new Float64Array(m);
  if (m === 0) {
    return { ok: true, x, lambda, dependent: new Int32Array(0), residual, rowNorm: residual };
  }

  // Unit-norm rows (scaled copies) and Y = H⁻¹ Cᵀ, one dense column per row.
  const scale = new Float64Array(m);
  const rowsC: ConstraintRow[] = cons.map((r, k) => {
    let s = 0;
    for (let e = 0; e < r.val.length; e++) s += r.val[e]! * r.val[e]!;
    const n2 = Math.sqrt(s);
    scale[k] = n2;
    const f = n2 > 0 ? 1 / n2 : 0;
    return { idx: r.idx, val: r.val.map((v) => v * f), rhs: r.rhs * f };
  });
  const Y = new Float64Array(m * dim * N);
  for (let k = 0; k < m; k++) {
    const y = Y.subarray(k * dim * N, (k + 1) * dim * N);
    const r = rowsC[k]!;
    for (let e = 0; e < r.idx.length; e++) y[r.idx[e]!] = y[r.idx[e]!]! + r.val[e]!;
    for (let c = 0; c < dim; c++) {
      let any = false;
      for (let e = 0; e < r.idx.length; e++) {
        const i = r.idx[e]!;
        if (i >= c * N && i < (c + 1) * N && r.val[e] !== 0) any = true;
      }
      if (any) bandCholSolve(H, y, c * N);
    }
  }
  const S = new Float64Array(m * m);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j <= i; j++) {
      const v = rowDot(rowsC[i]!, Y.subarray(j * dim * N, (j + 1) * dim * N));
      S[i * m + j] = v;
      S[j * m + i] = v;
    }
  }
  const F = pivotedCholesky(m, S, pivotRel);
  const independent = new Uint8Array(m);
  for (let k = 0; k < F.rank; k++) independent[F.perm[k]!] = 1;

  // λ = S⁻¹ (C x₀ − d), x = x₀ − Y λ (dependent rows: λ = 0).
  const rhs = new Float64Array(m);
  const applyCorrection = (xv: Float64Array, lam: Float64Array, rhsTarget: Float64Array): void => {
    for (let k = 0; k < m; k++) rhs[k] = independent[k] ? rowDot(rowsC[k]!, xv) - rhsTarget[k]! : 0;
    pivotedCholeskySolve(F, rhs, lam);
    for (let k = 0; k < m; k++) {
      const l = lam[k]!;
      if (l === 0) continue;
      const o = k * dim * N;
      for (let i = 0; i < dim * N; i++) xv[i] = xv[i]! - Y[o + i]! * l;
    }
  };
  const d = Float64Array.from(rowsC, (r) => r.rhs);
  const lam = new Float64Array(m);
  applyCorrection(x, lam, d);

  // One step of iterative refinement on the KKT residual (§10.4 step 3):
  // r_g = g − H x − Cᵀ λ, r_d = d − C x; dx₀ = H⁻¹ r_g, dλ = S⁻¹ (C dx₀ − r_d).
  const rg = new Float64Array(dim * N);
  for (let c = 0; c < dim; c++) bandSymMul(H0, x, c * N, rg, c * N);
  for (let i = 0; i < dim * N; i++) rg[i] = g[i]! - rg[i]!;
  for (let k = 0; k < m; k++) {
    const l = lam[k]!;
    if (l === 0) continue;
    const r = rowsC[k]!;
    for (let e = 0; e < r.idx.length; e++) rg[r.idx[e]!] = rg[r.idx[e]!]! - r.val[e]! * l;
  }
  const rd = new Float64Array(m);
  for (let k = 0; k < m; k++) rd[k] = d[k]! - rowDot(rowsC[k]!, x);
  solveAll(rg);
  const dlam = new Float64Array(m);
  applyCorrection(rg, dlam, rd);
  for (let i = 0; i < dim * N; i++) x[i] = x[i]! + rg[i]!;
  for (let k = 0; k < m; k++) {
    lambda[k] = scale[k]! > 0 ? (lam[k]! + dlam[k]!) / scale[k]! : 0;
    const r = cons[k]!;
    residual[k] = Math.abs(rowDot(r, x) - r.rhs);
  }
  const dependent: number[] = [];
  for (let k = F.rank; k < m; k++) dependent.push(F.perm[k]!);
  dependent.sort((a, b) => a - b);
  return {
    ok: true,
    x,
    lambda,
    dependent: Int32Array.from(dependent),
    residual,
    rowNorm: scale,
  };
}
