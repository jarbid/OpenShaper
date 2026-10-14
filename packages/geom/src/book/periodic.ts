// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Periodic bases on top of the clamped book code (design §4.4, §11.1).
 * Internal: the only module that knows how a periodic basis is laid out.
 *
 * A periodic basis stores one period of knots `t_0 ≤ … ≤ t_{n−1} < t_0 + T`;
 * the bi-infinite sequence is `t_{i + k·n} = t_i + k·T`, and basis function `i`
 * multiplies control point `i mod n`. Evaluation (§11.1):
 *
 * 1. wrap the parameter into `[t_0, t_0 + T)`;
 * 2. find the span `k` in the one-period list;
 * 3. build the local knot window `t_{k−p+1} … t_{k+p}` (O(p));
 * 4. gather control points `(k − p … k) mod n`;
 * 5. run A2.2 / A2.3 and A3.2 unchanged on the window, with span index `p − 1`
 *    relative to the window start.
 *
 * `n ≥ p + 1` keeps every window index within one period of the stored list.
 */
import type { ReadonlyF64 } from '../types';

/**
 * Wraps `t` into `[t0, t0 + T)`: `t0 + ((t − t0) mod T)`. A parameter already in
 * the period is returned unchanged (bitwise); `t0 + T` maps exactly to `t0`, and
 * so does a result that rounds up to `t0 + T`. A non-finite `t` maps to `t0`,
 * so kernels stay finite on any input.
 */
export function wrapParam(t0: number, T: number, t: number): number {
  const end = t0 + T;
  if (t >= t0 && t < end) return t;
  let r = (t - t0) % T;
  if (r < 0) r += T;
  if (!(r < T)) r = 0; // r = T after rounding, or NaN
  const w = t0 + r;
  return w < end ? w : t0;
}

/** Right-hand span: the largest `k ∈ [0, n)` with `U[k] ≤ t`, for `t ∈ [U[0], U[0] + T)`. */
export function periodicSpan(U: ReadonlyF64, n: number, t: number): number {
  let lo = 0;
  let hi = n; // U[lo] ≤ t and (hi = n or U[hi] > t)
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (U[mid]! <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Left-hand span: the largest `k` with `U[k] < t`, or `−1` when `t ≤ U[0]`; the
 * caller then evaluates span `n − 1` at `t + T` (the previous period's end).
 */
export function periodicSpanLeft(U: ReadonlyF64, n: number, t: number): number {
  if (!(t > U[0]!)) return -1;
  let lo = 0;
  let hi = n; // U[lo] < t and (hi = n or U[hi] ≥ t)
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (U[mid]! < t) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Writes the window `t_{k−p+1} … t_{k+p}` (2p knots) to `W[wo …]`. A2.2 / A2.3
 * then run on `W` with span index `wo + p − 1`: they read `U[i+1−j]` and `U[i+j]`
 * for `j = 1..p`, which are exactly the window.
 */
export function knotWindow(
  U: ReadonlyF64,
  n: number,
  T: number,
  k: number,
  p: number,
  W: Float64Array,
  wo: number,
): void {
  for (let j = 0; j < 2 * p; j++) {
    const idx = k - p + 1 + j;
    W[wo + j] = idx < 0 ? U[idx + n]! - T : idx >= n ? U[idx - n]! + T : U[idx]!;
  }
}

/**
 * Gathers the homogeneous control points `(k − p … k) mod n` (stride `h`) into
 * `P[po …]`, so A3.2 reads them contiguously.
 */
export function gatherPoints(
  cw: ReadonlyF64,
  n: number,
  h: number,
  k: number,
  p: number,
  P: Float64Array,
  po: number,
): void {
  for (let j = 0; j <= p; j++) {
    let idx = k - p + j;
    if (idx < 0) idx += n;
    const src = idx * h;
    const dst = po + j * h;
    for (let c = 0; c < h; c++) P[dst + c] = cw[src + c]!;
  }
}
