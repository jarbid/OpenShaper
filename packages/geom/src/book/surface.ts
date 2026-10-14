// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Literal ports of P&T chapters 3 and 4 for tensor-product surfaces, on
 * homogeneous control points `Pw_ij = [w·x, w·y, w·z, w]`. Internal.
 *
 * A NURBS surface is the projection of the B-spline surface
 * `Sw(u, v) = Σ_i Σ_j N_i(u) N_j(v) Pw_ij` (P&T eq. 4.15). A3.6 runs on Pw
 * unchanged (that is A4.3 and the first half of A4.4); A4.4 then recovers the
 * Euclidean derivatives by the quotient rule. Polynomial surfaces store
 * `w = 1`, so one accumulation serves both.
 *
 * `SKL[k][l]` (the derivative `∂^{k+l} S / ∂u^k ∂v^l`) is stored flat in
 * slot `o(o + 1)/2 + l` with `o = k + l`, so to second order the slots are
 * `[S, Su, Sv, Suu, Suv, Svv]` (design §4.6). `d ≤ 2` here.
 *
 * The control points of span pair `(uspan, vspan)` are not addressed as
 * `P[uspan − p + r][vspan − q + s]` directly: the caller passes their offsets
 * into the net (`R[ro + r] + C[co + s]`), which is how a periodic direction
 * wraps without a branch in the loop and how sample plans replay the exact
 * same arithmetic from stored offsets.
 */
import type { ReadonlyF64 } from '../types';

/** Binomial coefficients `Bin[k][i]` for `k ≤ 2`, row stride 3 (A4.4). */
const BIN = [1, 0, 0, 1, 1, 0, 1, 2, 1] as const;

/** Flat slot of `SKL[k][l]`: `o(o + 1)/2 + l`, `o = k + l`. */
export function slot(k: number, l: number): number {
  const o = k + l;
  return ((o * (o + 1)) >> 1) + l;
}

/**
 * A3.6 SurfaceDerivsAlg1 on Pw (with `d = 0`, A3.5 / A4.3): the homogeneous
 * derivatives `SKLw[k][l] = Σ_r Σ_s Nu[k][r] · Nv[l][s] · Pw[r][s]` for
 * `k + l ≤ d`, written to `SKL[so + 4·slot(k, l) …]`.
 *
 * `Nu[nuo + k·(p+1) + r]` and `Nv[nvo + l·(q+1) + s]` are the basis derivatives
 * from A2.3 (rows above the degree zero), `R[ro + r]` / `C[co + s]` the offsets
 * of row `r` and column `s` of the span pair in `Pw`, and `T[to …]` the book's
 * `temp[0..q]` (stride 4).
 */
export function surfaceDerivsH(
  p: number,
  q: number,
  d: number,
  Nu: Float64Array,
  nuo: number,
  Nv: Float64Array,
  nvo: number,
  Pw: ReadonlyF64,
  R: Int32Array,
  ro: number,
  C: Int32Array,
  co: number,
  T: Float64Array,
  to: number,
  SKL: Float64Array,
  so: number,
): void {
  const p1 = p + 1;
  const q1 = q + 1;
  const du = d < p ? d : p;
  const dv = d < q ? d : q;
  for (let k = p + 1; k <= d; k++) {
    for (let l = 0; l <= d - k; l++) {
      const o = so + 4 * slot(k, l);
      SKL[o] = 0.0;
      SKL[o + 1] = 0.0;
      SKL[o + 2] = 0.0;
      SKL[o + 3] = 0.0;
    }
  }
  for (let l = q + 1; l <= d; l++) {
    for (let k = 0; k <= d - l; k++) {
      const o = so + 4 * slot(k, l);
      SKL[o] = 0.0;
      SKL[o + 1] = 0.0;
      SKL[o + 2] = 0.0;
      SKL[o + 3] = 0.0;
    }
  }
  for (let k = 0; k <= du; k++) {
    for (let s = 0; s <= q; s++) {
      const t = to + 4 * s;
      let x = 0.0;
      let y = 0.0;
      let z = 0.0;
      let w = 0.0;
      const cs = C[co + s]!;
      for (let r = 0; r <= p; r++) {
        const n = Nu[nuo + k * p1 + r]!;
        const i = R[ro + r]! + cs;
        x += n * Pw[i]!;
        y += n * Pw[i + 1]!;
        z += n * Pw[i + 2]!;
        w += n * Pw[i + 3]!;
      }
      T[t] = x;
      T[t + 1] = y;
      T[t + 2] = z;
      T[t + 3] = w;
    }
    const dd = d - k < dv ? d - k : dv;
    for (let l = 0; l <= dd; l++) {
      let x = 0.0;
      let y = 0.0;
      let z = 0.0;
      let w = 0.0;
      for (let s = 0; s <= q; s++) {
        const n = Nv[nvo + l * q1 + s]!;
        const t = to + 4 * s;
        x += n * T[t]!;
        y += n * T[t + 1]!;
        z += n * T[t + 2]!;
        w += n * T[t + 3]!;
      }
      const o = so + 4 * slot(k, l);
      SKL[o] = x;
      SKL[o + 1] = y;
      SKL[o + 2] = z;
      SKL[o + 3] = w;
    }
  }
}

/**
 * A4.4 RatSurfaceDerivs: from the homogeneous derivatives `H[ho + 4·slot …]`
 * (`Aders[k][l]` = the first three values, `wders[k][l]` = the fourth), the
 * Euclidean derivatives for `k + l ≤ d` (d ≤ 2), written to
 * `SKL[so + 3·slot(k, l) …]`:
 *
 * `SKL[k][l] = (Aders[k][l] − Σ_{j=1..l} Bin(l,j)·wders[0][j]·SKL[k][l−j]
 *   − Σ_{i=1..k} Bin(k,i)·(wders[i][0]·SKL[k−i][l]
 *   + Σ_{j=1..l} Bin(l,j)·wders[i][j]·SKL[k−i][l−j])) / wders[0][0]`.
 */
export function ratSurfaceDerivs(
  H: Float64Array,
  ho: number,
  d: number,
  SKL: Float64Array,
  so: number,
): void {
  const w00 = H[ho + 3]!;
  for (let k = 0; k <= d; k++) {
    for (let l = 0; l <= d - k; l++) {
      const a = ho + 4 * slot(k, l);
      for (let c = 0; c < 3; c++) {
        let v = H[a + c]!;
        for (let j = 1; j <= l; j++) {
          v = v - BIN[l * 3 + j]! * H[ho + 4 * slot(0, j) + 3]! * SKL[so + 3 * slot(k, l - j) + c]!;
        }
        for (let i = 1; i <= k; i++) {
          v = v - BIN[k * 3 + i]! * H[ho + 4 * slot(i, 0) + 3]! * SKL[so + 3 * slot(k - i, l) + c]!;
          let v2 = 0.0;
          for (let j = 1; j <= l; j++) {
            v2 =
              v2 +
              BIN[l * 3 + j]! * H[ho + 4 * slot(i, j) + 3]! * SKL[so + 3 * slot(k - i, l - j) + c]!;
          }
          v = v - BIN[k * 3 + i]! * v2;
        }
        SKL[so + 3 * slot(k, l) + c] = v / w00;
      }
    }
  }
}

/** The polynomial case of A4.4 (`w ≡ 1`): `SKL[k][l] = Aders[k][l]`. */
export function polySurfaceDerivs(
  H: Float64Array,
  ho: number,
  d: number,
  SKL: Float64Array,
  so: number,
): void {
  const slots = ((d + 1) * (d + 2)) >> 1;
  for (let t = 0; t < slots; t++) {
    SKL[so + 3 * t] = H[ho + 4 * t]!;
    SKL[so + 3 * t + 1] = H[ho + 4 * t + 1]!;
    SKL[so + 3 * t + 2] = H[ho + 4 * t + 2]!;
  }
}
