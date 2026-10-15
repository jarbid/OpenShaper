// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The non-zero basis functions of a curve or surface **with its weights**,
 * and their derivatives, at one parameter (internal). With the weights fixed,
 * `C(t) = Σ R_i(t) P_i` and `S(u, v) = Σ R_ij(u, v) P_ij` are linear in the
 * Euclidean control points, which is what the solver's rows (data, constraints)
 * and fairness Gram matrices are built from (design §10.1).
 *
 * Polynomial geometry: `R = N` (tensor `N_i M_j` for surfaces). Rational
 * geometry: `R_i = w_i N_i / W`, `W = Σ w_j N_j`, differentiated by the
 * quotient rule exactly as P&T differentiate a NURBS point (eq. 4.8 for curves,
 * eq. 4.20 and A4.4 for surfaces), applied to each basis function instead of
 * to the point: `A^(k) = w N^(k)`, `R^(k) = (A^(k) − Σ_{i=1..k} C(k,i) W^(i) R^(k−i)) / W`.
 */
import type { ScratchImpl } from '../array';
import { evalBasisInto } from '../basis';
import type { Basis } from '../types';

/** `BIN[k][i] = C(k, i)` for `k ≤ 3`. */
const BIN: readonly (readonly number[])[] = [[1], [1, 1], [1, 2, 1], [1, 3, 3, 1]];

/** Control-point index of local function `j` of `span` (mod `count` when periodic). */
export function localIndex(b: Basis, span: number, j: number): number {
  const c = span - b.degree + j;
  return c < 0 ? c + b.count : c;
}

/**
 * Curve: the `p + 1` functions of `span` at the sanitized `t`, derivatives to
 * `nDer` (≤ 3). Writes `idx[j]` and `R[k·(p+1) + j]`. `cw` and `h` (stride)
 * give the weights; `rational` false skips them.
 */
export function curveLocal(
  b: Basis,
  cw: ArrayLike<number>,
  h: number,
  rational: boolean,
  t: number,
  span: number,
  nDer: number,
  s: ScratchImpl,
  idx: Int32Array,
  R: Float64Array,
): void {
  const p1 = b.degree + 1;
  const f = s.f;
  evalBasisInto(b, t, span, nDer, s, s.oN, s.oWin);
  for (let j = 0; j < p1; j++) idx[j] = localIndex(b, span, j);
  if (!rational) {
    for (let e = 0; e < (nDer + 1) * p1; e++) R[e] = f[s.oN + e]!;
    return;
  }
  // W^(k) and A^(k) = w N^(k), then the quotient rule order by order.
  const W = s.oH; // scratch: W^(k) at f[W + k]
  for (let k = 0; k <= nDer; k++) {
    let sum = 0;
    for (let j = 0; j < p1; j++) {
      const a = cw[idx[j]! * h + h - 1]! * f[s.oN + k * p1 + j]!;
      R[k * p1 + j] = a;
      sum += a;
    }
    f[W + k] = sum;
  }
  const w0 = f[W]!;
  for (let k = 0; k <= nDer; k++) {
    for (let j = 0; j < p1; j++) {
      let v = R[k * p1 + j]!;
      for (let i = 1; i <= k; i++) v -= BIN[k]![i]! * f[W + i]! * R[(k - i) * p1 + j]!;
      R[k * p1 + j] = v / w0;
    }
  }
}

/**
 * Surface: the `(p + 1)(q + 1)` functions of the span pair at sanitized
 * `(u, v)`, mixed derivatives `∂^(k+l)/∂u^k ∂v^l` for `k ≤ du`, `l ≤ dv`
 * (each ≤ 2). Function `e = a·(q+1) + b` multiplies control point
 * `idx[e]` (u-major flat index); slot `(k, l)` is
 * `R[(k·(dv+1) + l)·K + e]`, `K = (p+1)(q+1)`. `cw` has stride 4. The
 * scratch needs `maxDerivs ≥ 2` (its `oH` region holds the `W_kl`).
 */
export function surfaceLocal(
  bu: Basis,
  bv: Basis,
  cw: ArrayLike<number>,
  rational: boolean,
  u: number,
  v: number,
  su: number,
  sv: number,
  du: number,
  dv: number,
  s: ScratchImpl,
  idx: Int32Array,
  R: Float64Array,
): void {
  const p1 = bu.degree + 1;
  const q1 = bv.degree + 1;
  const K = p1 * q1;
  const nv = bv.count;
  const f = s.f;
  evalBasisInto(bu, u, su, du, s, s.oN, s.oWin);
  evalBasisInto(bv, v, sv, dv, s, s.oNv, s.oWinV);
  for (let a = 0; a < p1; a++) {
    const iu = localIndex(bu, su, a) * nv;
    for (let c = 0; c < q1; c++) idx[a * q1 + c] = iu + localIndex(bv, sv, c);
  }
  const L = dv + 1;
  for (let k = 0; k <= du; k++) {
    for (let l = 0; l <= dv; l++) {
      const o = (k * L + l) * K;
      for (let a = 0; a < p1; a++) {
        const na = f[s.oN + k * p1 + a]!;
        for (let c = 0; c < q1; c++) R[o + a * q1 + c] = na * f[s.oNv + l * q1 + c]!;
      }
    }
  }
  if (!rational) return;
  // A_kl = w N^(k) M^(l), W_kl = Σ A_kl; then R_kl in increasing (k, l).
  const W = s.oH; // scratch: W_kl at f[W + 3k + l] (the region holds 4(D + 1) ≥ 12 doubles for D ≥ 2)
  for (let k = 0; k <= du; k++) {
    for (let l = 0; l <= dv; l++) {
      const o = (k * L + l) * K;
      let sum = 0;
      for (let e = 0; e < K; e++) {
        const x = R[o + e]! * cw[idx[e]! * 4 + 3]!;
        R[o + e] = x;
        sum += x;
      }
      f[W + k * 3 + l] = sum;
    }
  }
  const w0 = f[W]!;
  for (let k = 0; k <= du; k++) {
    for (let l = 0; l <= dv; l++) {
      const o = (k * L + l) * K;
      for (let e = 0; e < K; e++) {
        let x = R[o + e]!;
        for (let i = 0; i <= k; i++) {
          for (let j = 0; j <= l; j++) {
            if (i === 0 && j === 0) continue;
            x -=
              BIN[k]![i]! * BIN[l]![j]! * f[W + i * 3 + j]! * R[((k - i) * L + (l - j)) * K + e]!;
          }
        }
        R[o + e] = x / w0;
      }
    }
  }
}
