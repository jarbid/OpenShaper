// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The least-squares fit of one section onto the shared cubic knot vector (docs/design/m1-model.md §2,
 * "As built (rail smoothness)").
 *
 * A section's chain (normalised u-v) is fitted separately on each half (bottom centre to apex, apex to
 * deck centre) by a cubic B-spline with `m` spans per half. Position alone is not enough: within the
 * 0.5 mm tolerance a least-squares cubic can still swing its normal by 17 degrees in a tight tuck, and
 * it overshoots by a tenth of the turn on both sides of a corner, which shades as bands along the rail.
 * So:
 *
 * - **Graded knots** ({@link gradedKnots}). The shared knot vector has shorter spans along the rail,
 *   where the section bends, than along the flat bottom and the crown of the deck.
 * - **Registration.** The fit's parameter t is arc length, except that the centre of the section's
 *   turning (its rail) is sent to the same t in every section ({@link SECTION_LANDMARK_BOTTOM}), so two
 *   stations have their rails at the same t and a blend between them blends rail with rail.
 * - **The tangent direction is fitted too.** Besides the positions the least squares
 *   has a row per sample that asks the fitted tangent to be parallel to the stored one
 *   ({@link SECTION_NORMAL_WEIGHT}).
 * - **An exact corner.** A half whose chain has one corner, a knot where it turns by
 *   more than {@link SECTION_CORNER_ANGLE} (the end stations' 90 degree rail edge), holds it as a triple
 *   control point at the registered knot: the curve reaches the corner with zero speed and leaves it
 *   along the other leg, a true crease that a cubic cannot hold any other way. The data are spaced so that
 *   the curve leaves the corner as the cubic ramp it is (distance ∝ τ³ over the first span).
 *
 * {@link normalExcess} measures how far the fitted tangent direction leaves the stored one's (within a
 * small window along the profile), on the section's real shape; `sections.ts` accepts a rung of the span
 * ladder only when that and the position error are within their limits.
 */
import { BASIS_SIZE, basisDers, spanOfKnots } from './bspline';
import { chainEval, compileChain } from './chain';
import type { CompiledChain } from './chain';
import {
  SECTION_APEX_TOL,
  SECTION_ASPECT_LIMIT,
  SECTION_CORNER_ANGLE,
  SECTION_DIRECTION_TOL,
  SECTION_DISTANCE_REACH,
  SECTION_EXACT_TOL,
  SECTION_GRADE_FROM,
  SECTION_GRADE_RATIO,
  SECTION_GRADE_STEPS,
  SECTION_GRADE_TO,
  SECTION_HALF_SAMPLES,
  SECTION_HANDLE_MIN,
  SECTION_LANDMARK_BOTTOM,
  SECTION_LANDMARK_DECK,
  SECTION_NORMAL_WEIGHT,
  SECTION_NORMAL_WINDOW,
  SECTION_POLYLINE_SAMPLES,
  SECTION_REGISTER_TURN,
  SECTION_RIDGE,
  SECTION_SPEED_FLOOR,
  SECTION_TANGENT_REACH,
} from './params';
import type { Section } from './types';

/** Control points of the blended section for `m` spans per half. */
export const controlCount = (m: number): number => 2 * m + 5;

// ---------------------------------------------------------------------------
// The shared knot vector
// ---------------------------------------------------------------------------

const gradedCache = new Map<number, readonly number[]>();

/**
 * The interior knots of one half (`m - 1` of them in (0, 1)), graded towards the end where the rail is:
 * the span density rises from 1 at `t = SECTION_GRADE_FROM` to {@link SECTION_GRADE_RATIO} at
 * `t = SECTION_GRADE_TO` and stays there, so the spans along the rail and the wall are that many times
 * shorter than along the flat bottom or the crown of the deck. `towardEnd` false mirrors it (the deck half,
 * whose rail is at its start).
 */
export function gradedKnots(m: number, towardEnd: boolean): readonly number[] {
  const key = towardEnd ? m : -m;
  const cached = gradedCache.get(key);
  if (cached !== undefined) return cached;
  const steps = SECTION_GRADE_STEPS;
  const density = (t: number): number => {
    const x = Math.min(
      1,
      Math.max(0, (t - SECTION_GRADE_FROM) / (SECTION_GRADE_TO - SECTION_GRADE_FROM)),
    );
    return 1 + (SECTION_GRADE_RATIO - 1) * x * x * (3 - 2 * x);
  };
  const cum = new Float64Array(steps + 1);
  for (let i = 1; i <= steps; i++) cum[i] = cum[i - 1]! + density((i - 0.5) / steps) / steps;
  const out: number[] = [];
  let j = 1;
  for (let i = 1; i < m; i++) {
    const target = (i / m) * cum[steps]!;
    while (j < steps && cum[j]! < target) j++;
    const f = (target - cum[j - 1]!) / (cum[j]! - cum[j - 1]!);
    out.push((j - 1 + f) / steps);
  }
  const knots = Object.freeze(towardEnd ? out : out.map((t) => 1 - t).reverse());
  gradedCache.set(key, knots);
  return knots;
}

/** The shared clamped cubic knot vector: `m` spans per half, graded towards the rail ({@link gradedKnots}), triple knot at ½. */
export function sectionKnots(m: number): Float64Array {
  const k: number[] = [0, 0, 0, 0];
  for (const t of gradedKnots(m, true)) k.push(t / 2);
  k.push(0.5, 0.5, 0.5);
  for (const t of gradedKnots(m, false)) k.push(0.5 + t / 2);
  k.push(1, 1, 1, 1);
  return Float64Array.from(k);
}

function halfKnots(m: number, towardEnd: boolean): Float64Array {
  return Float64Array.from([0, 0, 0, 0, ...gradedKnots(m, towardEnd), 1, 1, 1, 1]);
}

/** The interior knot of a half (1-based index `k`, parameter `t`) the rail is registered to: the one nearest the landmark. */
function railKnot(m: number, towardEnd: boolean): { readonly k: number; readonly t: number } {
  const kn = gradedKnots(m, towardEnd);
  const land = towardEnd ? SECTION_LANDMARK_BOTTOM : SECTION_LANDMARK_DECK;
  let k = 1;
  for (let i = 2; i <= kn.length; i++)
    if (Math.abs(kn[i - 1]! - land) < Math.abs(kn[k - 1]! - land)) k = i;
  // an exact corner holds the controls k, k + 1, k + 2, clear of the end controls the rules fix
  k = Math.min(Math.max(k, 2), m - 2);
  return { k, t: kn[k - 1]! };
}

// ---------------------------------------------------------------------------
// The fit and its report
// ---------------------------------------------------------------------------

/** One section fitted onto the `m`-span knot vector: `2·controlCount(m)` coordinates (u, v pairs). */
export interface SectionFit {
  readonly m: number;
  readonly ctrl: Float64Array;
  /** Largest distance from a sample of the stored chain to the fitted curve, normalised units. */
  readonly error: number;
  /** Controls moved back into the bounds. */
  readonly clamped: number;
  /** What {@link normalExcess} needs: per sample (both halves) the fitted tangent angle and the stored window. */
  readonly angles: SampleAngles;
}

/** Tangent angles (rad, on the stored branch) at the samples of both halves, `2·(samples + 1)` each. */
export interface SampleAngles {
  readonly fit: Float64Array;
  readonly lo: Float64Array;
  readonly hi: Float64Array;
}

// ---------------------------------------------------------------------------
// Tangent directions of the stored chain
// ---------------------------------------------------------------------------

/** First vector of `v` (as pairs) longer than the exact tolerance: the tangent of a Bézier end whose handle may have zero length. */
function firstDirection(v: readonly (readonly [number, number])[]): [number, number] | null {
  for (const d of v) if (Math.hypot(d[0], d[1]) > SECTION_HANDLE_MIN) return [d[0], d[1]];
  return null;
}

/** Direction in which the chain leaves knot `k` (towards knot `k + 1`), from its control polygon. */
export function leavingDirection(chain: Section['chain'], k: number): [number, number] | null {
  const a = chain.knots[k]!;
  const b = chain.knots[k + 1]!;
  const sub = (q: readonly [number, number]): [number, number] => [q[0] - a.p[0], q[1] - a.p[1]];
  return firstDirection([sub(a.out), sub(b.in), sub(b.p)]);
}

/** Direction in which the chain arrives at knot `k` (from knot `k - 1`). */
export function arrivingDirection(chain: Section['chain'], k: number): [number, number] | null {
  const a = chain.knots[k - 1]!;
  const b = chain.knots[k]!;
  const sub = (q: readonly [number, number]): [number, number] => [b.p[0] - q[0], b.p[1] - q[1]];
  return firstDirection([sub(b.in), sub(a.out), sub(a.p)]);
}

const isHorizontal = (d: readonly [number, number] | null): boolean =>
  d !== null && Math.abs(d[1]) <= SECTION_DIRECTION_TOL * Math.hypot(d[0], d[1]);
/** Whether `d` is within {@link SECTION_APEX_TOL} of vertical. */
export const isNearVertical = (d: readonly [number, number] | null): boolean =>
  d !== null && Math.abs(d[0]) <= Math.sin(SECTION_APEX_TOL) * Math.hypot(d[0], d[1]);

/** The turn (rad, 0 to π) of the chain at interior knot `k`. */
function turnAt(chain: Section['chain'], k: number): number {
  const a = arrivingDirection(chain, k);
  const l = leavingDirection(chain, k);
  if (a === null || l === null) return 0;
  return Math.abs(Math.atan2(a[0] * l[1] - a[1] * l[0], a[0] * l[0] + a[1] * l[1]));
}

function unit(x: number, y: number): [number, number] {
  const h = Math.hypot(x, y);
  return h > 0 ? [x / h, y / h] : [1, 0];
}

function wrapPi(a: number): number {
  let r = a;
  while (r > Math.PI) r -= 2 * Math.PI;
  while (r < -Math.PI) r += 2 * Math.PI;
  return r;
}

// ---------------------------------------------------------------------------
// The stored chain as a dense polyline (once per section)
// ---------------------------------------------------------------------------

/** A half of the stored chain, sampled densely: `count + 1` points, `SECTION_POLYLINE_SAMPLES` per segment. */
interface DenseHalf {
  readonly x: Float64Array;
  readonly y: Float64Array;
  /** Cumulative arc length. */
  readonly cum: Float64Array;
  /** Index of the point of each interior knot that is a corner. */
  readonly corners: readonly number[];
  /**
   * The centre of the half's turning as a fraction of its arc length (the turn-weighted mean arc position),
   * and the total turning (rad): a half that barely turns (a flat or vee bottom) has no rail to register.
   */
  readonly centre: number;
  readonly turning: number;
}

const denseCache = new WeakMap<Section, readonly [DenseHalf, DenseHalf]>();

function denseHalf(chain: CompiledChain, sec: Section, s0: number, s1: number): DenseHalf {
  const count = (s1 - s0) * SECTION_POLYLINE_SAMPLES;
  const x = new Float64Array(count + 1);
  const y = new Float64Array(count + 1);
  const cum = new Float64Array(count + 1);
  const p = new Float64Array(2);
  for (let i = 0; i <= count; i++) {
    chainEval(chain, s0 + i / SECTION_POLYLINE_SAMPLES, 0, p, 0);
    x[i] = p[0]!;
    y[i] = p[1]!;
    if (i > 0) cum[i] = cum[i - 1]! + Math.hypot(x[i]! - x[i - 1]!, y[i]! - y[i - 1]!);
  }
  const corners: number[] = [];
  for (let k = s0 + 1; k < s1; k++)
    if (turnAt(sec.chain, k) > SECTION_CORNER_ANGLE)
      corners.push((k - s0) * SECTION_POLYLINE_SAMPLES);
  let weight = 0;
  let moment = 0;
  let before = 0;
  for (let i = 1; i <= count; i++) {
    const a = Math.atan2(y[i]! - y[i - 1]!, x[i]! - x[i - 1]!);
    if (i > 1) {
      const turn = Math.abs(wrapPi(a - before));
      weight += turn;
      moment += turn * cum[i - 1]!;
    }
    before = a;
  }
  const arc = cum[count]!;
  return {
    x,
    y,
    cum,
    corners,
    centre: weight > 0 && arc > 0 ? moment / weight / arc : 0,
    turning: weight,
  };
}

function denseOf(sec: Section): readonly [DenseHalf, DenseHalf] {
  let d = denseCache.get(sec);
  if (d === undefined) {
    const chain = compileChain(sec.chain);
    const n = sec.chain.knots.length;
    d = [denseHalf(chain, sec, 0, sec.apex), denseHalf(chain, sec, sec.apex, n - 1)];
    denseCache.set(sec, d);
  }
  return d;
}

// ---------------------------------------------------------------------------
// What is fitted: the samples of a half
// ---------------------------------------------------------------------------

interface Profile {
  /** `samples + 1` points (u, v) at t = j / samples, and the stored unit tangents there. */
  readonly pts: Float64Array;
  readonly tau: Float64Array;
  /** Arc length of the stored half. */
  readonly arc: number;
  /** Per sample: the index of the dense polyline point the sample was taken from (just past it). */
  readonly at: Int32Array;
}

/**
 * The samples of a half at `m` spans. The parameter t is arc length except that the rail is registered:
 * the centre of the turning (or, with an exact corner, the corner) is at the rail knot's t, and t is linear
 * in arc length on each side of it. At an exact corner the curve leaves it as a cubic ramp, and so do the
 * samples: distance from the corner ∝ τ³ over the knot span next to it, linear (C1) beyond.
 */
function profileOf(
  d: DenseHalf,
  m: number,
  start: readonly [number, number] | null,
  end: readonly [number, number] | null,
  towardEnd: boolean,
  exact: boolean,
): Profile {
  const J = SECTION_HALF_SAMPLES;
  const n = d.cum.length;
  const arc = d.cum[n - 1]!;
  const kn = gradedKnots(m, towardEnd);
  const rail = railKnot(m, towardEnd);
  const corner = exact ? d.corners[0]! : -1;
  // (a half that barely turns has no rail: the registration fades in with the turning, continuously)
  const share = Math.min(1, d.turning / SECTION_REGISTER_TURN);
  const fc = exact ? d.cum[corner]! / arc : rail.t + share * (d.centre - rail.t);
  const slopeLow = fc / rail.t;
  const slopeHigh = (1 - fc) / (1 - rail.t);
  const hl = rail.t - (rail.k > 1 ? kn[rail.k - 2]! : 0);
  const hr = (rail.k < kn.length ? kn[rail.k]! : 1) - rail.t;
  // distance from the corner (arc units) at parameter distance tau, for a side with ramp span h and speed sigma
  const ramp = (tau: number, h: number, sigma: number): number =>
    tau <= h ? (sigma * tau * tau * tau) / (3 * h * h) : sigma * (h / 3 + (tau - h));
  const sigmaLow = (fc * arc) / (rail.t - (2 * hl) / 3);
  const sigmaHigh = ((1 - fc) * arc) / (1 - rail.t - (2 * hr) / 3);
  const toArc = (t: number): number => {
    if (exact) {
      return t <= rail.t
        ? fc * arc - ramp(rail.t - t, hl, sigmaLow)
        : fc * arc + ramp(t - rail.t, hr, sigmaHigh);
    }
    return (t <= rail.t ? t * slopeLow : fc + (t - rail.t) * slopeHigh) * arc;
  };
  const pts = new Float64Array(2 * (J + 1));
  const tau = new Float64Array(2 * (J + 1));
  const at = new Int32Array(J + 1);
  let i = 1;
  for (let j = 0; j <= J; j++) {
    const target = Math.min(Math.max(toArc(j / J), 0), arc);
    while (i < n - 1 && d.cum[i]! < target) i++;
    at[j] = i;
    const w = d.cum[i]! - d.cum[i - 1]!;
    const f = w > 0 ? (target - d.cum[i - 1]!) / w : 0;
    pts[2 * j] = d.x[i - 1]! + f * (d.x[i]! - d.x[i - 1]!);
    pts[2 * j + 1] = d.y[i - 1]! + f * (d.y[i]! - d.y[i - 1]!);
    // a central difference (symmetric about the sample, so it is second order), the exact direction at the
    // two ends, and a one-sided difference beside an exact corner (a difference across it is neither leg's)
    const reach = Math.max(1, Math.min(SECTION_TANGENT_REACH, i - 1, n - 1 - i));
    let ia = Math.max(0, i - 1 - reach);
    let ib = Math.min(n - 1, i + reach);
    if (exact && ia < corner && ib > corner) {
      if (i <= corner) ib = corner;
      else ia = corner;
    }
    const t =
      j === 0 && start !== null
        ? unit(start[0], start[1])
        : j === J && end !== null
          ? unit(end[0], end[1])
          : unit(d.x[ib]! - d.x[ia]!, d.y[ib]! - d.y[ia]!);
    tau[2 * j] = t[0];
    tau[2 * j + 1] = t[1];
  }
  return { pts, tau, arc, at };
}

// ---------------------------------------------------------------------------
// The constrained least squares of one half
// ---------------------------------------------------------------------------

interface HalfBasis {
  readonly n: number;
  /** Per sample: the span's first control index, the four basis values and their first derivatives. */
  readonly base: Int32Array;
  readonly b0: Float64Array;
  readonly b1: Float64Array;
}

const basisCache = new Map<number, HalfBasis>();

function halfBasis(m: number, towardEnd: boolean): HalfBasis {
  const key = towardEnd ? m : -m;
  let hb = basisCache.get(key);
  if (hb !== undefined) return hb;
  const J = SECTION_HALF_SAMPLES;
  const n = m + 3;
  const knots = halfKnots(m, towardEnd);
  const base = new Int32Array(J + 1);
  const b0 = new Float64Array(4 * (J + 1));
  const b1 = new Float64Array(4 * (J + 1));
  const N = new Float64Array(BASIS_SIZE);
  for (let j = 0; j <= J; j++) {
    const t = j / J;
    const span = spanOfKnots(knots, n, t, false);
    basisDers(knots, span, t, 1, N);
    base[j] = span - 3;
    for (let q = 0; q < 4; q++) {
      b0[4 * j + q] = N[q]!;
      b1[4 * j + q] = N[4 + q]!;
    }
  }
  hb = { n, base, b0, b1 };
  basisCache.set(key, hb);
  return hb;
}

/** The distance from (u, v) to the stored chain's polyline, searched `SECTION_DISTANCE_REACH` points either side of index `i`. */
function distanceToStored(d: DenseHalf, i: number, u: number, v: number): number {
  const n = d.cum.length;
  let best = Number.POSITIVE_INFINITY;
  for (
    let k = Math.max(1, i - SECTION_DISTANCE_REACH);
    k <= Math.min(n - 1, i + SECTION_DISTANCE_REACH);
    k++
  ) {
    const ax = d.x[k - 1]!;
    const ay = d.y[k - 1]!;
    const ex = d.x[k]! - ax;
    const ey = d.y[k]! - ay;
    const ee = ex * ex + ey * ey;
    const f = ee > 0 ? Math.min(1, Math.max(0, ((u - ax) * ex + (v - ay) * ey) / ee)) : 0;
    best = Math.min(best, Math.hypot(u - ax - f * ex, v - ay - f * ey));
  }
  return best;
}

const FIXED = -1;
const UNASSIGNED = -2;

/** Bandwidth (below the diagonal) of the normal equations: a row couples 4 controls of 2 coordinates, interleaved. */
const BAND = 7;

interface HalfFit {
  readonly ctrl: Float64Array;
  /** Largest distance of the fitted curve at a sample from its data point. */
  readonly residual: number;
  /** Fitted tangent angle (rad, any branch) at each sample, and whether the curve has (nearly) no speed there. */
  readonly angle: Float64Array;
  readonly slow: Uint8Array;
}

/**
 * `fixed` lists unknown indices (`2·i + c`: control `i`, coordinate `c`) held at a value. Solves
 * the least squares of the position rows and the rows `ν · C'(t) = 0` (ν the stored
 * normal) by a banded Cholesky factorisation of the normal equations.
 */
function solveHalf(
  prof: Profile,
  dense: DenseHalf,
  m: number,
  fixed: readonly (readonly [number, number])[],
  towardEnd: boolean,
): HalfFit | null {
  const J = SECTION_HALF_SAMPLES;
  const hb = halfBasis(m, towardEnd);
  const N = 2 * hb.n;
  const value = new Float64Array(N);
  const free = new Int32Array(N).fill(UNASSIGNED);
  for (const [k, v] of fixed) {
    value[k] = v;
    free[k] = FIXED;
  }
  let nf = 0;
  for (let k = 0; k < N; k++) if (free[k] === UNASSIGNED) free[k] = nf++;
  const stride = BAND + 1;
  const G = new Float64Array(nf * stride);
  const rhs = new Float64Array(nf);
  // a tangent row has |C'| ≈ arc, so this weight is SECTION_NORMAL_WEIGHT spans of position per radian
  const wn = SECTION_NORMAL_WEIGHT / m;
  const idx = new Int32Array(8);
  const val = new Float64Array(8);
  const addRow = (cnt: number, target: number): void => {
    let t = target;
    let k = 0;
    for (let a = 0; a < cnt; a++) {
      const f = free[idx[a]!]!;
      if (f === FIXED) t -= val[a]! * value[idx[a]!]!;
      else {
        idx[k] = f;
        val[k] = val[a]!;
        k++;
      }
    }
    for (let a = 0; a < k; a++) {
      const fa = idx[a]!;
      rhs[fa] = rhs[fa]! + val[a]! * t;
      for (let b = 0; b < k; b++) {
        const fb = idx[b]!;
        if (fb <= fa) G[fa * stride + (fa - fb)] = G[fa * stride + (fa - fb)]! + val[a]! * val[b]!;
      }
    }
  };
  for (let j = 0; j <= J; j++) {
    const base = hb.base[j]!;
    for (let c = 0; c < 2; c++) {
      for (let q = 0; q < 4; q++) {
        idx[q] = 2 * (base + q) + c;
        val[q] = hb.b0[4 * j + q]!;
      }
      addRow(4, prof.pts[2 * j + c]!);
    }
    if (wn > 0) {
      const nu0 = -prof.tau[2 * j + 1]!;
      const nu1 = prof.tau[2 * j]!;
      for (let q = 0; q < 4; q++) {
        idx[2 * q] = 2 * (base + q);
        idx[2 * q + 1] = 2 * (base + q) + 1;
        val[2 * q] = wn * nu0 * hb.b1[4 * j + q]!;
        val[2 * q + 1] = wn * nu1 * hb.b1[4 * j + q]!;
      }
      addRow(8, 0);
    }
  }
  for (let i = 0; i < nf; i++) G[i * stride] = G[i * stride]! + SECTION_RIDGE;
  if (!bandCholesky(G, nf)) return null;
  bandSolve(G, nf, rhs);
  const ctrl = new Float64Array(N);
  for (let k = 0; k < N; k++) ctrl[k] = free[k] === FIXED ? value[k]! : rhs[free[k]!]!;
  // residual and the fitted tangent angles
  let residual = 0;
  const angle = new Float64Array(J + 1);
  const slow = new Uint8Array(J + 1);
  for (let j = 0; j <= J; j++) {
    const base = hb.base[j]!;
    let u = 0;
    let v = 0;
    let du = 0;
    let dv = 0;
    for (let q = 0; q < 4; q++) {
      const cu = ctrl[2 * (base + q)]!;
      const cv = ctrl[2 * (base + q) + 1]!;
      u += hb.b0[4 * j + q]! * cu;
      v += hb.b0[4 * j + q]! * cv;
      du += hb.b1[4 * j + q]! * cu;
      dv += hb.b1[4 * j + q]! * cv;
    }
    residual = Math.max(residual, distanceToStored(dense, prof.at[j]!, u, v));
    angle[j] = Math.atan2(dv, du);
    // a fitted curve that stands nearly still (beside an exact corner) has no direction there
    slow[j] = Math.hypot(du, dv) < SECTION_SPEED_FLOOR * prof.arc ? 1 : 0;
  }
  return { ctrl, residual, angle, slow };
}

/** In-place banded Cholesky `G = L Lᵀ` (lower band, `BAND + 1` per row); false if not positive definite. */
function bandCholesky(G: Float64Array, n: number): boolean {
  const s = BAND + 1;
  for (let i = 0; i < n; i++) {
    for (let j = Math.max(0, i - BAND); j <= i; j++) {
      let sum = G[i * s + (i - j)]!;
      for (let k = Math.max(0, i - BAND, j - BAND); k < j; k++)
        sum -= G[i * s + (i - k)]! * G[j * s + (j - k)]!;
      if (j === i) {
        if (!(sum > 0)) return false;
        G[i * s] = Math.sqrt(sum);
      } else {
        G[i * s + (i - j)] = sum / G[j * s]!;
      }
    }
  }
  return true;
}

function bandSolve(L: Float64Array, n: number, b: Float64Array): void {
  const s = BAND + 1;
  for (let i = 0; i < n; i++) {
    let sum = b[i]!;
    for (let k = Math.max(0, i - BAND); k < i; k++) sum -= L[i * s + (i - k)]! * b[k]!;
    b[i] = sum / L[i * s]!;
  }
  for (let i = n - 1; i >= 0; i--) {
    let sum = b[i]!;
    for (let k = i + 1; k <= Math.min(n - 1, i + BAND); k++) sum -= L[k * s + (k - i)]! * b[k]!;
    b[i] = sum / L[i * s]!;
  }
}

// ---------------------------------------------------------------------------
// One section
// ---------------------------------------------------------------------------

/** Fits one section at `m` spans per half. `null` if the least squares fails. */
export function computeFit(section: Section, m: number): SectionFit | null {
  const J = SECTION_HALF_SAMPLES;
  const knots = section.chain.knots;
  const n = knots.length;
  const a = section.apex;
  const apex = knots[a]!;
  // The tangents that are held are the ones the stored curve really has (a zero-length
  // handle leaves along the polygon, a V bottom or a pitched deck leaves at an angle).
  const bottomFlat = isHorizontal(leavingDirection(section.chain, 0));
  const deckFlat = isHorizontal(arrivingDirection(section.chain, n - 1));
  // Each side of the apex is held vertical when the stored tangent is within SECTION_APEX_TOL of it.
  // (A smooth knot with u = 1 at the section's widest point is vertical on both sides, since the
  // bounds forbid a handle beyond u = 1; the flag is not trusted, only the geometry.)
  const apexBelowVertical = isNearVertical(arrivingDirection(section.chain, a));
  const apexAboveVertical = isNearVertical(leavingDirection(section.chain, a));
  const nb = m + 3;
  const bottomFixed: [number, number][] = [
    [0, 0],
    [1, 0],
    [2 * (nb - 1), apex.p[0]],
    [2 * (nb - 1) + 1, apex.p[1]],
  ];
  if (bottomFlat) bottomFixed.push([3, 0]);
  if (apexBelowVertical) bottomFixed.push([2 * (nb - 2), apex.p[0]]);
  const deckFixed: [number, number][] = [
    [0, apex.p[0]],
    [1, apex.p[1]],
    [2 * (nb - 1), 0],
    [2 * (nb - 1) + 1, 1],
  ];
  if (deckFlat) deckFixed.push([2 * (nb - 2) + 1, 1]);
  if (apexAboveVertical) deckFixed.push([2, apex.p[0]]);
  const dense = denseOf(section);
  // an exact corner: three coincident controls at the rail knot (a half with one corner)
  const exactB = dense[0].corners.length === 1;
  const exactD = dense[1].corners.length === 1;
  const holdCorner = (fixed: [number, number][], d: DenseHalf, towardEnd: boolean): void => {
    const k = railKnot(m, towardEnd).k;
    const c = d.corners[0]!;
    for (const q of [k, k + 1, k + 2]) fixed.push([2 * q, d.x[c]!], [2 * q + 1, d.y[c]!]);
  };
  if (exactB) holdCorner(bottomFixed, dense[0], true);
  if (exactD) holdCorner(deckFixed, dense[1], false);
  const pb = profileOf(
    dense[0],
    m,
    leavingDirection(section.chain, 0),
    arrivingDirection(section.chain, a),
    true,
    exactB,
  );
  const pd = profileOf(
    dense[1],
    m,
    leavingDirection(section.chain, a),
    arrivingDirection(section.chain, n - 1),
    false,
    exactD,
  );
  const b = solveHalf(pb, dense[0], m, bottomFixed, true);
  const d = solveHalf(pd, dense[1], m, deckFixed, false);
  if (b === null || d === null) return null;
  const count = controlCount(m);
  const ctrl = new Float64Array(2 * count);
  ctrl.set(b.ctrl, 0);
  ctrl.set(d.ctrl.subarray(2), 2 * nb); // deck control 0 is the apex, already the bottom's last
  // The rules are exact, not fitted: centre points and tangents, the apex point.
  let clamped = 0;
  const pin = (i: number, c: 0 | 1, value: number): void => {
    if (Math.abs(ctrl[2 * i + c]! - value) > SECTION_EXACT_TOL) clamped++;
    ctrl[2 * i + c] = value;
  };
  pin(0, 0, 0);
  pin(0, 1, 0);
  if (bottomFlat) pin(1, 1, 0);
  pin(count - 1, 0, 0);
  pin(count - 1, 1, 1);
  if (deckFlat) pin(count - 2, 1, 1);
  pin(nb - 1, 0, apex.p[0]);
  ctrl[2 * (nb - 1) + 1] = apex.p[1];
  // a vertical apex tangent: the controls next to the apex have the apex's u exactly, on both sides
  if (apexBelowVertical) pin(nb - 2, 0, apex.p[0]);
  if (apexAboveVertical) pin(nb, 0, apex.p[0]);
  for (let i = 0; i < count; i++) {
    const u = ctrl[2 * i]!;
    if (u < 0 || u > 1) {
      clamped++;
      ctrl[2 * i] = u < 0 ? 0 : 1;
    }
  }
  const error = Math.max(b.residual, d.residual);
  // the stored tangent's range within the window, and the fitted angle on the stored branch
  const lo = new Float64Array(2 * (J + 1));
  const hi = new Float64Array(2 * (J + 1));
  const fit = new Float64Array(2 * (J + 1));
  const w = SECTION_NORMAL_WINDOW;
  [pb, pd].forEach((p, h) => {
    const half = h === 0 ? b : d;
    const stored = new Float64Array(J + 1);
    let prev = 0;
    for (let j = 0; j <= J; j++) {
      const t = Math.atan2(p.tau[2 * j + 1]!, p.tau[2 * j]!);
      stored[j] = j === 0 ? t : prev + wrapPi(t - prev);
      prev = stored[j]!;
    }
    for (let j = 0; j <= J; j++) {
      let l = Number.POSITIVE_INFINITY;
      let u = Number.NEGATIVE_INFINITY;
      for (let k = Math.max(0, j - w); k <= Math.min(J, j + w); k++) {
        l = Math.min(l, stored[k]!);
        u = Math.max(u, stored[k]!);
      }
      const at = h * (J + 1) + j;
      fit[at] =
        half.angle[j]! + Math.round((stored[j]! - half.angle[j]!) / (2 * Math.PI)) * 2 * Math.PI;
      // no direction, nothing to compare
      lo[at] = half.slow[j] === 1 ? Number.NEGATIVE_INFINITY : l;
      hi[at] = half.slow[j] === 1 ? Number.POSITIVE_INFINITY : u;
    }
  });
  return Object.freeze({ m, ctrl, error, clamped, angles: Object.freeze({ fit, lo, hi }) });
}

/**
 * How far the fitted section's tangent direction leaves the stored one's (rad), in the shape the section
 * has on the board: the section is `chord` wide and `thickness` thick there, so a tangent (du, dv) is
 * (chord·du, thickness·dv) and angles are measured on that (with the ratio limited, as a sliver at a tip has
 * no normal of its own). At each sample the fitted angle may be any angle the stored tangent takes within
 * {@link SECTION_NORMAL_WINDOW} samples (so the position tolerance can slide the fit along a tight bend); the
 * excess beyond that range is the deviation.
 */
export function normalExcess(angles: SampleAngles, chord: number, thickness: number): number {
  const { fit, lo, hi } = angles;
  let worst = 0;
  const ratio = chord > 0 && thickness > 0 ? chord / thickness : 1;
  const c = Math.min(Math.max(ratio, 1 / SECTION_ASPECT_LIMIT), SECTION_ASPECT_LIMIT);
  const phys = (t: number): number => {
    const p = Math.atan2(Math.sin(t), c * Math.cos(t));
    return t + wrapPi(p - t);
  };
  for (let k = 0; k < fit.length; k++) {
    const f = fit[k]!;
    if (f >= lo[k]! && f <= hi[k]!) continue;
    const e = f < lo[k]! ? phys(lo[k]!) - phys(f) : phys(f) - phys(hi[k]!);
    if (e > worst) worst = e;
  }
  return worst;
}
