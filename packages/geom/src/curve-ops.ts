// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Curve operations (design §6.5): knot insertion (P&T A5.1) and refinement
 * (A5.4), knot removal with a tolerance (A5.8), degree elevation (A5.9),
 * splitting and sub-curves, reversal, affine reparameterisation, periodic →
 * clamped conversion, Bézier decomposition (A5.6) and compatibility for
 * skinning.
 *
 * - **Exact.** Insertion, refinement, elevation, splitting, sub-curves,
 *   reversal, reparameterisation, `toClamped` and decomposition return the
 *   same curve: their new control points are convex combinations of the old
 *   ones, so only rounding separates them. Removal and the knot unification of
 *   {@link makeCompatible} may change the shape; both report a rigorous bound
 *   on how much (see {@link deviationBound}).
 * - **One kernel per direction.** The `*Dir` functions act on a basis and a
 *   net of "points" of `h` doubles each: a curve's homogeneous points
 *   (`h = dim + 1`), or whole rows of a surface net (`surface-ops.ts`), which
 *   is how A5.1 becomes A5.3, A5.4 becomes A5.5 and A5.9 the row-wise surface
 *   elevation.
 * - **Periodic** (decision 8, §4.4): unroll exactly to a clamped window three
 *   periods long, run the clamped book algorithm with every change made to
 *   each copy of the period, read back the middle period. Reversal maps the
 *   one-period knot list directly (exact, no window).
 * - **Snapping** (§4.3): a parameter that becomes a knot snaps to an existing
 *   knot within `knotRel × domain` (and, periodic, to `t_0` from `t_0 + T`),
 *   so operations never create sliver spans; inserting a snapped value is exact.
 * - **Polynomial stays polynomial.** Convex combinations of weights that are
 *   all exactly 1 can round to 1 ± 1 ulp (A5.9's Bézier sums, A5.8's
 *   divisions); a polynomial input gets its weights written back as exactly 1,
 *   as `isoCurve` does.
 * - **Domains** (decision 10): kept by every operation except the explicit
 *   `reparameterize` / `normalizeDomain`; `splitCurve` and `subCurve` keep the
 *   sub-ranges.
 */
import { checkParam, clampedBasis, periodicBasis } from './basis';
import { basisFuns, findSpan as a21 } from './book/basis';
import { curvePointH } from './book/curve';
import { extractPeriod, unrollPeriodic } from './book/periodic';
import {
  curveKnotIns,
  decomposeCurve,
  degreeElevateCurve,
  refineKnotVectCurve,
  removeCurveKnot,
  runEnd,
  sliceKnots,
} from './book/refine';
import { checkCurveShape, curveFromHomogeneous } from './curve';
import { fail } from './errors';
import { resolveTolerances } from './tolerance';
import type { Tolerances } from './tolerance';
import type {
  Basis,
  ClampedBasis,
  ClampedCurve,
  Dim,
  Interval,
  NurbsCurve,
  PeriodicBasis,
  PeriodicCurve,
  ReadonlyF64,
} from './types';

/** A basis and its net of points of `h` doubles (a curve's Pw, or a surface's rows). */
export interface DirNet {
  readonly basis: Basis;
  readonly Pw: Float64Array;
}

/** Raw clamped knots and points, before validation. */
interface Raw {
  readonly U: Float64Array;
  readonly Pw: Float64Array;
}

const copyF64 = (a: ReadonlyF64): Float64Array => (a as Float64Array).slice();

// ---------------------------------------------------------------------------
// Knot queries and parameter handling
// ---------------------------------------------------------------------------

/** Multiplicity of the value `x` in `U` (exact equality: near-coincident knots are excluded, §4.3). */
function multiplicity(U: ReadonlyF64, x: number): number {
  let s = 0;
  for (let i = 0; i < U.length; i++) if (U[i] === x) s++;
  return s;
}

function lastIndex(U: ReadonlyF64, x: number): number {
  for (let i = U.length - 1; i >= 0; i--) if (U[i] === x) return i;
  return -1;
}

function firstIndex(U: ReadonlyF64, x: number): number {
  for (let i = 0; i < U.length; i++) if (U[i] === x) return i;
  return -1;
}

/**
 * Snaps a parameter that is about to become a knot to an existing knot value
 * closer than `knotRel × domain length` (design §4.3); a periodic `t_0 + T`
 * snaps to `t_0`. Otherwise returns `x` unchanged.
 */
export function snapKnot(b: Basis, x: number, tol: Tolerances): number {
  const [a, e] = b.domain;
  let dist = tol.knotRel * (e - a);
  let best = x;
  const U = b.knots;
  for (let i = 0; i < U.length; i++) {
    const g = Math.abs(U[i]! - x);
    if (g < dist) {
      best = U[i]!;
      dist = g;
    }
  }
  if (b.kind === 'periodic' && Math.abs(e - x) < dist) best = a;
  return best;
}

/** A validated parameter (throws beyond `paramRel`, clamps or wraps) snapped to the knots. */
function knotParam(b: Basis, t: number, tol: Tolerances): number {
  return snapKnot(b, checkParam(b, t, undefined, tol), tol);
}

function checkCount(k: number, what: string): void {
  if (!Number.isInteger(k) || k < 0) {
    fail('unsupported', `${what} must be an integer ≥ 0; got ${k}`, { value: k });
  }
}

/** `p − multiplicity` copies of `x` (none for a full run), appended to `X`. */
function toFull(p: number, U: ReadonlyF64, x: number, X: number[]): void {
  for (let k = multiplicity(U, x); k < p; k++) X.push(x);
}

// ---------------------------------------------------------------------------
// Raw clamped kernels
// ---------------------------------------------------------------------------

/** A5.4 on a clamped knot vector (a copy for an empty `X`). `X` ascending, inside the domain. */
function rawRefine(
  p: number,
  U: ReadonlyF64,
  Pw: ReadonlyF64,
  h: number,
  X: ArrayLike<number>,
): Raw {
  if (X.length === 0) return { U: copyF64(U), Pw: copyF64(Pw) };
  const r = refineKnotVectCurve(U.length - p - 2, p, U, Pw, h, X);
  return { U: r.Ubar, Pw: r.Qw };
}

/**
 * The clamped piece on `[lo, hi]` (`lo < hi`, both in the domain) of the
 * clamped curve `(U, Pw)`: both ends inserted to multiplicity `p` in one A5.4
 * pass, then sliced out.
 */
function rawSub(
  p: number,
  U: ReadonlyF64,
  Pw: ReadonlyF64,
  h: number,
  lo: number,
  hi: number,
): Raw {
  const X: number[] = [];
  if (lo > U[p]!) toFull(p, U, lo, X);
  if (hi < U[U.length - p - 1]!) toFull(p, U, hi, X);
  const R = rawRefine(p, U, Pw, h, X);
  return sliceKnots(p, R.U, R.Pw, h, lastIndex(R.U, lo), firstIndex(R.U, hi));
}

// ---------------------------------------------------------------------------
// Periodic: unroll to a clamped window, extract the middle period
// ---------------------------------------------------------------------------

function window(b: PeriodicBasis, Pw: ReadonlyF64, h: number): Raw {
  return unrollPeriodic(b.degree, b.knots, b.period, b.count, Pw, h);
}

function fromWindow(b: PeriodicBasis, degree: number, R: Raw, h: number, tol: Tolerances): DirNet {
  const E = extractPeriod(R.U, R.Pw, h, b.domain[0], b.period);
  return { basis: periodicBasis(degree, E.U, b.period, tol), Pw: E.Pw };
}

/**
 * The copies of a new periodic knot `x ∈ [t_0, t_0 + T)` inside the window's
 * open domain `(t_0 − T, t_0 + 2T)`, `times` each: `x − T` (unless `x = t_0`),
 * `x`, `x + T`, ascending. For an existing knot `t_i` these are exactly the window's
 * `t_i − T` and `t_i + T` (the same expressions as `periodicKnot`).
 */
function pushCopies(b: PeriodicBasis, x: number, times: number, X: number[]): void {
  const T = b.period;
  if (x > b.domain[0]) for (let k = 0; k < times; k++) X.push(x - T);
  for (let k = 0; k < times; k++) X.push(x);
  for (let k = 0; k < times; k++) X.push(x + T);
}

// ---------------------------------------------------------------------------
// Per-direction operations (curves: h = dim + 1; surfaces: whole rows)
// ---------------------------------------------------------------------------

/**
 * A5.1 (A5.3 on rows): inserts `t` `times` times. Clamped ends cannot be
 * inserted (their multiplicity is already `p + 1`); the resulting multiplicity
 * must stay ≤ `p` (`knot-multiplicity`).
 */
export function insertDir(
  b: Basis,
  Pw: ReadonlyF64,
  h: number,
  t: number,
  times: number,
  tol: Tolerances,
): DirNet {
  checkCount(times, 'times');
  const x = knotParam(b, t, tol);
  const p = b.degree;
  if (b.kind === 'clamped' && (x === b.domain[0] || x === b.domain[1])) {
    fail(
      'knot-multiplicity',
      `cannot insert the clamped domain end ${x}: it has multiplicity ${p + 1}`,
      {
        t: x,
      },
    );
  }
  const s = multiplicity(b.knots, x);
  if (s + times > p) {
    fail(
      'knot-multiplicity',
      `inserting ${x} ${times} times gives multiplicity ${s + times} > degree ${p}`,
      { t: x, value: s + times },
    );
  }
  if (times === 0) return { basis: b, Pw: copyF64(Pw) };
  if (b.kind === 'clamped') {
    const n = b.count - 1;
    const r = curveKnotIns(n, p, b.knots, Pw, h, x, a21(n, p, x, b.knots), s, times);
    return { basis: clampedBasis(p, r.UQ, tol), Pw: r.Qw };
  }
  const X: number[] = [];
  pushCopies(b, x, times, X);
  const W = window(b, Pw, h);
  return fromWindow(b, p, rawRefine(p, W.U, W.Pw, h, X), h, tol);
}

/**
 * A5.4 (A5.5 on rows): inserts every value of `xs` (any order; repeats raise
 * the multiplicity). Values snap to existing knots and to one another within
 * `knotRel × domain`; clamped ends are rejected; every resulting multiplicity
 * must stay ≤ `p`.
 */
export function refineDir(
  b: Basis,
  Pw: ReadonlyF64,
  h: number,
  xs: ArrayLike<number>,
  tol: Tolerances,
): DirNet {
  const p = b.degree;
  const [a, e] = b.domain;
  const X = Float64Array.from(xs, (t) => knotParam(b, t, tol)).sort();
  const d = tol.knotRel * (e - a);
  for (let i = 1; i < X.length; i++) {
    if (X[i] !== X[i - 1] && X[i]! - X[i - 1]! < d) X[i] = X[i - 1]!;
  }
  for (let i = 0; i < X.length; i = runEnd(X, i) + 1) {
    const x = X[i]!;
    const count = runEnd(X, i) - i + 1;
    if (b.kind === 'clamped' && (x === a || x === e)) {
      fail('knot-multiplicity', `cannot insert the clamped domain end ${x}`, { t: x });
    }
    const s = multiplicity(b.knots, x) + count;
    if (s > p) {
      fail('knot-multiplicity', `refinement gives knot ${x} multiplicity ${s} > degree ${p}`, {
        t: x,
        value: s,
      });
    }
  }
  if (X.length === 0) return { basis: b, Pw: copyF64(Pw) };
  if (b.kind === 'clamped') {
    const R = rawRefine(p, b.knots, Pw, h, X);
    return { basis: clampedBasis(p, R.U, tol), Pw: R.Pw };
  }
  const C: number[] = [];
  for (const x of X) pushCopies(b, x, 1, C);
  C.sort((x, y) => x - y);
  const W = window(b, Pw, h);
  return fromWindow(b, p, rawRefine(p, W.U, W.Pw, h, C), h, tol);
}

/** A5.9 (row-wise on surfaces): raises the degree by `by ≥ 0`; every knot's multiplicity grows by `by`. */
export function elevateDir(
  b: Basis,
  Pw: ReadonlyF64,
  h: number,
  by: number,
  tol: Tolerances,
): DirNet {
  checkCount(by, 'by');
  if (by === 0) return { basis: b, Pw: copyF64(Pw) };
  const p = b.degree;
  if (b.kind === 'clamped') {
    const r = degreeElevateCurve(b.count - 1, p, b.knots, Pw, h, by);
    return { basis: clampedBasis(p + by, r.Uh, tol), Pw: r.Qw };
  }
  const W = window(b, Pw, h);
  const r = degreeElevateCurve(W.U.length - p - 2, p, W.U, W.Pw, h, by);
  return fromWindow(b, p + by, { U: r.Uh, Pw: r.Qw }, h, tol);
}

/**
 * Splits a clamped direction at `t` (strictly inside after snapping): `t` is
 * inserted to multiplicity `p` and the two halves cut out (P&T §5.2). The
 * halves share their join point (the same control point, bit for bit).
 */
export function splitDir(
  b: Basis,
  Pw: ReadonlyF64,
  h: number,
  t: number,
  tol: Tolerances,
): readonly [DirNet, DirNet] {
  if (b.kind !== 'clamped') {
    fail(
      'unsupported',
      'a periodic direction has no ends to split between: use toClamped or a sub-range',
    );
  }
  const x = knotParam(b, t, tol);
  const [a, e] = b.domain;
  if (!(x > a && x < e)) {
    fail('empty-domain', `split parameter ${t} is at a domain end: one piece would be empty`, {
      t,
    });
  }
  const p = b.degree;
  const X: number[] = [];
  toFull(p, b.knots, x, X);
  const R = rawRefine(p, b.knots, Pw, h, X);
  const left = sliceKnots(p, R.U, R.Pw, h, p, firstIndex(R.U, x));
  const right = sliceKnots(p, R.U, R.Pw, h, lastIndex(R.U, x), R.U.length - p - 1);
  return [
    { basis: clampedBasis(p, left.U, tol), Pw: left.Pw },
    { basis: clampedBasis(p, right.U, tol), Pw: right.Pw },
  ];
}

/**
 * The clamped piece on `[t0, t1]`. Clamped: `t0 < t1` in the domain. Periodic:
 * both are wrapped into the period; `t1 ≤ t0` runs across the seam (the result
 * is on `[t0, t1 + T]`), and `t1 = t0` gives the whole loop on `[t0, t0 + T]`.
 */
export function subDir(
  b: Basis,
  Pw: ReadonlyF64,
  h: number,
  t0: number,
  t1: number,
  tol: Tolerances,
): DirNet {
  const p = b.degree;
  const x0 = knotParam(b, t0, tol);
  const x1 = knotParam(b, t1, tol);
  if (b.kind === 'clamped') {
    if (!(x1 > x0)) {
      fail('empty-domain', `sub-range [${t0}, ${t1}] is empty (t1 must exceed t0)`, { t: t1 });
    }
    const R = rawSub(p, b.knots, Pw, h, x0, x1);
    return { basis: clampedBasis(p, R.U, tol), Pw: R.Pw };
  }
  const W = window(b, Pw, h);
  const hi = x1 > x0 ? x1 : x1 + b.period;
  const R = rawSub(p, W.U, W.Pw, h, x0, hi);
  return { basis: clampedBasis(p, R.U, tol), Pw: R.Pw };
}

/**
 * Reverses the parameter direction: clamped `t ↦ a + b − t` on `[a, b]`,
 * periodic `t ↦ 2·t_0 + T − t` (the domain start maps to itself modulo `T`).
 * Exact: the points are permuted, the knots mirrored with the domain kept.
 */
export function reverseDir(b: Basis, Pw: ReadonlyF64, h: number, tol: Tolerances): DirNet {
  const n = b.count;
  const p = b.degree;
  const U = b.knots;
  const Q = new Float64Array(n * h);
  const move = (dst: number, src: number): void => {
    for (let c = 0; c < h; c++) Q[dst * h + c] = Pw[src * h + c]!;
  };
  const [a, e] = b.domain;
  if (b.kind === 'clamped') {
    const m = U.length - 1;
    const V = new Float64Array(m + 1);
    for (let i = 0; i <= m; i++) V[i] = i <= p ? a : i >= m - p ? e : a + (e - U[m - i]!);
    for (let i = 0; i < n; i++) move(i, n - 1 - i);
    return { basis: clampedBasis(p, V, tol), Pw: Q };
  }
  // Mirror s_j = c − t_{n+m0−1−j} with c = 2·t_0 + T, m0 the multiplicity of
  // t_0: s_0 … s_{m0−1} = t_0 keep the run of t_0 at the start of the list.
  // Function j of the mirror is the image of function n + m0 − p − 2 − j.
  const m0 = runEnd(U, 0) + 1;
  const V = new Float64Array(n);
  for (let j = 0; j < n; j++) V[j] = j < m0 ? a : a + (e - U[n + m0 - 1 - j]!);
  for (let j = 0; j < n; j++) move(j, (((m0 - p - 2 - j) % n) + n) % n);
  return { basis: periodicBasis(p, V, b.period, tol), Pw: Q };
}

function checkDomain(domain: Interval): void {
  const ok = Array.isArray(domain) && domain.length === 2;
  if (!ok) fail('size-mismatch', 'domain must be an interval [a, b]');
  const [c, d] = domain;
  if (!Number.isFinite(c) || !Number.isFinite(d)) {
    fail('non-finite', `domain [${c}, ${d}] is not finite`);
  }
  if (!(d > c)) fail('empty-domain', `domain [${c}, ${d}] has no length`, { value: d - c });
}

/**
 * The basis mapped affinely onto `domain = [c, d]` (periodic: `[c, d)`, period
 * `d − c`): `x ↦ c + (x − a)·(d − c)/(b − a)`, with the ends written exactly.
 */
export function reparamBasis(b: Basis, domain: Interval, tol: Tolerances): Basis {
  checkDomain(domain);
  const [c, d] = domain;
  const [a, e] = b.domain;
  const k = (d - c) / (e - a);
  const U = b.knots;
  const V = new Float64Array(U.length);
  for (let i = 0; i < U.length; i++) {
    const x = U[i]!;
    V[i] = x === a ? c : x === e ? d : c + (x - a) * k;
  }
  return b.kind === 'clamped'
    ? clampedBasis(b.degree, V, tol)
    : periodicBasis(b.degree, V, d - c, tol);
}

// ---------------------------------------------------------------------------
// Deviation bound (removal, makeCompatible)
// ---------------------------------------------------------------------------

/** The distinct values of two sorted knot vectors, merged. */
function mergedBreaks(U1: ReadonlyF64, U2: ReadonlyF64): number[] {
  const all = [...(U1 as Float64Array), ...(U2 as Float64Array)].sort((x, y) => x - y);
  return all.filter((x, i) => i === 0 || x !== all[i - 1]);
}

/**
 * A rigorous upper bound on `max_t |C1(t) − C2(t)|` for two clamped curves of
 * one degree `p` and one domain, each given by knots and homogeneous points.
 * On every span of the union of their knots both are polynomials of degree
 * `p` in homogeneous space, so each coordinate of the difference is bounded
 * by its largest value at the `p + 1` Chebyshev nodes of the span times the
 * Lebesgue constant of those nodes, `Λ_p ≤ (2/π)·ln(p + 1) + 1` (the classical
 * bound for Chebyshev interpolation; Rivlin, _The Chebyshev Polynomials_; the
 * test suite checks it numerically for p ≤ 12). Polynomial: that is the
 * Euclidean bound. Rational, in coordinates centred on the first net's box:
 * `C1 − C2 = (ΔA − C1·ΔW)/W2` with `|C1| ≤ R` (convex hull of the first net)
 * and `W2 ≥ min w2`, the bound P&T derive for eq. 5.30. Not a sampled
 * estimate: no resolution parameter, and an exact operation reports rounding.
 */
export function deviationBound(
  p: number,
  U1: ReadonlyF64,
  Pw1: ReadonlyF64,
  U2: ReadonlyF64,
  Pw2: ReadonlyF64,
  dim: number,
  rational: boolean,
): number {
  const h = dim + 1;
  const cen = new Float64Array(dim);
  let R = 0;
  let wmin2 = Infinity;
  if (rational) {
    const lo = new Float64Array(dim).fill(Infinity);
    const hi = new Float64Array(dim).fill(-Infinity);
    const count1 = Pw1.length / h;
    for (let i = 0; i < count1; i++) {
      for (let c = 0; c < dim; c++) {
        const x = Pw1[i * h + c]! / Pw1[i * h + dim]!;
        lo[c] = Math.min(lo[c]!, x);
        hi[c] = Math.max(hi[c]!, x);
      }
    }
    for (let c = 0; c < dim; c++) cen[c] = (lo[c]! + hi[c]!) / 2;
    for (let i = 0; i < count1; i++) {
      let r2 = 0;
      for (let c = 0; c < dim; c++) {
        const x = Pw1[i * h + c]! / Pw1[i * h + dim]! - cen[c]!;
        r2 += x * x;
      }
      R = Math.max(R, Math.sqrt(r2));
    }
    for (let i = 0; i < Pw2.length / h; i++) wmin2 = Math.min(wmin2, Pw2[i * h + dim]!);
  }
  const N = new Float64Array(p + 1);
  const work = new Float64Array(2 * p + 2);
  const H1 = new Float64Array(h);
  const H2 = new Float64Array(h);
  const M = new Float64Array(h); // largest |difference| at the nodes, per coordinate
  const evalH = (U: ReadonlyF64, Pw: ReadonlyF64, x: number, out: Float64Array): void => {
    const n = U.length - p - 2;
    const span = a21(n, p, x, U);
    basisFuns(span, x, p, U, N, 0, work, 0, p + 1);
    curvePointH(p, N, 0, Pw, (span - p) * h, h, out, 0);
  };
  const breaks = mergedBreaks(U1, U2);
  for (let s = 0; s + 1 < breaks.length; s++) {
    const mid = (breaks[s]! + breaks[s + 1]!) / 2;
    const half = (breaks[s + 1]! - breaks[s]!) / 2;
    for (let k = 0; k <= p; k++) {
      const x = mid + half * Math.cos(((2 * k + 1) * Math.PI) / (2 * p + 2));
      evalH(U1, Pw1, x, H1);
      evalH(U2, Pw2, x, H2);
      const dw = H1[dim]! - H2[dim]!;
      for (let c = 0; c < dim; c++) {
        const dA = H1[c]! - H2[c]! - (rational ? cen[c]! * dw : 0);
        M[c] = Math.max(M[c]!, Math.abs(dA));
      }
      M[dim] = Math.max(M[dim]!, Math.abs(dw));
    }
  }
  let a2 = 0;
  for (let c = 0; c < dim; c++) a2 += M[c]! * M[c]!;
  const lebesgue = (2 / Math.PI) * Math.log(p + 1) + 1;
  if (!rational) return lebesgue * Math.sqrt(a2);
  return (lebesgue * (Math.sqrt(a2) + R * M[dim]!)) / wmin2;
}

// ---------------------------------------------------------------------------
// Public curve operations
// ---------------------------------------------------------------------------

/** A curve of `c`'s dimension from a new basis and net; a polynomial `c` keeps weights exactly 1. */
function rebuild<C extends NurbsCurve>(c: NurbsCurve, r: DirNet): C {
  const h = c.dim + 1;
  if (!c.rational) for (let i = c.dim; i < r.Pw.length; i += h) r.Pw[i] = 1;
  return curveFromHomogeneous({ dim: c.dim, basis: r.basis, cw: r.Pw }) as unknown as C;
}

function checkClamped(c: NurbsCurve, what: string): asserts c is ClampedCurve {
  if (c.basis.kind !== 'clamped') {
    fail('unsupported', `${what} needs a clamped curve; convert a periodic one with toClamped`);
  }
}

/**
 * P&T A5.1: inserts the knot `t` `times` times (default 1). The curve is
 * unchanged; the domain and kind are kept. `t` snaps to an existing knot
 * within `knotRel × domain`. Throws `knot-multiplicity` at a clamped end or
 * when the multiplicity would exceed the degree.
 */
export function insertKnot<C extends NurbsCurve>(
  c: C,
  t: number,
  times = 1,
  tol?: Partial<Tolerances>,
): C {
  checkCurveShape(c);
  return rebuild(c, insertDir(c.basis, c.cw, c.dim + 1, t, times, resolveTolerances(tol)));
}

/**
 * P&T A5.4: inserts all of `x` in one pass (repeats raise the multiplicity).
 * The curve is unchanged. Same snapping and multiplicity rules as {@link insertKnot}.
 */
export function refineKnots<C extends NurbsCurve>(
  c: C,
  x: ArrayLike<number>,
  tol?: Partial<Tolerances>,
): C {
  checkCurveShape(c);
  return rebuild(c, refineDir(c.basis, c.cw, c.dim + 1, x, resolveTolerances(tol)));
}

/**
 * P&T A5.9: the same curve with degree `p + by`. Every distinct knot's
 * multiplicity grows by `by` (the curve keeps its continuity). Periodic
 * curves are elevated on the unrolled window.
 */
export function elevateDegree<C extends NurbsCurve>(
  c: C,
  by: number,
  tol?: Partial<Tolerances>,
): C {
  checkCurveShape(c);
  return rebuild(c, elevateDir(c.basis, c.cw, c.dim + 1, by, resolveTolerances(tol)));
}

/**
 * Splits a clamped curve at `t` into the pieces on `[a, t]` and `[t, b]`
 * (domains kept). Each piece equals the curve on its range; they share the
 * join point bit for bit. Throws `empty-domain` at a domain end.
 */
export function splitCurve<D extends Dim>(
  c: ClampedCurve<D>,
  t: number,
  tol?: Partial<Tolerances>,
): readonly [ClampedCurve<D>, ClampedCurve<D>] {
  checkCurveShape(c);
  checkClamped(c, 'splitCurve');
  const [l, r] = splitDir(c.basis, c.cw, c.dim + 1, t, resolveTolerances(tol));
  return Object.freeze([rebuild<ClampedCurve<D>>(c, l), rebuild<ClampedCurve<D>>(c, r)] as const);
}

/**
 * The clamped curve equal to `c` on `[t0, t1]` (domain kept). Periodic: the
 * parameters wrap; `t1 ≤ t0` runs across the seam (domain `[t0, t1 + T]`) and
 * `t1 = t0` gives the whole loop starting at `t0`.
 */
export function subCurve<D extends Dim>(
  c: NurbsCurve<D>,
  t0: number,
  t1: number,
  tol?: Partial<Tolerances>,
): ClampedCurve<D> {
  checkCurveShape(c);
  return rebuild(c, subDir(c.basis, c.cw, c.dim + 1, t0, t1, resolveTolerances(tol)));
}

/**
 * The same curve traversed backwards: `C′(t) = C(a + b − t)` on `[a, b]`;
 * periodic `C′(t) = C(2·t_0 + T − t)`. Domain and kind are kept.
 */
export function reverseCurve<C extends NurbsCurve>(c: C, tol?: Partial<Tolerances>): C {
  checkCurveShape(c);
  return rebuild(c, reverseDir(c.basis, c.cw, c.dim + 1, resolveTolerances(tol)));
}

/**
 * The same curve on `domain = [c, d]` by the affine map
 * `t ↦ c + (t − a)·(d − c)/(b − a)`: the k-th derivative scales by
 * `((b − a)/(d − c))^k`. Periodic: `[c, d)` with period `d − c`. The net is
 * shared by reference.
 */
export function reparameterize<C extends NurbsCurve>(
  c: C,
  domain: Interval,
  tol?: Partial<Tolerances>,
): C {
  checkCurveShape(c);
  const basis = reparamBasis(c.basis, domain, resolveTolerances(tol));
  return Object.freeze({ ...c, basis }) as C;
}

/** {@link reparameterize} onto `[0, 1]` (periodic: period 1), ends exactly 0 and 1. */
export function normalizeDomain<C extends NurbsCurve>(c: C, tol?: Partial<Tolerances>): C {
  return reparameterize(c, [0, 1], tol);
}

/**
 * The periodic curve as the identical clamped curve on `[seam, seam + T]`
 * (default seam `t_0`): the seam is inserted to multiplicity `p` and one
 * period unrolled. Exact; the end points coincide (closed C⁰).
 */
export function toClamped<D extends Dim>(
  c: PeriodicCurve<D>,
  seam?: number,
  tol?: Partial<Tolerances>,
): ClampedCurve<D> {
  checkCurveShape(c);
  if (c.basis.kind !== 'periodic') fail('unsupported', 'toClamped needs a periodic curve');
  const s = seam ?? c.basis.domain[0];
  return rebuild(c, subDir(c.basis, c.cw, c.dim + 1, s, s, resolveTolerances(tol)));
}

/**
 * P&T A5.6: the Bézier segments of a clamped curve, one per non-empty knot
 * span, in order; segment `k` is on `[x_k, x_{k+1}]` (the curve's breakpoints).
 */
export function decomposeBezier<D extends Dim>(c: ClampedCurve<D>): readonly ClampedCurve<D>[] {
  checkCurveShape(c);
  checkClamped(c, 'decomposeBezier');
  const b = c.basis as ClampedBasis;
  const p = b.degree;
  const h = c.dim + 1;
  const r = decomposeCurve(b.count - 1, p, b.knots, c.cw, h);
  const out: ClampedCurve<D>[] = [];
  for (let s = 0; s < r.nb; s++) {
    const U = new Float64Array(2 * p + 2);
    U.fill(r.breaks[s]!, 0, p + 1);
    U.fill(r.breaks[s + 1]!, p + 1);
    const Pw = r.Qw.slice(s * (p + 1) * h, (s + 1) * (p + 1) * h);
    out.push(rebuild<ClampedCurve<D>>(c, { basis: clampedBasis(p, U), Pw }));
  }
  return Object.freeze(out);
}

/**
 * P&T A5.8: removes the interior knot `t` up to `times` times (default 1) while
 * the curve moves by at most `tol.point` (by default the "points coincide" distance, 10 nm: the removal keeps
 * the shape). A5.8 runs with its homogeneous check distance `TOL = point`
 * (polynomial) or `point · w_min / (1 + |P|_max)` (rational, P&T eq. 5.30),
 * then {@link deviationBound} certifies the result; if the bound exceeds
 * `point`, fewer removals are tried. `removed` may be less than `times` (0:
 * the input curve is returned). `maxDeviation` is the certified bound (0 when
 * nothing was removed). Clamped curves only; `t` must be a knot.
 */
export function removeKnot<D extends Dim>(
  c: ClampedCurve<D>,
  t: number,
  times = 1,
  tol?: Partial<Tolerances>,
): { readonly curve: ClampedCurve<D>; readonly removed: number; readonly maxDeviation: number } {
  checkCurveShape(c);
  checkClamped(c, 'removeKnot');
  checkCount(times, 'times');
  const tl = resolveTolerances(tol);
  const b = c.basis;
  const x = knotParam(b, t, tl);
  const [a, e] = b.domain;
  if (x === a || x === e)
    fail('knot-multiplicity', 'the clamped end knots cannot be removed', { t: x });
  const s = multiplicity(b.knots, x);
  if (s === 0) fail('unsupported', `${t} is not a knot of the curve`, { t });
  if (times > s) {
    fail('knot-multiplicity', `knot ${x} has multiplicity ${s}; cannot remove it ${times} times`, {
      t: x,
      value: s,
    });
  }
  const dim: number = c.dim;
  const h = dim + 1;
  const p = b.degree;
  const d = tl.point;
  let TOL = d;
  if (c.rational) {
    let wmin = Infinity;
    let pmax = 0;
    for (let i = 0; i < b.count; i++) {
      const w = c.cw[i * h + dim]!;
      let r2 = 0;
      for (let k = 0; k < dim; k++) r2 += (c.cw[i * h + k]! / w) ** 2;
      wmin = Math.min(wmin, w);
      pmax = Math.max(pmax, Math.sqrt(r2));
    }
    TOL = (d * wmin) / (1 + pmax); // P&T eq. 5.30
  }
  const r = lastIndex(b.knots, x);
  let num = times;
  while (num > 0) {
    const res = removeCurveKnot(b.count - 1, p, b.knots, c.cw, h, x, r, s, num, TOL);
    if (res.t === 0) break;
    if (!c.rational) for (let i = dim; i < res.Pw.length; i += h) res.Pw[i] = 1;
    const bound = deviationBound(p, b.knots, c.cw, res.U, res.Pw, dim, c.rational);
    if (bound <= d) {
      const curve = rebuild<ClampedCurve<D>>(c, { basis: clampedBasis(p, res.U, tl), Pw: res.Pw });
      return Object.freeze({ curve, removed: res.t, maxDeviation: bound });
    }
    num = res.t - 1;
  }
  return Object.freeze({ curve: c, removed: 0, maxDeviation: 0 });
}

/**
 * Makes curves compatible for skinning and ruling (P&T §10.3): one degree (the
 * highest, by A5.9) and one knot vector (the union with the largest
 * multiplicity of each value, by A5.4). The curves must have one dimension,
 * one kind and equal domains (periodic: equal `t_0` and period).
 *
 * Distinct knots of different curves closer than `knotRel × domain` would make
 * sliver spans, so they are unified without chaining: the most used values
 * (ties: the smallest) are kept, and every other value within
 * `knotRel × domain` of a kept one snaps to the nearest, so a knot moves by
 * less than `knotRel × domain` (§4.3). `maxKnotShift` is the largest such move;
 * `maxDeviation` is a rigorous bound ({@link deviationBound}) on the shape
 * change it caused, 0 when no knot moved (every other step is exact). Throws
 * `knots-near-coincident` when a value cannot snap without merging two knots
 * of one curve (which needs that curve to have two knots less than
 * `2 · knotRel × domain` apart, both near a more used value).
 */
export function makeCompatible<C extends NurbsCurve>(
  cs: readonly C[],
  tol?: Partial<Tolerances>,
): { readonly curves: readonly C[]; readonly maxKnotShift: number; readonly maxDeviation: number } {
  const tl = resolveTolerances(tol);
  if (cs.length === 0)
    return Object.freeze({ curves: Object.freeze([]), maxKnotShift: 0, maxDeviation: 0 });
  for (const c of cs) checkCurveShape(c);
  const first = cs[0]!;
  const [a, e] = first.basis.domain;
  for (let i = 1; i < cs.length; i++) {
    const c = cs[i]!;
    if (c.dim !== first.dim) {
      fail('dimension-mismatch', `curve ${i} has dimension ${c.dim}; curve 0 has ${first.dim}`, {
        index: i,
      });
    }
    if (c.basis.kind !== first.basis.kind) {
      fail('unsupported', `curve ${i} is ${c.basis.kind}; curve 0 is ${first.basis.kind}`, {
        index: i,
      });
    }
    const [a1, e1] = c.basis.domain;
    if (a1 !== a || e1 !== e) {
      fail(
        'size-mismatch',
        `curve ${i} has domain [${a1}, ${e1}]; curve 0 has [${a}, ${e}] (reparameterize first)`,
        {
          index: i,
        },
      );
    }
  }
  const h = first.dim + 1;
  const periodic = first.basis.kind === 'periodic';
  const pMax = Math.max(...cs.map((c) => c.basis.degree));
  const elevated = cs.map((c) => elevateDir(c.basis, c.cw, h, pMax - c.basis.degree, tl));

  // Unify near-coincident values across curves without chaining: values become
  // representatives greedily, most used first (ties: the smallest), unless a
  // representative is already within d; such a value snaps to the nearest
  // representative within d that no curve of its own already maps a knot to.
  // Representatives are pairwise ≥ d apart, so the merged knots are valid and no
  // knot moves by d or more. The ends never move: every curve uses them (most
  // used), and each curve's own knots are ≥ d from them.
  const d = tl.knotRel * (e - a);
  const values = mergedBreaks(
    Float64Array.from(elevated.flatMap((r) => Array.from(r.basis.knots as Float64Array))),
    Float64Array.of(a),
  );
  const users = values.map((v) =>
    elevated.flatMap((r, idx) => (multiplicity(r.basis.knots, v) > 0 ? [idx] : [])),
  );
  const order = values
    .map((_, i) => i)
    .sort((i, j) => users[j]!.length - users[i]!.length || i - j);
  const reps: number[] = []; // representative values
  const claimed: Set<number>[] = []; // per representative, the curves mapped onto it
  const rep = new Map<number, number>();
  for (const i of order) {
    const v = values[i]!;
    const near = [...reps.keys()]
      .filter((k) => Math.abs(reps[k]! - v) < d)
      .sort((k, l) => Math.abs(reps[k]! - v) - Math.abs(reps[l]! - v) || reps[k]! - reps[l]!);
    if (near.length === 0) {
      reps.push(v);
      claimed.push(new Set(users[i]));
      rep.set(v, v);
      continue;
    }
    const k = near.find((k) => users[i]!.every((c) => !claimed[k]!.has(c)));
    if (k === undefined) {
      const c = users[i]!.find((c) => claimed[near[0]!]!.has(c))!;
      fail(
        'knots-near-coincident',
        `curve ${c}: knot ${v} would merge with another of its knots on unifying near-coincident knots at ${reps[near[0]!]}`,
        { index: c, t: v },
      );
    }
    for (const c of users[i]!) claimed[k]!.add(c);
    rep.set(v, reps[k]!);
  }
  let maxKnotShift = 0;
  let maxDeviation = 0;
  const moved = elevated.map((r, idx): DirNet => {
    const U = r.basis.knots;
    const V = Float64Array.from(U as Float64Array, (x) => rep.get(x) ?? x);
    let shift = 0;
    for (let i = 0; i < U.length; i++) shift = Math.max(shift, Math.abs(V[i]! - U[i]!));
    if (shift === 0) return r;
    maxKnotShift = Math.max(maxKnotShift, shift);
    const basis = periodic
      ? periodicBasis(pMax, V, (r.basis as PeriodicBasis).period, tl)
      : clampedBasis(pMax, V, tl);
    const next = { basis, Pw: r.Pw };
    // Compare as clamped curves (periodic: both unrolled at t_0, which never moves).
    const A = periodic ? subDir(r.basis, r.Pw, h, a, a, tl) : r;
    const B = periodic ? subDir(basis, r.Pw, h, a, a, tl) : next;
    maxDeviation = Math.max(
      maxDeviation,
      deviationBound(pMax, A.basis.knots, A.Pw, B.basis.knots, B.Pw, first.dim, cs[idx]!.rational),
    );
    return next;
  });

  // Merge: every value with the largest multiplicity any curve has.
  const need = new Map<number, number>();
  for (const r of moved) {
    const U = r.basis.knots;
    for (let i = 0; i < U.length; i = runEnd(U, i) + 1) {
      const x = U[i]!;
      need.set(x, Math.max(need.get(x) ?? 0, runEnd(U, i) - i + 1));
    }
  }
  const curves = moved.map((r, idx) => {
    const X: number[] = [];
    for (const [x, m] of need) {
      if (!periodic && (x === a || x === e)) continue;
      for (let k = multiplicity(r.basis.knots, x); k < m; k++) X.push(x);
    }
    return rebuild<C>(cs[idx]!, refineDir(r.basis, r.Pw, h, X, tl));
  });
  return Object.freeze({ curves: Object.freeze(curves), maxKnotShift, maxDeviation });
}
