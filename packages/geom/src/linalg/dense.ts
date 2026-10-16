// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Dense linear algebra (internal; design §3 `linalg/dense.ts`). Matrices are
 * row-major `Float64Array`s.
 *
 * - {@link pivotedCholesky}: rank-revealing Cholesky with diagonal pivoting of a
 *   symmetric positive semi-definite matrix: the Schur complement `S = C H⁻¹ Cᵀ`
 *   of the constrained least-squares solve (design §10.4 step 2). Pivots at or
 *   below `pivotRel ×` the largest diagonal mark dependent constraint rows.
 * - {@link luSolve}: Gaussian elimination with partial pivoting, a direct solver
 *   independent of the range-space path (tests solve the full KKT system with
 *   it).
 * - {@link householderLsq}: least squares by Householder QR, the oracle that
 *   cross-checks the normal-equation fits on small problems (design §10.4,
 *   "Fitting is the same machinery").
 */

/** Result of {@link pivotedCholesky}: `P S Pᵀ = L Lᵀ` on the leading `rank` rows. */
export interface PivotedCholesky {
  readonly m: number;
  /** `L` in the lower triangle of an `m × m` row-major array (leading `rank` columns valid). */
  readonly l: Float64Array;
  /** `perm[k]` is the original row of pivot `k`; rows `perm[rank..]` are dependent. */
  readonly perm: Int32Array;
  readonly rank: number;
}

/**
 * Cholesky with diagonal (complete) pivoting of the symmetric positive
 * semi-definite `m × m` matrix `s` (row-major; not modified). Stops when the
 * largest remaining diagonal is at most `pivotRel ×` the largest diagonal of
 * `s`: the remaining rows are linear combinations of the chosen ones.
 */
export function pivotedCholesky(
  m: number,
  s: ArrayLike<number>,
  pivotRel: number,
): PivotedCholesky {
  const a = new Float64Array(m * m);
  for (let i = 0; i < m * m; i++) a[i] = s[i]!;
  const perm = new Int32Array(m);
  for (let i = 0; i < m; i++) perm[i] = i;
  let dmax = 0;
  for (let i = 0; i < m; i++) dmax = Math.max(dmax, a[i * m + i]!);
  const thr = pivotRel * dmax;
  let rank = 0;
  for (let k = 0; k < m; k++) {
    let q = k;
    for (let i = k + 1; i < m; i++) if (a[i * m + i]! > a[q * m + q]!) q = i;
    if (!(a[q * m + q]! > thr)) break;
    if (q !== k) {
      // Symmetric swap of rows and columns k and q (full storage).
      for (let j = 0; j < m; j++) {
        const t = a[k * m + j]!;
        a[k * m + j] = a[q * m + j]!;
        a[q * m + j] = t;
      }
      for (let i = 0; i < m; i++) {
        const t = a[i * m + k]!;
        a[i * m + k] = a[i * m + q]!;
        a[i * m + q] = t;
      }
      const t = perm[k]!;
      perm[k] = perm[q]!;
      perm[q] = t;
    }
    const d = Math.sqrt(a[k * m + k]!);
    a[k * m + k] = d;
    for (let i = k + 1; i < m; i++) a[i * m + k] = a[i * m + k]! / d;
    // Right-looking update of the trailing block, both triangles kept symmetric.
    for (let i = k + 1; i < m; i++) {
      const lik = a[i * m + k]!;
      for (let j = k + 1; j <= i; j++) {
        const v = a[i * m + j]! - lik * a[j * m + k]!;
        a[i * m + j] = v;
        a[j * m + i] = v;
      }
    }
    rank = k + 1;
  }
  return { m, l: a, perm, rank };
}

/**
 * Solves `S_II y = rhs_I` on the independent rows `I = perm[0..rank)` of a
 * {@link pivotedCholesky} factor; `out[perm[k]] = y_k` for `k < rank`, and the
 * dependent rows get 0. `rhs` is indexed by original row. `work` (at least
 * `rank` long, overwritten) holds the triangular solves; without it they
 * use a new array, so a caller solving per frame passes one.
 */
export function pivotedCholeskySolve(
  f: PivotedCholesky,
  rhs: ArrayLike<number>,
  out: Float64Array,
  work?: Float64Array,
): void {
  const { m, l, perm, rank } = f;
  const y = work ?? new Float64Array(rank);
  for (let k = 0; k < rank; k++) {
    let s = rhs[perm[k]!]!;
    for (let j = 0; j < k; j++) s -= l[k * m + j]! * y[j]!;
    y[k] = s / l[k * m + k]!;
  }
  for (let k = rank - 1; k >= 0; k--) {
    let s = y[k]!;
    for (let j = k + 1; j < rank; j++) s -= l[j * m + k]! * y[j]!;
    y[k] = s / l[k * m + k]!;
  }
  out.fill(0);
  for (let k = 0; k < rank; k++) out[perm[k]!] = y[k]!;
}

/**
 * Solves the `n × n` system `A x = b` by Gaussian elimination with partial
 * pivoting. Returns `x`, or `null` when a pivot is at most `pivotRel ×` the
 * largest absolute entry (numerically singular). Inputs are not modified.
 */
export function luSolve(
  n: number,
  A: ArrayLike<number>,
  b: ArrayLike<number>,
  pivotRel: number,
): Float64Array | null {
  const a = Float64Array.from({ length: n * n }, (_, i) => A[i]!);
  const x = Float64Array.from({ length: n }, (_, i) => b[i]!);
  let amax = 0;
  for (let i = 0; i < n * n; i++) amax = Math.max(amax, Math.abs(a[i]!));
  const thr = pivotRel * amax;
  for (let k = 0; k < n; k++) {
    let r = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(a[i * n + k]!) > Math.abs(a[r * n + k]!)) r = i;
    if (!(Math.abs(a[r * n + k]!) > thr)) return null;
    if (r !== k) {
      for (let j = 0; j < n; j++) {
        const t = a[k * n + j]!;
        a[k * n + j] = a[r * n + j]!;
        a[r * n + j] = t;
      }
      const t = x[k]!;
      x[k] = x[r]!;
      x[r] = t;
    }
    for (let i = k + 1; i < n; i++) {
      const l = a[i * n + k]! / a[k * n + k]!;
      if (l === 0) continue;
      for (let j = k + 1; j < n; j++) a[i * n + j] = a[i * n + j]! - l * a[k * n + j]!;
      x[i] = x[i]! - l * x[k]!;
    }
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = x[i]!;
    for (let j = i + 1; j < n; j++) s -= a[i * n + j]! * x[j]!;
    x[i] = s / a[i * n + i]!;
  }
  return x;
}

/**
 * Least squares `min ‖A x − b‖₂` for an `m × n` matrix (`m ≥ n`, full column
 * rank) by Householder QR, with `nrhs` right-hand sides as the columns of the
 * row-major `m × nrhs` array `b`. Returns the `n × nrhs` solution, or `null`
 * when `R` has a diagonal at most `pivotRel ×` its largest (rank deficient).
 * Inputs are not modified.
 */
export function householderLsq(
  m: number,
  n: number,
  A: ArrayLike<number>,
  b: ArrayLike<number>,
  nrhs: number,
  pivotRel: number,
): Float64Array | null {
  const a = Float64Array.from({ length: m * n }, (_, i) => A[i]!);
  const c = Float64Array.from({ length: m * nrhs }, (_, i) => b[i]!);
  const v = new Float64Array(m);
  for (let k = 0; k < n; k++) {
    let norm2 = 0;
    for (let i = k; i < m; i++) norm2 += a[i * n + k]! * a[i * n + k]!;
    const norm = Math.sqrt(norm2);
    if (norm === 0) continue;
    const alpha = a[k * n + k]! > 0 ? -norm : norm;
    for (let i = k; i < m; i++) v[i] = a[i * n + k]!;
    v[k] = v[k]! - alpha;
    let vv = 0;
    for (let i = k; i < m; i++) vv += v[i]! * v[i]!;
    if (vv === 0) continue;
    // Apply H = I − 2 v vᵀ / (vᵀ v) to the remaining columns of A and to C.
    for (let j = k; j < n; j++) {
      let s = 0;
      for (let i = k; i < m; i++) s += v[i]! * a[i * n + j]!;
      const f = (2 * s) / vv;
      for (let i = k; i < m; i++) a[i * n + j] = a[i * n + j]! - f * v[i]!;
    }
    for (let j = 0; j < nrhs; j++) {
      let s = 0;
      for (let i = k; i < m; i++) s += v[i]! * c[i * nrhs + j]!;
      const f = (2 * s) / vv;
      for (let i = k; i < m; i++) c[i * nrhs + j] = c[i * nrhs + j]! - f * v[i]!;
    }
  }
  let rmax = 0;
  for (let k = 0; k < n; k++) rmax = Math.max(rmax, Math.abs(a[k * n + k]!));
  for (let k = 0; k < n; k++) if (!(Math.abs(a[k * n + k]!) > pivotRel * rmax)) return null;
  const x = new Float64Array(n * nrhs);
  for (let j = 0; j < nrhs; j++) {
    for (let i = n - 1; i >= 0; i--) {
      let s = c[i * nrhs + j]!;
      for (let k = i + 1; k < n; k++) s -= a[i * n + k]! * x[k * nrhs + j]!;
      x[i * nrhs + j] = s / a[i * n + i]!;
    }
  }
  return x;
}
