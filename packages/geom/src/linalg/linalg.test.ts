// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Linear-algebra oracles (internal `linalg/`): every factorisation is checked
 * against a different algorithm or an exact construction.
 *
 * - band LU with partial pivoting ↔ dense LU, including systems whose diagonal
 *   is zero (pivoting required) and the wrap-around band of a periodic system;
 * - band Cholesky ↔ dense LU on SPD band matrices; `bandSymMul` ↔ dense product;
 * - Householder least squares ↔ the normal equations on well-conditioned data,
 *   and exact recovery of a consistent overdetermined system;
 * - pivoted Cholesky reveals the exact rank of `G Gᵀ` (G random `m × r`) and
 *   solves the independent rows;
 * - the band Cholesky condition estimate ↔ the exact 1-norm condition from a
 *   dense inverse: never above it (Hager's estimate is a lower bound of
 *   `‖S⁻¹‖₁`), exact when the inverse has no negative entry, and invariant
 *   under diagonal scaling;
 * - singular and indefinite inputs are reported, not divided through.
 *
 * Tolerances: solutions `1e-12` relative to the solution's size (condition
 * numbers here are ≤ ~10³ by construction: diagonally weighted random
 * matrices, measured; ε · κ ≈ 2e-13).
 */
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../testing';
import {
  bandCholFactor,
  bandCholRcond,
  bandCholSolve,
  bandLu,
  bandLuFactor,
  bandLuSet,
  bandLuSolve,
  bandSym,
  bandSymAdd,
  bandSymCopy,
  bandSymMul,
} from './banded';
import { householderLsq, luSolve, pivotedCholesky, pivotedCholeskySolve } from './dense';

const PIV = 1e-12;
const SOL = 1e-12;

function maxAbs(a: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]!));
  return m;
}

function expectClose(a: ArrayLike<number>, b: ArrayLike<number>, rel: number): void {
  expect(a.length).toBe(b.length);
  const s = Math.max(maxAbs(b), 1);
  for (let i = 0; i < a.length; i++)
    expect(Math.abs(a[i]! - b[i]!), `entry ${i}`).toBeLessThanOrEqual(rel * s);
}

describe('band LU', () => {
  it('matches dense LU, with and without a zero diagonal and with periodic wrap', () => {
    const rng = mulberry32(81);
    for (const [n, ml, mu, zeroDiag, wrap] of [
      [30, 3, 2, false, false],
      [25, 1, 4, true, false],
      [20, 3, 3, false, true],
    ] as const) {
      const dense = new Float64Array(n * n);
      const at = (i: number, j: number): void => {
        dense[i * n + j] = (2 * rng() - 1) * (i === j ? (zeroDiag ? 0 : 4) : 1);
      };
      for (let i = 0; i < n; i++) {
        for (let j = Math.max(0, i - ml); j <= Math.min(n - 1, i + mu); j++) at(i, j);
        if (wrap) {
          // Cyclic coupling: the corners of a periodic collocation matrix.
          if (i < 2) at(i, n - 2 + i);
          if (i >= n - 2) at(i, i - (n - 2));
        }
      }
      // Bandwidths measured from the entries, as the callers do.
      let bl = 0;
      let bu = 0;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          if (dense[i * n + j] !== 0) {
            bl = Math.max(bl, i - j);
            bu = Math.max(bu, j - i);
          }
        }
      }
      const m = bandLu(n, bl, bu);
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++)
          if (dense[i * n + j] !== 0) bandLuSet(m, i, j, dense[i * n + j]!);
      expect(bandLuFactor(m, PIV)).toBe(-1);
      // Two right-hand sides interleaved (stride 2), as the fitters store coordinates.
      const b = Float64Array.from({ length: 2 * n }, () => 2 * rng() - 1);
      const x = b.slice();
      bandLuSolve(m, x, 0, 2);
      bandLuSolve(m, x, 1, 2);
      for (const c of [0, 1]) {
        const rhs = Float64Array.from({ length: n }, (_, i) => b[2 * i + c]!);
        const ref = luSolve(n, dense, rhs, PIV)!;
        expectClose(
          Float64Array.from({ length: n }, (_, i) => x[2 * i + c]!),
          ref,
          SOL,
        );
      }
    }
  });

  it('reports a singular system at the dependent column', () => {
    const m = bandLu(4, 1, 1);
    // Rows 2 and 3 equal on the band: rank 3.
    const rows = [
      [1, 2, 0, 0],
      [3, 1, 1, 0],
      [0, 1, 1, 0],
      [0, 0, 0, 0],
    ];
    for (let i = 0; i < 4; i++)
      for (let j = 0; j < 4; j++) if (Math.abs(i - j) <= 1) bandLuSet(m, i, j, rows[i]![j]!);
    expect(bandLuFactor(m, PIV)).toBe(3);
    expect(luSolve(4, rows.flat(), [1, 1, 1, 1], PIV)).toBeNull();
  });
});

describe('band Cholesky', () => {
  it('matches dense LU on SPD band matrices; bandSymMul matches the dense product', () => {
    const rng = mulberry32(82);
    for (const [n, bw] of [
      [40, 3],
      [15, 14],
    ] as const) {
      // A = Bᵀ B + I with B banded: SPD, half-bandwidth bw.
      const half = Math.floor(bw / 2);
      const B = new Float64Array(n * n);
      for (let i = 0; i < n; i++)
        for (let j = i; j <= Math.min(n - 1, i + half); j++) B[i * n + j] = 2 * rng() - 1;
      const A = new Float64Array(n * n);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          let s = i === j ? 1 : 0;
          for (let k = 0; k < n; k++) s += B[k * n + i]! * B[k * n + j]!;
          A[i * n + j] = s;
        }
      }
      const m = bandSym(n, bw);
      for (let i = 0; i < n; i++)
        for (let j = Math.max(0, i - bw); j <= i; j++) bandSymAdd(m, i, j, A[i * n + j]!);
      const x = Float64Array.from({ length: n }, () => 2 * rng() - 1);
      const y = new Float64Array(n);
      bandSymMul(m, x, 0, y, 0);
      const yd = Float64Array.from({ length: n }, (_, i) => {
        let s = 0;
        for (let j = 0; j < n; j++) s += A[i * n + j]! * x[j]!;
        return s;
      });
      expectClose(y, yd, SOL);
      const f = bandSymCopy(m);
      expect(bandCholFactor(f, PIV)).toBe(-1);
      const sol = yd.slice();
      bandCholSolve(f, sol, 0);
      expectClose(sol, x, SOL);
      expectClose(sol, luSolve(n, A, yd, PIV)!, SOL);
    }
  });

  it('reports the first dependent column of a semi-definite matrix', () => {
    const m = bandSym(3, 1);
    // [[1, 1, 0], [1, 1, 0], [0, 0, 1]]: column 1 equals column 0.
    bandSymAdd(m, 0, 0, 1);
    bandSymAdd(m, 1, 0, 1);
    bandSymAdd(m, 1, 1, 1);
    bandSymAdd(m, 2, 2, 1);
    expect(bandCholFactor(m, PIV)).toBe(1);
  });
});

describe('dense least squares and rank', () => {
  it('Householder QR agrees with the normal equations and recovers consistent data exactly', () => {
    const rng = mulberry32(83);
    const m = 40;
    const n = 6;
    const A = Float64Array.from({ length: m * n }, () => 2 * rng() - 1);
    const xTrue = Float64Array.from({ length: n * 2 }, () => 2 * rng() - 1);
    const b = new Float64Array(m * 2);
    for (let i = 0; i < m; i++) {
      for (let c = 0; c < 2; c++) {
        let s = 0;
        for (let j = 0; j < n; j++) s += A[i * n + j]! * xTrue[j * 2 + c]!;
        b[i * 2 + c] = s;
      }
    }
    expectClose(householderLsq(m, n, A, b, 2, PIV)!, xTrue, SOL);
    // Noisy right-hand side: QR equals the normal-equation solution.
    const noisy = b.map((v) => v + 0.1 * (2 * rng() - 1));
    const x = householderLsq(m, n, A, noisy, 2, PIV)!;
    const AtA = new Float64Array(n * n);
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        for (let k = 0; k < m; k++)
          AtA[i * n + j] = AtA[i * n + j]! + A[k * n + i]! * A[k * n + j]!;
    for (const c of [0, 1]) {
      const Atb = Float64Array.from({ length: n }, (_, i) => {
        let s = 0;
        for (let k = 0; k < m; k++) s += A[k * n + i]! * noisy[k * 2 + c]!;
        return s;
      });
      expectClose(
        Float64Array.from({ length: n }, (_, i) => x[i * 2 + c]!),
        luSolve(n, AtA, Atb, PIV)!,
        1e-11,
      );
    }
    // A repeated column is rank deficient.
    const D = Float64Array.from({ length: m * 2 }, (_, i) => A[Math.floor(i / 2) * n]!);
    expect(householderLsq(m, 2, D, b.subarray(0, m), 1, PIV)).toBeNull();
  });

  it('pivoted Cholesky finds the rank of G Gᵀ and solves the independent rows', () => {
    const rng = mulberry32(84);
    const m = 7;
    const r = 4;
    const G = Float64Array.from({ length: m * r }, () => 2 * rng() - 1);
    const S = new Float64Array(m * m);
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) {
        let s = 0;
        for (let k = 0; k < r; k++) s += G[i * r + k]! * G[j * r + k]!;
        S[i * m + j] = s;
      }
    }
    const f = pivotedCholesky(m, S, PIV);
    expect(f.rank).toBe(r);
    // S y = S z for any z is consistent; the solution on the independent rows reproduces it.
    const z = Float64Array.from({ length: m }, () => 2 * rng() - 1);
    const rhs = Float64Array.from({ length: m }, (_, i) => {
      let s = 0;
      for (let j = 0; j < m; j++) s += S[i * m + j]! * z[j]!;
      return s;
    });
    const y = new Float64Array(m);
    pivotedCholeskySolve(f, rhs, y);
    for (let k = r; k < m; k++) expect(y[f.perm[k]!]).toBe(0);
    for (let i = 0; i < m; i++) {
      let s = 0;
      for (let j = 0; j < m; j++) s += S[i * m + j]! * y[j]!;
      expect(Math.abs(s - rhs[i]!)).toBeLessThanOrEqual(1e-10 * Math.max(1, maxAbs(rhs)));
    }
  });
});

describe('band Cholesky condition estimate', () => {
  /** A dense symmetric matrix as a band (`bw`), its factor, and the exact scaled rcond. */
  function setup(n: number, bw: number, dense: Float64Array) {
    const A = bandSym(n, bw);
    for (let i = 0; i < n; i++)
      for (let j = Math.max(0, i - bw); j <= i; j++) bandSymAdd(A, i, j, dense[i * n + j]!);
    const F = bandSymCopy(A);
    expect(bandCholFactor(F, PIV)).toBe(-1);
    // S = D A D, D = diag(A)^{-1/2}; exact ‖S‖₁ ‖S⁻¹‖₁ from n dense solves.
    const d = Float64Array.from({ length: n }, (_, i) => 1 / Math.sqrt(dense[i * n + i]!));
    const S = Float64Array.from(dense, (v, k) => v * d[Math.floor(k / n)]! * d[k % n]!);
    let normS = 0;
    let normInv = 0;
    for (let j = 0; j < n; j++) {
      let c = 0;
      for (let i = 0; i < n; i++) c += Math.abs(S[i * n + j]!);
      normS = Math.max(normS, c);
      const e = new Float64Array(n);
      e[j] = 1;
      normInv = Math.max(
        normInv,
        luSolve(n, S, e, PIV)!.reduce((a, v) => a + Math.abs(v), 0),
      );
    }
    return { A, F, exact: 1 / (normS * normInv) };
  }

  it('is exact for an inverse with no negative entry (second differences)', () => {
    for (const n of [1, 2, 12, 40]) {
      const dense = new Float64Array(n * n);
      for (let i = 0; i < n; i++) {
        dense[i * n + i] = 2;
        if (i > 0) dense[i * n + i - 1] = dense[(i - 1) * n + i] = -1;
      }
      const { A, F, exact } = setup(n, 1, dense);
      // Both sides are sums of n positive terms from well-conditioned solves.
      expect(Math.abs(bandCholRcond(A, F) / exact - 1), `n ${n}`).toBeLessThanOrEqual(1e-12);
    }
  });

  it('never exceeds the true condition, stays close to it, and ignores diagonal scaling', () => {
    const rng = mulberry32(91);
    for (let trial = 0; trial < 30; trial++) {
      const n = 5 + Math.floor(rng() * 30);
      const hb = 1 + Math.floor(rng() * 2);
      const bw = 2 * hb;
      const shift = 10 ** (-6 * rng());
      // Gram matrix G Gᵀ of a random upper band G (half-width hb), plus a
      // diagonal shift of 1e-6 … 1: SPD, measured condition 1 … ~1e7.
      const G = new Float64Array(n * n);
      for (let i = 0; i < n; i++)
        for (let j = i; j <= Math.min(n - 1, i + hb); j++) G[i * n + j] = 2 * rng() - 1;
      const dense = new Float64Array(n * n);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          let s = 0;
          for (let k = 0; k < n; k++) s += G[i * n + k]! * G[j * n + k]!;
          dense[i * n + j] = s;
        }
        dense[i * n + i] = dense[i * n + i]! + shift;
      }
      const { A, F, exact } = setup(n, bw, dense);
      const est = bandCholRcond(A, F);
      // A lower bound of ‖S⁻¹‖₁ gives rcond ≥ the exact value, to the exact
      // value's own rounding (dense LU: κ·ε ≤ ~1e-9 here). Higham reports the
      // estimate rarely more than 3× off; measured here within 1 + 1e-10.
      expect(est, `trial ${trial}`).toBeGreaterThanOrEqual(exact * (1 - 1e-9));
      expect(est, `trial ${trial}`).toBeLessThanOrEqual(3 * exact);
      // Scaling rows and columns by 10^±1 leaves S, hence the estimate, unchanged
      // (a wider range trips bandCholFactor's pivot test, relative to the largest diagonal).
      const sc = Float64Array.from({ length: n }, () => 10 ** (2 * rng() - 1));
      const scaled = Float64Array.from(dense, (v, k) => v * sc[Math.floor(k / n)]! * sc[k % n]!);
      const T = setup(n, bw, scaled);
      expect(Math.abs(bandCholRcond(T.A, T.F) / est - 1), `trial ${trial}`).toBeLessThanOrEqual(
        1e-9,
      );
    }
  });
});
