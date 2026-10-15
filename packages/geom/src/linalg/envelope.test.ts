// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Oracles for the solver's sparse linear algebra (A3): `sparse.ts`, `rcm.ts`,
 * `envelope.ts`.
 *
 * - CSR assembly ↔ a dense accumulation of the same triplets (duplicates
 *   summed, columns sorted); transpose and products ↔ dense.
 * - RCM returns a permutation; on graphs whose optimal bandwidth is known
 *   (a path, a `w`-wide grid, both relabelled at random) it finds that
 *   bandwidth; disconnected components get contiguous blocks.
 * - Envelope Cholesky ↔ dense LU on random sparse SPD matrices in RCM order,
 *   including solves that start at a right-hand side's first non-zero; the
 *   factor reproduces `A` (`L Lᵀ = P A Pᵀ`); a singular matrix reports its
 *   dependent row.
 * - The condition estimate never exceeds the true reciprocal condition of
 *   the diagonally scaled matrix (Hager's estimate of `‖S⁻¹‖₁` is a lower
 *   bound) and equals it when `S⁻¹` has no negative entry.
 *
 * Tolerances: solutions `1e-12` relative to their size; the matrices are
 * diagonally dominant by construction (condition ≲ 10², measured), so
 * `ε · κ ≈ 2e-14` and the bound leaves two orders of headroom.
 */
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../testing';
import { luSolve } from './dense';
import {
  envCholFactor,
  envCholSolve,
  envelopeCopy,
  envelopeFromCsr,
  envelopeSize,
  envMul,
  envRcond,
} from './envelope';
import { invertPerm, rcmOrder } from './rcm';
import { coo, cooAdd, cooToCsr, csrMul, csrMulStrided, csrToDense, csrTranspose } from './sparse';
import type { Csr } from './sparse';

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

/** A random symmetric diagonally dominant sparse matrix on the edges of `edges`. */
function spd(n: number, edges: readonly [number, number][], rng: () => number): Csr {
  const b = coo(n, n);
  const diag = new Float64Array(n);
  for (const [i, j] of edges) {
    const v = 2 * rng() - 1;
    cooAdd(b, i, j, v);
    cooAdd(b, j, i, v);
    diag[i] = diag[i]! + Math.abs(v);
    diag[j] = diag[j]! + Math.abs(v);
  }
  for (let i = 0; i < n; i++) cooAdd(b, i, i, diag[i]! + 0.5 + rng());
  return cooToCsr(b);
}

function shuffled(n: number, rng: () => number): Int32Array {
  const p = Int32Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = p[i]!;
    p[i] = p[j]!;
    p[j] = t;
  }
  return p;
}

/** Bandwidth of the pattern of `A` under `perm` (new → old). */
function bandwidth(A: Csr, perm: Int32Array): number {
  const inv = invertPerm(perm);
  let bw = 0;
  for (let i = 0; i < A.rows; i++) {
    for (let p = A.rowPtr[i]!; p < A.rowPtr[i + 1]!; p++) {
      bw = Math.max(bw, Math.abs(inv[i]! - inv[A.col[p]!]!));
    }
  }
  return bw;
}

/** Grid graph `w × h` with node labels permuted by `lab`. */
function gridEdges(w: number, h: number, lab: Int32Array): [number, number][] {
  const e: [number, number][] = [];
  for (let i = 0; i < h; i++) {
    for (let j = 0; j < w; j++) {
      const a = lab[i * w + j]!;
      if (j + 1 < w) e.push([a, lab[i * w + j + 1]!]);
      if (i + 1 < h) e.push([a, lab[(i + 1) * w + j]!]);
    }
  }
  return e;
}

describe('CSR', () => {
  it('sums duplicates, sorts columns and matches a dense accumulation', () => {
    const rng = mulberry32(11);
    const b = coo(7, 5, 2); // small capacity: exercises growth
    const dense = new Float64Array(35);
    for (let k = 0; k < 80; k++) {
      const i = Math.floor(rng() * 7);
      const j = Math.floor(rng() * 5);
      const v = rng() - 0.5;
      cooAdd(b, i, j, v);
      dense[i * 5 + j] = dense[i * 5 + j]! + v;
    }
    const A = cooToCsr(b);
    for (let i = 0; i < 7; i++) {
      for (let p = A.rowPtr[i]! + 1; p < A.rowPtr[i + 1]!; p++)
        expect(A.col[p]!).toBeGreaterThan(A.col[p - 1]!);
    }
    expectClose(csrToDense(A), dense, 1e-15);
    const Ad = csrToDense(A);
    const At = csrToDense(csrTranspose(A));
    for (let i = 0; i < 7; i++)
      for (let j = 0; j < 5; j++) expect(At[j * 7 + i]).toBe(Ad[i * 5 + j]);
    const x = Float64Array.from({ length: 5 }, () => rng());
    const y = new Float64Array(7);
    csrMul(A, x, y);
    const yd = Float64Array.from({ length: 7 }, (_, i) => {
      let s = 0;
      for (let j = 0; j < 5; j++) s += dense[i * 5 + j]! * x[j]!;
      return s;
    });
    expectClose(y, yd, 1e-14);
  });

  it('applies a scalar matrix to interleaved points (A ⊗ I)', () => {
    const rng = mulberry32(12);
    const A = spd(
      6,
      [
        [0, 1],
        [1, 2],
        [3, 5],
      ],
      rng,
    );
    const x = Float64Array.from({ length: 18 }, () => rng());
    const out = new Float64Array(18);
    csrMulStrided(A, x, out, 3);
    for (let c = 0; c < 3; c++) {
      const xc = Float64Array.from({ length: 6 }, (_, i) => x[i * 3 + c]!);
      const yc = new Float64Array(6);
      csrMul(A, xc, yc);
      for (let i = 0; i < 6; i++) expect(out[i * 3 + c]).toBe(yc[i]);
    }
  });
});

describe('reverse Cuthill–McKee', () => {
  it('recovers the bandwidth of a relabelled path (1) and grid (its width)', () => {
    const rng = mulberry32(21);
    const n = 40;
    const lab = shuffled(n, rng);
    const path: [number, number][] = [];
    for (let i = 0; i + 1 < n; i++) path.push([lab[i]!, lab[i + 1]!]);
    const P = spd(n, path, rng);
    const perm = rcmOrder(P);
    expect([...perm].sort((a, b) => a - b)).toEqual([...Array(n).keys()]);
    expect(bandwidth(P, perm)).toBe(1);
    expect(
      bandwidth(
        P,
        Int32Array.from({ length: n }, (_, i) => i),
      ),
    ).toBeGreaterThan(5);

    const w = 6;
    const h = 30;
    const gl = shuffled(w * h, rng);
    const G = spd(w * h, gridEdges(w, h, gl), rng);
    // Row-by-row along the narrow side is the best band order (bandwidth w).
    // RCM (a heuristic) starts at a corner, so its levels are anti-diagonals:
    // bandwidth at most w + 1 and an envelope within 15% of the row order's
    // (measured 1319 vs 1229 entries: 7%), far below the random labelling's.
    const rowOrder = Int32Array.from({ length: w * h }, (_, k) => gl[k]!);
    const rcm = rcmOrder(G);
    expect(bandwidth(G, rcm)).toBeLessThanOrEqual(w + 1);
    const prof = (perm: Int32Array): number =>
      envelopeSize(envelopeFromCsr(G, perm, invertPerm(perm)));
    expect(prof(rcm)).toBeLessThanOrEqual(1.15 * prof(rowOrder));
    expect(prof(rcm)).toBeLessThan(prof(Int32Array.from({ length: w * h }, (_, i) => i)) / 4);
  });

  it('numbers disconnected components in contiguous blocks', () => {
    const rng = mulberry32(22);
    // Three interleaved paths (like the x, y, z unknowns of a separable problem).
    const n = 30;
    const edges: [number, number][] = [];
    for (let c = 0; c < 3; c++)
      for (let i = 0; i + 1 < 10; i++) edges.push([3 * i + c, 3 * (i + 1) + c]);
    const A = spd(n, edges, rng);
    const perm = rcmOrder(A);
    const comp = Array.from(perm, (old) => old % 3);
    for (let k = 1; k < n; k++) {
      if (comp[k] !== comp[k - 1]) expect(comp.slice(k).includes(comp[k - 1]!)).toBe(false);
    }
    expect(bandwidth(A, perm)).toBe(1);
  });
});

describe('envelope Cholesky', () => {
  it('matches dense LU on random sparse SPD matrices in RCM order, with offset starts', () => {
    const rng = mulberry32(31);
    for (const [n, density] of [
      [25, 0.1],
      [60, 0.04],
      [120, 0.02],
    ] as const) {
      const edges: [number, number][] = [];
      for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++) if (rng() < density) edges.push([i, j]);
      const A = spd(n, edges, rng);
      const perm = rcmOrder(A);
      const iperm = invertPerm(perm);
      const E = envelopeFromCsr(A, perm, iperm);
      // The envelope of P A Pᵀ never exceeds the full lower triangle.
      expect(envelopeSize(E)).toBeLessThanOrEqual((n * (n + 1)) / 2);
      const L = envelopeCopy(E);
      expect(envCholFactor(L, 1e-12)).toBe(-1);
      // Dense P A Pᵀ.
      const D = csrToDense(A);
      const PAP = new Float64Array(n * n);
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++) PAP[i * n + j] = D[perm[i]! * n + perm[j]!]!;
      // L Lᵀ = P A Pᵀ.
      const LL = new Float64Array(n * n);
      const Ld = new Float64Array(n * n);
      for (let i = 0; i < n; i++) {
        for (let j = L.first[i]!; j <= i; j++) Ld[i * n + j] = L.a[L.off[i]! + j - L.first[i]!]!;
      }
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++) {
          let s = 0;
          for (let k = 0; k < n; k++) s += Ld[i * n + k]! * Ld[j * n + k]!;
          LL[i * n + j] = s;
        }
      expectClose(LL, PAP, 1e-14);
      // Solves, including a right-hand side with leading zeros.
      for (const start of [0, Math.floor(n / 3), n - 1]) {
        const b = Float64Array.from({ length: n }, (_, i) => (i < start ? 0 : rng() - 0.5));
        const x = b.slice();
        envCholSolve(L, x, start);
        expectClose(x, luSolve(n, PAP, b, 1e-14)!, SOL);
      }
      // envMul ↔ dense product.
      const x = Float64Array.from({ length: n }, () => rng());
      const y = new Float64Array(n);
      envMul(E, x, y);
      const yd = Float64Array.from({ length: n }, (_, i) => {
        let s = 0;
        for (let j = 0; j < n; j++) s += PAP[i * n + j]! * x[j]!;
        return s;
      });
      expectClose(y, yd, 1e-14);
    }
  });

  it('reports the dependent row of a singular matrix', () => {
    // Graph Laplacian of a path: singular (constants), PSD; the last pivot vanishes.
    const n = 8;
    const b = coo(n, n);
    for (let i = 0; i + 1 < n; i++) {
      cooAdd(b, i, i, 1);
      cooAdd(b, i + 1, i + 1, 1);
      cooAdd(b, i, i + 1, -1);
      cooAdd(b, i + 1, i, -1);
    }
    const A = cooToCsr(b);
    const id = Int32Array.from({ length: n }, (_, i) => i);
    const L = envelopeFromCsr(A, id, id);
    expect(envCholFactor(L, 1e-12)).toBe(n - 1);
  });

  it('estimates the scaled reciprocal condition from below, exactly for a positive inverse', () => {
    const rng = mulberry32(41);
    const trueRcond = (A: Csr): number => {
      const n = A.rows;
      const D = csrToDense(A);
      const d = Float64Array.from({ length: n }, (_, i) => 1 / Math.sqrt(D[i * n + i]!));
      const S = Float64Array.from(D, (v, k) => v * d[Math.floor(k / n)]! * d[k % n]!);
      const inv = new Float64Array(n * n);
      for (let j = 0; j < n; j++) {
        const e = new Float64Array(n);
        e[j] = 1;
        inv.set(luSolve(n, S, e, 1e-15)!, j * n); // column j (S symmetric)
      }
      const n1 = (M: Float64Array): number => {
        let m = 0;
        for (let j = 0; j < n; j++) {
          let s = 0;
          for (let i = 0; i < n; i++) s += Math.abs(M[i * n + j]!);
          m = Math.max(m, s);
        }
        return m;
      };
      return 1 / (n1(S) * n1(inv));
    };
    const est = (A: Csr): number => {
      const id = Int32Array.from({ length: A.rows }, (_, i) => i);
      const E = envelopeFromCsr(A, id, id);
      const L = envelopeCopy(E);
      expect(envCholFactor(L, 1e-14)).toBe(-1);
      return envRcond(E, L);
    };
    for (let t = 0; t < 5; t++) {
      const n = 20;
      const edges: [number, number][] = [];
      for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++) if (rng() < 0.15) edges.push([i, j]);
      const A = spd(n, edges, rng);
      expect(est(A)).toBeGreaterThanOrEqual(trueRcond(A) * (1 - 1e-12));
    }
    // tridiag(−1, 2 + ε, −1): an M-matrix, its inverse is positive ⇒ the estimate is exact.
    const n = 30;
    const b = coo(n, n);
    for (let i = 0; i < n; i++) {
      cooAdd(b, i, i, 2.01);
      if (i + 1 < n) {
        cooAdd(b, i, i + 1, -1);
        cooAdd(b, i + 1, i, -1);
      }
    }
    const M = cooToCsr(b);
    expect(Math.abs(est(M) - trueRcond(M))).toBeLessThanOrEqual(1e-10 * trueRcond(M));
  });
});
