// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Literal ports of P&T chapter 5 (knot insertion and refinement) on homogeneous
 * control points. Internal.
 *
 * F1 needs only A5.1, for `clampUnclamped`; step A1 adds A5.3–A5.9 here.
 */
import type { ReadonlyF64 } from '../types';

/**
 * A5.1 CurveKnotIns: inserts `u` `r` times into the curve `(UP, Pw)` with
 * `np + 1` control points of stride `h`. `k` is the span with
 * `UP[k] ≤ u < UP[k+1]`, `s` the multiplicity of `u` in `UP`, and `r + s ≤ p`.
 * Returns the new knots `UQ` (`np + p + r + 2`) and control points `Qw`
 * (`(np + r + 1) · h`). The curve is unchanged (P&T eq. 5.15).
 */
export function curveKnotIns(
  np: number,
  p: number,
  UP: ReadonlyF64,
  Pw: ReadonlyF64,
  h: number,
  u: number,
  k: number,
  s: number,
  r: number,
): { readonly UQ: Float64Array; readonly Qw: Float64Array } {
  const mp = np + p + 1;
  const nq = np + r;
  const UQ = new Float64Array(mp + r + 1);
  const Qw = new Float64Array((nq + 1) * h);
  const Rw = new Float64Array((p + 1) * h);
  // Load new knot vector
  for (let i = 0; i <= k; i++) UQ[i] = UP[i]!;
  for (let i = 1; i <= r; i++) UQ[k + i] = u;
  for (let i = k + 1; i <= mp; i++) UQ[i + r] = UP[i]!;
  // Save unaltered control points
  const copy = (dst: Float64Array, di: number, src: ReadonlyF64, si: number): void => {
    for (let c = 0; c < h; c++) dst[di * h + c] = src[si * h + c]!;
  };
  for (let i = 0; i <= k - p; i++) copy(Qw, i, Pw, i);
  for (let i = k - s; i <= np; i++) copy(Qw, i + r, Pw, i);
  for (let i = 0; i <= p - s; i++) copy(Rw, i, Pw, k - p + i);
  let L = k - p;
  for (let j = 1; j <= r; j++) {
    // Insert the knot r times
    L = k - p + j;
    for (let i = 0; i <= p - j - s; i++) {
      const alpha = (u - UP[L + i]!) / (UP[i + k + 1]! - UP[L + i]!);
      for (let c = 0; c < h; c++) {
        Rw[i * h + c] = alpha * Rw[(i + 1) * h + c]! + (1.0 - alpha) * Rw[i * h + c]!;
      }
    }
    copy(Qw, L, Rw, 0);
    copy(Qw, k + r - j - s, Rw, p - j - s);
  }
  // Load remaining control points
  for (let i = L + 1; i < k - s; i++) copy(Qw, i, Rw, i - L);
  return { UQ, Qw };
}
