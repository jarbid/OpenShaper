// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Literal ports of P&T chapters 3 and 4 for curves, on homogeneous control
 * points `Pw = [w·x, (w·y, (w·z,)) w]` (stride `h = dim + 1`). Internal.
 *
 * A NURBS curve is the projection of the B-spline curve `Cw(u) = Σ N_i(u) Pw_i`
 * (P&T eq. 4.5). A3.1 / A3.2 run on Pw unchanged (that is A4.1 and the first
 * half of A4.2); A4.2 then recovers the Euclidean derivatives by the quotient
 * rule. Polynomial curves store `w = 1`, so the same accumulation serves both.
 */
import type { ReadonlyF64 } from '../types';

/** Binomial coefficients `Bin[k][i]` for `k ≤ 3`, row stride 4 (A4.2). */
const BIN = [1, 0, 0, 0, 1, 1, 0, 0, 1, 2, 1, 0, 1, 3, 3, 1] as const;

/**
 * A3.1 CurvePoint (A4.1 on Pw): `Cw = Σ_{j=0..p} N[no+j] · Pw[po + j·h]`, written
 * to `out[oo …]` (h values). `po` is the offset of control point `span − p`.
 */
export function curvePointH(
  p: number,
  N: Float64Array,
  no: number,
  Pw: ReadonlyF64,
  po: number,
  h: number,
  out: Float64Array,
  oo: number,
): void {
  for (let c = 0; c < h; c++) out[oo + c] = 0.0;
  for (let j = 0; j <= p; j++) {
    const nj = N[no + j]!;
    const q = po + j * h;
    for (let c = 0; c < h; c++) out[oo + c] = out[oo + c]! + nj * Pw[q + c]!;
  }
}

/**
 * A3.2 CurveDerivsAlg1 on Pw: `CKw[k] = Σ_j ders[k][j] · Pw_{span−p+j}` for
 * `k = 0..d`, from basis derivatives `D[do_ + k·(p+1) + j]` (A2.3, rows `k > p`
 * already zero). Output stride `h`.
 */
export function curveDerivsH(
  p: number,
  d: number,
  D: Float64Array,
  do_: number,
  Pw: ReadonlyF64,
  po: number,
  h: number,
  out: Float64Array,
  oo: number,
): void {
  const p1 = p + 1;
  for (let k = 0; k <= d; k++) {
    const ok = oo + k * h;
    for (let c = 0; c < h; c++) out[ok + c] = 0.0;
    for (let j = 0; j <= p; j++) {
      const nkj = D[do_ + k * p1 + j]!;
      const q = po + j * h;
      for (let c = 0; c < h; c++) out[ok + c] = out[ok + c]! + nkj * Pw[q + c]!;
    }
  }
}

/**
 * A4.2 RatCurveDerivs: from the homogeneous derivatives `H[ho + k·h …]`
 * (`Aders[k]` = the first `dim` values, `wders[k]` = the last), the Euclidean
 * derivatives `CK[k] = (Aders[k] − Σ_{i=1..k} Bin(k,i) · wders[i] · CK[k−i]) / wders[0]`
 * for `k = 0..d` (d ≤ 3), written to `CK[co + k·dim …]`.
 */
export function ratCurveDerivs(
  H: Float64Array,
  ho: number,
  dim: number,
  d: number,
  CK: Float64Array,
  co: number,
): void {
  const h = dim + 1;
  const w0 = H[ho + dim]!;
  for (let k = 0; k <= d; k++) {
    for (let c = 0; c < dim; c++) {
      let v = H[ho + k * h + c]!;
      for (let i = 1; i <= k; i++) {
        v = v - BIN[k * 4 + i]! * H[ho + i * h + dim]! * CK[co + (k - i) * dim + c]!;
      }
      CK[co + k * dim + c] = v / w0;
    }
  }
}

/** The polynomial case of A4.2 (`w ≡ 1`): `CK[k] = Aders[k]`. */
export function polyCurveDerivs(
  H: Float64Array,
  ho: number,
  dim: number,
  d: number,
  CK: Float64Array,
  co: number,
): void {
  const h = dim + 1;
  for (let k = 0; k <= d; k++) {
    for (let c = 0; c < dim; c++) CK[co + k * dim + c] = H[ho + k * h + c]!;
  }
}
