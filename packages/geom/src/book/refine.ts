// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Literal ports of P&T chapter 5 (fundamental geometric algorithms) on
 * homogeneous control points. Internal: never re-exported.
 *
 * Notation is the book's: `p` degree, `n + 1` control points (so `n` is the
 * last index), `U` the knot vector of `m + 1 = n + p + 2` knots, `Pw` the
 * homogeneous control points. A "point" here is any vector of `h` doubles: a
 * curve's `[w·x, …, w]` (`h = dim + 1`), or a whole row of a surface net
 * (`h = 4 · count` of the other direction). Applied to rows, A5.1 is A5.3
 * (its alphas are computed once per row and applied across the row), A5.4 is
 * A5.5 and A5.9 is the row-wise surface elevation, so surfaces reuse these
 * ports unchanged (design §3, "row/column form").
 *
 * Every function returns new arrays and never writes its inputs. Callers
 * guarantee the preconditions stated per function (parameters inside the
 * domain, multiplicities within the degree); nothing here validates.
 *
 * - A5.1 CurveKnotIns ({@link curveKnotIns}), and its use at both ends of an
 *   unclamped knot vector ({@link clampKnots}, for `clampUnclamped` and the
 *   periodic windows of `book/periodic.ts`), and the cut of a curve between
 *   two full-multiplicity knots ({@link sliceKnots}: splitting, P&T §5.2);
 * - A5.4 RefineKnotVectCurve ({@link refineKnotVectCurve});
 * - A5.6 DecomposeCurve ({@link decomposeCurve});
 * - A5.8 RemoveCurveKnot ({@link removeCurveKnot});
 * - A5.9 DegreeElevateCurve ({@link degreeElevateCurve}).
 */
import type { ReadonlyF64 } from '../types';
import { findSpan } from './basis';

/** Copies point `si` of `src` to point `di` of `dst` (stride `h`). */
function copyPt(dst: Float64Array, di: number, src: ReadonlyF64, si: number, h: number): void {
  for (let c = 0; c < h; c++) dst[di * h + c] = src[si * h + c]!;
}

/** Last index of the run of knots equal to `U[i]`. */
export function runEnd(U: ReadonlyF64, i: number): number {
  let j = i;
  while (j + 1 < U.length && U[j + 1] === U[i]) j++;
  return j;
}

/** First index of the run of knots equal to `U[i]`. */
export function runStart(U: ReadonlyF64, i: number): number {
  let j = i;
  while (j > 0 && U[j - 1] === U[i]) j--;
  return j;
}

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

/**
 * Clamps an unclamped (or already clamped) knot vector exactly on its domain
 * `[U[p], U[n+1]]`: each domain end is inserted with A5.1 until its
 * multiplicity reaches `p`, then the knots and control points whose basis
 * functions do not reach the domain are dropped. The outermost kept knot of
 * each end lies outside every remaining support on the domain, so it is set to
 * the end value exactly. Preconditions: non-decreasing knots, end runs of
 * multiplicity ≤ `p + 1`, a non-empty domain.
 */
export function clampKnots(
  p: number,
  U0: ReadonlyF64,
  Pw0: ReadonlyF64,
  h: number,
): { readonly U: Float64Array; readonly Pw: Float64Array } {
  let U: ReadonlyF64 = U0;
  let Pw: ReadonlyF64 = Pw0;
  let n = U.length - p - 2;
  const a = U[p]!;
  // Clamp the start: insert a until its multiplicity is p.
  let k = runEnd(U, p);
  let s = k - runStart(U, p) + 1;
  if (s < p) {
    const ins = curveKnotIns(n, p, U, Pw, h, a, k, s, p - s);
    U = ins.UQ;
    Pw = ins.Qw;
    n += p - s;
    k += p - s;
  }
  const L = k; // last index of the a-run, now of multiplicity ≥ p
  // Clamp the end: insert b until its multiplicity is p. The new knots go after
  // the b-run's first index F, which therefore stays put.
  const F = runStart(U, n + 1);
  const b = U[F]!;
  const bEnd = runEnd(U, F);
  s = bEnd - F + 1;
  if (s < p) {
    const ins = curveKnotIns(n, p, U, Pw, h, b, bEnd, s, p - s);
    U = ins.UQ;
    Pw = ins.Qw;
    n += p - s;
  }
  return sliceKnots(p, U, Pw, h, L, F);
}

/**
 * The clamped curve on `[U[L], U[F]]` cut out of a curve whose knot `U[L]`
 * (last index of its run) and `U[F]` (first index of its run) both have
 * multiplicity ≥ `p`: knots `L − p … F + p` and control points `L − p … F − 1`,
 * the only ones whose basis functions reach `[U[L], U[F]]`. The outermost kept
 * knot of each end lies outside every remaining support on that range, so it
 * is set to the end value exactly (P&T §5.2: the curve is split by inserting a
 * knot `p` times).
 */
export function sliceKnots(
  p: number,
  U: ReadonlyF64,
  Pw: ReadonlyF64,
  h: number,
  L: number,
  F: number,
): { readonly U: Float64Array; readonly Pw: Float64Array } {
  const first = L - p;
  const last = F - 1;
  const knots = (U as Float64Array).slice(first, F + p + 1);
  knots[0] = U[L]!;
  knots[knots.length - 1] = U[F]!;
  return { U: knots, Pw: (Pw as Float64Array).slice(first * h, (last + 1) * h) };
}

/**
 * A5.4 RefineKnotVectCurve: inserts the non-decreasing knots `X[0..r]` into
 * the curve `(U, Pw)` in one pass. Precondition: every `X[j]` lies strictly
 * inside the domain `(U[p], U[n+1])` and the resulting multiplicities are at
 * most `p`. Returns `Ubar` (`m + r + 2` knots) and `Qw` (`n + r + 2` points).
 * The curve is unchanged (P&T eq. 5.15 applied repeatedly).
 */
export function refineKnotVectCurve(
  n: number,
  p: number,
  U: ReadonlyF64,
  Pw: ReadonlyF64,
  h: number,
  X: ArrayLike<number>,
): { readonly Ubar: Float64Array; readonly Qw: Float64Array } {
  const r = X.length - 1;
  const m = n + p + 1;
  const Ubar = new Float64Array(m + r + 2);
  const Qw = new Float64Array((n + r + 2) * h);
  if (r < 0) {
    Ubar.set(U as Float64Array);
    Qw.set(Pw as Float64Array);
    return { Ubar, Qw };
  }
  const a = findSpan(n, p, X[0]!, U);
  let b = findSpan(n, p, X[r]!, U);
  b = b + 1;
  for (let j = 0; j <= a - p; j++) copyPt(Qw, j, Pw, j, h);
  for (let j = b - 1; j <= n; j++) copyPt(Qw, j + r + 1, Pw, j, h);
  for (let j = 0; j <= a; j++) Ubar[j] = U[j]!;
  for (let j = b + p; j <= m; j++) Ubar[j + r + 1] = U[j]!;
  let i = b + p - 1;
  let k = b + p + r;
  for (let j = r; j >= 0; j--) {
    while (X[j]! <= U[i]! && i > a) {
      copyPt(Qw, k - p - 1, Pw, i - p - 1, h);
      Ubar[k] = U[i]!;
      k = k - 1;
      i = i - 1;
    }
    copyPt(Qw, k - p - 1, Qw, k - p, h);
    for (let l = 1; l <= p; l++) {
      const ind = k - p + l;
      let alfa = Ubar[k + l]! - X[j]!;
      if (Math.abs(alfa) === 0.0) copyPt(Qw, ind - 1, Qw, ind, h);
      else {
        alfa = alfa / (Ubar[k + l]! - U[i - p + l]!);
        for (let c = 0; c < h; c++) {
          Qw[(ind - 1) * h + c] = alfa * Qw[(ind - 1) * h + c]! + (1.0 - alfa) * Qw[ind * h + c]!;
        }
      }
    }
    Ubar[k] = X[j]!;
    k = k - 1;
  }
  return { Ubar, Qw };
}

/**
 * A5.6 DecomposeCurve: the Bézier segments of a clamped curve, one per
 * non-empty knot span. `Qw` holds `nb` segments of `p + 1` points each
 * (segment `s`, point `i` at `(s·(p + 1) + i)·h`); segment `s` spans
 * `[breaks[s], breaks[s + 1]]`.
 */
export function decomposeCurve(
  n: number,
  p: number,
  U: ReadonlyF64,
  Pw: ReadonlyF64,
  h: number,
): { readonly nb: number; readonly Qw: Float64Array; readonly breaks: Float64Array } {
  const m = n + p + 1;
  const maxSeg = n - p + 1;
  // One spare segment: the book writes the next segment's first points
  // (`Qw[nb+1][save]`) before it knows whether there is one.
  const Qw = new Float64Array((maxSeg + 1) * (p + 1) * h);
  const breaks = new Float64Array(maxSeg + 1);
  const alphas = new Float64Array(p);
  const seg = (sg: number, i: number): number => (sg * (p + 1) + i) * h;
  let a = p;
  let b = p + 1;
  let nb = 0;
  breaks[0] = U[p]!;
  for (let i = 0; i <= p; i++) for (let c = 0; c < h; c++) Qw[seg(nb, i) + c] = Pw[i * h + c]!;
  while (b < m) {
    const i0 = b;
    while (b < m && U[b + 1] === U[b]) b++;
    const mult = b - i0 + 1;
    if (mult < p) {
      const numer = U[b]! - U[a]!; // Numerator of alpha
      // Compute and store alphas
      for (let j = p; j > mult; j--) alphas[j - mult - 1] = numer / (U[a + j]! - U[a]!);
      const r = p - mult; // Insert knot r times
      for (let j = 1; j <= r; j++) {
        const save = r - j;
        const s = mult + j; // This many new points
        for (let k = p; k >= s; k--) {
          const alpha = alphas[k - s]!;
          const q = seg(nb, k);
          const q1 = seg(nb, k - 1);
          for (let c = 0; c < h; c++) Qw[q + c] = alpha * Qw[q + c]! + (1.0 - alpha) * Qw[q1 + c]!;
        }
        if (b < m) {
          // Control point of next segment
          const d = seg(nb + 1, save);
          const q = seg(nb, p);
          for (let c = 0; c < h; c++) Qw[d + c] = Qw[q + c]!;
        }
      }
    }
    nb = nb + 1; // Bezier segment completed
    breaks[nb] = U[b]!;
    if (b < m) {
      // Initialize for next segment
      for (let i = p - mult; i <= p; i++) {
        for (let c = 0; c < h; c++) Qw[seg(nb, i) + c] = Pw[(b - p + i) * h + c]!;
      }
      a = b;
      b = b + 1;
    }
  }
  return {
    nb,
    Qw: Qw.slice(0, nb * (p + 1) * h),
    breaks: breaks.slice(0, nb + 1),
  };
}

/** Euclidean distance between point `i` of `A` and point `j` of `B` (stride `h`): P&T's Distance4D. */
function distance(A: ReadonlyF64, i: number, B: ReadonlyF64, j: number, h: number): number {
  let d2 = 0;
  for (let c = 0; c < h; c++) {
    const e = A[i * h + c]! - B[j * h + c]!;
    d2 += e * e;
  }
  return Math.sqrt(d2);
}

/**
 * A5.8 RemoveCurveKnot: removes the interior knot `u = U[r]` (last index of
 * its run, multiplicity `s`) up to `num ≤ s` times, stopping at the first
 * removal whose check distance (P&T eq. 5.28/5.29 in homogeneous space)
 * exceeds `TOL`. Returns the number removed `t` and the new knots and points.
 * Precondition: `p + s ≤ r ≤ n` (an interior knot), `TOL ≥ 0`.
 */
export function removeCurveKnot(
  n: number,
  p: number,
  U0: ReadonlyF64,
  Pw0: ReadonlyF64,
  h: number,
  u: number,
  r: number,
  s: number,
  num: number,
  TOL: number,
): { readonly t: number; readonly U: Float64Array; readonly Pw: Float64Array } {
  const U = Float64Array.from(U0 as Float64Array);
  const Pw = Float64Array.from(Pw0 as Float64Array);
  const m = n + p + 1;
  const ord = p + 1;
  const fout = (2 * r - s - p) >> 1; // First control point out
  let last = r - s;
  let first = r - p;
  // temp spans first − 1 … last + 1, which grows by 2 per removal (≤ p + s + 2 points).
  const temp = new Float64Array((2 * p + 3) * h);
  let t = 0;
  for (t = 0; t < num; t++) {
    // This loop is Eq. (5.28)
    const off = first - 1; // Diff in index between temp and P
    copyPt(temp, 0, Pw, off, h);
    copyPt(temp, last + 1 - off, Pw, last + 1, h);
    let i = first;
    let j = last;
    let ii = 1;
    let jj = last - off;
    let remflag = false;
    while (j - i > t) {
      // Compute new control points for one removal step
      const alfi = (u - U[i]!) / (U[i + ord + t]! - U[i]!);
      const alfj = (u - U[j - t]!) / (U[j + ord]! - U[j - t]!);
      for (let c = 0; c < h; c++) {
        temp[ii * h + c] = (Pw[i * h + c]! - (1.0 - alfi) * temp[(ii - 1) * h + c]!) / alfi;
        temp[jj * h + c] = (Pw[j * h + c]! - alfj * temp[(jj + 1) * h + c]!) / (1.0 - alfj);
      }
      i = i + 1;
      ii = ii + 1;
      j = j - 1;
      jj = jj - 1;
    }
    if (j - i < t) {
      // Check if knot removable
      if (distance(temp, ii - 1, temp, jj + 1, h) <= TOL) remflag = true;
    } else {
      const alfi = (u - U[i]!) / (U[i + ord + t]! - U[i]!);
      let d2 = 0;
      for (let c = 0; c < h; c++) {
        const e =
          Pw[i * h + c]! -
          (alfi * temp[(ii + t + 1) * h + c]! + (1.0 - alfi) * temp[(ii - 1) * h + c]!);
        d2 += e * e;
      }
      if (Math.sqrt(d2) <= TOL) remflag = true;
    }
    if (!remflag) break; // Cannot remove any more knots
    // Successful removal. Save new cont. pts.
    i = first;
    j = last;
    while (j - i > t) {
      copyPt(Pw, i, temp, i - off, h);
      copyPt(Pw, j, temp, j - off, h);
      i = i + 1;
      j = j - 1;
    }
    first = first - 1;
    last = last + 1;
  }
  if (t === 0) return { t, U, Pw };
  for (let k = r + 1; k <= m; k++) U[k - t] = U[k]!; // Shift knots
  let j = fout;
  let i = j; // Pj thru Pi will be overwritten
  for (let k = 1; k < t; k++) {
    if (k % 2 === 1) i = i + 1;
    else j = j - 1;
  }
  for (let k = i + 1; k <= n; k++) {
    // Shift
    copyPt(Pw, j, Pw, k, h);
    j = j + 1;
  }
  return { t, U: U.slice(0, m + 1 - t), Pw: Pw.slice(0, (n + 1 - t) * h) };
}

/** Binomial coefficient `C(a, b)` (exact in doubles for the degrees used). */
function bin(a: number, b: number): number {
  let r = 1;
  for (let k = 1; k <= b; k++) r = (r * (a - b + k)) / k;
  return r;
}

/**
 * A5.9 DegreeElevateCurve: the same curve with degree `p + t`. Each distinct
 * knot's multiplicity grows by `t`; the curve is decomposed into Bézier
 * segments on the fly (A5.6), each is elevated (eq. 5.36), and the unneeded
 * knots are removed again. Returns `nh` (last new index), `Uh` and `Qw`.
 */
export function degreeElevateCurve(
  n: number,
  p: number,
  U: ReadonlyF64,
  Pw: ReadonlyF64,
  h: number,
  t: number,
): { readonly nh: number; readonly Uh: Float64Array; readonly Qw: Float64Array } {
  const m = n + p + 1;
  const ph = p + t;
  const ph2 = ph >> 1;
  const P1 = p + 1;
  // Compute Bezier degree elevation coefficients
  const bezalfs = new Float64Array((ph + 1) * P1);
  bezalfs[0] = 1.0;
  bezalfs[ph * P1 + p] = 1.0;
  for (let i = 1; i <= ph2; i++) {
    const inv = 1.0 / bin(ph, i);
    const mpi = Math.min(p, i);
    for (let j = Math.max(0, i - t); j <= mpi; j++) {
      bezalfs[i * P1 + j] = inv * bin(p, j) * bin(t, i - j);
    }
  }
  for (let i = ph2 + 1; i <= ph - 1; i++) {
    const mpi = Math.min(p, i);
    for (let j = Math.max(0, i - t); j <= mpi; j++) {
      bezalfs[i * P1 + j] = bezalfs[(ph - i) * P1 + p - j]!;
    }
  }
  // Output sizes: every distinct interior knot and the curve itself gain t points.
  let distinct = 0;
  for (let i = p + 1; i <= n; i++) if (U[i] !== U[i - 1]) distinct++;
  const count = n + 1 + t * (distinct + 1);
  const Uh = new Float64Array(count + ph + 1);
  const Qw = new Float64Array(count * h);
  const bpts = new Float64Array(P1 * h);
  const ebpts = new Float64Array((ph + 1) * h);
  const Nextbpts = new Float64Array(Math.max(p - 1, 1) * h);
  const alfs = new Float64Array(Math.max(p - 1, 1));
  let mh = ph;
  let kind = ph + 1;
  let r = -1;
  let a = p;
  let b = p + 1;
  let cind = 1;
  let ua = U[0]!;
  copyPt(Qw, 0, Pw, 0, h);
  for (let i = 0; i <= ph; i++) Uh[i] = ua;
  // Initialize first Bezier seg
  for (let i = 0; i <= p; i++) copyPt(bpts, i, Pw, i, h);
  while (b < m) {
    // Big loop thru knot vector
    let i = b;
    while (b < m && U[b] === U[b + 1]) b = b + 1;
    const mul = b - i + 1;
    mh = mh + mul + t;
    const ub = U[b]!;
    const oldr = r;
    r = p - mul;
    // Insert knot u(b) r times
    const lbz = oldr > 0 ? (oldr + 2) >> 1 : 1;
    const rbz = r > 0 ? ph - ((r + 1) >> 1) : ph;
    if (r > 0) {
      // Insert knot to get Bezier segment
      const numer = ub - ua;
      for (let k = p; k > mul; k--) alfs[k - mul - 1] = numer / (U[a + k]! - ua);
      for (let j = 1; j <= r; j++) {
        const save = r - j;
        const s = mul + j;
        for (let k = p; k >= s; k--) {
          const al = alfs[k - s]!;
          for (let c = 0; c < h; c++) {
            bpts[k * h + c] = al * bpts[k * h + c]! + (1.0 - al) * bpts[(k - 1) * h + c]!;
          }
        }
        copyPt(Nextbpts, save, bpts, p, h);
      }
    } // End of "insert knot"
    for (i = lbz; i <= ph; i++) {
      // Degree elevate Bezier; only points lbz,...,ph are used below
      for (let c = 0; c < h; c++) ebpts[i * h + c] = 0.0;
      const mpi = Math.min(p, i);
      for (let j = Math.max(0, i - t); j <= mpi; j++) {
        const ba = bezalfs[i * P1 + j]!;
        for (let c = 0; c < h; c++) ebpts[i * h + c] = ebpts[i * h + c]! + ba * bpts[j * h + c]!;
      }
    } // End of degree elevating Bezier
    if (oldr > 1) {
      // Must remove knot u=U[a] oldr times
      let first = kind - 2;
      let last = kind;
      const den = ub - ua;
      const bet = (ub - Uh[kind - 1]!) / den;
      for (let tr = 1; tr < oldr; tr++) {
        // Knot removal loop
        i = first;
        let j = last;
        let kj = j - kind + 1;
        while (j - i > tr) {
          // Loop and compute the new control points for one removal step
          if (i < cind) {
            const alf = (ub - Uh[i]!) / (ua - Uh[i]!);
            for (let c = 0; c < h; c++) {
              Qw[i * h + c] = alf * Qw[i * h + c]! + (1.0 - alf) * Qw[(i - 1) * h + c]!;
            }
          }
          if (j >= lbz) {
            if (j - tr <= kind - ph + oldr) {
              const gam = (ub - Uh[j - tr]!) / den;
              for (let c = 0; c < h; c++) {
                ebpts[kj * h + c] =
                  gam * ebpts[kj * h + c]! + (1.0 - gam) * ebpts[(kj + 1) * h + c]!;
              }
            } else {
              for (let c = 0; c < h; c++) {
                ebpts[kj * h + c] =
                  bet * ebpts[kj * h + c]! + (1.0 - bet) * ebpts[(kj + 1) * h + c]!;
              }
            }
          }
          i = i + 1;
          j = j - 1;
          kj = kj - 1;
        }
        first = first - 1;
        last = last + 1;
      }
    } // End of removing knot, u=U[a]
    if (a !== p) {
      // Load the knot ua
      for (i = 0; i < ph - oldr; i++) {
        Uh[kind] = ua;
        kind = kind + 1;
      }
    }
    for (let j = lbz; j <= rbz; j++) {
      // Load ctrl pts into Qw
      copyPt(Qw, cind, ebpts, j, h);
      cind = cind + 1;
    }
    if (b < m) {
      // Set up for next pass thru loop
      for (let j = 0; j < r; j++) copyPt(bpts, j, Nextbpts, j, h);
      for (let j = r; j <= p; j++) copyPt(bpts, j, Pw, b - p + j, h);
      a = b;
      b = b + 1;
      ua = ub;
    } else {
      // End knot
      for (i = 0; i <= ph; i++) Uh[kind + i] = ub;
    }
  } // End of while-loop (b < m)
  const nh = mh - ph - 1;
  return { nh, Uh, Qw };
}
