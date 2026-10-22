// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The height-field least squares of §9.6, z only (step S7, performance; see
 * docs/design/board2.md "S7 as built").
 *
 * A height field's x and y are affine in (u, v), so of geom's
 * `approximateSurface` only the z solve matters, and the fairness search of
 * §9.8 solves the same data on the same basis a dozen times with only the
 * weight changed. This module assembles the data's normal equations **once per
 * basis** and each trial adds `β G₂` and factors:
 *
 *     minimise  Σ_k (S_z(u_k, v_k) − z_k)²  +  β zᵀ G₂ z
 *     subject to  Σ_j M_j(v_s) z_ij = c_i   for every u column i,
 *
 * the same minimiser as `approximateSurface` with the stringer identity as
 * point constraints at the Greville sites (§3.4: the n_u point conditions and
 * these n_u column conditions are equivalent, both saying that the iso-curve
 * at `v_s` is the line `Σ_i c_i N_i(u)`) and parametric thin-plate fairness
 * `G₂ = ∫∫ R_uu R_uuᵀ + 2 R_uv R_uvᵀ + R_vv R_vvᵀ` (geom's, with the
 * parametric metric: `Gu₂ ⊗ Gv₀ + 2 Gu₁ ⊗ Gv₁ + Gu₀ ⊗ Gv₂`, exact 1D Gram
 * matrices by `p + 1` Gauss–Legendre points per span).
 *
 * **The constraints are eliminated**, not multiplied: in every column the
 * control value `j*` with the largest `M_j*(v_s)` is
 * `z_ij* = (c_i − Σ_{j≠j*} M_j(v_s) z_ij) / M_j*(v_s)`. The substitution
 * `z = T w + t` acts on the v index alone (`T = I ⊗ R`), so the reduced
 * fairness is `Σ A_t ⊗ (Rᵀ B_t R)` and stays banded, and the identity holds
 * to rounding by construction (no multipliers, no Schur complement).
 *
 * **Determination** follows geom's `solveLsq`: the reduced normal matrix is
 * factored by banded Cholesky, refused when a pivot is at most `pivotRel ×`
 * its largest diagonal (`column`) or when its estimated reciprocal condition
 * (diagonally scaled, 1-norm, Hager–Higham) is at most `pivotRel`
 * (`schoenberg-whitney` in geom; the caller moves the fairness up). The
 * linear algebra is a port of geom's internal `linalg/banded.ts` (not part of
 * geom's public API).
 */
import {
  basisDersInto,
  basisFunsInto,
  createScratch,
  findSpan,
  gaussLegendre,
} from '@openshaper/geom';
import type { Basis, ClampedBasis } from '@openshaper/geom';

/** One height-field fit problem on fixed bases (module comment). */
export interface FieldProblem {
  /** Degrees. */
  readonly p: number;
  readonly q: number;
  readonly nu: number;
  readonly nv: number;
  /** Samples. */
  readonly n: number;
  /** Per sample: the full index of its first control point and its 16 (p+1)(q+1) coefficients. */
  readonly base: Int32Array;
  readonly coef: Float64Array;
  readonly z: Float64Array;
  /** The eliminated v index and the substitution `z_ij* = t_i + Σ_j s_j z_ij`. */
  readonly jStar: number;
  readonly s: Float64Array;
  readonly t: Float64Array;
  /** Constant subtracted from every z before the solve (conditioning). */
  readonly centre: number;
  /** Reduced system: size, half-bandwidth, data normal matrix and right-hand side, fairness and its force. */
  readonly size: number;
  readonly bw: number;
  readonly Hd: Float64Array;
  readonly gd: Float64Array;
  readonly Gr: Float64Array;
  readonly gf: Float64Array;
}

export type FieldSolve =
  | {
      readonly ok: true;
      /** Control values, u-major `i · nv + j`. */
      readonly z: Float64Array;
      /** |S_z(u_k, v_k) − z_k| per sample. */
      readonly residual: Float64Array;
    }
  | { readonly ok: false; readonly message: string };

/**
 * The 1D Gram matrices `∫ N_i^(k) N_i'^(k)` over the domain (one period for a
 * periodic basis, whose functions wrap mod `count`), k = 0, 1, 2, dense `n × n`
 * each; `p + 1` Gauss–Legendre points per span (exact: degree ≤ 2p).
 */
export function gram1d(b: Basis): readonly [Float64Array, Float64Array, Float64Array] {
  const p = b.degree;
  const n = b.count;
  const rule = gaussLegendre(p + 1);
  const sc = createScratch({ maxDegree: p, maxDerivs: 2 });
  const d = new Float64Array(3 * (p + 1));
  const g: [Float64Array, Float64Array, Float64Array] = [
    new Float64Array(n * n),
    new Float64Array(n * n),
    new Float64Array(n * n),
  ];
  const U = b.knots;
  const periodic = b.kind === 'periodic';
  const first = periodic ? 0 : p;
  for (let s = first; s < n; s++) {
    const a = U[s]!;
    const e = periodic && s + 1 === n ? U[0]! + b.period : U[s + 1]!;
    if (!(e > a)) continue;
    const h = 0.5 * (e - a);
    for (let q = 0; q < rule.nodes.length; q++) {
      const x = a + h * (rule.nodes[q]! + 1);
      basisDersInto(b, s, x, 2, d, 0, sc);
      const w = rule.weights[q]! * h;
      for (let k = 0; k < 3; k++) {
        const gk = g[k]!;
        for (let i = 0; i <= p; i++) {
          const di = w * d[k * (p + 1) + i]!;
          if (di === 0) continue;
          const row = (((s - p + i) % n) + n) % n;
          for (let j = 0; j <= p; j++) {
            const col = (((s - p + j) % n) + n) % n;
            gk[row * n + col] = gk[row * n + col]! + di * d[k * (p + 1) + j]!;
          }
        }
      }
    }
  }
  return g;
}

/**
 * Assembles the problem on bases `bu × bv` (clamped, degree p × q) for samples
 * at `uv` (interleaved) with heights `z`; the stringer identity at `vs` with
 * the line's control values `c` (one per u column, on `bu`).
 */
export function fieldProblem(
  bu: ClampedBasis,
  bv: ClampedBasis,
  uv: ArrayLike<number>,
  z: ArrayLike<number>,
  vs: number,
  c: ArrayLike<number>,
): FieldProblem {
  const p = bu.degree;
  const q = bv.degree;
  const nu = bu.count;
  const nv = bv.count;
  const n = z.length;
  const sc = createScratch({ maxDegree: Math.max(p, q), maxDerivs: 0 });

  // The eliminated index and the substitution R (module comment).
  const mv = new Float64Array(q + 1);
  const ls = findSpan(bv, vs);
  basisFunsInto(bv, ls, vs, mv, 0, sc);
  let jStar = ls - q;
  for (let b = 1; b <= q; b++) if (mv[b]! > mv[jStar - (ls - q)]!) jStar = ls - q + b;
  const mStar = mv[jStar - (ls - q)]!;
  const s = new Float64Array(nv);
  for (let b = 0; b <= q; b++) {
    const j = ls - q + b;
    if (j !== jStar) s[j] = -mv[b]! / mStar;
  }
  let centre = 0;
  for (let k = 0; k < n; k++) centre += z[k]!;
  centre = n > 0 ? centre / n : 0;
  const t = new Float64Array(nu);
  for (let i = 0; i < nu; i++) t[i] = (c[i]! - centre) / mStar;
  const sLo = ls - q;
  const sHi = ls;
  const nr = nv - 1;
  const red = (i: number, j: number): number => i * nr + (j < jStar ? j : j - 1);

  // Per-sample collocation (kept for the residuals).
  const K = (p + 1) * (q + 1);
  const base = new Int32Array(n);
  const coef = new Float64Array(n * K);
  const nuv = new Float64Array(p + 1);
  const nvv = new Float64Array(q + 1);
  for (let k = 0; k < n; k++) {
    const u = uv[2 * k]!;
    const v = uv[2 * k + 1]!;
    const ku = findSpan(bu, u);
    const kv = findSpan(bv, v);
    basisFunsInto(bu, ku, u, nuv, 0, sc);
    basisFunsInto(bv, kv, v, nvv, 0, sc);
    base[k] = (ku - p) * nv + (kv - q);
    for (let a = 0; a <= p; a++)
      for (let b = 0; b <= q; b++) coef[k * K + a * (q + 1) + b] = nuv[a]! * nvv[b]!;
  }

  // Reduced rows: per sample, (index, value) pairs and the constant from t.
  const maxEntries = (p + 1) * (q + 1 + (sHi - sLo + 1));
  const ri = new Int32Array(maxEntries);
  const rv = new Float64Array(maxEntries);
  const win = new Float64Array(nv);
  const reduceRow = (k: number): { m: number; shift: number } => {
    const i0 = (base[k]! / nv) | 0;
    const j0 = base[k]! - i0 * nv;
    let m = 0;
    let shift = 0;
    for (let a = 0; a <= p; a++) {
      const i = i0 + a;
      const lo = Math.min(j0, sLo);
      const hi = Math.max(j0 + q, sHi);
      for (let j = lo; j <= hi; j++) win[j] = 0;
      for (let b = 0; b <= q; b++) {
        const j = j0 + b;
        const v = coef[k * K + a * (q + 1) + b]!;
        if (j === jStar) {
          shift += v * t[i]!;
          for (let jj = sLo; jj <= sHi; jj++) win[jj] = win[jj]! + v * s[jj]!;
        } else win[j] = win[j]! + v;
      }
      for (let j = lo; j <= hi; j++) {
        if (j === jStar || win[j] === 0) continue;
        ri[m] = red(i, j);
        rv[m] = win[j]!;
        m++;
      }
    }
    return { m, shift };
  };

  // The reduced fairness: Σ_t A_t ⊗ (Rᵀ B_t R), and its force Σ_t (A_t t) ⊗ (Rᵀ B_t e_j*).
  const [gu0, gu1, gu2] = gram1d(bu);
  const [gv0, gv1, gv2] = gram1d(bv);
  const terms: readonly (readonly [Float64Array, Float64Array, number])[] = [
    [gu2, gv0, 1],
    [gu1, gv1, 2],
    [gu0, gv2, 1],
  ];
  // R as a column map: full j → (reduced r, coefficient) pairs.
  const Rcols: { r: number; w: number }[][] = [];
  for (let j = 0; j < nv; j++) {
    if (j !== jStar) Rcols.push([{ r: j < jStar ? j : j - 1, w: 1 }]);
    else {
      const l: { r: number; w: number }[] = [];
      for (let jj = sLo; jj <= sHi; jj++)
        if (jj !== jStar) l.push({ r: jj < jStar ? jj : jj - 1, w: s[jj]! });
      Rcols.push(l);
    }
  }
  const Bred = terms.map(([, B]) => {
    const out = new Float64Array(nr * nr);
    for (let j = 0; j < nv; j++) {
      for (let jj = 0; jj < nv; jj++) {
        const bjj = B[j * nv + jj]!;
        if (bjj === 0) continue;
        for (const x of Rcols[j]!)
          for (const y of Rcols[jj]!) out[x.r * nr + y.r] = out[x.r * nr + y.r]! + x.w * bjj * y.w;
      }
    }
    return out;
  });
  const Bforce = terms.map(([, B]) => {
    // Rᵀ B e_j*: entry r = Σ_j R[j][r] B[j][j*].
    const out = new Float64Array(nr);
    for (let j = 0; j < nv; j++) {
      const b = B[j * nv + jStar]!;
      if (b === 0) continue;
      for (const x of Rcols[j]!) out[x.r] = out[x.r]! + x.w * b;
    }
    return out;
  });
  let maxB = 0;
  for (const Bt of Bred)
    for (let r = 0; r < nr; r++)
      for (let r2 = 0; r2 <= r; r2++) if (Bt[r * nr + r2] !== 0) maxB = Math.max(maxB, r - r2);

  // Bandwidth from the actual sparsity of both terms.
  let bw = p * nr + maxB;
  for (let k = 0; k < n; k++) {
    const { m } = reduceRow(k);
    let lo = Infinity;
    let hi = -Infinity;
    for (let e = 0; e < m; e++) {
      lo = Math.min(lo, ri[e]!);
      hi = Math.max(hi, ri[e]!);
    }
    if (m > 0) bw = Math.max(bw, hi - lo);
  }
  const size = nu * nr;
  const W = bw + 1;
  const Hd = new Float64Array(size * W);
  const gd = new Float64Array(size);
  for (let k = 0; k < n; k++) {
    const { m, shift } = reduceRow(k);
    const target = z[k]! - centre - shift;
    for (let e = 0; e < m; e++) {
      const a = ri[e]!;
      const va = rv[e]!;
      gd[a] = gd[a]! + va * target;
      for (let f = 0; f < m; f++) {
        const b = ri[f]!;
        if (b > a) continue;
        Hd[a * W + (b - a + bw)] = Hd[a * W + (b - a + bw)]! + va * rv[f]!;
      }
    }
  }
  const Gr = new Float64Array(size * W);
  const gf = new Float64Array(size);
  terms.forEach(([A, , wt], ti) => {
    const Bt = Bred[ti]!;
    const Bf = Bforce[ti]!;
    for (let i = 0; i < nu; i++) {
      // Force: (A t)_i ⊗ Rᵀ B e_j*.
      let at = 0;
      for (let i2 = Math.max(0, i - p); i2 <= Math.min(nu - 1, i + p); i2++)
        at += A[i * nu + i2]! * t[i2]!;
      for (let r = 0; r < nr; r++) gf[i * nr + r] = gf[i * nr + r]! + wt * at * Bf[r]!;
      for (let i2 = Math.max(0, i - p); i2 <= i; i2++) {
        const a = A[i * nu + i2]!;
        if (a === 0) continue;
        for (let r = 0; r < nr; r++) {
          const row = i * nr + r;
          for (let r2 = 0; r2 < nr; r2++) {
            const col = i2 * nr + r2;
            if (col > row) continue;
            const b = Bt[r * nr + r2]!;
            if (b === 0) continue;
            Gr[row * W + (col - row + bw)] = Gr[row * W + (col - row + bw)]! + wt * a * b;
          }
        }
      }
    }
  });
  return Object.freeze({
    p,
    q,
    nu,
    nv,
    n,
    base,
    coef,
    z: Float64Array.from(z),
    jStar,
    s,
    t,
    centre,
    size,
    bw,
    Hd,
    gd,
    Gr,
    gf,
  });
}

/** Banded Cholesky in place (geom's `bandCholFactor`): −1, or the first column whose pivot fails. */
export function cholFactor(a: Float64Array, n: number, bw: number, pivotRel: number): number {
  const w = bw + 1;
  let dmax = 0;
  for (let i = 0; i < n; i++) dmax = Math.max(dmax, a[i * w + bw]!);
  const thr = pivotRel * dmax;
  for (let i = 0; i < n; i++) {
    const j0 = Math.max(0, i - bw);
    for (let j = j0; j <= i; j++) {
      let s = a[i * w + (j - i + bw)]!;
      const k0 = Math.max(j0, j - bw);
      const oi = i * w - i + bw;
      const oj = j * w - j + bw;
      for (let k = k0; k < j; k++) s -= a[oi + k]! * a[oj + k]!;
      if (j === i) {
        if (!(s > thr)) return i;
        a[i * w + bw] = Math.sqrt(s);
      } else a[i * w + (j - i + bw)] = s / a[j * w + bw]!;
    }
  }
  return -1;
}

/** Solves in place after {@link cholFactor} (geom's `bandCholSolve`). */
export function cholSolve(a: Float64Array, n: number, bw: number, b: Float64Array): void {
  const w = bw + 1;
  for (let i = 0; i < n; i++) {
    let s = b[i]!;
    const oi = i * w - i + bw;
    for (let k = Math.max(0, i - bw); k < i; k++) s -= a[oi + k]! * b[k]!;
    b[i] = s / a[i * w + bw]!;
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i]!;
    const kEnd = Math.min(n - 1, i + bw);
    for (let k = i + 1; k <= kEnd; k++) s -= a[k * w + (i - k + bw)]! * b[k]!;
    b[i] = s / a[i * w + bw]!;
  }
}

/** Iteration cap of the 1-norm estimator (LAPACK `xLACN2`'s `ITMAX`, as geom's `bandCholRcond`). */
const RCOND_MAX_ITER = 5;

/** Estimated reciprocal 1-norm condition of `D A D`, `D = diag(A)^{−½}` (geom's `bandCholRcond`). */
export function cholRcond(A: Float64Array, F: Float64Array, n: number, bw: number): number {
  const w = bw + 1;
  const dinv = new Float64Array(n);
  for (let i = 0; i < n; i++) dinv[i] = Math.sqrt(A[i * w + bw]!);
  const col = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    for (let j = Math.max(0, i - bw); j <= i; j++) {
      const v = Math.abs(A[i * w + (j - i + bw)]!) / (dinv[i]! * dinv[j]!);
      col[j] = col[j]! + v;
      if (j !== i) col[i] = col[i]! + v;
    }
  }
  let norm = 0;
  for (let i = 0; i < n; i++) norm = Math.max(norm, col[i]!);
  const solve = (x: Float64Array): void => {
    for (let i = 0; i < n; i++) x[i] = x[i]! * dinv[i]!;
    cholSolve(F, n, bw, x);
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

/** The fit at fairness weight `beta` (module comment); refused when the reduced system is not determined. */
export function solveField(P: FieldProblem, beta: number, pivotRel: number): FieldSolve {
  const { size, bw, nu, nv } = P;
  const W = bw + 1;
  const H = new Float64Array(size * W);
  for (let e = 0; e < H.length; e++) H[e] = P.Hd[e]! + beta * P.Gr[e]!;
  const H0 = H.slice();
  const x = new Float64Array(size);
  for (let i = 0; i < size; i++) x[i] = P.gd[i]! - beta * P.gf[i]!;
  const failed = cholFactor(H, size, bw, pivotRel);
  if (failed >= 0) {
    return {
      ok: false,
      message: `control value ${failed} is not determined by the data and fairness`,
    };
  }
  const rcond = cholRcond(H0, H, size, bw);
  if (!(rcond > pivotRel)) {
    return {
      ok: false,
      message: `the data and fairness barely determine the net (reciprocal condition ${rcond})`,
    };
  }
  cholSolve(H, size, bw, x);
  // One step of iterative refinement on the normal equations (as geom's solveLsq).
  const r = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    let s = H0[i * W + bw]! * x[i]!;
    for (let j = Math.max(0, i - bw); j < i; j++) {
      const v = H0[i * W + (j - i + bw)]!;
      s += v * x[j]!;
      r[j] = r[j]! + v * x[i]!;
    }
    r[i] = r[i]! + s;
  }
  for (let i = 0; i < size; i++) r[i] = P.gd[i]! - beta * P.gf[i]! - r[i]!;
  cholSolve(H, size, bw, r);
  for (let i = 0; i < size; i++) x[i] = x[i]! + r[i]!;
  // Back to the full net: z = T w + t, plus the centre.
  const nr = nv - 1;
  const z = new Float64Array(nu * nv);
  for (let i = 0; i < nu; i++) {
    let star = P.t[i]!;
    for (let j = 0; j < nv; j++) {
      if (j === P.jStar) continue;
      const w = x[i * nr + (j < P.jStar ? j : j - 1)]!;
      z[i * nv + j] = w;
      star += P.s[j]! * w;
    }
    z[i * nv + P.jStar] = star;
  }
  for (let e = 0; e < z.length; e++) z[e] = z[e]! + P.centre;
  const p1 = P.p + 1;
  const q1 = P.q + 1;
  const K = p1 * q1;
  const residual = new Float64Array(P.n);
  for (let k = 0; k < P.n; k++) {
    let v = 0;
    const b0 = P.base[k]!;
    for (let a = 0; a < p1; a++)
      for (let b = 0; b < q1; b++) v += P.coef[k * K + a * q1 + b]! * z[b0 + a * nv + b]!;
    residual[k] = Math.abs(v - P.z[k]!);
  }
  return { ok: true, z, residual };
}
