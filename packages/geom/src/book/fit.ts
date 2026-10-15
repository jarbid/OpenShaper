// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Literal ports of P&T chapter 9's parameter and knot formulas (The NURBS
 * Book, 2nd ed.), on raw arrays. Internal: the validating API is in `fit/`.
 *
 * Notation is the book's: data `Q_0 … Q_n` (or `Q_0 … Q_m` for least squares)
 * of stride `r`, parameters `ub` (ū), degree `p`, knots `U`. Nothing here
 * validates; the callers guarantee sizes and finiteness.
 */
import type { ReadonlyF64 } from '../types';

/** Length of the chord `Q_a → Q_b` (stride `r`), with `Math.sqrt` (§9 kernel rules). */
function chord(Q: ArrayLike<number>, r: number, a: number, b: number): number {
  let s = 0;
  for (let c = 0; c < r; c++) {
    const d = Q[b * r + c]! - Q[a * r + c]!;
    s += d * d;
  }
  return Math.sqrt(s);
}

/**
 * The parameter increment for a chord of length `d` and exponent `e`:
 * `d^e`. Exponent 1 is the chord-length method (eq. 9.5), ½ the centripetal
 * method (eq. 9.6) and 0 equally spaced parameters (eq. 9.3). Those three
 * are computed exactly as written (`d`, `√d`, `1`) so the generalised
 * exponent reproduces them bit for bit.
 */
function increment(d: number, e: number): number {
  if (e === 1) return d;
  if (e === 0.5) return Math.sqrt(d);
  if (e === 0) return 1;
  return Math.pow(d, e);
}

/**
 * Eqs. 9.3–9.6, generalised to an exponent: `ū_0 = 0`, `ū_k = ū_{k−1} +
 * |Q_k − Q_{k−1}|^e / d`, `ū_n = 1`, where `d` is the sum of all increments.
 * `closed`: the chord `Q_n → Q_0` is part of the total, so `ū_n < 1` and the
 * period is 1. `count` points of stride `r` in `Q`; writes `count` values to
 * `ub`. Returns the total `d` (0 when every increment is 0).
 */
export function chordParams(
  Q: ArrayLike<number>,
  r: number,
  count: number,
  e: number,
  closed: boolean,
  ub: Float64Array,
): number {
  ub[0] = 0;
  let d = 0;
  for (let k = 1; k < count; k++) {
    d += increment(chord(Q, r, k - 1, k), e);
    ub[k] = d;
  }
  if (closed) d += increment(chord(Q, r, count - 1, 0), e);
  if (!(d > 0)) return 0;
  for (let k = 1; k < count; k++) ub[k] = ub[k]! / d;
  if (!closed) ub[count - 1] = 1;
  return d;
}

/**
 * Eq. 9.8, knots by averaging: for parameters `ub[0..n]` and degree `p`,
 * `u_0 = … = u_p = ū_0`, `u_{m−p} = … = u_m = ū_n` and
 * `u_{j+p} = (1/p) Σ_{i=j}^{j+p−1} ū_i`, `j = 1 … n − p`
 * (`m = n + p + 1`). With an end derivative (§9.2.2, eq. 9.22) the caller
 * repeats `ū_0` (or `ū_n`) once in `ub`, which gives the book's knots for
 * both ends and the same rule for one. Writes `n + p + 2` knots to `U`.
 */
export function averageKnots(ub: ReadonlyF64, n: number, p: number, U: Float64Array): void {
  const m = n + p + 1;
  for (let i = 0; i <= p; i++) {
    U[i] = ub[0]!;
    U[m - i] = ub[n]!;
  }
  for (let j = 1; j <= n - p; j++) {
    let s = 0;
    for (let i = j; i <= j + p - 1; i++) s += ub[i]!;
    U[j + p] = s / p;
  }
}

/**
 * `ū(s)` for a fractional index `s = num / den` (integers, `0 ≤ s`): the
 * parameters joined linearly in index, `ū(i + α) = (1 − α) ū_i + α ū_{i+1}`,
 * with `α` computed exactly from the integers. `m` parameters of a period
 * (`ū_{i+m} = ū_i + 1`) when `periodic`; otherwise `m + 1` parameters and
 * `s ≤ m`.
 */
function paramAt(ub: ReadonlyF64, m: number, num: number, den: number, periodic: boolean): number {
  const i = Math.floor(num / den);
  const r = num - i * den;
  const at = (k: number): number => (periodic && k >= m ? ub[k - m]! + 1 : ub[k]!);
  if (r === 0) return at(i);
  const alpha = r / den;
  return (1 - alpha) * at(i) + alpha * at(i + 1);
}

/**
 * Knots for least squares, eqs. 9.68–9.69 with the knots centred (a
 * modification of the book's rule): `m + 1` parameters `ub`, `n + 1` control
 * points (`p ≤ n ≤ m`), `h = m/n` and, for `j = 1 … n − p`,
 * `u_{p+j} = ū(h·(j + (p − 1)/2))`, where `ū(s)` joins the parameters linearly
 * in index (the book interpolates the same way). Ends clamped at `ū_0` and
 * `ū_m`. Writes `n + p + 2` knots to `U`.
 *
 * Why not eq. 9.69 as printed: it puts knot `j` at index `j·d − 1`
 * (`d = (m + 1)/(n − p + 1)`), so the knots lag towards the start, and as `n`
 * approaches `m` the first interior knot closes on `ū_0` (at `n = m` it sits
 * `p/(m − p + 1)` of a spacing away). The basis then becomes numerically
 * singular: for 40 centripetal parameters and `p = 3` the collocation matrix
 * has condition 1e2 at 30 control points, 1e7 at 37 and 1e18 at 40. Centred
 * positions are symmetric (`s_{n−p} = m − s_1`); the end spans are `h·(p + 1)/2`
 * indices long and the interior ones `h`, both at least one, so every knot
 * span (closed) still holds a parameter, the book's Schoenberg–Whitney
 * argument. At `n = m` the knots are the classic interpolation knots (data
 * sites for odd `p`, midpoints for even `p`). Measured over random and graded
 * parameter sets (`p = 1 … 5`, 8–60 parameters), the condition matches the
 * book's for `n < m/2` (median ratio 1) and is lower by 1–3 orders of
 * magnitude in the median above `0.6·m`; on strongly graded parameters a few
 * percent of cases come out up to 1e4 worse, against 1e9 better at the median
 * near `n = m`.
 */
export function approxKnots(
  ub: ReadonlyF64,
  m: number,
  n: number,
  p: number,
  U: Float64Array,
): void {
  for (let i = 0; i <= p; i++) {
    U[i] = ub[0]!;
    U[n + p + 1 - i] = ub[m]!;
  }
  // s_j = h·(j + (p − 1)/2) = m·(2j + p − 1) / (2n), kept as integers.
  for (let j = 1; j <= n - p; j++) U[p + j] = paramAt(ub, m, m * (2 * j + p - 1), 2 * n, false);
}

/**
 * The periodic analogue of eq. 9.8 (not in the book): for `n` parameters
 * `ū_0 < … < ū_{n−1}` of one period `[ū_0, ū_0 + 1)` (`ū_{i+n} = ū_i + 1`),
 * `τ_j = (1/p) Σ_{i=j}^{j+p−1} ū_i`, `j = 0 … n − 1`. For uniform parameters
 * this puts the knots at the data sites for odd `p` and midway between them
 * for even `p`, the classic choices that keep the cyclic collocation matrix
 * non-singular. Writes `n` increasing values to `T` with `τ_{n−1} < τ_0 + 1`.
 */
export function averageKnotsPeriodic(ub: ReadonlyF64, n: number, p: number, T: Float64Array): void {
  for (let j = 0; j < n; j++) {
    let s = 0;
    for (let i = j; i <= j + p - 1; i++) s += i < n ? ub[i]! : ub[i - n]! + 1;
    T[j] = s / p;
  }
}

/**
 * The periodic analogue of {@link approxKnots} (not in the book): `m`
 * parameters `ū_0 ≤ … ≤ ū_{m−1}` of one period (`ū_{i+m} = ū_i + 1`), `n ≤ m`
 * unique control points of degree `p`, `h = m/n` and, for `j = 0 … n − 1`,
 * `τ_j = ū(h·(j + (p − 1)/2))`. Every span (`h ≥ 1` indices) holds a
 * parameter. The offset `(p − 1)/2` is what makes `n = m` work: there the
 * knots fall on the data sites for odd `p` and midway between them for even
 * `p`, as {@link averageKnotsPeriodic} does for uniform parameters; without it
 * an even degree puts every knot on a data site and the cyclic system is
 * singular. `τ_0 ≠ ū_0` in general: the caller shifts knots and parameters.
 */
export function approxKnotsPeriodic(
  ub: ReadonlyF64,
  m: number,
  n: number,
  p: number,
  T: Float64Array,
): void {
  for (let j = 0; j < n; j++) T[j] = paramAt(ub, m, m * (2 * j + p - 1), 2 * n, true);
}

/**
 * A9.3 SurfMeshParams, generalised to the exponent of {@link chordParams} and
 * to a closed direction: the parameters of a `rows × cols` grid (u-major,
 * stride 3, point `(k, l)` at `(k·cols + l)·3`) along `dir`. For each line of
 * the other direction the line's parameters are computed; lines whose total
 * is 0 (a collapsed edge or pole) are skipped, as in the book; the result is
 * their average. Returns the number of lines used (0: every line collapsed).
 */
export function surfMeshParams(
  Q: ArrayLike<number>,
  rows: number,
  cols: number,
  dir: 'u' | 'v',
  e: number,
  closed: boolean,
  ub: Float64Array,
): number {
  const len = dir === 'u' ? rows : cols;
  const lines = dir === 'u' ? cols : rows;
  const line = new Float64Array(3 * len);
  const cds = new Float64Array(len);
  ub.fill(0, 0, len);
  let num = 0;
  for (let l = 0; l < lines; l++) {
    for (let k = 0; k < len; k++) {
      const at = dir === 'u' ? (k * cols + l) * 3 : (l * cols + k) * 3;
      line[3 * k] = Q[at]!;
      line[3 * k + 1] = Q[at + 1]!;
      line[3 * k + 2] = Q[at + 2]!;
    }
    if (chordParams(line, 3, len, e, closed, cds) === 0) continue;
    num++;
    for (let k = 1; k < len; k++) ub[k] = ub[k]! + cds[k]!;
  }
  if (num === 0) return 0;
  for (let k = 1; k < len; k++) ub[k] = ub[k]! / num;
  if (!closed) ub[len - 1] = 1;
  return num;
}
