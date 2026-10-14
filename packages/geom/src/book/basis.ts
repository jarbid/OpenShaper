// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Literal ports of P&T chapter 2 (The NURBS Book, 2nd ed.): span search and
 * B-spline basis functions with their derivatives. Internal: never re-exported.
 *
 * Notation is the book's: `p` degree, `n + 1` basis functions (so `n` is the
 * last index), `U` knot vector of `m + 1 = n + p + 2` knots, `i`/`span` the
 * knot span with `U[i] ≤ u < U[i+1]`. Work arrays are regions of one caller
 * `Float64Array` given by offsets (design §9: no per-call arrays); `left[j]` in
 * the book is `w[lo + j]` here, and so on. A periodic basis runs these
 * unchanged on a knot window (`book/periodic.ts`).
 *
 * The callers guarantee the preconditions: `u` inside `[U[p], U[n+1]]` and a
 * non-empty span. Nothing here validates or allocates (A2.4 excepted: oracle).
 */
import type { ReadonlyF64 } from '../types';

/**
 * A2.1 FindSpan: the span index `i ∈ [p, n]` with `U[i] ≤ u < U[i+1]` (the
 * right-hand limit), and the special case `u = U[n+1] ⇒ n` so the domain end
 * uses the last non-empty span. Binary search.
 */
export function findSpan(n: number, p: number, u: number, U: ReadonlyF64): number {
  if (u >= U[n + 1]!) return n; // Special case
  // Not in the book: a parameter at or below the domain start takes the first
  // span (non-empty for a valid basis), so out-of-domain input cannot loop.
  if (u <= U[p]!) return p;
  let low = p;
  let high = n + 1; // Do binary search
  let mid = (low + high) >> 1;
  while (u < U[mid]! || u >= U[mid + 1]!) {
    if (u < U[mid]!) high = mid;
    else low = mid;
    mid = (low + high) >> 1;
  }
  return mid;
}

/**
 * The left-hand mirror of A2.1 (not in the book): the span `i ∈ [p, n]` with
 * `U[i] < u ≤ U[i+1]`, used for one-sided derivatives at a knot. At the domain
 * start `u = U[p]` no left span exists and the first non-empty span is returned.
 */
export function findSpanLeft(n: number, p: number, u: number, U: ReadonlyF64): number {
  if (u <= U[p]!) return p;
  if (u >= U[n + 1]!) return n;
  let low = p;
  let high = n + 1;
  let mid = (low + high) >> 1;
  // Invariant: U[low] < u ≤ U[high].
  while (u <= U[mid]! || u > U[mid + 1]!) {
    if (u <= U[mid]!) high = mid;
    else low = mid;
    mid = (low + high) >> 1;
  }
  return mid;
}

/**
 * A2.2 BasisFuns: the p + 1 non-vanishing basis functions at `u` in span `i`,
 * `N[no + j] = N_{i−p+j, p}(u)`. `left[1..p]` and `right[1..p]` are the regions of
 * `w` at `lo` and `ro`.
 */
export function basisFuns(
  i: number,
  u: number,
  p: number,
  U: ReadonlyF64,
  N: Float64Array,
  no: number,
  w: Float64Array,
  lo: number,
  ro: number,
): void {
  N[no] = 1.0;
  for (let j = 1; j <= p; j++) {
    w[lo + j] = u - U[i + 1 - j]!;
    w[ro + j] = U[i + j]! - u;
    let saved = 0.0;
    for (let r = 0; r < j; r++) {
      const temp = N[no + r]! / (w[ro + r + 1]! + w[lo + j - r]!);
      N[no + r] = saved + w[ro + r + 1]! * temp;
      saved = w[lo + j - r]! * temp;
    }
    N[no + j] = saved;
  }
}

/**
 * A2.3 DersBasisFuns: basis functions and their derivatives up to order `nd`
 * at `u` in span `i`: `ders[k][j] = N^{(k)}_{i−p+j, p}(u)`, stored at
 * `D[do_ + k·(p+1) + j]`. Work regions in `w`: `left`, `right` (p + 1 each),
 * `ndu` ((p + 1)², row stride p + 1) and `a` (two rows of stride p + 1).
 *
 * The book assumes `nd ≤ p`; rows `k > p` are identically zero and are written
 * as zeros here (as in A3.2's `du = min(d, p)`), so any `nd` is valid.
 */
export function dersBasisFuns(
  i: number,
  u: number,
  p: number,
  nd: number,
  U: ReadonlyF64,
  D: Float64Array,
  do_: number,
  w: Float64Array,
  lo: number,
  ro: number,
  ndu: number,
  ao: number,
): void {
  const p1 = p + 1;
  const n = nd < p ? nd : p;
  w[ndu] = 1.0; // ndu[0][0]
  for (let j = 1; j <= p; j++) {
    w[lo + j] = u - U[i + 1 - j]!;
    w[ro + j] = U[i + j]! - u;
    let saved = 0.0;
    for (let r = 0; r < j; r++) {
      // Lower triangle
      w[ndu + j * p1 + r] = w[ro + r + 1]! + w[lo + j - r]!;
      const temp = w[ndu + r * p1 + j - 1]! / w[ndu + j * p1 + r]!;
      // Upper triangle
      w[ndu + r * p1 + j] = saved + w[ro + r + 1]! * temp;
      saved = w[lo + j - r]! * temp;
    }
    w[ndu + j * p1 + j] = saved;
  }
  for (let j = 0; j <= p; j++) D[do_ + j] = w[ndu + j * p1 + p]!; // Load the basis functions
  // This section computes the derivatives (Eq. [2.9])
  for (let r = 0; r <= p; r++) {
    // Loop over function index
    let s1 = 0;
    let s2 = 1; // Alternate rows in array a
    w[ao] = 1.0; // a[0][0]
    for (let k = 1; k <= n; k++) {
      // Loop to compute kth derivative
      let d = 0.0;
      const rk = r - k;
      const pk = p - k;
      if (r >= k) {
        w[ao + s2 * p1] = w[ao + s1 * p1]! / w[ndu + (pk + 1) * p1 + rk]!;
        d = w[ao + s2 * p1]! * w[ndu + rk * p1 + pk]!;
      }
      const j1 = rk >= -1 ? 1 : -rk;
      const j2 = r - 1 <= pk ? k - 1 : p - r;
      for (let j = j1; j <= j2; j++) {
        w[ao + s2 * p1 + j] =
          (w[ao + s1 * p1 + j]! - w[ao + s1 * p1 + j - 1]!) / w[ndu + (pk + 1) * p1 + rk + j]!;
        d += w[ao + s2 * p1 + j]! * w[ndu + (rk + j) * p1 + pk]!;
      }
      if (r <= pk) {
        w[ao + s2 * p1 + k] = -w[ao + s1 * p1 + k - 1]! / w[ndu + (pk + 1) * p1 + r]!;
        d += w[ao + s2 * p1 + k]! * w[ndu + r * p1 + pk]!;
      }
      D[do_ + k * p1 + r] = d;
      const j = s1; // Switch rows
      s1 = s2;
      s2 = j;
    }
  }
  // Multiply through by the correct factors (Eq. [2.9])
  let r = p;
  for (let k = 1; k <= n; k++) {
    for (let j = 0; j <= p; j++) D[do_ + k * p1 + j] = D[do_ + k * p1 + j]! * r;
    r *= p - k;
  }
  for (let k = n + 1; k <= nd; k++) for (let j = 0; j <= p; j++) D[do_ + k * p1 + j] = 0.0;
}

/**
 * A2.4 OneBasisFun: the single basis function `N_{i,p}(u)` on the knot vector
 * `U[0..m]` by the triangular Cox–de Boor table. An independent algorithm from
 * A2.2, used as the test oracle (`basisFunction`); allocates its table.
 */
export function oneBasisFun(
  p: number,
  m: number,
  U: ArrayLike<number>,
  i: number,
  u: number,
): number {
  // Special cases
  if ((i === 0 && u === U[0]) || (i === m - p - 1 && u === U[m])) return 1.0;
  // Local property
  if (u < U[i]! || u >= U[i + p + 1]!) return 0.0;
  const N = new Float64Array(p + 1);
  for (let j = 0; j <= p; j++) {
    // Initialize zeroth-degree functions
    N[j] = u >= U[i + j]! && u < U[i + j + 1]! ? 1.0 : 0.0;
  }
  for (let k = 1; k <= p; k++) {
    // Compute triangular table
    let saved = N[0] === 0.0 ? 0.0 : ((u - U[i]!) * N[0]!) / (U[i + k]! - U[i]!);
    for (let j = 0; j < p - k + 1; j++) {
      const Uleft = U[i + j + 1]!;
      const Uright = U[i + j + k + 1]!;
      if (N[j + 1] === 0.0) {
        N[j] = saved;
        saved = 0.0;
      } else {
        const temp = N[j + 1]! / (Uright - Uleft);
        N[j] = saved + (Uright - u) * temp;
        saved = (u - Uleft) * temp;
      }
    }
  }
  return N[0]!;
}
