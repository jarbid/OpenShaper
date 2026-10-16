// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Point inversion and closest points on curves and surfaces (design §6.14,
 * algorithm §11.2).
 *
 * The squared distance `D = |X − P|² / 2` is minimised over the parameter
 * domain in two stages:
 *
 * 1. **Global seeding.** Every non-empty span (span pair on a surface) is a
 *    cell. By the convex-hull property (positive weights) a cell's piece of the
 *    curve or surface lies in the bounding box of its `p + 1` (`(p + 1)(q + 1)`)
 *    control points, so the distance from `P` to that box is a lower bound for
 *    the whole cell. Cells are visited in order of that bound (a binary heap)
 *    and each visited cell is sampled on a uniform grid of `oversample · p + 1`
 *    parameters per direction (§11.2: `2p + 1`, the derivative of `D` has at
 *    most `2p − 1` roots per polynomial span). A cell whose bound is not below
 *    the `starts`-th best sampled distance cannot contribute a better seed, so
 *    the visit stops there: the pruning loses nothing the full sampling would
 *    have found. The best sample of each of the `starts` best cells seeds
 *    Newton; the closest result wins. Sampling is not a proof: a valley
 *    narrower than the sample spacing, or a near-tie with another valley, can
 *    be missed. Measured (geom-core.md §11.2): on graph- and tube-like nets
 *    2 of 2,720 points landed on a near-tie (within 1% of the global
 *    distance); on fully random, self-folding nets ~2% of points miss.
 *    `seeding` trades cost for density.
 * 2. **Newton** (P&T §6.1, eqs. 6.3 for curves and 6.4–6.8 for surfaces) on
 *    `∇D = (r·Su, r·Sv)` with `r = S − P` and Jacobian
 *    `[[|Su|² + r·Suu, Su·Sv + r·Suv], [·, |Sv|² + r·Svv]]`, safeguarded:
 *    - **descent:** a step that increases the distance is rejected and retried
 *      with Levenberg–Marquardt damping (`J + λ·diag(G)`, `G` the Gauss–Newton
 *      part `[[|Su|², ·], [·, |Sv|²]]`, each diagonal entry floored at
 *      `LM_DIAG_FLOOR · tr(G)`, so the damped matrix is positive definite and
 *      the step turns towards scaled steepest descent as `λ` grows). The
 *      per-row scaling matters at a pole: there `|Su| → 0`, and a uniform
 *      `λ·tr(G)` damps the u row by `|Sv|²/|Su|²` and freezes it); an accepted
 *      step resets `λ` to 0, so the final iterations are undamped Newton and
 *      converge quadratically. Near a minimum the distance is flat to
 *      rounding over parameter steps of ~√ε (its change is second order in
 *      the step), so comparing distances alone would reject good Newton steps
 *      and stop ~√ε short in the parameters. A step that raises the
 *      distance by no more than `point` is therefore accepted when it lowers
 *      the zero-cosine measure (the gradient, accurate to ε): the iteration
 *      then reaches `cosine` or `paramRel`;
 *    - **domain and kinks:** Newton works inside one C¹ patch: the domain cut
 *      at the C⁰ breaks (knots of multiplicity ≥ degree, where the derivative
 *      jumps and Newton would oscillate across). Iterates are projected onto
 *      the patch (P&T §6.1: "clamp"); a periodic direction without breaks
 *      iterates freely and wraps when evaluated. A parameter on a patch bound
 *      whose gradient points out of the patch is *active* (the bound's KKT
 *      condition holds), and Newton continues in the free direction only: 1D
 *      Newton on the bounding iso-curve (§11.2). A result held at a C⁰ break
 *      restarts in the neighbouring patch and moves on while that lowers the
 *      distance; a result that stays is a kink minimum. A seed starts in the
 *      patch of the cell it was sampled in;
 *    - **second order:** the zero-cosine test holds at any stationary point,
 *      and trivially where a partial vanishes (`|S′| = 0`: coincident end
 *      control points, a collapsed edge), whatever the point; a bound whose
 *      gradient is negligible is not held by it. So where the test holds,
 *      the Hessian of `D` over the directions with a negligible gradient is
 *      checked: a direction of negative curvature `κ` (an axis, or the
 *      eigenvector of a negative eigenvalue) that stays in the patch is
 *      stepped by `h = √(−2κ / |S_ee|²)`, the minimum of the quartic model
 *      `D + ½κh² + ⅛|S_ee|²h⁴` (exact for `S′ = 0` on a quadratic; skipped
 *      when the model's gain is below the rounding of the distance), halved
 *      until the distance drops or the step reaches `paramRel`, and Newton
 *      resumes from there. A maximum or saddle is therefore never returned as
 *      converged (unless the cap cuts the escape short: then `converged` is
 *      false);
 *    - **stop:** P&T's zero-cosine test `|r·Su| ≤ cosine · |r| · |Su|` in every
 *      free direction, or a parameter step `≤ paramRel ×` the domain length in
 *      every direction (accepted, or rejected because even that step cannot
 *      lower the distance at rounding level: a minimum to parameter
 *      resolution, also at a C⁰ kink). P&T's point-coincidence test
 *      (`|r| ≤ point`) does **not** stop the iteration: it would leave the
 *      parameters off by up to `point / |Su|` (six orders above `paramRel`),
 *      while one or two more steps reach `paramRel`. It only decides
 *      `converged` when `newtonMaxIter` cuts the iteration short.
 *
 * Every Newton trial (an evaluation, or a damping increase), across all
 * patches of one start, counts towards `newtonMaxIter`. Results always carry
 * the best point found, its distance, `converged` (a stationary point by the
 * tests above, or on the geometry within `point`) and the Newton iterations
 * of the returned start.
 *
 * Local starts (§11.2: "warm start from the previous point's result, falling
 * back to seeding when Newton fails"). A caller's `seed` (single queries) or
 * `seeds` (batches) is a local projection: the converged Newton result from
 * it is returned, and only a start that does not converge is seeded
 * globally. A `warmStart` batch starts each point from the previous result
 * and keeps it if it converged within the continuity bound
 * `d_i ≤ d_{i−1} + |P_i − P_{i−1}| + point` (which the global minimum always
 * satisfies, the distance to a set being 1-Lipschitz); otherwise the point is
 * seeded globally. A warm batch therefore follows one branch continuously:
 * where another branch becomes closer without breaking the bound, it keeps
 * the branch it is on (what a pcurve or a tracked point wants), and a cold
 * batch is the global answer. A warm result within `point` of the geometry is
 * always global, so the samples of a curve lying on a surface are exact.
 *
 * Trimmed surfaces (`closestPointOnTrimmed`) land with trimming in step B2:
 * they need trim-loop classification.
 */
import { checkOut, makeScratch } from './array';
import type { ScratchImpl } from './array';
import { checkParam, evalBasisInto, sanitizeParam, spanOf } from './basis';
import { wrapParam } from './book/periodic';
import { checkBasisShape, evalCurveSpan } from './curve';
import { fail } from './errors';
import { checkSurfaceShape, evalSurfaceSpan, spanOffsets } from './surface';
import { resolveTolerances } from './tolerance';
import type { Tolerances } from './tolerance';
import type {
  Basis,
  Dim,
  Interval,
  NurbsCurve,
  NurbsSurface,
  Point3,
  PointOf,
  ReadonlyF64,
  SurfaceEdge,
  UV,
} from './types';

// ---------------------------------------------------------------------------
// Public records and options
// ---------------------------------------------------------------------------

/** The closest point on a curve. */
export interface CurveProjection<D extends Dim> {
  /** Parameter of the closest point (wrapped into the domain for a periodic curve). */
  readonly t: number;
  readonly point: PointOf<D>;
  /** `|point − p|`. */
  readonly distance: number;
  /** Newton reached a stationary point (§11.2), or a point on the curve within `point`. */
  readonly converged: boolean;
  /** Newton iterations of the returned start. */
  readonly iterations: number;
}

/** The closest point on a surface. */
export interface SurfaceProjection {
  /** Parameters of the closest point (wrapped into the domain in periodic directions). */
  readonly uv: UV;
  readonly point: Point3;
  /** `|point − p|`. */
  readonly distance: number;
  /** Newton reached a stationary point (§11.2), or a point on the surface within `point`. */
  readonly converged: boolean;
  /** Newton iterations of the returned start. */
  readonly iterations: number;
  /** The clamped domain edge the point lies on (u checked before v), else `false`. `'trim'` from B2. */
  readonly onBoundary: false | SurfaceEdge | 'trim';
}

/**
 * Global seeding density (§11.2). Each cell (non-empty span, or span pair) is
 * sampled at `oversample · p + 1` parameters per direction, ends included,
 * and the best samples of the `starts` best cells each start Newton.
 */
export interface ProjectionSeeding {
  /** Samples per span and direction are `oversample · degree + 1`. */
  readonly oversample: number;
  /** Newton starts from the best cells. */
  readonly starts: number;
}

/**
 * `oversample: 2` gives §11.2's `2p + 1` samples per span: the derivative of
 * the squared distance has at most `2p − 1` roots on a polynomial span, so
 * every valley of a well-shaped span is sampled. `starts: 3` covers a point
 * nearly equidistant from two or three branches (the inside of a bend, a
 * saddle) at three Newton runs; the brute-force tests are the check.
 */
export const DEFAULT_PROJECTION_SEEDING: ProjectionSeeding = Object.freeze({
  oversample: 2,
  starts: 3,
});

/** Damping growth after a rejected step (Marquardt's factor). */
const LM_GROWTH = 10;

/**
 * Floor of a damped diagonal entry, relative to `|Su|² + |Sv|²`. Marquardt's
 * scaling damps each row by its own `|S_k|²`; where that vanishes (a pole,
 * a collapsed edge) the row would get no damping at all, so it is floored at
 * the rounding level of the trace: positive, and below anything that changes
 * a row whose partial is not rounding noise.
 */
const LM_DIAG_FLOOR = Number.EPSILON;

/**
 * Smallest gain worth a second-order escape, relative to `|r|²`. The
 * quartic model's minimum lowers `|r|²` by `κ² / |S_ee|²`; below the
 * rounding of `|r|²` itself the gain cannot be measured (a point at a centre
 * of curvature, where the distance is flat and `κ` is rounding noise), and
 * the halving search would only spend iterations.
 */
const ESCAPE_GAIN_FLOOR = Number.EPSILON;

// ---------------------------------------------------------------------------
// Shared internals
// ---------------------------------------------------------------------------

/** One Newton outcome (mutable, internal; reused across a batch). */
export interface Outcome {
  x: number;
  y: number;
  d2: number;
  iters: number;
  converged: boolean;
  /** Active patch bound per direction at the result: −1 lower, +1 upper, 0 none. */
  aU: number;
  aV: number;
}

const newOutcome = (): Outcome => ({
  x: 0,
  y: 0,
  d2: Infinity,
  iters: 0,
  converged: false,
  aU: 0,
  aV: 0,
});

function copyOutcome(dst: Outcome, src: Outcome): void {
  dst.x = src.x;
  dst.y = src.y;
  dst.d2 = src.d2;
  dst.iters = src.iters;
  dst.converged = src.converged;
  dst.aU = src.aU;
  dst.aV = src.aV;
}

/** A local result is kept when Newton converged. */
const isConverged = (o: Outcome): boolean => o.converged;

/** Keeps `o` if it is closer than `best` (ties keep `best`). */
function keepBetter(best: Outcome, o: Outcome): void {
  if (o.d2 < best.d2) copyOutcome(best, o);
}

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/** P&T's zero-cosine measure `|r·S′| / (|r|·|S′|)` from `f = r·S′`, `d2 = |r|²`, `g = |S′|²` (0 if either vanishes). */
function cosineOf(f: number, d2: number, g: number): number {
  const den = Math.sqrt(d2 * g);
  return den > 0 ? Math.abs(f) / den : 0;
}

/** Merges seeding options over the default and validates them (internal; shared with curve-on-surface.ts). */
export function checkSeeding(s: Partial<ProjectionSeeding> | undefined): ProjectionSeeding {
  if (s === undefined) return DEFAULT_PROJECTION_SEEDING;
  const out = { ...DEFAULT_PROJECTION_SEEDING, ...s };
  for (const key of ['oversample', 'starts'] as const) {
    const v = out[key];
    if (!Number.isInteger(v) || v < 1) {
      fail('unsupported', `seeding ${key} must be an integer ≥ 1; got ${String(v)}`, { value: v });
    }
  }
  return out;
}

/** Squared distance from `P[po …]` to the box `B[bo …]` (`[min_0, max_0, min_1, …]`), `dim` coordinates. */
function boxDist2(P: Float64Array, B: Float64Array, bo: number, dim: number): number {
  let d2 = 0;
  for (let k = 0; k < dim; k++) {
    const x = P[k]!;
    const lo = B[bo + 2 * k]!;
    const hi = B[bo + 2 * k + 1]!;
    const e = x < lo ? lo - x : x > hi ? x - hi : 0;
    d2 += e * e;
  }
  return d2;
}

/** Grows box `B[bo …]` to contain the Euclidean point `cw[q …] / w`. */
function growBox(B: Float64Array, bo: number, cw: ReadonlyF64, q: number, dim: number): void {
  const w = cw[q + dim]!;
  for (let k = 0; k < dim; k++) {
    const x = cw[q + k]! / w;
    if (x < B[bo + 2 * k]!) B[bo + 2 * k] = x;
    if (x > B[bo + 2 * k + 1]!) B[bo + 2 * k + 1] = x;
  }
}

function emptyBox(B: Float64Array, bo: number, dim: number): void {
  for (let k = 0; k < dim; k++) {
    B[bo + 2 * k] = Infinity;
    B[bo + 2 * k + 1] = -Infinity;
  }
}

/**
 * A binary min-heap of cell indices keyed by `key` (lower bounds), built in
 * O(n) and popped in O(log n): cells are visited in order of their bound
 * without sorting all of them.
 */
interface Heap {
  readonly idx: Int32Array;
  size: number;
}

function heapify(h: Heap, key: Float64Array, n: number): void {
  for (let i = 0; i < n; i++) h.idx[i] = i;
  h.size = n;
  for (let i = (n >> 1) - 1; i >= 0; i--) siftDown(h, key, i);
}

function siftDown(h: Heap, key: Float64Array, i0: number): void {
  const a = h.idx;
  let i = i0;
  for (;;) {
    const l = 2 * i + 1;
    if (l >= h.size) return;
    const r = l + 1;
    const m = r < h.size && key[a[r]!]! < key[a[l]!]! ? r : l;
    if (!(key[a[m]!]! < key[a[i]!]!)) return;
    const t = a[i]!;
    a[i] = a[m]!;
    a[m] = t;
    i = m;
  }
}

function heapPop(h: Heap, key: Float64Array): number {
  const a = h.idx;
  const top = a[0]!;
  h.size--;
  a[0] = a[h.size]!;
  siftDown(h, key, 0);
  return top;
}

/**
 * The `starts` best seeds (one per cell), sorted by distance: `d2[k]`, `x[k]`,
 * `y[k]`, `count` filled.
 */
interface Seeds {
  readonly d2: Float64Array;
  readonly x: Float64Array;
  readonly y: Float64Array;
  /**
   * Per seed, bit 0 (u) and bit 1 (v): the seed starts in the patch above its
   * parameter. Clear for a sample on its cell's upper end, so a seed on a C⁰
   * break starts in the cell it was sampled in.
   */
  readonly up: Uint8Array;
  count: number;
}

function newSeeds(n: number): Seeds {
  return {
    d2: new Float64Array(n),
    x: new Float64Array(n),
    y: new Float64Array(n),
    up: new Uint8Array(n),
    count: 0,
  };
}

/** The squared distance a cell's bound must beat to matter: the worst kept seed once all are filled. */
function seedThreshold(s: Seeds): number {
  return s.count < s.d2.length ? Infinity : s.d2[s.count - 1]!;
}

/** Inserts a cell's best sample, keeping the list sorted; equal starts are kept once. */
function offerSeed(s: Seeds, d2: number, x: number, y: number, up: number): void {
  for (let k = 0; k < s.count; k++) if (s.x[k] === x && s.y[k] === y && s.up[k] === up) return;
  const cap = s.d2.length;
  if (s.count === cap && !(d2 < s.d2[cap - 1]!)) return;
  let k = s.count < cap ? s.count++ : cap - 1;
  while (k > 0 && s.d2[k - 1]! > d2) {
    s.d2[k] = s.d2[k - 1]!;
    s.x[k] = s.x[k - 1]!;
    s.y[k] = s.y[k - 1]!;
    s.up[k] = s.up[k - 1]!;
    k--;
  }
  s.d2[k] = d2;
  s.x[k] = x;
  s.y[k] = y;
  s.up[k] = up;
}

/** Seed bit for a direction: the patch above, unless the sample is on its cell's upper end. */
const UP_U = 1;
const UP_V = 2;

/**
 * The cells of one direction: its non-empty spans, `[a_k, b_k]` in the stored
 * period's coordinates (so evaluation with span `span_k` never wraps), plus
 * `off_k`, the shift to the iteration parameter `x = t + off_k`.
 */
export interface Cells {
  readonly n: number;
  readonly a: Float64Array;
  readonly b: Float64Array;
  readonly off: Float64Array;
  readonly span: Int32Array;
}

/** Span `k`'s knot interval in stored coordinates; a periodic basis' last span ends at `t_0 + T`. */
function spanEnds(b: Basis, k: number): [number, number] {
  const U = b.knots;
  if (b.kind === 'clamped') return [U[k]!, U[k + 1]!];
  return [U[k]!, k + 1 < b.count ? U[k + 1]! : U[0]! + b.period];
}

/** The cells of a whole direction: clamped spans `p … count − 1`, or one period (internal; shared with curve-on-surface.ts). */
export function directionCells(b: Basis): Cells {
  const k0 = b.kind === 'clamped' ? b.degree : 0;
  const spans: number[] = [];
  for (let k = k0; k < b.count; k++) {
    const [a, e] = spanEnds(b, k);
    if (e > a) spans.push(k);
  }
  const n = spans.length;
  const cells = {
    n,
    a: new Float64Array(n),
    b: new Float64Array(n),
    off: new Float64Array(n),
    span: Int32Array.from(spans),
  };
  spans.forEach((k, i) => {
    const [a, e] = spanEnds(b, k);
    cells.a[i] = a;
    cells.b[i] = e;
  });
  return cells;
}

/**
 * The cells of `[lo, hi]` (iteration coordinates): clamped, the spans it
 * meets, cut to it; periodic, the spans met walking forward from `lo` across
 * period boundaries (`hi − lo ≤ T`), each cut to the range.
 */
function rangeCells(b: Basis, lo: number, hi: number): Cells {
  const a: number[] = [];
  const e: number[] = [];
  const off: number[] = [];
  const span: number[] = [];
  if (b.kind === 'clamped') {
    for (let k = b.degree; k < b.count; k++) {
      const [ka, kb] = spanEnds(b, k);
      const ca = ka > lo ? ka : lo;
      const cb = kb < hi ? kb : hi;
      if (kb > ka && cb > ca) {
        a.push(ca);
        e.push(cb);
        off.push(0);
        span.push(k);
      }
    }
  } else {
    const start = wrapParam(b.domain[0], b.period, lo);
    let shift = lo - start;
    let k = spanOf(b, start, false);
    let ca = start;
    for (;;) {
      const [, kb] = spanEnds(b, k);
      const end = hi - shift;
      const cb = kb < end ? kb : end;
      if (cb > ca) {
        a.push(ca);
        e.push(cb);
        off.push(shift);
        span.push(k);
      }
      if (!(kb < end)) break;
      k++;
      if (k === b.count) {
        k = 0;
        shift += b.period;
      }
      ca = spanEnds(b, k)[0];
    }
  }
  return {
    n: a.length,
    a: Float64Array.from(a),
    b: Float64Array.from(e),
    off: Float64Array.from(off),
    span: Int32Array.from(span),
  };
}

/** The `i`-th of `m` uniform samples of `[a, b]`, ends exact and never outside (internal; shared). */
export function sampleAt(a: number, b: number, i: number, m: number): number {
  if (i === m - 1) return b;
  const t = a + ((b - a) * i) / (m - 1);
  return t < b ? t : b;
}

// ---------------------------------------------------------------------------
// C¹ patches
// ---------------------------------------------------------------------------

/**
 * The C⁰ breaks of a direction: knot values of multiplicity `≥ degree` inside
 * the domain (one period, seam included, for a periodic basis), ascending.
 * Across a break the derivative jumps, so Newton never steps over one.
 */
function c0Breaks(b: Basis): Float64Array {
  const U = b.knots;
  const p = b.degree;
  // Clamped: the interior knots U[p+1 .. count−1]; periodic: the whole period.
  const start = b.kind === 'clamped' ? p + 1 : 0;
  const end = b.count;
  const out: number[] = [];
  let i = start;
  while (i < end) {
    let j = i;
    while (j + 1 < end && U[j + 1] === U[i]) j++;
    if (j - i + 1 >= p) out.push(U[i]!);
    i = j + 1;
  }
  return Float64Array.from(out);
}

/** One direction of an iteration: its basis, outer bounds and C⁰ breaks. */
interface Dir {
  readonly b: Basis;
  /** Outer bounds apply: a clamped domain, or a curve's range. */
  readonly bounded: boolean;
  readonly lo: number;
  readonly hi: number;
  readonly breaks: Float64Array;
}

/**
 * Writes the C¹ patch of `d` containing iteration parameter `x` to
 * `out[o]`, `out[o + 1]` (±Infinity where unbounded). On a break, `up` picks
 * the patch above it, else the one below. Periodic breaks repeat every
 * period; their copies are formed as `break + m·T` for the periods around
 * `x`, the same expression every time, so a bound found here is found again
 * bit for bit when `x` sits on it.
 */
function patchOf(d: Dir, x: number, up: boolean, out: Float64Array, o: number): void {
  let lo = -Infinity;
  let hi = Infinity;
  const B = d.breaks;
  const b = d.b;
  const scan = (c: number): void => {
    if (up ? c <= x : c < x) {
      if (c > lo) lo = c;
    } else if (c < hi) hi = c;
  };
  if (b.kind === 'clamped') {
    for (let k = 0; k < B.length; k++) scan(B[k]!);
  } else if (B.length > 0) {
    const T = b.period;
    const m = Math.floor((x - b.domain[0]) / T);
    for (let j = m - 1; j <= m + 1; j++) for (let k = 0; k < B.length; k++) scan(B[k]! + j * T);
  }
  if (d.bounded) {
    if (!(lo > d.lo)) lo = d.lo;
    if (!(hi < d.hi)) hi = d.hi;
  }
  out[o] = lo;
  out[o + 1] = hi;
}

/** Whether a patch bound is a C⁰ break (another patch lies beyond it), not an outer bound. */
const isBreak = (d: Dir, bound: number): boolean =>
  Number.isFinite(bound) && !(d.bounded && (bound === d.lo || bound === d.hi));

// ---------------------------------------------------------------------------
// Curves
// ---------------------------------------------------------------------------

/** Everything one curve query (or a batch) needs, prepared once. */
interface CurveProblem {
  readonly c: NurbsCurve;
  readonly dim: number;
  /** Iteration bounds apply (clamped curve, or a range). */
  readonly bounded: boolean;
  readonly lo: number;
  readonly hi: number;
  readonly dir: Dir;
  /** The current C¹ patch and a neighbour (2 values each). */
  readonly patch: Float64Array;
  readonly patch2: Float64Array;
  /** Parameter-step stop: `paramRel ×` the domain length or period. */
  readonly stepTol: number;
  readonly cells: Cells;
  /** Per cell: the control points' box (`2 · dim` values). */
  readonly box: Float64Array;
  /** Per cell: lower bound of the squared distance (rewritten per query). */
  readonly lb: Float64Array;
  readonly heap: Heap;
  /** Samples per cell. */
  readonly m: number;
  readonly seeds: Seeds;
  readonly tol: Tolerances;
  readonly sc: ScratchImpl;
  /** The query point. */
  readonly P: Float64Array;
  /** `[C, C′, C″]` of the current iterate. */
  readonly cur: Float64Array;
  readonly trial: Outcome;
  readonly best: Outcome;
  /** A local (seeded or warm) result kept while global seeding runs. */
  readonly keep: Outcome;
  /** A Newton run in a neighbouring patch. */
  readonly cross: Outcome;
}

function checkCurve(c: NurbsCurve, what: string): void {
  if (typeof c !== 'object' || c === null) fail('size-mismatch', `${what}: expected a curve`);
  checkBasisShape(c.basis);
  if (!(c.cw instanceof Float64Array) || c.cw.length !== c.basis.count * (c.dim + 1)) {
    fail('size-mismatch', `${what}: curve net does not match its basis (use makeCurve)`);
  }
  if (c.dim !== 2 && c.dim !== 3) {
    fail('dimension-mismatch', `${what} needs a 2D or 3D curve; got dimension ${c.dim}`, {
      value: c.dim,
    });
  }
}

function prepareCurve(
  c: NurbsCurve,
  range: Interval | undefined,
  tol: Tolerances,
  seeding: ProjectionSeeding,
): CurveProblem {
  const b = c.basis;
  const [d0, d1] = b.domain;
  const L = d1 - d0;
  let bounded = b.kind === 'clamped';
  let lo = d0;
  let hi = d1;
  let cells: Cells;
  if (range === undefined) {
    cells = directionCells(b);
  } else {
    const [r0, r1] = range;
    if (!Number.isFinite(r0) || !Number.isFinite(r1)) {
      fail('non-finite', `range [${r0}, ${r1}] is not finite`);
    }
    if (!(r1 > r0)) fail('empty-domain', `range [${r0}, ${r1}] is empty`);
    const slack = tol.paramRel * L;
    if (b.kind === 'clamped') {
      if (r0 < d0 - slack || r1 > d1 + slack) {
        fail('param-out-of-domain', `range [${r0}, ${r1}] leaves the domain [${d0}, ${d1}]`, {
          value: r0,
        });
      }
      lo = clamp(r0, d0, d1);
      hi = clamp(r1, d0, d1);
      if (!(hi > lo)) fail('empty-domain', `range [${r0}, ${r1}] is empty in the domain`);
    } else {
      if (r1 - r0 > b.period + slack) {
        fail('unsupported', `range [${r0}, ${r1}] is longer than the period ${b.period}`, {
          value: r1 - r0,
        });
      }
      lo = r0;
      hi = r1 - r0 > b.period ? r0 + b.period : r1;
    }
    bounded = true;
    cells = rangeCells(b, lo, hi);
  }
  const dim = c.dim;
  const h = dim + 1;
  const p = b.degree;
  const box = new Float64Array(cells.n * 2 * dim);
  for (let i = 0; i < cells.n; i++) {
    emptyBox(box, i * 2 * dim, dim);
    const k = cells.span[i]!;
    for (let j = 0; j <= p; j++) {
      let idx = k - p + j;
      if (idx < 0) idx += b.count;
      growBox(box, i * 2 * dim, c.cw, idx * h, dim);
    }
  }
  return {
    c,
    dim,
    bounded,
    lo,
    hi,
    dir: { b, bounded, lo, hi, breaks: c0Breaks(b) },
    patch: new Float64Array(2),
    patch2: new Float64Array(2),
    stepTol: tol.paramRel * L,
    cells,
    box,
    lb: new Float64Array(cells.n),
    heap: { idx: new Int32Array(cells.n), size: 0 },
    m: seeding.oversample * p + 1,
    seeds: newSeeds(seeding.starts),
    tol,
    sc: makeScratch(p, 2),
    P: new Float64Array(3),
    cur: new Float64Array(9),
    trial: newOutcome(),
    best: newOutcome(),
    keep: newOutcome(),
    cross: newOutcome(),
  };
}

/** Squared distance from `pr.P` to `C` at `sc.f[sc.oC …]`. */
function curveDist2(pr: CurveProblem): number {
  const f = pr.sc.f;
  const o = pr.sc.oC;
  let d2 = 0;
  for (let k = 0; k < pr.dim; k++) {
    const e = f[o + k]! - pr.P[k]!;
    d2 += e * e;
  }
  return d2;
}

/**
 * Evaluates `[C, C′, C″]` at iteration parameter `x` (clamped or wrapped),
 * from the left when `left` (the upper bound of a patch), and returns `|C − P|²`.
 */
function curveEvalAt(pr: CurveProblem, x: number, left = false): number {
  const b = pr.c.basis;
  const u = sanitizeParam(b, x);
  evalCurveSpan(pr.c, u, spanOf(b, u, left), 2, pr.sc);
  return curveDist2(pr);
}

/** Global seeding (§11.2) into `pr.seeds`. */
function seedCurve(pr: CurveProblem): void {
  const { cells, box, lb, heap, seeds, dim, m, sc } = pr;
  for (let i = 0; i < cells.n; i++) lb[i] = boxDist2(pr.P, box, i * 2 * dim, dim);
  heapify(heap, lb, cells.n);
  seeds.count = 0;
  while (heap.size > 0) {
    const i = heap.idx[0]!;
    if (!(lb[i]! < seedThreshold(seeds))) break;
    heapPop(heap, lb);
    const a = cells.a[i]!;
    const e = cells.b[i]!;
    const k = cells.span[i]!;
    let bd = Infinity;
    let bt = a;
    for (let j = 0; j < m; j++) {
      const t = sampleAt(a, e, j, m);
      evalCurveSpan(pr.c, t, k, 0, sc);
      const d2 = curveDist2(pr);
      if (d2 < bd) {
        bd = d2;
        bt = t;
      }
    }
    offerSeed(seeds, bd, bt + cells.off[i]!, 0, bt < e ? UP_U : 0);
  }
}

/**
 * Safeguarded Newton (P&T eq. 6.3) from iteration parameter `x0` inside the
 * patch `[lo, hi]` (±Infinity where unbounded); see the module comment for
 * damping, bounds and stopping. Sets `out.aU` to the active bound.
 */
function newtonCurvePatch(
  pr: CurveProblem,
  x0: number,
  lo: number,
  hi: number,
  out: Outcome,
): void {
  const { dim, tol, cur, P, sc, stepTol } = pr;
  const f = sc.f;
  const o = sc.oC;
  const n3 = 3 * dim;
  let x = clamp(x0, lo, hi);
  let d2 = curveEvalAt(pr, x, x >= hi);
  for (let k = 0; k < n3; k++) cur[k] = f[o + k]!;
  let iters = 0;
  let lambda = 0;
  let converged = false;
  let active = 0;
  for (;;) {
    let fr = 0;
    let g = 0;
    let rc2 = 0;
    for (let k = 0; k < dim; k++) {
      const r = cur[k]! - P[k]!;
      const c1 = cur[dim + k]!;
      fr += r * c1;
      g += c1 * c1;
      rc2 += r * cur[2 * dim + k]!;
    }
    active = x <= lo && fr >= 0 ? -1 : x >= hi && fr <= 0 ? 1 : 0;
    if (d2 === 0) {
      converged = true;
      break;
    }
    const cos = cosineOf(fr, d2, g);
    if (cos <= tol.cosine) {
      // Stationary to first order, also where C′ vanishes (cosine 0 whatever
      // r is): a minimum only if D″ = |C′|² + r·C″ ≥ 0 (module comment).
      const D2 = g + rc2;
      if (D2 < 0) {
        const e = escapeCurve(pr, x, d2, D2, lo, hi, iters);
        iters = e.iters;
        if (e.x !== x) {
          x = e.x;
          d2 = curveEvalAt(pr, x, x >= hi);
          for (let k = 0; k < n3; k++) cur[k] = f[o + k]!;
          lambda = 0;
          continue;
        }
        if (e.capped) break;
      }
      converged = true;
      break;
    }
    if (active !== 0) {
      // The bound's KKT condition with a gradient pointing out of the patch.
      converged = true;
      break;
    }
    if (iters >= tol.newtonMaxIter) break;
    iters++;
    const M = g + rc2 + lambda * g;
    if (!(M > 0)) {
      lambda = lambda === 0 ? 1 : lambda * LM_GROWTH;
      continue;
    }
    const xn = clamp(x - fr / M, lo, hi);
    const small = Math.abs(xn - x) <= stepTol;
    const d2n = curveEvalAt(pr, xn, xn >= hi);
    let accept = d2n <= d2;
    if (!accept && Math.sqrt(d2n) <= Math.sqrt(d2) + tol.point) {
      // Within `point` of a non-increase: decide by the gradient (module comment).
      let frn = 0;
      let gn = 0;
      for (let k = 0; k < dim; k++) {
        const c1 = f[o + dim + k]!;
        frn += (f[o + k]! - P[k]!) * c1;
        gn += c1 * c1;
      }
      accept = cosineOf(frn, d2n, gn) < cos;
    }
    if (accept) {
      x = xn;
      d2 = d2n;
      for (let k = 0; k < n3; k++) cur[k] = f[o + k]!;
      lambda = 0;
    } else {
      lambda = lambda === 0 ? 1 : lambda * LM_GROWTH;
    }
    if (small) {
      // A minimum to parameter resolution (also where the step could not lower the distance).
      converged = true;
      let fe = 0;
      for (let k = 0; k < dim; k++) fe += (cur[k]! - P[k]!) * cur[dim + k]!;
      active = x <= lo && fe >= 0 ? -1 : x >= hi && fe <= 0 ? 1 : 0;
      break;
    }
  }
  out.x = x;
  out.y = 0;
  out.d2 = d2;
  out.iters = iters;
  out.converged = converged || Math.sqrt(d2) <= tol.point;
  out.aU = active;
  out.aV = 0;
}

/**
 * The second-order escape from a first-order stationary point with negative
 * curvature `D2 = D″ < 0` (a maximum, or a zero tangent the point lies
 * behind). The quartic model `D(x + h) ≈ D + ½D″h² + ⅛|C″|²h⁴` (the
 * first-order term vanishes, and the cubic one with `C′`) is least at
 * `h² = −2D″ / |C″|²`; where `C′ = 0` this is Newton in `s = h²/2`, exact for
 * `C(t) = C + ½C″t²`. Skipped when the model's gain is below rounding
 * (`ESCAPE_GAIN_FLOOR`). Both feasible directions are tried, each step halved
 * until it lowers the distance or falls to `paramRel`; every evaluation counts
 * as an iteration. Returns the lowest point found (`x` itself if none) and
 * whether the iteration cap cut a search short.
 */
function escapeCurve(
  pr: CurveProblem,
  x: number,
  d2: number,
  D2: number,
  lo: number,
  hi: number,
  iters0: number,
): { x: number; iters: number; capped: boolean } {
  const { dim, cur, stepTol, tol } = pr;
  let c2 = 0;
  for (let k = 0; k < dim; k++) c2 += cur[2 * dim + k]! ** 2;
  let iters = iters0;
  let capped = false;
  let bx = x;
  let bd = d2;
  if (!(c2 > 0 && (D2 * D2) / c2 > ESCAPE_GAIN_FLOOR * d2)) return { x, iters, capped };
  const h0 = Math.sqrt((-2 * D2) / c2);
  for (const sgn of [1, -1]) {
    if (sgn > 0 ? !(x < hi) : !(x > lo)) continue;
    for (let h = h0; ; h /= 2) {
      const xn = clamp(x + sgn * h, lo, hi);
      if (!(Math.abs(xn - x) > stepTol)) break;
      if (iters >= tol.newtonMaxIter) {
        capped = true;
        break;
      }
      iters++;
      const dn = curveEvalAt(pr, xn, xn >= hi);
      if (dn < d2) {
        if (dn < bd) {
          bd = dn;
          bx = xn;
        }
        break;
      }
    }
  }
  return { x: bx, iters, capped: capped && bd === d2 };
}

/**
 * Newton from `x0` in its C¹ patch, then across C⁰ breaks: a result held at a
 * break by a gradient pointing out of the patch restarts in the neighbouring
 * patch, and moves on while that lowers the distance. A result that stays is
 * a kink minimum (stationary from both sides). All runs share
 * `newtonMaxIter`.
 */
function newtonCurve(pr: CurveProblem, x0: number, out: Outcome, up = true): void {
  const { dir, patch, patch2, cross, tol } = pr;
  const x = dir.bounded ? clamp(x0, dir.lo, dir.hi) : x0;
  patchOf(dir, x, up, patch, 0);
  newtonCurvePatch(pr, x, patch[0]!, patch[1]!, out);
  let iters = out.iters;
  while (out.aU !== 0 && iters < tol.newtonMaxIter) {
    const bound = out.aU > 0 ? patch[1]! : patch[0]!;
    if (!isBreak(dir, bound)) break;
    patchOf(dir, bound, out.aU > 0, patch2, 0);
    newtonCurvePatch(pr, out.x, patch2[0]!, patch2[1]!, cross);
    iters += cross.iters;
    if (!(cross.d2 < out.d2)) break;
    patch.set(patch2);
    copyOutcome(out, cross);
  }
  out.iters = iters;
}

/** Global search: Newton from every seed; the closest result lands in `pr.best`. */
function solveCurveSeeded(pr: CurveProblem): void {
  seedCurve(pr);
  pr.best.d2 = Infinity;
  for (let k = 0; k < pr.seeds.count; k++) {
    newtonCurve(pr, pr.seeds.x[k]!, pr.trial, (pr.seeds.up[k]! & UP_U) !== 0);
    keepBetter(pr.best, pr.trial);
    if (pr.best.d2 === 0) break;
  }
}

/**
 * A local start: Newton from `x0` into `pr.best`; when it fails `accept`, the
 * global search runs and the local result is kept only if nothing closer is
 * found.
 */
function solveCurveFrom(pr: CurveProblem, x0: number, accept: (o: Outcome) => boolean): void {
  newtonCurve(pr, x0, pr.best);
  if (accept(pr.best)) return;
  copyOutcome(pr.keep, pr.best);
  solveCurveSeeded(pr);
  keepBetter(pr.best, pr.keep);
}

/** The iteration parameter reported to callers: wrapped for a periodic curve. */
function reportedT(pr: CurveProblem, x: number): number {
  return sanitizeParam(pr.c.basis, x);
}

function readPoint(P: Float64Array, p: { x: number; y: number; z?: number }, dim: number): void {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || (dim === 3 && !Number.isFinite(p.z!))) {
    fail('non-finite', 'query point is not finite');
  }
  P[0] = p.x;
  P[1] = p.y;
  P[2] = dim === 3 ? p.z! : 0;
}

/**
 * The closest point on `c` (2D or 3D) to `p` (P&T §6.1 point inversion with
 * global seeding, §11.2). `range` restricts the search to `[r0, r1]`: inside
 * the domain for a clamped curve, at most one period long (and may cross the
 * seam) for a periodic one. `seed` starts Newton there instead of seeding
 * globally (a local projection, e.g. when tracking a moving point); global
 * seeding is used as well only if that Newton does not converge.
 */
export function closestPointOnCurve<D extends 2 | 3>(
  c: NurbsCurve<D>,
  p: PointOf<D>,
  opts?: {
    readonly seed?: number;
    readonly range?: Interval;
    readonly tol?: Partial<Tolerances>;
    readonly seeding?: Partial<ProjectionSeeding>;
  },
): CurveProjection<D> {
  checkCurve(c, 'closestPointOnCurve');
  const tol = resolveTolerances(opts?.tol);
  const pr = prepareCurve(c, opts?.range, tol, checkSeeding(opts?.seeding));
  readPoint(pr.P, p as { x: number; y: number; z?: number }, c.dim);
  pr.best.d2 = Infinity;
  if (opts?.seed !== undefined) {
    let x = checkParam(c.basis, opts.seed, undefined, tol);
    if (pr.bounded && c.basis.kind === 'periodic') {
      // Move the seed to the period of the range.
      x = pr.lo + wrapParam(0, c.basis.period, x - pr.lo);
    }
    solveCurveFrom(pr, x, isConverged);
  } else solveCurveSeeded(pr);
  const best = pr.best;
  const t = reportedT(pr, best.x);
  curveEvalAt(pr, best.x);
  const f = pr.sc.f;
  const o = pr.sc.oC;
  const point = (
    c.dim === 2 ? { x: f[o]!, y: f[o + 1]! } : { x: f[o]!, y: f[o + 1]!, z: f[o + 2]! }
  ) as PointOf<D>;
  return Object.freeze({
    t,
    point,
    distance: Math.sqrt(best.d2),
    converged: best.converged,
    iterations: best.iters,
  });
}

/** `|P_i − P_{i−1}|` for points of stride `dim`. */
function stepLength(pts: ReadonlyF64, i: number, dim: number): number {
  let d2 = 0;
  for (let k = 0; k < dim; k++) {
    const e = pts[i * dim + k]! - pts[(i - 1) * dim + k]!;
    d2 += e * e;
  }
  return Math.sqrt(d2);
}

function checkPoints(pts: ReadonlyF64, stride: number, what: string): number {
  if (pts.length % stride !== 0) {
    fail('size-mismatch', `${what}: points need stride ${stride}; got ${pts.length} values`, {
      value: pts.length,
    });
  }
  for (let i = 0; i < pts.length; i++) {
    if (!Number.isFinite(pts[i]!)) {
      fail('non-finite', `${what}: point ${Math.floor(i / stride)} is not finite`, {
        index: Math.floor(i / stride),
      });
    }
  }
  return pts.length / stride;
}

/**
 * Projects every point of `pts` (stride `c.dim`) onto `c`: parameters into
 * `outT[i]`, distances into `outDist[i]`. With `warmStart` each point starts
 * Newton from the previous result and is seeded globally only when that does
 * not converge or breaks the continuity bound (module comment): it follows a
 * branch along a dense path. Returns the number of points whose projection did
 * not converge.
 */
export function projectPointsToCurveInto(
  c: NurbsCurve<2> | NurbsCurve<3>,
  pts: ReadonlyF64,
  outT: Float64Array,
  outDist: Float64Array,
  opts?: {
    readonly warmStart?: boolean;
    readonly tol?: Partial<Tolerances>;
    readonly seeding?: Partial<ProjectionSeeding>;
  },
): number {
  checkCurve(c, 'projectPointsToCurveInto');
  const dim = c.dim;
  const n = checkPoints(pts, dim, 'projectPointsToCurveInto');
  checkOut(outT, 0, n, 'projectPointsToCurveInto (t)');
  checkOut(outDist, 0, n, 'projectPointsToCurveInto (distance)');
  const tol = resolveTolerances(opts?.tol);
  const pr = prepareCurve(c, undefined, tol, checkSeeding(opts?.seeding));
  const warm = opts?.warmStart === true;
  let failed = 0;
  let prevX = 0;
  let bound = 0;
  const continued = (o: Outcome): boolean => o.converged && Math.sqrt(o.d2) <= bound;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < dim; k++) pr.P[k] = pts[i * dim + k]!;
    if (warm && i > 0) {
      bound = Math.sqrt(pr.best.d2) + stepLength(pts, i, dim) + tol.point;
      solveCurveFrom(pr, prevX, continued);
    } else solveCurveSeeded(pr);
    const b = pr.best;
    prevX = b.x;
    outT[i] = reportedT(pr, b.x);
    outDist[i] = Math.sqrt(b.d2);
    if (!b.converged) failed++;
  }
  return failed;
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

/** Everything one surface query (or a batch) needs, prepared once. */
export interface SurfaceProblem {
  readonly s: NurbsSurface;
  readonly boundedU: boolean;
  readonly boundedV: boolean;
  readonly u0: number;
  readonly u1: number;
  readonly v0: number;
  readonly v1: number;
  readonly stepU: number;
  readonly stepV: number;
  readonly dirU: Dir;
  readonly dirV: Dir;
  /** The current C¹ patch `[ulo, uhi, vlo, vhi]` and a neighbour. */
  readonly patch: Float64Array;
  readonly patch2: Float64Array;
  readonly cu: Cells;
  readonly cv: Cells;
  /** Per cell pair `iu · cv.n + iv`: the control points' box (6 values). */
  readonly box: Float64Array;
  readonly lb: Float64Array;
  readonly heap: Heap;
  readonly mu: number;
  readonly mv: number;
  /** Sample bases of one cell (`mu × (p + 1)`, `mv × (q + 1)`) and its net offsets (rows, then columns). */
  readonly nu: Float64Array;
  readonly nv: Float64Array;
  readonly offs: Int32Array;
  readonly seeds: Seeds;
  readonly tol: Tolerances;
  readonly sc: ScratchImpl;
  readonly P: Float64Array;
  /** `[S, Su, Sv, Suu, Suv, Svv]` of the current iterate. */
  readonly cur: Float64Array;
  readonly trial: Outcome;
  readonly best: Outcome;
  /** A local (seeded or warm) result kept while global seeding runs. */
  readonly keep: Outcome;
  /** A Newton run in a neighbouring patch. */
  readonly cross: Outcome;
}

/** Prepares a surface for projection queries (internal; shared with curve-on-surface.ts). */
export function prepareSurface(
  s: NurbsSurface,
  tol: Tolerances,
  seeding: ProjectionSeeding,
): SurfaceProblem {
  const bu = s.u;
  const bv = s.v;
  const p = bu.degree;
  const q = bv.degree;
  const cu = directionCells(bu);
  const cv = directionCells(bv);
  const nPairs = cu.n * cv.n;
  const box = new Float64Array(nPairs * 6);
  // Per (row i, v cell) boxes first, then each pair joins p + 1 of them.
  const rowBox = new Float64Array(bu.count * cv.n * 6);
  const cols = new Int32Array(q + 1);
  for (let jv = 0; jv < cv.n; jv++) {
    spanOffsets(bv, cv.span[jv]!, 4, cols, 0);
    for (let i = 0; i < bu.count; i++) {
      const bo = (i * cv.n + jv) * 6;
      emptyBox(rowBox, bo, 3);
      const row = i * bv.count * 4;
      for (let c = 0; c <= q; c++) growBox(rowBox, bo, s.cw, row + cols[c]!, 3);
    }
  }
  for (let iu = 0; iu < cu.n; iu++) {
    const k = cu.span[iu]!;
    for (let jv = 0; jv < cv.n; jv++) {
      const bo = (iu * cv.n + jv) * 6;
      emptyBox(box, bo, 3);
      for (let r = 0; r <= p; r++) {
        let i = k - p + r;
        if (i < 0) i += bu.count;
        const ro = (i * cv.n + jv) * 6;
        for (let c = 0; c < 3; c++) {
          if (rowBox[ro + 2 * c]! < box[bo + 2 * c]!) box[bo + 2 * c] = rowBox[ro + 2 * c]!;
          if (rowBox[ro + 2 * c + 1]! > box[bo + 2 * c + 1]!) {
            box[bo + 2 * c + 1] = rowBox[ro + 2 * c + 1]!;
          }
        }
      }
    }
  }
  const [u0, u1] = bu.domain;
  const [v0, v1] = bv.domain;
  return {
    s,
    boundedU: bu.kind === 'clamped',
    boundedV: bv.kind === 'clamped',
    u0,
    u1,
    v0,
    v1,
    stepU: tol.paramRel * (u1 - u0),
    stepV: tol.paramRel * (v1 - v0),
    dirU: { b: bu, bounded: bu.kind === 'clamped', lo: u0, hi: u1, breaks: c0Breaks(bu) },
    dirV: { b: bv, bounded: bv.kind === 'clamped', lo: v0, hi: v1, breaks: c0Breaks(bv) },
    patch: new Float64Array(4),
    patch2: new Float64Array(4),
    cu,
    cv,
    box,
    lb: new Float64Array(nPairs),
    heap: { idx: new Int32Array(nPairs), size: 0 },
    mu: seeding.oversample * p + 1,
    mv: seeding.oversample * q + 1,
    nu: new Float64Array((seeding.oversample * p + 1) * (p + 1)),
    nv: new Float64Array((seeding.oversample * q + 1) * (q + 1)),
    offs: new Int32Array(p + q + 2),
    seeds: newSeeds(seeding.starts),
    tol,
    sc: makeScratch(p > q ? p : q, 2),
    P: new Float64Array(3),
    cur: new Float64Array(18),
    trial: newOutcome(),
    best: newOutcome(),
    keep: newOutcome(),
    cross: newOutcome(),
  };
}

function surfaceDist2(pr: SurfaceProblem): number {
  const f = pr.sc.f;
  const o = pr.sc.oS;
  const ex = f[o]! - pr.P[0]!;
  const ey = f[o + 1]! - pr.P[1]!;
  const ez = f[o + 2]! - pr.P[2]!;
  return ex * ex + ey * ey + ez * ez;
}

/**
 * Evaluates `SKL` to order 2 at iteration parameters (clamped or wrapped),
 * from the left in a direction whose flag is set (the upper bound of a
 * patch); returns `|S − P|²`.
 */
function surfaceEvalAt(pr: SurfaceProblem, x: number, y: number, lu = false, lv = false): number {
  const s = pr.s;
  const u = sanitizeParam(s.u, x);
  const v = sanitizeParam(s.v, y);
  evalSurfaceSpan(s, u, v, spanOf(s.u, u, lu), spanOf(s.v, v, lv), 2, pr.sc);
  return surfaceDist2(pr);
}

/**
 * Global seeding (§11.2): the best sample of each cell, cells visited by their
 * box bound. With `inside`, only samples it accepts are candidates (a trimmed
 * domain); a cell without one offers no seed.
 */
function seedSurface(
  pr: SurfaceProblem,
  inside: ((u: number, v: number) => boolean) | null = null,
): void {
  const { cu, cv, box, lb, heap, seeds, mu, mv, sc, s } = pr;
  const nPairs = cu.n * cv.n;
  for (let i = 0; i < nPairs; i++) lb[i] = boxDist2(pr.P, box, i * 6, 3);
  heapify(heap, lb, nPairs);
  seeds.count = 0;
  while (heap.size > 0) {
    const pair = heap.idx[0]!;
    if (!(lb[pair]! < seedThreshold(seeds))) break;
    heapPop(heap, lb);
    const iu = (pair / cv.n) | 0;
    const jv = pair - iu * cv.n;
    const ua = cu.a[iu]!;
    const ub = cu.b[iu]!;
    const va = cv.a[jv]!;
    const vb = cv.b[jv]!;
    const ku = cu.span[iu]!;
    const kv = cv.span[jv]!;
    let bd = Infinity;
    let bu = ua;
    let bv = va;
    // Separable sampling: the bases once per sample row and column, then
    // S = Σ Nu·Nv·Pw (A3.5 / A4.3 with the bases shared across the grid).
    const p = s.u.degree;
    const q = s.v.degree;
    const { nu, nv, offs } = pr;
    for (let a = 0; a < mu; a++) {
      evalBasisInto(s.u, sampleAt(ua, ub, a, mu), ku, 0, sc, sc.oN, sc.oWin);
      for (let r = 0; r <= p; r++) nu[a * (p + 1) + r] = sc.f[sc.oN + r]!;
    }
    for (let b = 0; b < mv; b++) {
      evalBasisInto(s.v, sampleAt(va, vb, b, mv), kv, 0, sc, sc.oNv, sc.oWinV);
      for (let c = 0; c <= q; c++) nv[b * (q + 1) + c] = sc.f[sc.oNv + c]!;
    }
    spanOffsets(s.u, ku, s.v.count * 4, offs, 0);
    spanOffsets(s.v, kv, 4, offs, p + 1);
    const cw = s.cw;
    const P = pr.P;
    for (let a = 0; a < mu; a++) {
      for (let b = 0; b < mv; b++) {
        let x = 0;
        let y = 0;
        let z = 0;
        let w = 0;
        for (let r = 0; r <= p; r++) {
          const Nr = nu[a * (p + 1) + r]!;
          const row = offs[r]!;
          for (let c = 0; c <= q; c++) {
            const k = Nr * nv[b * (q + 1) + c]!;
            const o = row + offs[p + 1 + c]!;
            x += k * cw[o]!;
            y += k * cw[o + 1]!;
            z += k * cw[o + 2]!;
            w += k * cw[o + 3]!;
          }
        }
        const ex = x / w - P[0]!;
        const ey = y / w - P[1]!;
        const ez = z / w - P[2]!;
        const d2 = ex * ex + ey * ey + ez * ez;
        if (d2 < bd) {
          const x = sampleAt(ua, ub, a, mu);
          const y = sampleAt(va, vb, b, mv);
          if (inside !== null && !inside(x, y)) continue;
          bd = d2;
          bu = x;
          bv = y;
        }
      }
    }
    if (bd < Infinity) offerSeed(seeds, bd, bu, bv, (bu < ub ? UP_U : 0) | (bv < vb ? UP_V : 0));
  }
}

/** The active bound of a direction at `x` in `[lo, hi]` with gradient `g`: −1, +1 or 0. */
const activeOf = (x: number, lo: number, hi: number, g: number): number =>
  x <= lo && g >= 0 ? -1 : x >= hi && g <= 0 ? 1 : 0;

/**
 * {@link escapeCurve} for surfaces, over the directions `zu`, `zv` whose
 * gradient is negligible (the others are held by their bound's KKT
 * condition). With the undamped Hessian `H = [[a, b], [b, d]]` of `D`
 * restricted to them, a negative eigenvalue `μ` (unit eigenvector `e`) or a
 * negative diagonal entry (axis `e`) is a direction of negative curvature
 * `κ = eᵀHe`; each such direction, both signs that stay in the patch `B`, is
 * stepped by `h = √(−2κ / |S_ee|²)` (`S_ee = Σ e_i e_j S_ij`) and halved until
 * the distance drops or the step falls to `paramRel`. Returns the lowest
 * point found (the start if none) and whether the iteration cap stopped it.
 */
function escapeSurface(
  pr: SurfaceProblem,
  x: number,
  y: number,
  d2: number,
  B: Float64Array,
  zu: boolean,
  zv: boolean,
  iters0: number,
): { x: number; y: number; iters: number; capped: boolean } {
  const { cur, P, tol } = pr;
  const rx = cur[0]! - P[0]!;
  const ry = cur[1]! - P[1]!;
  const rz = cur[2]! - P[2]!;
  const dot = (i: number, j: number): number =>
    cur[i]! * cur[j]! + cur[i + 1]! * cur[j + 1]! + cur[i + 2]! * cur[j + 2]!;
  const rDot = (i: number): number => rx * cur[i]! + ry * cur[i + 1]! + rz * cur[i + 2]!;
  const a = dot(3, 3) + rDot(9);
  const b = dot(3, 6) + rDot(12);
  const d = dot(6, 6) + rDot(15);
  // Candidate directions (unit in parameter space), at most three.
  const m = (a + d) / 2;
  const mu = m - Math.sqrt(((a - d) / 2) ** 2 + b * b);
  if (!((zu && a < 0) || (zv && d < 0) || (zu && zv && mu < 0))) {
    return { x, y, iters: iters0, capped: false };
  }
  const dirs: [number, number][] = [];
  if (zu && a < 0) dirs.push([1, 0]);
  if (zv && d < 0) dirs.push([0, 1]);
  if (zu && zv && mu < 0 && b !== 0) {
    // Each is orthogonal to one row of H − μI, so both span the eigenvector
    // (b ≠ 0; b = 0 makes it an axis, covered above); the longer is better
    // conditioned.
    const e1: [number, number] = [b, mu - a];
    const e2: [number, number] = [mu - d, b];
    const [ex, ey] = Math.hypot(...e1) >= Math.hypot(...e2) ? e1 : e2;
    const n = Math.hypot(ex, ey);
    dirs.push([ex / n, ey / n]);
  }
  let iters = iters0;
  let capped = false;
  let bx = x;
  let by = y;
  let bd = d2;
  const [ulo, uhi, vlo, vhi] = [B[0]!, B[1]!, B[2]!, B[3]!];
  for (const [ex, ey] of dirs) {
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (let k = 0; k < 3; k++) {
      const s = cur[9 + k]! * ex * ex + 2 * cur[12 + k]! * ex * ey + cur[15 + k]! * ey * ey;
      if (k === 0) sx = s;
      else if (k === 1) sy = s;
      else sz = s;
    }
    const kappa = a * ex * ex + 2 * b * ex * ey + d * ey * ey;
    const see = sx * sx + sy * sy + sz * sz;
    if (!(kappa < 0 && see > 0 && (kappa * kappa) / see > ESCAPE_GAIN_FLOOR * d2)) continue;
    const h0 = Math.sqrt((-2 * kappa) / see);
    for (const sgn of [1, -1]) {
      const mx = sgn * ex;
      const my = sgn * ey;
      // Stay in the patch: no component leaving it at a bound.
      if ((mx < 0 && !(x > ulo)) || (mx > 0 && !(x < uhi))) continue;
      if ((my < 0 && !(y > vlo)) || (my > 0 && !(y < vhi))) continue;
      for (let h = h0; ; h /= 2) {
        const xn = clamp(x + mx * h, ulo, uhi);
        const yn = clamp(y + my * h, vlo, vhi);
        if (!(Math.abs(xn - x) > pr.stepU || Math.abs(yn - y) > pr.stepV)) break;
        if (iters >= tol.newtonMaxIter) {
          capped = true;
          break;
        }
        iters++;
        const dn = surfaceEvalAt(pr, xn, yn, xn >= uhi, yn >= vhi);
        if (dn < d2) {
          if (dn < bd) {
            bd = dn;
            bx = xn;
            by = yn;
          }
          break;
        }
      }
    }
  }
  return { x: bx, y: by, iters, capped: capped && bd === d2 };
}

/**
 * Safeguarded Newton (P&T eqs. 6.4–6.8) from `(x0, y0)` inside the patch
 * `B = [ulo, uhi, vlo, vhi]` (±Infinity where unbounded), with the
 * active-set treatment of its bounds; see the module comment. Sets
 * `out.aU`, `out.aV` to the active bounds.
 */
function newtonSurfacePatch(
  pr: SurfaceProblem,
  x0: number,
  y0: number,
  B: Float64Array,
  out: Outcome,
): void {
  const { tol, cur, P, sc } = pr;
  const f = sc.f;
  const o = sc.oS;
  const ulo = B[0]!;
  const uhi = B[1]!;
  const vlo = B[2]!;
  const vhi = B[3]!;
  let x = clamp(x0, ulo, uhi);
  let y = clamp(y0, vlo, vhi);
  let d2 = surfaceEvalAt(pr, x, y, x >= uhi, y >= vhi);
  for (let k = 0; k < 18; k++) cur[k] = f[o + k]!;
  let iters = 0;
  let lambda = 0;
  let converged = false;
  let aU = 0;
  let aV = 0;
  for (;;) {
    const rx = cur[0]! - P[0]!;
    const ry = cur[1]! - P[1]!;
    const rz = cur[2]! - P[2]!;
    const [sux, suy, suz, svx, svy, svz] = [cur[3]!, cur[4]!, cur[5]!, cur[6]!, cur[7]!, cur[8]!];
    const fu = rx * sux + ry * suy + rz * suz;
    const fv = rx * svx + ry * svy + rz * svz;
    const guu = sux * sux + suy * suy + suz * suz;
    const gvv = svx * svx + svy * svy + svz * svz;
    aU = activeOf(x, ulo, uhi, fu);
    aV = activeOf(y, vlo, vhi, fv);
    if (d2 === 0) {
      converged = true;
      break;
    }
    // The largest cosine over the free directions (P&T's zero-cosine test).
    const cosU = aU !== 0 ? 0 : cosineOf(fu, d2, guu);
    const cosV = aV !== 0 ? 0 : cosineOf(fv, d2, gvv);
    const cos = cosU > cosV ? cosU : cosV;
    if (cos <= tol.cosine) {
      // Stationary to first order in the free directions. A direction whose
      // gradient is negligible (also where its partial vanishes: cosine 0
      // whatever r is) may still descend at second order (module comment).
      const e = escapeSurface(
        pr,
        x,
        y,
        d2,
        B,
        cosineOf(fu, d2, guu) <= tol.cosine,
        cosineOf(fv, d2, gvv) <= tol.cosine,
        iters,
      );
      iters = e.iters;
      if (e.x !== x || e.y !== y) {
        x = e.x;
        y = e.y;
        d2 = surfaceEvalAt(pr, x, y, x >= uhi, y >= vhi);
        for (let k = 0; k < 18; k++) cur[k] = f[o + k]!;
        lambda = 0;
        continue;
      }
      if (e.capped) break;
      converged = true;
      break;
    }
    if (iters >= tol.newtonMaxIter) break;
    iters++;
    let du = 0;
    let dv = 0;
    if (aU !== 0 || aV !== 0) {
      // 1D Newton on the bounding iso-curve in the free direction.
      if (aU !== 0) {
        const M = gvv + rx * cur[15]! + ry * cur[16]! + rz * cur[17]! + lambda * gvv;
        if (!(M > 0)) {
          lambda = lambda === 0 ? 1 : lambda * LM_GROWTH;
          continue;
        }
        dv = -fv / M;
      } else {
        const M = guu + rx * cur[9]! + ry * cur[10]! + rz * cur[11]! + lambda * guu;
        if (!(M > 0)) {
          lambda = lambda === 0 ? 1 : lambda * LM_GROWTH;
          continue;
        }
        du = -fu / M;
      }
    } else {
      const guv = sux * svx + suy * svy + suz * svz;
      // Marquardt's diagonal scaling: each row damped by its own `|S_k|²`
      // (floored at `LM_DIAG_FLOOR` of the trace where a partial vanishes, as
      // at a pole), so a short `Su` does not freeze the u step behind `|Sv|²`.
      const floor = LM_DIAG_FLOOR * (guu + gvv);
      const a =
        guu + rx * cur[9]! + ry * cur[10]! + rz * cur[11]! + lambda * (guu > floor ? guu : floor);
      const b = guv + rx * cur[12]! + ry * cur[13]! + rz * cur[14]!;
      const d =
        gvv + rx * cur[15]! + ry * cur[16]! + rz * cur[17]! + lambda * (gvv > floor ? gvv : floor);
      const det = a * d - b * b;
      if (!(a > 0 && det > 0)) {
        lambda = lambda === 0 ? 1 : lambda * LM_GROWTH;
        continue;
      }
      du = -(d * fu - b * fv) / det;
      dv = -(a * fv - b * fu) / det;
    }
    const xn = clamp(x + du, ulo, uhi);
    const yn = clamp(y + dv, vlo, vhi);
    const small = Math.abs(xn - x) <= pr.stepU && Math.abs(yn - y) <= pr.stepV;
    const d2n = surfaceEvalAt(pr, xn, yn, xn >= uhi, yn >= vhi);
    let accept = d2n <= d2;
    if (!accept && Math.sqrt(d2n) <= Math.sqrt(d2) + tol.point) {
      // Within `point` of a non-increase: decide by the gradient (module comment).
      const ex = f[o]! - P[0]!;
      const ey = f[o + 1]! - P[1]!;
      const ez = f[o + 2]! - P[2]!;
      const nu =
        aU !== 0
          ? 0
          : cosineOf(
              ex * f[o + 3]! + ey * f[o + 4]! + ez * f[o + 5]!,
              d2n,
              f[o + 3]! ** 2 + f[o + 4]! ** 2 + f[o + 5]! ** 2,
            );
      const nv =
        aV !== 0
          ? 0
          : cosineOf(
              ex * f[o + 6]! + ey * f[o + 7]! + ez * f[o + 8]!,
              d2n,
              f[o + 6]! ** 2 + f[o + 7]! ** 2 + f[o + 8]! ** 2,
            );
      accept = (nu > nv ? nu : nv) < cos;
    }
    if (accept) {
      x = xn;
      y = yn;
      d2 = d2n;
      for (let k = 0; k < 18; k++) cur[k] = f[o + k]!;
      lambda = 0;
    } else {
      lambda = lambda === 0 ? 1 : lambda * LM_GROWTH;
    }
    if (small) {
      // A minimum to parameter resolution (also where the step could not lower the distance).
      converged = true;
      const ex = cur[0]! - P[0]!;
      const ey = cur[1]! - P[1]!;
      const ez = cur[2]! - P[2]!;
      aU = activeOf(x, ulo, uhi, ex * cur[3]! + ey * cur[4]! + ez * cur[5]!);
      aV = activeOf(y, vlo, vhi, ex * cur[6]! + ey * cur[7]! + ez * cur[8]!);
      break;
    }
  }
  out.x = x;
  out.y = y;
  out.d2 = d2;
  out.iters = iters;
  out.converged = converged || Math.sqrt(d2) <= tol.point;
  out.aU = aU;
  out.aV = aV;
}

/** {@link newtonCurve} for surfaces: Newton in the C¹ patch of the start, then across C⁰ break lines. */
function newtonSurface(
  pr: SurfaceProblem,
  x0: number,
  y0: number,
  out: Outcome,
  up = UP_U | UP_V,
): void {
  const { dirU, dirV, patch, patch2, cross, tol } = pr;
  const x = dirU.bounded ? clamp(x0, dirU.lo, dirU.hi) : x0;
  const y = dirV.bounded ? clamp(y0, dirV.lo, dirV.hi) : y0;
  patchOf(dirU, x, (up & UP_U) !== 0, patch, 0);
  patchOf(dirV, y, (up & UP_V) !== 0, patch, 2);
  newtonSurfacePatch(pr, x, y, patch, out);
  let iters = out.iters;
  while (iters < tol.newtonMaxIter) {
    let moved = false;
    for (let k = 0; k < 2 && !moved; k++) {
      const a = k === 0 ? out.aU : out.aV;
      const dir = k === 0 ? dirU : dirV;
      if (a === 0) continue;
      const bound = patch[2 * k + (a > 0 ? 1 : 0)]!;
      if (!isBreak(dir, bound)) continue;
      patch2.set(patch);
      patchOf(dir, bound, a > 0, patch2, 2 * k);
      newtonSurfacePatch(pr, out.x, out.y, patch2, cross);
      iters += cross.iters;
      if (cross.d2 < out.d2) {
        patch.set(patch2);
        copyOutcome(out, cross);
        moved = true;
      }
    }
    if (!moved) break;
  }
  out.iters = iters;
}

/** {@link solveCurveSeeded} for surfaces. */
function solveSurfaceSeeded(pr: SurfaceProblem): void {
  seedSurface(pr);
  pr.best.d2 = Infinity;
  for (let k = 0; k < pr.seeds.count; k++) {
    newtonSurface(pr, pr.seeds.x[k]!, pr.seeds.y[k]!, pr.trial, pr.seeds.up[k]!);
    keepBetter(pr.best, pr.trial);
    if (pr.best.d2 === 0) break;
  }
}

/** {@link solveCurveFrom} for surfaces. */
function solveSurfaceFrom(
  pr: SurfaceProblem,
  x0: number,
  y0: number,
  accept: (o: Outcome) => boolean,
): void {
  newtonSurface(pr, x0, y0, pr.best);
  if (accept(pr.best)) return;
  copyOutcome(pr.keep, pr.best);
  solveSurfaceSeeded(pr);
  keepBetter(pr.best, pr.keep);
}

function edgeOf(pr: SurfaceProblem, u: number, v: number): false | SurfaceEdge {
  if (pr.boundedU && u === pr.u0) return 'u0';
  if (pr.boundedU && u === pr.u1) return 'u1';
  if (pr.boundedV && v === pr.v0) return 'v0';
  if (pr.boundedV && v === pr.v1) return 'v1';
  return false;
}

/**
 * The closest point on `s` to `p` (P&T §6.1 point inversion with global
 * seeding and the safeguards of §11.2). `seed` starts Newton there instead of
 * seeding globally (a local projection); global seeding is used as well only
 * if that Newton does not converge. On a closed or degenerate surface (a
 * pole, a seam) every parameter of the closest point is a valid answer; the
 * one returned is deterministic.
 */
export function closestPointOnSurface(
  s: NurbsSurface,
  p: Point3,
  opts?: {
    readonly seed?: UV;
    readonly tol?: Partial<Tolerances>;
    readonly seeding?: Partial<ProjectionSeeding>;
  },
): SurfaceProjection {
  checkSurfaceShape(s);
  const tol = resolveTolerances(opts?.tol);
  const pr = prepareSurface(s, tol, checkSeeding(opts?.seeding));
  readPoint(pr.P, p, 3);
  pr.best.d2 = Infinity;
  if (opts?.seed !== undefined) {
    const x = checkParam(s.u, opts.seed.u, undefined, tol);
    const y = checkParam(s.v, opts.seed.v, undefined, tol);
    solveSurfaceFrom(pr, x, y, isConverged);
  } else solveSurfaceSeeded(pr);
  return surfaceResult(pr);
}

/**
 * The closest point of `s` to `p` over a region of its domain (internal;
 * trim.ts, §11.2 "Trimmed"): global seeding over the samples `inside`
 * accepts, Newton (unconstrained by the region) from each seed, and the best
 * result `inside` accepts. A minimum of the region that is not a minimum of
 * the surface lies on the region's boundary, which the caller searches;
 * `null` when no sample or result is accepted.
 */
export function closestPointOnSurfaceWhere(
  s: NurbsSurface,
  p: Point3,
  inside: (u: number, v: number) => boolean,
  tol: Tolerances,
  seeding: ProjectionSeeding,
): SurfaceProjection | null {
  const pr = prepareSurface(s, tol, seeding);
  readPoint(pr.P, p, 3);
  seedSurface(pr, inside);
  pr.best.d2 = Infinity;
  for (let k = 0; k < pr.seeds.count; k++) {
    newtonSurface(pr, pr.seeds.x[k]!, pr.seeds.y[k]!, pr.trial, pr.seeds.up[k]!);
    if (!inside(sanitizeParam(s.u, pr.trial.x), sanitizeParam(s.v, pr.trial.y))) continue;
    keepBetter(pr.best, pr.trial);
    if (pr.best.d2 === 0) break;
  }
  return pr.best.d2 < Infinity ? surfaceResult(pr) : null;
}

function surfaceResult(pr: SurfaceProblem): SurfaceProjection {
  const best = pr.best;
  const u = sanitizeParam(pr.s.u, best.x);
  const v = sanitizeParam(pr.s.v, best.y);
  surfaceEvalAt(pr, u, v);
  const f = pr.sc.f;
  const o = pr.sc.oS;
  return Object.freeze({
    uv: Object.freeze({ u, v }),
    point: Object.freeze({ x: f[o]!, y: f[o + 1]!, z: f[o + 2]! }),
    distance: Math.sqrt(best.d2),
    converged: best.converged,
    iterations: best.iters,
    onBoundary: edgeOf(pr, u, v),
  });
}

/**
 * The batch core shared with `projectCurveSamplesToSurface`: projects `n`
 * points of stride 3 into `outUV` (stride 2, wrapped) and `outDist`. Seeds:
 * caller `seeds` (uv pairs), else the previous result when `warm`; global
 * seeding when there is no seed or it fails. Returns the count not converged.
 */
export function projectSurfaceBatch(
  pr: SurfaceProblem,
  pts: ReadonlyF64,
  n: number,
  outUV: Float64Array,
  outDist: Float64Array,
  warm: boolean,
  seeds: ReadonlyF64 | undefined,
): number {
  const s = pr.s;
  let failed = 0;
  let prevX = 0;
  let prevY = 0;
  let bound = 0;
  const continued = (o: Outcome): boolean => o.converged && Math.sqrt(o.d2) <= bound;
  for (let i = 0; i < n; i++) {
    pr.P[0] = pts[3 * i]!;
    pr.P[1] = pts[3 * i + 1]!;
    pr.P[2] = pts[3 * i + 2]!;
    if (seeds !== undefined) {
      solveSurfaceFrom(pr, seeds[2 * i]!, seeds[2 * i + 1]!, isConverged);
    } else if (warm && i > 0) {
      bound = Math.sqrt(pr.best.d2) + stepLength(pts, i, 3) + pr.tol.point;
      solveSurfaceFrom(pr, prevX, prevY, continued);
    } else solveSurfaceSeeded(pr);
    const b = pr.best;
    prevX = b.x;
    prevY = b.y;
    outUV[2 * i] = sanitizeParam(s.u, b.x);
    outUV[2 * i + 1] = sanitizeParam(s.v, b.y);
    outDist[i] = Math.sqrt(b.d2);
    if (!b.converged) failed++;
  }
  return failed;
}

/**
 * Projects every point of `pts` (stride 3) onto `s`: parameters into `outUV`
 * (stride 2, wrapped into the domain in periodic directions), distances into
 * `outDist`. `seeds` (uv pairs, one per point; clamped or wrapped, never
 * rejected) start a local projection per point; otherwise `warmStart` starts
 * each point from the previous result, kept within the continuity bound
 * (module comment). A point without a start, or whose start fails, is seeded
 * globally. Returns the number not converged.
 */
export function projectPointsToSurfaceInto(
  s: NurbsSurface,
  pts: ReadonlyF64,
  outUV: Float64Array,
  outDist: Float64Array,
  opts?: {
    readonly warmStart?: boolean;
    readonly seeds?: ReadonlyF64;
    readonly tol?: Partial<Tolerances>;
    readonly seeding?: Partial<ProjectionSeeding>;
  },
): number {
  checkSurfaceShape(s);
  const n = checkPoints(pts, 3, 'projectPointsToSurfaceInto');
  checkOut(outUV, 0, 2 * n, 'projectPointsToSurfaceInto (uv)');
  checkOut(outDist, 0, n, 'projectPointsToSurfaceInto (distance)');
  const seeds = opts?.seeds;
  if (seeds !== undefined) {
    checkOut(seeds, 0, 2 * n, 'projectPointsToSurfaceInto (seeds)');
    for (let i = 0; i < 2 * n; i++) {
      if (!Number.isFinite(seeds[i]!)) {
        fail('non-finite', `projectPointsToSurfaceInto: seed ${i >> 1} is not finite`, {
          index: i >> 1,
        });
      }
    }
  }
  const pr = prepareSurface(s, resolveTolerances(opts?.tol), checkSeeding(opts?.seeding));
  return projectSurfaceBatch(pr, pts, n, outUV, outDist, opts?.warmStart === true, seeds);
}
