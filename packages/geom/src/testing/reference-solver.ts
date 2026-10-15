// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The solver's test oracle (design §6.21, decision 25): the same constrained
 * fair problem solved by a different algorithm, dense and slow.
 *
 * It shares only the problem's assembly with `prepareFairSolver`
 * (`assembleFair`: the rows and Gram matrices, which their own tests pin to
 * closed forms and to the geometry). Everything after that is independent:
 *
 * 1. dense `K = Tᵀ (Hs ⊗ I) T`, `g′ = Tᵀ(g − H δ_f)`, `C′ = C T` with
 *    unit-norm rows (no ordering, no envelope, no Schur complement);
 * 2. Householder QR **with column pivoting** of `C′ᵀ` (Golub & Van Loan,
 *    _Matrix Computations_, 4th ed., Alg. 5.4.1): rank `r` where
 *    `|R_kk| ≤ pivotRel · |R_00|`; `Q = [Q₁ Q₂]`, `Q₂` spans the null space of
 *    the independent rows;
 * 3. particular solution `z_p = Q₁ R₁₁⁻ᵀ e′_I`, reduced system
 *    `(Q₂ᵀ K Q₂) w = Q₂ᵀ (g′ − K z_p)` by Gaussian elimination with partial
 *    pivoting, `z = z_p + Q₂ w` (null-space method, Nocedal & Wright §16.2);
 * 4. multipliers from `C′_Iᵀ λ = g′ − K z` through `R₁₁`;
 * 5. `x = x_fixed + T z`, without re-applying exact rules (so `copy` and
 *    mirror rules hold here only to rounding).
 *
 * The report has the solver's meaning; dependent rows are classified with
 * the same per-row test.
 */
import { luSolve } from '../linalg/dense';
import { csrMulStrided } from '../linalg/sparse';
import { assembleFair } from '../solver/solver';
import type { FairProblem, SolveReport } from '../solver/solver';
import { resolveTolerances } from '../tolerance';
import type { Tolerances } from '../tolerance';

/** Column-pivoted Householder QR of the `rows × cols` matrix `A` (row-major), in place. */
function qrPivoted(
  rows: number,
  cols: number,
  A: Float64Array,
  pivotRel: number,
): { Q: Float64Array; R: Float64Array; perm: Int32Array; rank: number } {
  const perm = Int32Array.from({ length: cols }, (_, i) => i);
  const Q = new Float64Array(rows * rows);
  for (let i = 0; i < rows; i++) Q[i * rows + i] = 1;
  const norms = new Float64Array(cols);
  for (let j = 0; j < cols; j++) {
    let s = 0;
    for (let i = 0; i < rows; i++) s += A[i * cols + j]! * A[i * cols + j]!;
    norms[j] = s;
  }
  const v = new Float64Array(rows);
  let rank = 0;
  let r00 = 0;
  const kmax = Math.min(rows, cols);
  for (let k = 0; k < kmax; k++) {
    // Pivot: the column of largest remaining norm (recomputed: exact, not downdated).
    let best = k;
    let bn = -1;
    for (let j = k; j < cols; j++) {
      let s = 0;
      for (let i = k; i < rows; i++) s += A[i * cols + j]! * A[i * cols + j]!;
      norms[j] = s;
      if (s > bn) {
        bn = s;
        best = j;
      }
    }
    if (best !== k) {
      for (let i = 0; i < rows; i++) {
        const t = A[i * cols + k]!;
        A[i * cols + k] = A[i * cols + best]!;
        A[i * cols + best] = t;
      }
      const t = perm[k]!;
      perm[k] = perm[best]!;
      perm[best] = t;
    }
    const norm = Math.sqrt(bn);
    if (k === 0) r00 = norm;
    if (!(norm > pivotRel * r00) || norm === 0) break;
    const alpha = A[k * cols + k]! > 0 ? -norm : norm;
    for (let i = 0; i < rows; i++) v[i] = i < k ? 0 : A[i * cols + k]!;
    v[k] = v[k]! - alpha;
    let vv = 0;
    for (let i = k; i < rows; i++) vv += v[i]! * v[i]!;
    if (vv > 0) {
      for (let j = k; j < cols; j++) {
        let s = 0;
        for (let i = k; i < rows; i++) s += v[i]! * A[i * cols + j]!;
        const f = (2 * s) / vv;
        for (let i = k; i < rows; i++) A[i * cols + j] = A[i * cols + j]! - f * v[i]!;
      }
      // Q ← Q H (accumulate the orthogonal factor explicitly).
      for (let i = 0; i < rows; i++) {
        let s = 0;
        for (let l = k; l < rows; l++) s += Q[i * rows + l]! * v[l]!;
        const f = (2 * s) / vv;
        for (let l = k; l < rows; l++) Q[i * rows + l] = Q[i * rows + l]! - f * v[l]!;
      }
    }
    rank = k + 1;
  }
  return { Q, R: A, perm, rank };
}

/**
 * Solves `p` with `values` (stride 3 per constraint, as `solveFairInto`) by
 * the dense null-space method of the module comment. Returns the homogeneous
 * control net and a report; throws when the reduced system is singular.
 * Test-only: O(n³) in the unknowns.
 */
export function solveFairReference(
  p: FairProblem,
  values: ArrayLike<number>,
  tolIn?: Partial<Tolerances>,
): { cw: Float64Array; report: SolveReport } {
  const tol = resolveTolerances(tolIn);
  const A = assembleFair(p, tol);
  const { dim, n, nz, dof, xRef, Hs, g, gx, energy0, T0 } = A;
  const nr = n * dim;
  // Dense T and K = Tᵀ (Hs ⊗ I) T.
  const T = new Float64Array(nr * nz);
  for (let r = 0; r < nr; r++) {
    for (let q = T0.rowPtr[r]!; q < T0.rowPtr[r + 1]!; q++) T[r * nz + T0.col[q]!] = T0.val[q]!;
  }
  const HT = new Float64Array(nr * nz);
  for (let i = 0; i < n; i++) {
    for (let q = Hs.rowPtr[i]!; q < Hs.rowPtr[i + 1]!; q++) {
      const j = Hs.col[q]!;
      const h = Hs.val[q]!;
      for (let c = 0; c < dim; c++) {
        for (let a = 0; a < nz; a++)
          HT[(i * dim + c) * nz + a] = HT[(i * dim + c) * nz + a]! + h * T[(j * dim + c) * nz + a]!;
      }
    }
  }
  const K = new Float64Array(nz * nz);
  for (let a = 0; a < nz; a++) {
    for (let b = 0; b < nz; b++) {
      let s = 0;
      for (let r = 0; r < nr; r++) s += T[r * nz + a]! * HT[r * nz + b]!;
      K[a * nz + b] = s;
    }
  }
  const gp = new Float64Array(nz);
  for (let a = 0; a < nz; a++) {
    let s = 0;
    for (let r = 0; r < nr; r++) s += T[r * nz + a]! * gx[r]!;
    gp[a] = s;
  }
  // C′ (unit rows in x) and e′.
  const m = A.rowIdx.length;
  const Cp = new Float64Array(m * nz);
  const ep = new Float64Array(m);
  const norm = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    const idx = A.rowIdx[k]!;
    const val = A.rowVal[k]!;
    let s2 = 0;
    for (let e = 0; e < val.length; e++) s2 += val[e]! * val[e]!;
    norm[k] = Math.sqrt(s2);
    let cf = 0;
    for (let e = 0; e < idx.length; e++) {
      const v = val[e]! / norm[k]!;
      cf += v * dof.fixed[idx[e]!]!;
      for (let a = 0; a < nz; a++) Cp[k * nz + a] = Cp[k * nz + a]! + v * T[idx[e]! * nz + a]!;
    }
    const vi = A.rowValue[k]!;
    ep[k] = (vi < 0 ? 0 : values[vi]!) / norm[k]! - cf;
  }
  // QR of C′ᵀ (nz × m).
  const Ct = new Float64Array(nz * m);
  for (let k = 0; k < m; k++) for (let a = 0; a < nz; a++) Ct[a * m + k] = Cp[k * nz + a]!;
  const { Q, R, perm, rank } = qrPivoted(nz, m, Ct, tol.pivotRel);
  // z_p = Q₁ y with R₁₁ᵀ y = e′_I (forward substitution).
  const y = new Float64Array(rank);
  for (let i = 0; i < rank; i++) {
    let s = ep[perm[i]!]!;
    for (let j = 0; j < i; j++) s -= R[j * m + i]! * y[j]!;
    y[i] = s / R[i * m + i]!;
  }
  const z = new Float64Array(nz);
  for (let a = 0; a < nz; a++) {
    let s = 0;
    for (let i = 0; i < rank; i++) s += Q[a * nz + i]! * y[i]!;
    z[a] = s;
  }
  // Reduced system on Q₂.
  const nn = nz - rank;
  if (nn > 0) {
    const Kz = new Float64Array(nz);
    for (let a = 0; a < nz; a++) {
      let s = 0;
      for (let b = 0; b < nz; b++) s += K[a * nz + b]! * z[b]!;
      Kz[a] = s;
    }
    const KQ2 = new Float64Array(nz * nn);
    for (let a = 0; a < nz; a++) {
      for (let j = 0; j < nn; j++) {
        let s = 0;
        for (let b = 0; b < nz; b++) s += K[a * nz + b]! * Q[b * nz + rank + j]!;
        KQ2[a * nn + j] = s;
      }
    }
    const M = new Float64Array(nn * nn);
    const rhs = new Float64Array(nn);
    for (let i = 0; i < nn; i++) {
      let s = 0;
      for (let a = 0; a < nz; a++) s += Q[a * nz + rank + i]! * (gp[a]! - Kz[a]!);
      rhs[i] = s;
      for (let j = 0; j < nn; j++) {
        let t = 0;
        for (let a = 0; a < nz; a++) t += Q[a * nz + rank + i]! * KQ2[a * nn + j]!;
        M[i * nn + j] = t;
      }
    }
    const w = luSolve(nn, M, rhs, tol.pivotRel);
    if (w === null) throw new Error('solveFairReference: the reduced system is singular');
    for (let a = 0; a < nz; a++) {
      let s = 0;
      for (let j = 0; j < nn; j++) s += Q[a * nz + rank + j]! * w[j]!;
      z[a] = z[a]! + s;
    }
  }
  // λ_I: C′_Iᵀ λ = g′ − K z ⇒ R₁₁ λ_perm = Q₁ᵀ (g′ − K z).
  const res = new Float64Array(nz);
  for (let a = 0; a < nz; a++) {
    let s = gp[a]!;
    for (let b = 0; b < nz; b++) s -= K[a * nz + b]! * z[b]!;
    res[a] = s;
  }
  const qr = new Float64Array(rank);
  for (let i = 0; i < rank; i++) {
    let s = 0;
    for (let a = 0; a < nz; a++) s += Q[a * nz + i]! * res[a]!;
    qr[i] = s;
  }
  const lp = new Float64Array(rank);
  for (let i = rank - 1; i >= 0; i--) {
    let s = qr[i]!;
    for (let j = i + 1; j < rank; j++) s -= R[i * m + j]! * lp[j]!;
    lp[i] = s / R[i * m + i]!;
  }
  const lamScaled = new Float64Array(m);
  const independent = new Uint8Array(m);
  for (let i = 0; i < rank; i++) {
    lamScaled[perm[i]!] = lp[i]!;
    independent[perm[i]!] = 1;
  }
  // x and the report.
  const x = new Float64Array(nr);
  for (let r = 0; r < nr; r++) {
    let s = 0;
    for (let a = 0; a < nz; a++) s += T[r * nz + a]! * z[a]!;
    x[r] = dof.fixed[r]! + s;
  }
  const h = dim + 1;
  const cw = new Float64Array(n * h);
  const cw0 = A.target.cw;
  for (let i = 0; i < n; i++) {
    const wt = cw0[i * h + dim]!;
    for (let c = 0; c < dim; c++) cw[i * h + c] = wt * x[i * dim + c]!;
    cw[i * h + dim] = wt;
  }
  const residuals = new Float64Array(m);
  const multipliers = new Float64Array(m);
  const dep: number[] = [];
  const inc: number[] = [];
  let cres = 0;
  for (let k = 0; k < m; k++) {
    const idx = A.rowIdx[k]!;
    const val = A.rowVal[k]!;
    let v = 0;
    for (let e = 0; e < idx.length; e++) v += val[e]! * x[idx[e]!]!;
    const vi = A.rowValue[k]!;
    const r = Math.abs(v - (vi < 0 ? 0 : values[vi]!));
    residuals[k] = r;
    if (!independent[k]) {
      if (r / Math.max(1, norm[k]!) <= tol.constraint) dep.push(k);
      else {
        inc.push(k);
        continue;
      }
    }
    cres = Math.max(cres, r);
    multipliers[k] = lamScaled[k]! / norm[k]!;
  }
  const d = new Float64Array(nr);
  for (let i = 0; i < nr; i++) d[i] = x[i]! - xRef[i]!;
  const Hd = new Float64Array(nr);
  csrMulStrided(Hs, d, Hd, dim);
  let energy = energy0;
  for (let i = 0; i < nr; i++) {
    energy += 0.5 * d[i]! * Hd[i]! - g[i]! * d[i]!;
    Hd[i] = Hd[i]! - g[i]!;
  }
  for (let k = 0; k < m; k++) {
    const l = multipliers[k]!;
    const idx = A.rowIdx[k]!;
    const val = A.rowVal[k]!;
    for (let e = 0; e < idx.length; e++) Hd[idx[e]!] = Hd[idx[e]!]! + val[e]! * l;
  }
  let stat = 0;
  for (let a = 0; a < nz; a++) {
    let s = 0;
    for (let r = 0; r < nr; r++) s += T[r * nz + a]! * Hd[r]!;
    stat = Math.max(stat, Math.abs(s));
  }
  return {
    cw,
    report: {
      constraintResidual: cres,
      stationarityResidual: stat,
      energy,
      dependent: Int32Array.from(dep),
      inconsistent: Int32Array.from(inc),
      multipliers,
      residuals,
    },
  };
}
