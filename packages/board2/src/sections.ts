// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The section fit and the smooth blend along the board (docs/design/m1-model.md §2).
 *
 * **Fit.** A station's section chain (normalised u-v) is resampled by arc-length
 * fraction, separately on each half (bottom to apex, apex to deck), and fitted by
 * a least-squares cubic B-spline (`approximateCurve`) on a knot vector that all
 * stations of a side share: `m` equal spans per half, a triple knot at t = ½ (the
 * apex). The fit holds the centre points, the horizontal centre tangents and the
 * apex point exactly; a vertical apex tangent is held (on both sides) when the stored one is within
 * {@link SECTION_APEX_TOL} of vertical.
 * `m` climbs a ladder until every station is within {@link SECTION_FIT_TOL} cm or the error
 * stops improving.
 *
 * **Blend.** Each control coordinate is interpolated along ξ by the complete
 * cubic spline through the stations (zero end slopes), held constant beyond the
 * end stations. The spline is C2 at every interior station; the result is
 * therefore C2 along the board. (At an end station that lies inside the board the
 * curvature may jump: put the end stations at the board's ends.) The u coordinates,
 * which must stay within [0, 1], go through one smooth limiter instead of a clamp
 * or a switch: see {@link blendAt}. It depends continuously on the stations, so
 * moving a station moves the surface by a comparable amount.
 */
import { approximateCurve, controlPointsInto } from '@openshaper/geom';
import type { CurveConstraint } from '@openshaper/geom';
import { arcFractionParams, chainEval, compileChain } from './chain';
import {
  BLEND_ROOM_MIN,
  SECTION_APEX_TOL,
  SECTION_DIRECTION_TOL,
  SECTION_EXACT_TOL,
  SECTION_FIT_TOL,
  SECTION_HANDLE_MIN,
  SECTION_HALF_SAMPLES,
  SECTION_SPAN_LADDER,
  SECTION_STALL_PATIENCE,
  SECTION_STALL_RATIO,
} from './params';
import type { Section } from './types';

/** Control points of the blended section for `m` spans per half. */
export const controlCount = (m: number): number => 2 * m + 5;

/** The shared clamped cubic knot vector: `m` equal spans per half, triple knot at ½. */
export function sectionKnots(m: number): Float64Array {
  const k: number[] = [0, 0, 0, 0];
  for (let i = 1; i < m; i++) k.push(i / (2 * m));
  k.push(0.5, 0.5, 0.5);
  for (let i = 1; i < m; i++) k.push(0.5 + i / (2 * m));
  k.push(1, 1, 1, 1);
  return Float64Array.from(k);
}

function halfKnots(m: number): Float64Array {
  const k: number[] = [0, 0, 0, 0];
  for (let i = 1; i < m; i++) k.push(i / m);
  k.push(1, 1, 1, 1);
  return Float64Array.from(k);
}

/** One section fitted onto the `m`-span knot vector: `2·controlCount(m)` coordinates (u, v pairs). */
export interface SectionFit {
  readonly m: number;
  readonly ctrl: Float64Array;
  /** Largest distance from a sample to the fitted curve, normalised units. */
  readonly error: number;
  /** Controls moved back into the bounds. */
  readonly clamped: number;
}

const cache = new WeakMap<Section, Map<number, SectionFit | null>>();

const fractions = ((): Float64Array => {
  const f = new Float64Array(SECTION_HALF_SAMPLES + 1);
  for (let j = 0; j <= SECTION_HALF_SAMPLES; j++) f[j] = j / SECTION_HALF_SAMPLES;
  return f;
})();

/** Fits one section at `m` spans per half; cached by section identity. `null` if the fit failed. */
export function fitSection(section: Section, m: number): SectionFit | null {
  let byM = cache.get(section);
  if (byM === undefined) {
    byM = new Map();
    cache.set(section, byM);
  }
  if (byM.has(m)) return byM.get(m)!;
  const fit = computeFit(section, m);
  byM.set(m, fit);
  return fit;
}

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

function computeFit(section: Section, m: number): SectionFit | null {
  const chain = compileChain(section.chain);
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
  const sample = (s0: number, s1: number): Float64Array => {
    const ss = arcFractionParams(chain, s0, s1, fractions);
    const pts = new Float64Array(2 * ss.length);
    for (let j = 0; j < ss.length; j++) chainEval(chain, ss[j]!, 0, pts, 2 * j);
    return pts;
  };
  const horizontal = { x: 1, y: 0 };
  const upward = { x: 0, y: 1 };
  const pt = (t: number, x: number, y: number): CurveConstraint<2> => ({
    kind: 'point',
    t,
    value: { x, y },
  });
  const dir = (t: number, d: { x: number; y: number }): CurveConstraint<2> => ({
    kind: 'tangentDirection',
    t,
    direction: d,
  });
  const bottom: CurveConstraint<2>[] = [pt(0, 0, 0), pt(1, apex.p[0], apex.p[1])];
  const deck: CurveConstraint<2>[] = [pt(0, apex.p[0], apex.p[1]), pt(1, 0, 1)];
  if (bottomFlat) bottom.push(dir(0, horizontal));
  if (deckFlat) deck.push(dir(1, horizontal));
  if (apexBelowVertical) bottom.push(dir(1, upward));
  if (apexAboveVertical) deck.push(dir(0, upward));
  const half = (
    s0: number,
    s1: number,
    cons: CurveConstraint<2>[],
  ): { ctrl: Float64Array; err: number } | null => {
    const r = approximateCurve(sample(s0, s1), 2, {
      degree: 3,
      knots: halfKnots(m),
      params: fractions,
      constraints: cons,
    });
    if (!r.ok) return null;
    const ctrl = new Float64Array(2 * (m + 3));
    controlPointsInto(r.value.curve, ctrl);
    return { ctrl, err: r.value.maxError };
  };
  const b = half(0, a, bottom);
  const d = half(a, n - 1, deck);
  if (b === null || d === null) return null;
  const count = controlCount(m);
  const ctrl = new Float64Array(2 * count);
  const nb = m + 3;
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
  const error = Math.max(b.err, d.err);
  return Object.freeze({ m, ctrl, error, clamped });
}

// ---------------------------------------------------------------------------
// One side's blend
// ---------------------------------------------------------------------------

/** A station's input to {@link fitSide}: `scale` converts normalised error to cm (the larger of chord length and thickness there). */
export interface SideItem {
  readonly id: string;
  readonly x: number;
  readonly section: Section;
  readonly scale: number;
}

export interface SideBlend {
  readonly m: number;
  /** The shared knot vector (clamped cubic, triple knot at ½). */
  readonly knots: Float64Array;
  /** Control coordinates per curve: `2·controlCount(m)`. */
  readonly width: number;
  /** Station coordinates ξ, strictly increasing. */
  readonly xs: Float64Array;
  /**
   * Fitted controls per station, `width` each, and per interval the second derivatives of its cubic
   * at its left and right end (`lm`, `rm`; `width` each per interval): those of the complete C2
   * spline. For the u coordinates (even indices) `ml`, `mr` hold the same for the monotone cubic
   * Hermite interpolant (Fritsch-Carlson slopes, zero end slopes), which cannot leave the range of
   * its data; {@link blendAt} limits the C2 spline's excursion from it. (Entries of the other
   * coordinates are 0.)
   */
  readonly q: Float64Array;
  readonly lm: Float64Array;
  readonly rm: Float64Array;
  readonly ml: Float64Array;
  readonly mr: Float64Array;
  /** Per station: the fit error in cm (error × scale). */
  readonly stationError: Float64Array;
  /** Controls the fit pulled back into bounds, all stations. */
  readonly clamped: number;
}

/**
 * The stopping rule of the span ladder. Offer the worst station error (cm) of each rung in turn; the
 * answer says whether this rung is the best so far (keep it) and whether to stop climbing: the error
 * is within {@link SECTION_FIT_TOL}, or {@link SECTION_STALL_PATIENCE} rungs in a row have failed to
 * beat the best error by {@link SECTION_STALL_RATIO}.
 */
export function ladderClimb(): (worst: number) => { best: boolean; stop: boolean } {
  let best = Number.POSITIVE_INFINITY;
  let stalled = 0;
  return (worst) => {
    const better = worst < best;
    stalled =
      worst <= SECTION_STALL_RATIO * best || best === Number.POSITIVE_INFINITY ? 0 : stalled + 1;
    if (better) best = worst;
    return { best: better, stop: worst <= SECTION_FIT_TOL || stalled >= SECTION_STALL_PATIENCE };
  };
}

/** What {@link blendAt} needs: a side's blend without the fit report. */
export type Blend = Omit<SideBlend, 'stationError' | 'clamped'>;

/**
 * Fits every station on a common knot vector and prepares the blend. Returns
 * `null` if no rung of the ladder could fit every section (the geom refusal);
 * otherwise the last rung is used even if it misses {@link SECTION_FIT_TOL}
 * (the miss is in `stationError`).
 */
export function fitSide(items: readonly SideItem[]): SideBlend | null {
  // Climb the ladder until the worst station is within the limit, or until the error stops improving
  // (a corner knot of a classic slice converges slowly and may not be resolved at all).
  let chosen: { m: number; fits: SectionFit[] } | null = null;
  const climb = ladderClimb();
  for (const m of SECTION_SPAN_LADDER) {
    const fits: SectionFit[] = [];
    let ok = true;
    for (const it of items) {
      const f = fitSection(it.section, m);
      if (f === null) {
        ok = false;
        break;
      }
      fits.push(f);
    }
    if (!ok) continue;
    let worst = 0;
    for (let i = 0; i < items.length; i++)
      worst = Math.max(worst, fits[i]!.error * items[i]!.scale);
    const step = climb(worst);
    if (step.best) chosen = { m, fits };
    if (step.stop) break;
  }
  if (chosen === null) return null;
  const { m, fits } = chosen;
  const n = items.length;
  const width = 2 * controlCount(m);
  const q = new Float64Array(n * width);
  const stationError = new Float64Array(n);
  let clamped = 0;
  for (let i = 0; i < n; i++) {
    q.set(fits[i]!.ctrl, i * width);
    stationError[i] = fits[i]!.error * items[i]!.scale;
    clamped += fits[i]!.clamped;
  }
  const blend = blendControls(m, Float64Array.from(items.map((i) => i.x)), q);
  return Object.freeze({ ...blend, stationError, clamped });
}

/**
 * The blend through given station controls: `q` holds `width = 2·controlCount(m)` coordinates per
 * station, `xs` the strictly increasing station coordinates. (The seam between the fits and the
 * interpolation along the board; the fits are `fitSide`'s.)
 */
export function blendControls(m: number, xs: Float64Array, q: Float64Array): Blend {
  const n = xs.length;
  const width = 2 * controlCount(m);
  const mom = moments(xs, q, n, width);
  const lm = new Float64Array(Math.max(n - 1, 0) * width);
  const rm = new Float64Array(Math.max(n - 1, 0) * width);
  for (let i = 0; i + 1 < n; i++) {
    lm.set(mom.subarray(i * width, (i + 1) * width), i * width);
    rm.set(mom.subarray((i + 1) * width, (i + 2) * width), i * width);
  }
  const { ml, mr } = monotoneMoments(xs, q, n, width);
  return { m, knots: sectionKnots(m), width, xs, q, lm, rm, ml, mr };
}

/**
 * The interval moments (second derivatives at the left and right end of each interval) of the
 * monotone cubic Hermite interpolant (Fritsch-Carlson / Brodlie weighted harmonic slopes, zero end
 * slopes) of every u coordinate (even index). It is C1 and stays within the range of its data on
 * each interval; its slope depends continuously on the data (0 at a local extremum).
 */
function monotoneMoments(
  xs: Float64Array,
  q: Float64Array,
  n: number,
  width: number,
): { ml: Float64Array; mr: Float64Array } {
  const ml = new Float64Array(Math.max(n - 1, 0) * width);
  const mr = new Float64Array(Math.max(n - 1, 0) * width);
  const d = new Float64Array(n);
  const h = (i: number): number => xs[i + 1]! - xs[i]!;
  for (let k = 0; k < width; k += 2) {
    const delta = (i: number): number => (q[(i + 1) * width + k]! - q[i * width + k]!) / h(i);
    d.fill(0);
    for (let i = 1; i + 1 < n; i++) {
      const l = delta(i - 1);
      const r = delta(i);
      if (l * r > 0) {
        const w1 = 2 * h(i) + h(i - 1);
        const w2 = h(i) + 2 * h(i - 1);
        d[i] = (w1 + w2) / (w1 / l + w2 / r);
      }
    }
    for (let i = 0; i + 1 < n; i++) {
      const hh = h(i);
      const dl = delta(i);
      ml[i * width + k] = (6 * dl - 4 * d[i]! - 2 * d[i + 1]!) / hh;
      mr[i * width + k] = (-6 * dl + 2 * d[i]! + 4 * d[i + 1]!) / hh;
    }
  }
  return { ml, mr };
}

/**
 * Second derivatives of the complete cubic spline (zero end slopes) through
 * `n` stations for `width` curves at once (Thomas algorithm).
 */
function moments(xs: Float64Array, q: Float64Array, n: number, width: number): Float64Array {
  const mom = new Float64Array(n * width);
  if (n < 2) return mom;
  const h = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) h[i] = xs[i + 1]! - xs[i]!;
  const diag = new Float64Array(n);
  const low = new Float64Array(n);
  const up = new Float64Array(n);
  diag[0] = 2 * h[0]!;
  up[0] = h[0]!;
  diag[n - 1] = 2 * h[n - 2]!;
  low[n - 1] = h[n - 2]!;
  for (let i = 1; i < n - 1; i++) {
    low[i] = h[i - 1]!;
    diag[i] = 2 * (h[i - 1]! + h[i]!);
    up[i] = h[i]!;
  }
  const rhs = mom; // solved in place
  for (let c = 0; c < width; c++) {
    const slope = (i: number): number => (q[(i + 1) * width + c]! - q[i * width + c]!) / h[i]!;
    rhs[c] = 6 * slope(0);
    rhs[(n - 1) * width + c] = -6 * slope(n - 2);
    for (let i = 1; i < n - 1; i++) rhs[i * width + c] = 6 * (slope(i) - slope(i - 1));
  }
  // forward elimination
  const cp = new Float64Array(n);
  cp[0] = up[0]! / diag[0]!;
  for (let c = 0; c < width; c++) rhs[c] = rhs[c]! / diag[0]!;
  for (let i = 1; i < n; i++) {
    const den = diag[i]! - low[i]! * cp[i - 1]!;
    cp[i] = up[i]! / den;
    for (let c = 0; c < width; c++) {
      rhs[i * width + c] = (rhs[i * width + c]! - low[i]! * rhs[(i - 1) * width + c]!) / den;
    }
  }
  for (let i = n - 2; i >= 0; i--) {
    for (let c = 0; c < width; c++) {
      rhs[i * width + c] = rhs[i * width + c]! - cp[i]! * rhs[(i + 1) * width + c]!;
    }
  }
  return mom;
}

/**
 * The blended controls at ξ and their first and second derivatives in ξ, into
 * `c`, `c1`, `c2` (each `width` long); a derivative array is only written for
 * the orders asked. Beyond the end stations the end section is held (value
 * exact, first derivative 0; the second is the spline's at the station itself).
 *
 * **The bounded u coordinates.** The C2 spline `s` through a u coordinate's station values may
 * leave [0, 1] (a rail that is full at one station and tucked at the next). Instead of a switch or
 * a clamp, the coordinate is `m + r·T(e / r)`: `m` is the monotone interpolant of the same data
 * (always inside [0, 1]), `e = s − m` the spline's excursion from it, `r = m (1 − m)` the room to
 * the nearest bound (never more than the distance to it), and `T(z) = z / √(1 + z²)` a smooth
 * saturation. It cannot leave [0, 1] and passes through every station value. Where there is room
 * (`e ≪ r`) it equals `s` to third order in `e / r`, so it is C2 across a station that is clear of
 * the bounds; where the data touch a bound it follows `m` there (slope 0 on both sides, so the
 * normal stays continuous; only the curvature can jump). It is a continuous function of the
 * stations, which a threshold between two blends was not.
 */
export function blendAt(
  b: Blend,
  xi: number,
  order: 0 | 1 | 2,
  c: Float64Array,
  c1: Float64Array,
  c2: Float64Array,
): void {
  const n = b.xs.length;
  const w = b.width;
  if (n === 1 || xi <= b.xs[0]! || xi >= b.xs[n - 1]!) {
    const i = n === 1 || xi <= b.xs[0]! ? 0 : n - 1;
    const on = xi === b.xs[i]!;
    for (let k = 0; k < w; k++) {
      c[k] = b.q[i * w + k]!;
      if (order >= 1) c1[k] = 0;
      if (order >= 2) c2[k] = on && n > 1 ? (i === 0 ? b.lm[k]! : b.rm[(n - 2) * w + k]!) : 0;
    }
    return;
  }
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (b.xs[mid]! <= xi) lo = mid;
    else hi = mid;
  }
  const h = b.xs[lo + 1]! - b.xs[lo]!;
  const A = (b.xs[lo + 1]! - xi) / h;
  const B = 1 - A;
  const kA = ((A * A * A - A) * h * h) / 6;
  const kB = ((B * B * B - B) * h * h) / 6;
  const dA = (-(3 * A * A - 1) * h) / 6;
  const dB = ((3 * B * B - 1) * h) / 6;
  const o0 = lo * w;
  const o1 = (lo + 1) * w;
  for (let k = 0; k < w; k++) {
    const y0 = b.q[o0 + k]!;
    const y1 = b.q[o1 + k]!;
    const m0 = b.lm[o0 + k]!;
    const m1 = b.rm[o0 + k]!;
    let s = A * y0 + B * y1 + kA * m0 + kB * m1;
    let s1 = (y1 - y0) / h + dA * m0 + dB * m1;
    let s2 = A * m0 + B * m1;
    if ((k & 1) === 0) {
      // u coordinate: limit the spline's excursion from the monotone interpolant (see above)
      const n0 = b.ml[o0 + k]!;
      const n1 = b.mr[o0 + k]!;
      const m = A * y0 + B * y1 + kA * n0 + kB * n1;
      const mp = (y1 - y0) / h + dA * n0 + dB * n1;
      const mpp = A * n0 + B * n1;
      const e = s - m;
      const r = m * (1 - m);
      if (r > BLEND_ROOM_MIN) {
        const rp = mp * (1 - 2 * m);
        const rpp = mpp * (1 - 2 * m) - 2 * mp * mp;
        const z = e / r;
        const q = Math.sqrt(1 + z * z);
        const T = z / q;
        const S = 1 / (q * q * q);
        const Sz = (-3 * z * S) / (q * q);
        const ep = s1 - mp;
        const zp = (ep - z * rp) / r;
        const lim = T - S * z;
        s = m + r * T;
        s1 = mp + rp * lim + S * ep;
        s2 = mpp + rpp * lim + r * Sz * zp * zp + S * (s2 - mpp);
      } else {
        s = m;
        s1 = mp;
        s2 = mpp;
      }
    }
    c[k] = s;
    if (order >= 1) c1[k] = s1;
    if (order >= 2) c2[k] = s2;
  }
}
