// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The cubic B-spline basis of the blended section (docs/design/m1-model.md §2),
 * allocation-free and specialised to degree 3 with derivatives to order 2
 * (P&T A2.2/A2.3). The knot vector is clamped on [0, 1].
 */

/** Basis values and derivatives of one span: `out[4·k + j]` = k-th derivative of function `j`, k = 0..2. */
export const BASIS_SIZE = 12;

/**
 * The span of `t`: the last `i` with `knots[i] ≤ t` (the first with `t ≤ knots[i + 1]` when `left`),
 * within `[3, count − 1]`. A clamped end is its own span.
 */
export function spanOfKnots(knots: Float64Array, count: number, t: number, left: boolean): number {
  if (t >= knots[count]!) return count - 1;
  if (t <= knots[3]!) return 3;
  let lo = 3;
  let hi = count;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (knots[mid]! <= t) lo = mid;
    else hi = mid;
  }
  if (left && knots[lo] === t) {
    while (lo > 3 && knots[lo - 1] === t) lo--;
    if (lo > 3) lo--;
  }
  return lo;
}

const ndu = new Float64Array(16);
const left = new Float64Array(4);
const right = new Float64Array(4);
const a = new Float64Array(8);

/** A2.3 for degree 3, orders 0 to `nDer` (≤ 2), into `out[0 … 4·(nDer + 1))`. */
export function basisDers(
  knots: Float64Array,
  span: number,
  t: number,
  nDer: number,
  out: Float64Array,
): void {
  ndu[0] = 1;
  for (let j = 1; j <= 3; j++) {
    left[j] = t - knots[span + 1 - j]!;
    right[j] = knots[span + j]! - t;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      ndu[4 * j + r] = right[r + 1]! + left[j - r]!;
      const temp = ndu[4 * r + j - 1]! / ndu[4 * j + r]!;
      ndu[4 * r + j] = saved + right[r + 1]! * temp;
      saved = left[j - r]! * temp;
    }
    ndu[4 * j + j] = saved;
  }
  for (let j = 0; j <= 3; j++) out[j] = ndu[4 * j + 3]!;
  for (let r = 0; r <= 3; r++) {
    let s1 = 0;
    let s2 = 1;
    a[0] = 1;
    for (let k = 1; k <= nDer; k++) {
      let d = 0;
      const rk = r - k;
      const pk = 3 - k;
      if (r >= k) {
        a[4 * s2] = a[4 * s1]! / ndu[4 * (pk + 1) + rk]!;
        d = a[4 * s2]! * ndu[4 * rk + pk]!;
      }
      const j1 = rk >= -1 ? 1 : -rk;
      const j2 = r - 1 <= pk ? k - 1 : 3 - r;
      for (let j = j1; j <= j2; j++) {
        a[4 * s2 + j] = (a[4 * s1 + j]! - a[4 * s1 + j - 1]!) / ndu[4 * (pk + 1) + rk + j]!;
        d += a[4 * s2 + j]! * ndu[4 * (rk + j) + pk]!;
      }
      if (r <= pk) {
        a[4 * s2 + k] = -a[4 * s1 + k - 1]! / ndu[4 * (pk + 1) + r]!;
        d += a[4 * s2 + k]! * ndu[4 * r + pk]!;
      }
      out[4 * k + r] = d;
      const tmp = s1;
      s1 = s2;
      s2 = tmp;
    }
  }
  // multiply by the factorial factors p!/(p - k)!
  let f = 3;
  for (let k = 1; k <= nDer; k++) {
    for (let j = 0; j <= 3; j++) out[4 * k + j] = out[4 * k + j]! * f;
    f *= 3 - k;
  }
}
