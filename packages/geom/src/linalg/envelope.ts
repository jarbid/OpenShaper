// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Envelope (profile, variable-band) Cholesky (internal; design §3
 * `linalg/envelope.ts`, decision 21).
 *
 * George & Liu (1981), ch. 4: for a symmetric positive definite matrix in a
 * fixed ordering (reverse Cuthill–McKee, `rcm.ts`), row `i` of the lower
 * triangle is stored from its first non-zero column `first[i]` to the
 * diagonal. Cholesky's fill never leaves that envelope, so the factor
 * overwrites it in place: row-oriented ("bordering") elimination,
 * `L_ij = (A_ij − Σ_{k ≥ max(first_i, first_j)} L_ik L_jk) / L_jj`.
 *
 * Solves take a right-hand side whose leading entries are zero (a constraint
 * row's column of `C′ᵀ` touches a few control points): forward substitution
 * starts at its first non-zero, which is what keeps the Schur step's `m`
 * solves cheap (design §10.4 step 2).
 *
 * The factor's pivot test is relative (`pivotRel ×` the largest diagonal);
 * {@link envRcond} adds the Hager–Higham 1-norm condition estimate of the
 * diagonally scaled matrix, because pivots alone pass matrices whose
 * condition reaches 1e17 (see `bandCholRcond`, `banded.ts`).
 */
import type { Csr } from './sparse';

/** A symmetric matrix in envelope storage, in its own (already permuted) ordering. */
export interface Envelope {
  readonly n: number;
  /** First stored column of each row. */
  readonly first: Int32Array;
  /** Row `i` starts at `off[i]`; entry `(i, j)`, `first[i] ≤ j ≤ i`, is at `off[i] + j − first[i]`. */
  readonly off: Int32Array;
  readonly a: Float64Array;
}

/**
 * The envelope of `P A Pᵀ` for a symmetric CSR matrix `A` (both triangles
 * stored) and `perm[new] = old`, `iperm[old] = new`, filled with `A`'s values.
 */
export function envelopeFromCsr(A: Csr, perm: Int32Array, iperm: Int32Array): Envelope {
  const n = A.rows;
  const first = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const old = perm[i]!;
    let f = i;
    for (let p = A.rowPtr[old]!; p < A.rowPtr[old + 1]!; p++) {
      const j = iperm[A.col[p]!]!;
      if (j < f) f = j;
    }
    first[i] = f;
  }
  const off = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) off[i + 1] = off[i]! + (i - first[i]! + 1);
  const a = new Float64Array(off[n]!);
  for (let i = 0; i < n; i++) {
    const old = perm[i]!;
    for (let p = A.rowPtr[old]!; p < A.rowPtr[old + 1]!; p++) {
      const j = iperm[A.col[p]!]!;
      if (j <= i) a[off[i]! + j - first[i]!] = a[off[i]! + j - first[i]!]! + A.val[p]!;
    }
  }
  return { n, first, off, a };
}

/** Number of stored entries (the profile), a cost measure for reports and benchmarks. */
export function envelopeSize(e: Envelope): number {
  return e.off[e.n]!;
}

/**
 * Factors `A = L Lᵀ` in place. Returns −1 on success, otherwise the first
 * row whose pivot (the diagonal left after elimination) is at most
 * `pivotRel ×` the largest diagonal entry of `A` (not numerically positive
 * definite; that row depends on the ones before it).
 */
export function envCholFactor(e: Envelope, pivotRel: number): number {
  const { n, first, off, a } = e;
  let dmax = 0;
  for (let i = 0; i < n; i++) dmax = Math.max(dmax, a[off[i]! + i - first[i]!]!);
  const thr = pivotRel * dmax;
  for (let i = 0; i < n; i++) {
    const fi = first[i]!;
    const oi = off[i]! - fi;
    for (let j = fi; j < i; j++) {
      const fj = first[j]!;
      const oj = off[j]! - fj;
      let s = a[oi + j]!;
      for (let k = fi > fj ? fi : fj; k < j; k++) s -= a[oi + k]! * a[oj + k]!;
      a[oi + j] = s / a[oj + j]!;
    }
    let s = a[oi + i]!;
    for (let k = fi; k < i; k++) s -= a[oi + k]! * a[oi + k]!;
    if (!(s > thr)) return i;
    a[oi + i] = Math.sqrt(s);
  }
  return -1;
}

/**
 * Solves `L Lᵀ x = b` in place (`b` in the envelope's ordering). Entries of
 * `b` before `start` must be zero; forward substitution begins there.
 */
export function envCholSolve(e: Envelope, b: Float64Array, start = 0): void {
  const { n, first, off, a } = e;
  for (let i = start; i < n; i++) {
    const fi = first[i]!;
    const oi = off[i]! - fi;
    let s = b[i]!;
    for (let k = fi > start ? fi : start; k < i; k++) s -= a[oi + k]! * b[k]!;
    b[i] = s / a[oi + i]!;
  }
  for (let i = n - 1; i >= 0; i--) {
    const fi = first[i]!;
    const oi = off[i]! - fi;
    const x = b[i]! / a[oi + i]!;
    b[i] = x;
    if (x === 0) continue;
    for (let k = fi; k < i; k++) b[k] = b[k]! - a[oi + k]! * x;
  }
}

/** `out = A x` for the unfactored envelope matrix `A` (symmetric). */
export function envMul(e: Envelope, x: ArrayLike<number>, out: Float64Array): void {
  const { n, first, off, a } = e;
  out.fill(0);
  for (let i = 0; i < n; i++) {
    const fi = first[i]!;
    const oi = off[i]! - fi;
    const xi = x[i]!;
    let s = a[oi + i]! * xi;
    for (let k = fi; k < i; k++) {
      const v = a[oi + k]!;
      s += v * x[k]!;
      out[k] = out[k]! + v * xi;
    }
    out[i] = out[i]! + s;
  }
}

/**
 * Iteration cap of the 1-norm estimator: LAPACK `xLACN2`'s `ITMAX = 5`
 * (Higham reports convergence in two or three steps; the cap bounds cycling).
 */
const RCOND_MAX_ITER = 5;

/**
 * Estimated reciprocal 1-norm condition of the diagonally scaled matrix
 * `S = D A D`, `D = diag(A)^{−½}`, from `A` (unfactored) and its factor `F`.
 * Hager's method as refined by Higham (_Accuracy and Stability of Numerical
 * Algorithms_, 2nd ed., Alg. 15.4) with Higham's alternating-sign extra
 * vector; the same estimator as `bandCholRcond` on envelope storage. The
 * estimate of `‖S⁻¹‖₁` is a lower bound, so the result never understates the
 * true reciprocal condition.
 */
export function envRcond(A: Envelope, F: Envelope): number {
  const { n, first, off, a } = A;
  const dinv = new Float64Array(n);
  for (let i = 0; i < n; i++) dinv[i] = Math.sqrt(a[off[i]! + i - first[i]!]!);
  const col = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const fi = first[i]!;
    for (let j = fi; j <= i; j++) {
      const v = Math.abs(a[off[i]! + j - fi]!) / (dinv[i]! * dinv[j]!);
      col[j] = col[j]! + v;
      if (j !== i) col[i] = col[i]! + v;
    }
  }
  let norm = 0;
  for (let i = 0; i < n; i++) norm = Math.max(norm, col[i]!);
  const solve = (x: Float64Array): void => {
    for (let i = 0; i < n; i++) x[i] = x[i]! * dinv[i]!;
    envCholSolve(F, x);
    for (let i = 0; i < n; i++) x[i] = x[i]! * dinv[i]!;
  };
  const norm1 = (x: Float64Array): number => {
    let s = 0;
    for (let i = 0; i < n; i++) s += Math.abs(x[i]!);
    return s;
  };
  const x = new Float64Array(n).fill(1 / n);
  const y = new Float64Array(n);
  const z = new Float64Array(n);
  let est = 0;
  for (let iter = 0; iter < RCOND_MAX_ITER; iter++) {
    y.set(x);
    solve(y);
    est = Math.max(est, norm1(y));
    for (let i = 0; i < n; i++) z[i] = y[i]! >= 0 ? 1 : -1;
    solve(z);
    let ztx = 0;
    let j = 0;
    for (let i = 0; i < n; i++) {
      ztx += z[i]! * x[i]!;
      if (Math.abs(z[i]!) > Math.abs(z[j]!)) j = i;
    }
    if (Math.abs(z[j]!) <= ztx) break;
    x.fill(0);
    x[j] = 1;
  }
  for (let i = 0; i < n; i++) y[i] = (i % 2 === 0 ? 1 : -1) * (1 + (n > 1 ? i / (n - 1) : 0));
  solve(y);
  est = Math.max(est, (2 * norm1(y)) / (3 * n));
  return 1 / (norm * est);
}

/** A copy (the factorisation overwrites its input). */
export function envelopeCopy(e: Envelope): Envelope {
  return { n: e.n, first: e.first, off: e.off, a: e.a.slice() };
}
