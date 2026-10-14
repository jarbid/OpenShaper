// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Bases: validated knot vectors, knot generators, span search and basis
 * function kernels (design §4.3, §6.2).
 *
 * A {@link Basis} is created only by {@link clampedBasis} or
 * {@link periodicBasis}, which validate fully and freeze the record. Curves and
 * surfaces share bases by reference, so `===` on a basis is a cheap validity key
 * for cached plans.
 *
 * Domains are never normalised implicitly (decision 10): the caller's knots are
 * kept as given.
 */
import { scratchFor } from './array';
import type { Scratch, ScratchImpl } from './array';
import { basisFuns, dersBasisFuns, findSpan as a21, findSpanLeft, oneBasisFun } from './book/basis';
import { knotWindow, periodicSpan, periodicSpanLeft, wrapParam } from './book/periodic';
import { fail } from './errors';
import { resolveTolerances } from './tolerance';
import type { Tolerances } from './tolerance';
import type { Basis, ClampedBasis, Interval, PeriodicBasis, ReadonlyF64, Side } from './types';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function checkDegree(degree: number): void {
  if (!Number.isInteger(degree) || degree < 1) {
    fail('invalid-degree', `degree must be an integer ≥ 1; got ${degree}`, { value: degree });
  }
}

function checkFiniteKnots(knots: ArrayLike<number>): Float64Array {
  const U = new Float64Array(knots.length);
  for (let i = 0; i < knots.length; i++) {
    const x = knots[i]!;
    if (!Number.isFinite(x))
      fail('non-finite', `knot ${i} is not finite: ${x}`, { index: i, value: x });
    U[i] = x;
  }
  return U;
}

function checkNonDecreasing(U: Float64Array): void {
  for (let i = 1; i < U.length; i++) {
    if (U[i]! < U[i - 1]!) {
      fail(
        'knots-decreasing',
        `knots must be non-decreasing; knot ${i} = ${U[i]} < knot ${i - 1} = ${U[i - 1]}`,
        {
          index: i,
          value: U[i],
        },
      );
    }
  }
}

/**
 * Rejects distinct knots closer than `knotRel · length` (design §4.3). `gapAfter`
 * also checks the gap from the last knot to `end` (a periodic list's `t_0 + T`).
 */
function checkNearCoincident(U: Float64Array, length: number, t: Tolerances, end?: number): void {
  const min = t.knotRel * length;
  const check = (i: number, a: number, b: number): void => {
    if (b > a && b - a < min) {
      fail(
        'knots-near-coincident',
        `knots ${a} and ${b} are distinct but closer than knotRel × domain (${min}); merge them with mergeNearKnots`,
        { index: i, value: b - a },
      );
    }
  };
  for (let i = 1; i < U.length; i++) check(i, U[i - 1]!, U[i]!);
  if (end !== undefined) check(U.length, U[U.length - 1]!, end);
}

/** Largest run of equal knots in `U[from..to]` and where it starts. */
function maxRun(U: Float64Array, from: number, to: number): { len: number; at: number } {
  let best = 0;
  let at = from;
  let i = from;
  while (i <= to) {
    let j = i;
    while (j + 1 <= to && U[j + 1] === U[i]) j++;
    if (j - i + 1 > best) {
      best = j - i + 1;
      at = i;
    }
    i = j + 1;
  }
  return { len: best, at };
}

/**
 * A clamped basis of degree `p` from `count + p + 1` knots: the first and the
 * last `p + 1` knots equal (exactly `p + 1`), non-decreasing, interior
 * multiplicity ≤ `p`, no distinct knots closer than `knotRel × domain`.
 * `domain = [knots[p], knots[count]]`. Throws `GeomError` otherwise.
 */
export function clampedBasis(
  degree: number,
  knots: ArrayLike<number>,
  tol?: Partial<Tolerances>,
): ClampedBasis {
  checkDegree(degree);
  const t = resolveTolerances(tol);
  const p = degree;
  if (knots.length < 2 * (p + 1)) {
    fail(
      'knot-count',
      `a clamped basis of degree ${p} needs ≥ ${2 * (p + 1)} knots; got ${knots.length}`,
      {
        value: knots.length,
      },
    );
  }
  const U = checkFiniteKnots(knots);
  checkNonDecreasing(U);
  const m = U.length - 1;
  const count = m - p;
  for (let i = 1; i <= p; i++) {
    if (U[i] !== U[0] || U[m - i] !== U[m]) {
      fail(
        'knots-not-clamped',
        `the first and last ${p + 1} knots must be equal (clamped); use clampUnclamped`,
        {
          index: U[i] !== U[0] ? i : m - i,
        },
      );
    }
  }
  const a = U[p]!;
  const b = U[count]!;
  if (!(b > a)) fail('empty-domain', `domain [${a}, ${b}] has no length`, { value: b - a });
  if (U[p + 1] === a || U[count - 1] === b) {
    fail('knot-multiplicity', `end knots must have multiplicity exactly ${p + 1}`, {
      index: U[p + 1] === a ? p + 1 : count - 1,
    });
  }
  const run = maxRun(U, p + 1, count - 1);
  if (run.len > p) {
    fail(
      'knot-multiplicity',
      `interior knot ${U[run.at]} has multiplicity ${run.len} > degree ${p}`,
      {
        index: run.at,
        value: run.len,
      },
    );
  }
  checkNearCoincident(U, b - a, t);
  return Object.freeze({
    kind: 'clamped',
    degree: p,
    count,
    knots: U,
    domain: Object.freeze([a, b] as const),
  }) as unknown as ClampedBasis;
}

/**
 * A periodic basis of degree `p` with `count = knots.length ≥ p + 1` unique
 * control points. `knots` is one period `t_0 ≤ … ≤ t_{n−1} < t_0 + period`
 * (the bi-infinite sequence is `t_{i+k·n} = t_i + k·period`); multiplicity ≤ `p`;
 * no distinct knots (including `t_{n−1}` and `t_0 + period`) closer than
 * `knotRel × period`. `domain = [t_0, t_0 + period)`.
 */
export function periodicBasis(
  degree: number,
  knots: ArrayLike<number>,
  period: number,
  tol?: Partial<Tolerances>,
): PeriodicBasis {
  checkDegree(degree);
  const t = resolveTolerances(tol);
  const p = degree;
  if (!Number.isFinite(period))
    fail('non-finite', `period is not finite: ${period}`, { value: period });
  if (!(period > 0)) fail('empty-domain', `period must be > 0; got ${period}`, { value: period });
  if (knots.length < p + 1) {
    fail(
      'knot-count',
      `a periodic basis of degree ${p} needs ≥ ${p + 1} knots per period; got ${knots.length}`,
      {
        value: knots.length,
      },
    );
  }
  const U = checkFiniteKnots(knots);
  checkNonDecreasing(U);
  const n = U.length;
  const t0 = U[0]!;
  const end = t0 + period;
  if (!(U[n - 1]! < end)) {
    fail(
      'knots-decreasing',
      `one period must satisfy t_{n−1} < t_0 + period; ${U[n - 1]} ≥ ${end} (list each knot once per period)`,
      { index: n - 1, value: U[n - 1] },
    );
  }
  // t_{n−1} < t_0 + T strictly, so no run of equal knots crosses the period
  // boundary in the bi-infinite sequence: runs in the stored list are complete.
  const run = maxRun(U, 0, n - 1);
  if (run.len > p) {
    fail('knot-multiplicity', `knot ${U[run.at]} has multiplicity ${run.len} > degree ${p}`, {
      index: run.at,
      value: run.len,
    });
  }
  checkNearCoincident(U, period, t, end);
  return Object.freeze({
    kind: 'periodic',
    degree: p,
    count: n,
    knots: U,
    period,
    domain: Object.freeze([t0, end] as const),
  }) as unknown as PeriodicBasis;
}

// ---------------------------------------------------------------------------
// Knot generators and queries
// ---------------------------------------------------------------------------

function checkCount(count: number, min: number, what: string): void {
  if (!Number.isInteger(count) || count < min) {
    fail('too-few-points', `${what} must be an integer ≥ ${min}; got ${count}`, { value: count });
  }
}

function checkInterval(d: Interval): void {
  const [a, b] = d;
  if (!Number.isFinite(a) || !Number.isFinite(b))
    fail('non-finite', `interval [${a}, ${b}] is not finite`);
  if (!(b > a)) fail('empty-domain', `interval [${a}, ${b}] has no length`, { value: b - a });
}

/**
 * Clamped knots with uniformly spaced interior knots: `p + 1` copies of `a`,
 * `count − p − 1` interior knots `a + (b − a)·i/(count − p)`, `p + 1` copies of `b`.
 */
export function clampedUniformKnots(
  degree: number,
  count: number,
  domain: Interval = [0, 1],
): Float64Array {
  checkDegree(degree);
  checkCount(count, degree + 1, 'count');
  checkInterval(domain);
  const [a, b] = domain;
  const p = degree;
  const segs = count - p;
  const U = new Float64Array(count + p + 1);
  for (let i = 0; i <= p; i++) {
    U[i] = a;
    U[count + i] = b;
  }
  for (let i = 1; i < segs; i++) U[p + i] = a + ((b - a) * i) / segs;
  return U;
}

/** One period of uniform knots: `t_i = i·period/count`, `i = 0..count−1`. */
export function periodicUniformKnots(count: number, period = 1): Float64Array {
  checkCount(count, 1, 'count');
  if (!Number.isFinite(period) || !(period > 0)) {
    fail('empty-domain', `period must be finite and > 0; got ${period}`, { value: period });
  }
  const U = new Float64Array(count);
  for (let i = 0; i < count; i++) U[i] = (i * period) / count;
  return U;
}

/** Expands strictly increasing `breaks` with positive integer `mults` into a knot vector. */
export function knotsFromBreaks(breaks: ArrayLike<number>, mults: ArrayLike<number>): Float64Array {
  if (breaks.length !== mults.length) {
    fail('size-mismatch', `breaks (${breaks.length}) and mults (${mults.length}) differ in length`);
  }
  let total = 0;
  for (let i = 0; i < breaks.length; i++) {
    const x = breaks[i]!;
    const k = mults[i]!;
    if (!Number.isFinite(x)) fail('non-finite', `break ${i} is not finite: ${x}`, { index: i });
    if (i > 0 && !(x > breaks[i - 1]!)) {
      fail('knots-decreasing', `breaks must be strictly increasing at ${i}`, {
        index: i,
        value: x,
      });
    }
    if (!Number.isInteger(k) || k < 1) {
      fail('knot-multiplicity', `multiplicity ${i} must be an integer ≥ 1; got ${k}`, {
        index: i,
        value: k,
      });
    }
    total += k;
  }
  const U = new Float64Array(total);
  let o = 0;
  for (let i = 0; i < breaks.length; i++) for (let j = 0; j < mults[i]!; j++) U[o++] = breaks[i]!;
  return U;
}

/** Distinct values of the stored knot vector and their multiplicities. */
export function knotMultiplicities(b: Basis): {
  readonly values: Float64Array;
  readonly mults: Int32Array;
} {
  const U = b.knots;
  const values: number[] = [];
  const mults: number[] = [];
  for (let i = 0; i < U.length; i++) {
    if (i > 0 && U[i] === U[i - 1]) mults[mults.length - 1]!++;
    else {
      values.push(U[i]!);
      mults.push(1);
    }
  }
  return Object.freeze({ values: Float64Array.from(values), mults: Int32Array.from(mults) });
}

/**
 * The explicit fix for `knots-near-coincident` (design §4.3): every cluster of
 * knots whose consecutive gaps are below `knotRel × (last − first)` becomes one
 * value. A cluster keeps the first or last knot when it contains one (so a
 * clamped domain is unchanged), otherwise its most frequent value (ties: the
 * smallest). `moved` is the number of knot entries whose value changed.
 */
export function mergeNearKnots(
  knots: ArrayLike<number>,
  tol?: Partial<Tolerances>,
): { readonly knots: Float64Array; readonly moved: number } {
  const t = resolveTolerances(tol);
  const U = checkFiniteKnots(knots);
  checkNonDecreasing(U);
  const n = U.length;
  if (n === 0) return Object.freeze({ knots: U, moved: 0 });
  const min = t.knotRel * (U[n - 1]! - U[0]!);
  let moved = 0;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && U[j + 1]! - U[j]! < min) j++;
    if (j > i) {
      let rep: number;
      if (i === 0) rep = U[0]!;
      else if (j === n - 1) rep = U[n - 1]!;
      else {
        rep = U[i]!;
        let best = 0;
        let k = i;
        while (k <= j) {
          let l = k;
          while (l + 1 <= j && U[l + 1] === U[k]) l++;
          if (l - k + 1 > best) {
            best = l - k + 1;
            rep = U[k]!;
          }
          k = l + 1;
        }
      }
      for (let k = i; k <= j; k++) {
        if (U[k] !== rep) {
          U[k] = rep;
          moved++;
        }
      }
    }
    i = j + 1;
  }
  return Object.freeze({ knots: U, moved });
}

/** Distinct knot values inside the domain: `[a, …, b]` (clamped) or `[t_0, …)` (periodic). */
export function breakpoints(b: Basis): Float64Array {
  const U = b.knots;
  const from = b.kind === 'clamped' ? b.degree : 0;
  const to = b.kind === 'clamped' ? b.count : U.length - 1;
  const out: number[] = [];
  for (let i = from; i <= to; i++) if (i === from || U[i] !== U[i - 1]) out.push(U[i]!);
  return Float64Array.from(out);
}

/** A basis as plain JSON-safe values (inside `SurfaceJSON`). */
export interface BasisJSON {
  readonly kind: 'clamped' | 'periodic';
  readonly degree: number;
  readonly knots: readonly number[];
  readonly period?: number;
}

/**
 * Re-validates the fields of an untrusted basis (a structured clone or a
 * {@link BasisJSON}) through {@link clampedBasis} / {@link periodicBasis}.
 * Internal: `reviveCurve` and `reviveSurface` use it.
 */
export function reviveBasis(
  kind: unknown,
  degree: unknown,
  knots: unknown,
  period: unknown,
): Basis {
  const arrayLike =
    typeof knots === 'object' &&
    knots !== null &&
    typeof (knots as { length?: unknown }).length === 'number';
  if (typeof degree !== 'number' || !arrayLike) fail('size-mismatch', 'basis is malformed');
  const U = knots as ArrayLike<number>;
  if (kind === 'clamped') return clampedBasis(degree, U);
  if (kind === 'periodic') {
    if (typeof period !== 'number') fail('size-mismatch', 'periodic basis has no period');
    return periodicBasis(degree, U, period);
  }
  return fail('unsupported', `unknown basis kind ${String(kind)}`);
}

/** The JSON form of a basis: plain arrays. */
export function basisToJSON(b: Basis): BasisJSON {
  const knots = Array.from(b.knots as Float64Array);
  return Object.freeze({
    kind: b.kind,
    degree: b.degree,
    knots,
    ...(b.kind === 'periodic' ? { period: b.period } : {}),
  });
}

// ---------------------------------------------------------------------------
// Parameters and spans
// ---------------------------------------------------------------------------

/**
 * Checks a parameter for a validating (allocating) entry point: finite; for a
 * clamped basis inside the domain up to `paramRel × length` slack (then clamped
 * onto it); for a periodic basis wrapped into `[t_0, t_0 + T)`. An explicitly
 * requested side that does not exist (left of a clamped start, right of a
 * clamped end) throws `side-unavailable`. Returns the parameter to evaluate.
 */
export function checkParam(b: Basis, t: number, side: Side | undefined, tol: Tolerances): number {
  if (!Number.isFinite(t)) fail('non-finite', `parameter is not finite: ${t}`, { t });
  const [a, e] = b.domain;
  if (b.kind === 'periodic') return wrapParam(a, b.period, t);
  const slack = tol.paramRel * (e - a);
  if (t < a - slack || t > e + slack) {
    fail('param-out-of-domain', `parameter ${t} is outside the domain [${a}, ${e}]`, {
      t,
      value: t,
    });
  }
  const u = t < a ? a : t > e ? e : t;
  if ((side === 'left' && u === a) || (side === 'right' && u === e)) {
    fail('side-unavailable', `only the inner side exists at the clamped domain end ${u}`, { t: u });
  }
  return u;
}

/** Clamps (clamped) or wraps (periodic) a parameter without throwing; NaN maps to the domain start. */
export function sanitizeParam(b: Basis, t: number): number {
  const [a, e] = b.domain;
  if (b.kind === 'periodic') return wrapParam(a, b.period, t);
  return t > a ? (t < e ? t : e) : a;
}

/**
 * The span of a sanitized parameter. Clamped: P&T's index in `[p, count − 1]`
 * (A2.1, or its left-hand mirror). Periodic: `k ∈ [0, count)` with
 * `t_k ≤ t < t_{k+1}`; the left-hand limit at `t_0` is span `count − 1` of the
 * previous period.
 */
export function spanOf(b: Basis, t: number, left: boolean): number {
  const U = b.knots;
  if (b.kind === 'clamped') {
    return left ? findSpanLeft(b.count - 1, b.degree, t, U) : a21(b.count - 1, b.degree, t, U);
  }
  if (!left) return periodicSpan(U, b.count, t);
  const k = periodicSpanLeft(U, b.count, t);
  return k < 0 ? b.count - 1 : k;
}

/**
 * A2.1 FindSpan. Clamped: P&T span index in `[p, count − 1]`, with the last
 * non-empty span at the domain end. Periodic: `k ∈ [0, count)` with
 * `t_k ≤ t < t_{k+1}` (left: `t_k < t ≤ t_{k+1}`, so `t_0` from the left is
 * span `count − 1`). Basis function `j = 0..p` of span `k` multiplies control
 * point `k − p + j` (periodic: mod `count`).
 *
 * Validating: throws for a non-finite `t`, a clamped `t` outside the domain
 * beyond `paramRel` slack, or an explicit side that does not exist there.
 */
export function findSpan(b: Basis, t: number, side?: Side): number {
  const u = checkParam(b, t, side, resolveTolerances());
  return spanOf(b, u, side === 'left');
}

// ---------------------------------------------------------------------------
// Basis kernels
// ---------------------------------------------------------------------------

/**
 * Runs A2.2 (`nDer = 0`) or A2.3 for a sanitized parameter and its span into
 * `s.f[s.oN …]` (row stride p + 1). Periodic: on the knot window in `s.f[s.oWin …]`,
 * with `t` moved to the span's period first. Clamped ends get exact unit values.
 */
export function evalBasisAt(b: Basis, t: number, span: number, nDer: number, s: ScratchImpl): void {
  evalBasisInto(b, t, span, nDer, s, s.oN, s.oWin);
}

/**
 * {@link evalBasisAt} into the region `s.f[no …]`, with the periodic knot window
 * at `s.f[wo …]`: surfaces keep the u and v bases side by side.
 */
export function evalBasisInto(
  b: Basis,
  t: number,
  span: number,
  nDer: number,
  s: ScratchImpl,
  no: number,
  wo: number,
): void {
  const p = b.degree;
  const f = s.f;
  let U: ReadonlyF64 = b.knots;
  let i = span;
  let u = t;
  if (b.kind === 'periodic') {
    if (u < b.knots[span]!) u += b.period; // the left-hand limit at t_0
    knotWindow(b.knots, b.count, b.period, span, p, f, wo);
    U = f;
    i = wo + p - 1;
  }
  if (nDer === 0) basisFuns(i, u, p, U, f, no, f, s.oLeft, s.oRight);
  else dersBasisFuns(i, u, p, nDer, U, f, no, f, s.oLeft, s.oRight, s.oNdu, s.oA);
  if (b.kind === 'clamped' && (u === b.domain[0] || u === b.domain[1])) {
    // At a clamped end the values are exactly a unit vector (multiplicity p + 1),
    // but A2.2 forms them as x·(1/x), which can miss 1 by an ulp. Writing them
    // exactly makes C(a) = P_0 and C(b) = P_n bitwise (design §4.6).
    for (let j = 0; j <= p; j++) f[no + j] = 0;
    f[no + (u === b.domain[0] ? 0 : p)] = 1;
  }
}

function checkSpan(b: Basis, span: number): void {
  const lo = b.kind === 'clamped' ? b.degree : 0;
  const hi = b.count - 1;
  if (!Number.isInteger(span) || span < lo || span > hi) {
    fail('size-mismatch', `span ${span} is outside [${lo}, ${hi}]`, { index: span });
  }
}

/**
 * A2.2: the `p + 1` non-zero basis functions at `t` in `span` into
 * `out[o + j]`, `j = 0..p` (function `j` multiplies control point `span − p + j`,
 * mod `count` when periodic). Clamps or wraps `t`; never throws on it. `t` must
 * lie in the span (a span from {@link findSpan} for the same `t`).
 */
export function basisFunsInto(
  b: Basis,
  span: number,
  t: number,
  out: Float64Array,
  o: number,
  s: Scratch,
): void {
  basisDersInto(b, span, t, 0, out, o, s);
}

/**
 * A2.3: basis functions and derivatives to order `nDer` at `t` in `span`,
 * `out[o + k·(p+1) + j]` = `k`-th derivative of function `j`. Orders above the
 * degree are zero. Same parameter rules as {@link basisFunsInto}.
 */
export function basisDersInto(
  b: Basis,
  span: number,
  t: number,
  nDer: number,
  out: Float64Array,
  o: number,
  s: Scratch,
): void {
  const p = b.degree;
  if (!Number.isInteger(nDer) || nDer < 0)
    fail('unsupported', `derivative order ${nDer} is not valid`);
  const sc = scratchFor(s, p, nDer);
  checkSpan(b, span);
  const p1 = p + 1;
  if (!Number.isInteger(o) || o < 0 || out.length < o + (nDer + 1) * p1) {
    fail('size-mismatch', `output needs ${(nDer + 1) * p1} values from offset ${o}`, { offset: o });
  }
  evalBasisAt(b, sanitizeParam(b, t), span, nDer, sc);
  const f = sc.f;
  for (let k = 0; k < (nDer + 1) * p1; k++) out[o + k] = f[sc.oN + k]!;
}

/**
 * A2.4 OneBasisFun: the value at `t` of the basis function that multiplies
 * control point `i`. An independent algorithm from A2.2 / A2.3, kept as the test
 * oracle. Periodic: the sum of the bi-infinite functions `N_{i + k·count}`.
 */
export function basisFunction(b: Basis, i: number, t: number): number {
  if (!Number.isInteger(i) || i < 0 || i >= b.count) {
    fail('size-mismatch', `basis function ${i} is outside [0, ${b.count})`, { index: i });
  }
  const u = checkParam(b, t, undefined, resolveTolerances());
  const p = b.degree;
  if (b.kind === 'clamped') return oneBasisFun(p, b.knots.length - 1, b.knots, i, u);
  // Knots t_{−n} … t_{2n−1}; index e holds t_{e−n}.
  const n = b.count;
  const ext = new Float64Array(3 * n);
  for (let e = 0; e < 3 * n; e++) {
    const j = e - n;
    ext[e] = j < 0 ? b.knots[j + n]! - b.period : j >= n ? b.knots[j - n]! + b.period : b.knots[j]!;
  }
  // Functions non-zero on [t_0, t_0 + T) are j ∈ [−p, n − 1]: i itself and i − n.
  let v = oneBasisFun(p, 3 * n - 1, ext, i + n, u);
  if (i - n >= -p) v += oneBasisFun(p, 3 * n - 1, ext, i, u);
  return v;
}
