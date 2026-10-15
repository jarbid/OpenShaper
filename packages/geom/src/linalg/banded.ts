// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Banded linear algebra (internal; design §3 `linalg/banded.ts`).
 *
 * Collocation matrices of interpolation (P&T A9.1, A9.4) and Gram matrices of
 * least-squares fits are banded: a parameter in span `k` touches only the
 * `p + 1` basis functions `k − p … k`. Two factorisations:
 *
 * - {@link bandLuFactor}: Gaussian elimination with partial pivoting on a
 *   general band matrix (LAPACK `gbtrf`'s scheme: the upper band widens by the
 *   lower bandwidth to hold the fill of row interchanges). P&T solve A9.1
 *   without pivoting (the collocation matrix is totally positive, de Boor);
 *   end-derivative rows (§9.2.2) and periodic wrap break that property, so
 *   pivoting is kept.
 * - {@link bandCholFactor}: Cholesky of a symmetric positive definite band
 *   matrix (normal equations), with a relative pivot test that names the first
 *   column found dependent.
 *
 * Bandwidths are measured from the actual sparsity, so a periodic wrap simply
 * widens the band (up to dense); no structure is assumed. Nothing allocates
 * after construction; right-hand sides are solved in place with an offset and
 * a stride, so one factor serves every coordinate and every row of a grid.
 */

/** A general `n × n` band matrix with `ml` sub- and `mu` super-diagonals, factorable in place. */
export interface BandLU {
  readonly n: number;
  readonly ml: number;
  readonly mu: number;
  /** Stored width per row: `2·ml + mu + 1` (room for the fill of pivoting). */
  readonly w: number;
  /** Row `i` stores columns `i − ml … i + ml + mu` at `i·w + (j − i + ml)`. */
  readonly a: Float64Array;
  /** Row interchanges: at step `k`, row `k` was swapped with row `piv[k]`. */
  readonly piv: Int32Array;
}

/** A zero band matrix ready for {@link bandLuSet}. */
export function bandLu(n: number, ml: number, mu: number): BandLU {
  const w = 2 * ml + mu + 1;
  return { n, ml, mu, w, a: new Float64Array(n * w), piv: new Int32Array(n) };
}

/** `A(i, j) = v`; `j − i` must lie in `[−ml, mu]`. */
export function bandLuSet(m: BandLU, i: number, j: number, v: number): void {
  m.a[i * m.w + (j - i + m.ml)] = v;
}

/**
 * Factors `P A = L U` in place. Returns −1 on success, otherwise the column `k`
 * whose best pivot is at most `pivotRel ×` the largest absolute entry of `A`
 * (numerically singular).
 */
export function bandLuFactor(m: BandLU, pivotRel: number): number {
  const { n, ml, mu, w, a, piv } = m;
  let amax = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Math.abs(a[i]!);
    if (x > amax) amax = x;
  }
  const thr = pivotRel * amax;
  for (let k = 0; k < n; k++) {
    const last = Math.min(n - 1, k + ml);
    let r = k;
    let best = Math.abs(a[k * w + ml]!);
    for (let i = k + 1; i <= last; i++) {
      const x = Math.abs(a[i * w + (k - i + ml)]!);
      if (x > best) {
        best = x;
        r = i;
      }
    }
    piv[k] = r;
    if (!(best > thr)) return k;
    const jEnd = Math.min(n - 1, k + ml + mu);
    if (r !== k) {
      for (let j = k; j <= jEnd; j++) {
        const ik = k * w + (j - k + ml);
        const ir = r * w + (j - r + ml);
        const t = a[ik]!;
        a[ik] = a[ir]!;
        a[ir] = t;
      }
    }
    const pivot = a[k * w + ml]!;
    for (let i = k + 1; i <= last; i++) {
      const ii = i * w + (k - i + ml);
      const l = a[ii]! / pivot;
      a[ii] = l;
      if (l === 0) continue;
      for (let j = k + 1; j <= jEnd; j++) {
        a[i * w + (j - i + ml)] = a[i * w + (j - i + ml)]! - l * a[k * w + (j - k + ml)]!;
      }
    }
  }
  return -1;
}

/**
 * Solves `A x = b` in place after {@link bandLuFactor}: `b[o + i·stride]`,
 * `i = 0..n−1`, holds the right-hand side and receives the solution.
 */
export function bandLuSolve(m: BandLU, b: Float64Array, o = 0, stride = 1): void {
  const { n, ml, mu, w, a, piv } = m;
  for (let k = 0; k < n; k++) {
    const r = piv[k]!;
    if (r !== k) {
      const t = b[o + k * stride]!;
      b[o + k * stride] = b[o + r * stride]!;
      b[o + r * stride] = t;
    }
    const bk = b[o + k * stride]!;
    if (bk === 0) continue;
    const last = Math.min(n - 1, k + ml);
    for (let i = k + 1; i <= last; i++)
      b[o + i * stride] = b[o + i * stride]! - a[i * w + (k - i + ml)]! * bk;
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = b[o + i * stride]!;
    const jEnd = Math.min(n - 1, i + ml + mu);
    for (let j = i + 1; j <= jEnd; j++) s -= a[i * w + (j - i + ml)]! * b[o + j * stride]!;
    b[o + i * stride] = s / a[i * w + ml]!;
  }
}

/** A symmetric `n × n` band matrix with half-bandwidth `bw`, lower triangle stored. */
export interface BandSym {
  readonly n: number;
  readonly bw: number;
  /** Row `i` stores columns `i − bw … i` at `i·(bw + 1) + (j − i + bw)`. */
  readonly a: Float64Array;
}

/** A zero symmetric band matrix. */
export function bandSym(n: number, bw: number): BandSym {
  return { n, bw, a: new Float64Array(n * (bw + 1)) };
}

/** `A(i, j) += v` for `j ≤ i ≤ j + bw` (the lower triangle). */
export function bandSymAdd(m: BandSym, i: number, j: number, v: number): void {
  m.a[i * (m.bw + 1) + (j - i + m.bw)] = m.a[i * (m.bw + 1) + (j - i + m.bw)]! + v;
}

/** A copy (the factorisation overwrites its input; refinement needs the original). */
export function bandSymCopy(m: BandSym): BandSym {
  return { n: m.n, bw: m.bw, a: m.a.slice() };
}

/**
 * `out[oo + i·stride] = (A x)_i` for the symmetric band matrix `A` (unfactored),
 * `x[xo + i·stride]`.
 */
export function bandSymMul(
  m: BandSym,
  x: Float64Array,
  xo: number,
  out: Float64Array,
  oo: number,
  stride = 1,
): void {
  const { n, bw, a } = m;
  const w = bw + 1;
  for (let i = 0; i < n; i++) out[oo + i * stride] = 0;
  for (let i = 0; i < n; i++) {
    const j0 = Math.max(0, i - bw);
    let s = a[i * w + bw]! * x[xo + i * stride]!;
    const xi = x[xo + i * stride]!;
    for (let j = j0; j < i; j++) {
      const v = a[i * w + (j - i + bw)]!;
      s += v * x[xo + j * stride]!;
      out[oo + j * stride] = out[oo + j * stride]! + v * xi;
    }
    out[oo + i * stride] = out[oo + i * stride]! + s;
  }
}

/**
 * Cholesky `A = L Lᵀ` in place (row-oriented, Cholesky–Banachiewicz). Returns
 * −1 on success, otherwise the first column whose pivot (the diagonal left
 * after elimination) is at most `pivotRel ×` the largest diagonal entry of `A`:
 * `A` is not numerically positive definite, and that column is dependent on
 * the ones before it.
 */
export function bandCholFactor(m: BandSym, pivotRel: number): number {
  const { n, bw, a } = m;
  const w = bw + 1;
  let dmax = 0;
  for (let i = 0; i < n; i++) dmax = Math.max(dmax, a[i * w + bw]!);
  const thr = pivotRel * dmax;
  for (let i = 0; i < n; i++) {
    const j0 = Math.max(0, i - bw);
    for (let j = j0; j <= i; j++) {
      let s = a[i * w + (j - i + bw)]!;
      const k0 = Math.max(j0, j - bw);
      for (let k = k0; k < j; k++) s -= a[i * w + (k - i + bw)]! * a[j * w + (k - j + bw)]!;
      if (j === i) {
        if (!(s > thr)) return i;
        a[i * w + bw] = Math.sqrt(s);
      } else {
        a[i * w + (j - i + bw)] = s / a[j * w + bw]!;
      }
    }
  }
  return -1;
}

/** Solves `A x = b` in place after {@link bandCholFactor} (`b[o + i·stride]`). */
export function bandCholSolve(m: BandSym, b: Float64Array, o = 0, stride = 1): void {
  const { n, bw, a } = m;
  const w = bw + 1;
  for (let i = 0; i < n; i++) {
    let s = b[o + i * stride]!;
    for (let k = Math.max(0, i - bw); k < i; k++)
      s -= a[i * w + (k - i + bw)]! * b[o + k * stride]!;
    b[o + i * stride] = s / a[i * w + bw]!;
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = b[o + i * stride]!;
    const kEnd = Math.min(n - 1, i + bw);
    for (let k = i + 1; k <= kEnd; k++) s -= a[k * w + (i - k + bw)]! * b[o + k * stride]!;
    b[o + i * stride] = s / a[i * w + bw]!;
  }
}

/**
 * Iteration cap of the 1-norm estimator in {@link bandCholRcond}: LAPACK
 * `xLACN2`'s `ITMAX = 5`. Higham reports the estimate settling in two or three
 * steps; the cap only bounds cycling.
 */
const RCOND_MAX_ITER = 5;

/**
 * Estimated reciprocal condition number, in the 1-norm, of the diagonally
 * scaled matrix `S = D A D` (`D = diag(A)^{−½}`, so `S` has a unit diagonal),
 * given `A` and its factor `F` from {@link bandCholFactor}. Scaling first
 * makes the figure the one that governs Cholesky's accuracy (van der Sluis:
 * the factorisation is invariant to diagonal scaling) and independent of the
 * units of the data weights.
 *
 * `‖S‖₁` is exact; `‖S⁻¹‖₁` is estimated by Hager's method as refined by
 * Higham (Accuracy and Stability of Numerical Algorithms, 2nd ed., Alg. 15.4,
 * LAPACK `xLACN2`; `S⁻¹` is symmetric, so its transpose solves are the same
 * solves), with Higham's alternating-sign extra vector. The estimate never
 * exceeds `‖S⁻¹‖₁`, so the returned value is never below the true reciprocal
 * condition; it is exact when `S⁻¹` has no negative entry.
 */
export function bandCholRcond(A: BandSym, F: BandSym): number {
  const { n, bw, a } = A;
  const w = bw + 1;
  const dinv = new Float64Array(n); // D⁻¹ = diag(A)^{½}
  for (let i = 0; i < n; i++) dinv[i] = Math.sqrt(a[i * w + bw]!);
  const col = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    for (let j = Math.max(0, i - bw); j <= i; j++) {
      const v = Math.abs(a[i * w + (j - i + bw)]!) / (dinv[i]! * dinv[j]!);
      col[j] = col[j]! + v;
      if (j !== i) col[i] = col[i]! + v;
    }
  }
  let norm = 0;
  for (let i = 0; i < n; i++) norm = Math.max(norm, col[i]!);
  // S⁻¹ x = D⁻¹ A⁻¹ D⁻¹ x, in place.
  const solve = (x: Float64Array): void => {
    for (let i = 0; i < n; i++) x[i] = x[i]! * dinv[i]!;
    bandCholSolve(F, x);
    for (let i = 0; i < n; i++) x[i] = x[i]! * dinv[i]!;
  };
  const norm1 = (x: Float64Array): number => {
    let s = 0;
    for (let i = 0; i < n; i++) s += Math.abs(x[i]!);
    return s;
  };
  // Hager (Higham Alg. 15.4): x = e/n; repeat y = S⁻¹x, z = S⁻¹ sign(y);
  // stop when ‖z‖∞ ≤ zᵀx, else x = e_j at j = argmax |z_j|. Every ‖y‖₁ is
  // ‖S⁻¹x‖₁ with ‖x‖₁ = 1, a lower bound of ‖S⁻¹‖₁; the largest is kept.
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
  // Higham's extra vector b_i = (−1)^i (1 + i/(n − 1)), ‖b‖₁ = 3n/2.
  for (let i = 0; i < n; i++) y[i] = (i % 2 === 0 ? 1 : -1) * (1 + (n > 1 ? i / (n - 1) : 0));
  solve(y);
  est = Math.max(est, (2 * norm1(y)) / (3 * n));
  return 1 / (norm * est);
}
