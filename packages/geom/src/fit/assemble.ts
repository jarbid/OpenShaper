// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Assembly helpers for fitting (internal; design §3 `fit/assemble.ts`):
 * collocation rows (basis values and derivatives at many parameters) for one
 * direction, and their tensor products for surfaces.
 *
 * A row holds the `p + 1` non-zero basis functions of one parameter and the
 * control-point index each multiplies (`span − p + j`, mod `count` when
 * periodic: design §4.3). Values come from the same A2.2 / A2.3 kernel the
 * evaluators run (`evalBasisAt`), so a fitted curve evaluated at a data
 * parameter reproduces the row's arithmetic.
 */
import { makeScratch } from '../array';
import { evalBasisAt, sanitizeParam, spanOf } from '../basis';
import type { Basis } from '../types';

/** Basis values (and derivatives) of one direction at `count` parameters. */
export interface Collocation {
  readonly count: number;
  /** Non-zero functions per parameter: `p + 1`. */
  readonly p1: number;
  readonly nDer: number;
  /** `count × p1` control-point indices. */
  readonly cols: Int32Array;
  /** `count × (nDer + 1) × p1`: derivative `k` of function `j` at parameter `r` is `vals[(r·(nDer+1) + k)·p1 + j]`. */
  readonly vals: Float64Array;
}

/**
 * Basis values and derivatives to `nDer` at each parameter of `ts` (clamped
 * or wrapped onto the domain; right-hand limits at interior knots, the inner
 * side at clamped ends).
 */
export function collocate(b: Basis, ts: ArrayLike<number>, nDer: number): Collocation {
  const p = b.degree;
  const p1 = p + 1;
  const n = b.count;
  const s = makeScratch(p, Math.max(nDer, 0));
  const count = ts.length;
  const cols = new Int32Array(count * p1);
  const vals = new Float64Array(count * (nDer + 1) * p1);
  const f = s.f;
  for (let r = 0; r < count; r++) {
    const t = sanitizeParam(b, ts[r]!);
    const span = spanOf(b, t, false);
    evalBasisAt(b, t, span, nDer, s);
    for (let j = 0; j < p1; j++) {
      const c = span - p + j;
      cols[r * p1 + j] = c < 0 ? c + n : c;
    }
    for (let k = 0; k < (nDer + 1) * p1; k++) vals[r * (nDer + 1) * p1 + k] = f[s.oN + k]!;
  }
  return { count, p1, nDer, cols, vals };
}

/** Sparse rows of a linear map from control points: `K` entries per row. */
export interface DesignRows {
  readonly rows: number;
  readonly K: number;
  /** `rows × K` control-point indices (flat `i · v.count + j` for surfaces). */
  readonly idx: Int32Array;
  readonly val: Float64Array;
}

/** The value rows (`k`-th derivative) of a curve collocation. */
export function curveRows(c: Collocation, k = 0): DesignRows {
  const { count, p1, nDer } = c;
  const idx = c.cols;
  const val = new Float64Array(count * p1);
  for (let r = 0; r < count; r++) {
    for (let j = 0; j < p1; j++) val[r * p1 + j] = c.vals[(r * (nDer + 1) + k) * p1 + j]!;
  }
  return { rows: count, K: p1, idx, val };
}

/**
 * Tensor-product rows for surface samples `r` with u- and v-collocations
 * taken at the same sample index: entry `(a, b)` is
 * `N_a^(du)(u_r) · M_b^(dv)(v_r)` at control point `cols_u[a] · nv + cols_v[b]`.
 */
export function surfaceRows(
  cu: Collocation,
  cv: Collocation,
  nv: number,
  du: number,
  dv: number,
): DesignRows {
  const rows = cu.count;
  const K = cu.p1 * cv.p1;
  const idx = new Int32Array(rows * K);
  const val = new Float64Array(rows * K);
  for (let r = 0; r < rows; r++) {
    let e = r * K;
    for (let a = 0; a < cu.p1; a++) {
      const na = cu.vals[(r * (cu.nDer + 1) + du) * cu.p1 + a]!;
      const ia = cu.cols[r * cu.p1 + a]! * nv;
      for (let b = 0; b < cv.p1; b++) {
        idx[e] = ia + cv.cols[r * cv.p1 + b]!;
        val[e] = na * cv.vals[(r * (cv.nDer + 1) + dv) * cv.p1 + b]!;
        e++;
      }
    }
  }
  return { rows, K, idx, val };
}

/** The half-bandwidth of `Aᵀ A` for rows `A`: the widest index spread of one row. */
export function rowBandwidth(d: DesignRows): number {
  let bw = 0;
  for (let r = 0; r < d.rows; r++) {
    let lo = d.idx[r * d.K]!;
    let hi = lo;
    for (let e = 1; e < d.K; e++) {
      const i = d.idx[r * d.K + e]!;
      if (i < lo) lo = i;
      if (i > hi) hi = i;
    }
    if (hi - lo > bw) bw = hi - lo;
  }
  return bw;
}
