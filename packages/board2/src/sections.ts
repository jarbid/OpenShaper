// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The section fit and the smooth blend along the board (docs/design/m1-model.md §2).
 *
 * **Fit.** A station's section chain (normalised u-v) is fitted, separately on each half (bottom to
 * apex, apex to deck), by a least-squares cubic B-spline on a knot vector that all stations of a
 * side share: `m` spans per half, graded towards the rail, a triple knot at t = ½ (the apex). The
 * fit (`section-lsq.ts`) holds the centre points, the horizontal centre tangents and the apex point
 * exactly (a vertical apex tangent on both sides when the stored one is within
 * {@link SECTION_APEX_TOL} of vertical), registers the rail of every section to the same
 * parameter, fits the tangent direction as well as the positions, and holds a corner of the stored
 * section exactly. `m` climbs a ladder until every station is within {@link SECTION_FIT_TOL} cm and
 * {@link SECTION_NORMAL_TOL} of the stored section's tangent direction, or the fit stops improving.
 *
 * **Blend.** Each control coordinate is interpolated along ξ by a **local** C2
 * quintic Hermite interpolant through the stations, held constant beyond the end
 * stations: at each station its slope is the Fritsch-Carlson (Brodlie) slope of the
 * monotone cubic through the same data, and its second derivative the smaller (minmod)
 * of that cubic's one-sided ones (0 at an end station or a local extremum). It is C2
 * everywhere, depends only on the neighbouring stations and continuously on them, and
 * follows the data without ringing. (The complete C2 cubic spline it replaces is global:
 * a tip station whose normalised shape is far from its neighbours' made it overshoot
 * through the whole board, a lump in the tuck and up to 4.7 mm off classic between the
 * stations of the shortboard.) The u coordinates, which must stay within [0, 1], go
 * through one smooth limiter instead of a clamp or a switch: see {@link blendAt}.
 */
import {
  arrivingDirection,
  computeFit,
  controlCount,
  isNearVertical,
  leavingDirection,
  normalExcess,
  sectionKnots,
} from './section-lsq';
import type { SectionFit } from './section-lsq';
import {
  BLEND_ROOM_MIN,
  SECTION_COST_TIE,
  SECTION_FIT_TOL,
  SECTION_NORMAL_TOL,
  SECTION_SPAN_LADDER,
  SECTION_STALL_PATIENCE,
  SECTION_STALL_RATIO,
} from './params';
import type { Section } from './types';

export { arrivingDirection, controlCount, isNearVertical, leavingDirection, sectionKnots };
export type { SectionFit };

const cache = new WeakMap<Section, Map<number, SectionFit | null>>();

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

/**
 * What a station's fit costs, in cm: the larger of its position error and the position tolerance times the
 * share of {@link SECTION_NORMAL_TOL} its tangent direction misses by, so the cost is within
 * {@link SECTION_FIT_TOL} exactly when both are; and a small share of the position error besides, so a rung
 * that improves the position while the direction cannot be improved still counts as better.
 */
function fitCost(fit: SectionFit, it: SideItem): number {
  const pos = fit.error * it.scale;
  const dir = (SECTION_FIT_TOL * stationNormal(fit, it)) / SECTION_NORMAL_TOL;
  return Math.max(pos, dir) + SECTION_COST_TIE * pos;
}

// ---------------------------------------------------------------------------
// One side's blend
// ---------------------------------------------------------------------------

/**
 * A station's input to {@link fitSide}: `scale` converts normalised error to cm (the larger of chord length
 * and thickness there); `chord` and `thickness` (cm, default `scale`) give the section its shape for the
 * tangent-direction check.
 */
export interface SideItem {
  readonly id: string;
  readonly x: number;
  readonly section: Section;
  readonly scale: number;
  readonly chord?: number;
  readonly thickness?: number;
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
   * Fitted controls per station, `width` each, and per station the slope `d` and second derivative
   * `dd` in ξ of the blend there (`width` each): the Fritsch-Carlson slopes and the minmod of the
   * monotone cubic's one-sided second derivatives (see {@link blendControls}).
   */
  readonly q: Float64Array;
  readonly d: Float64Array;
  readonly dd: Float64Array;
  /** Per station: the fit error in cm (error × scale). */
  readonly stationError: Float64Array;
  /** Per station: how far the fitted tangent direction leaves the stored one's, rad ({@link normalExcess}). */
  readonly stationNormal: Float64Array;
  /** Controls the fit pulled back into bounds, all stations. */
  readonly clamped: number;
}

const stationNormal = (fit: SectionFit, it: SideItem): number =>
  normalExcess(fit.angles, it.chord ?? it.scale, it.thickness ?? it.scale);

/**
 * The stopping rule of the span ladder. Offer the worst station cost (cm: see `fitCost`) of each rung in
 * turn; the answer says whether this rung is the best so far (keep it) and whether to stop climbing:
 * the cost is within {@link SECTION_FIT_TOL} (position and tangent direction both), or {@link SECTION_STALL_PATIENCE} rungs in a row have failed to
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
    return {
      best: better,
      stop: worst <= SECTION_FIT_TOL * (1 + SECTION_COST_TIE) || stalled >= SECTION_STALL_PATIENCE,
    };
  };
}

/** What {@link blendAt} needs: a side's blend without the fit report. */
export type Blend = Omit<SideBlend, 'stationError' | 'stationNormal' | 'clamped'>;

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
    // the rung's worst station cost, in cm (see fitCost): within the tolerance only when both the
    // position and the tangent direction are, and an improvement in either counts
    let worst = 0;
    let ok = true;
    for (const it of items) {
      const f = fitSection(it.section, m);
      if (f === null) {
        ok = false;
        break;
      }
      fits.push(f);
      worst = Math.max(worst, fitCost(f, it));
    }
    if (!ok) continue;
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
  const stationNormalErr = new Float64Array(n);
  let clamped = 0;
  for (let i = 0; i < n; i++) {
    q.set(fits[i]!.ctrl, i * width);
    stationError[i] = fits[i]!.error * items[i]!.scale;
    stationNormalErr[i] = stationNormal(fits[i]!, items[i]!);
    clamped += fits[i]!.clamped;
  }
  const blend = blendControls(m, Float64Array.from(items.map((i) => i.x)), q);
  return Object.freeze({ ...blend, stationError, stationNormal: stationNormalErr, clamped });
}

/**
 * The blend through given station controls: `q` holds `width = 2·controlCount(m)` coordinates per
 * station, `xs` the strictly increasing station coordinates. (The seam between the fits and the
 * interpolation along the board; the fits are `fitSide`'s.)
 *
 * Per coordinate and station: the slope is the Fritsch-Carlson / Brodlie weighted harmonic mean of the
 * neighbouring chord slopes (0 at a local extremum and at the end stations), so the cubic Hermite with
 * these slopes is monotone on every interval and stays within the range of its data; the second
 * derivative is the minmod of that cubic's second derivatives just left and right of the station (0
 * where they disagree in sign, and at the end stations, so the blend joins the held end section with
 * C2). Both depend continuously on the data.
 */
export function blendControls(m: number, xs: Float64Array, q: Float64Array): Blend {
  const n = xs.length;
  const width = 2 * controlCount(m);
  const d = new Float64Array(n * width);
  const dd = new Float64Array(n * width);
  const h = (i: number): number => xs[i + 1]! - xs[i]!;
  for (let k = 0; k < width; k++) {
    const delta = (i: number): number => (q[(i + 1) * width + k]! - q[i * width + k]!) / h(i);
    for (let i = 1; i + 1 < n; i++) {
      const l = delta(i - 1);
      const r = delta(i);
      if (l * r > 0) {
        const w1 = 2 * h(i) + h(i - 1);
        const w2 = h(i) + 2 * h(i - 1);
        d[i * width + k] = (w1 + w2) / (w1 / l + w2 / r);
      }
    }
    for (let i = 1; i + 1 < n; i++) {
      const di = d[i * width + k]!;
      const left = (-6 * delta(i - 1) + 2 * d[(i - 1) * width + k]! + 4 * di) / h(i - 1);
      const right = (6 * delta(i) - 4 * di - 2 * d[(i + 1) * width + k]!) / h(i);
      dd[i * width + k] =
        left * right > 0 ? Math.sign(left) * Math.min(Math.abs(left), Math.abs(right)) : 0;
    }
  }
  return { m, knots: sectionKnots(m), width, xs, q, d, dd };
}

/**
 * The blended controls at ξ and their first and second derivatives in ξ, into
 * `c`, `c1`, `c2` (each `width` long); a derivative array is only written for
 * the orders asked. Beyond the end stations the end section is held (value
 * exact, first and second derivatives 0, as the blend's at the end station).
 *
 * **The bounded u coordinates.** The C2 quintic `s` through a u coordinate's station values may
 * leave [0, 1] slightly (a rail that is full at one station and tucked at the next). Instead of a switch or
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
    for (let k = 0; k < w; k++) {
      c[k] = b.q[i * w + k]!;
      if (order >= 1) c1[k] = 0;
      if (order >= 2) c2[k] = 0;
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
  const t = (xi - b.xs[lo]!) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  const o0 = lo * w;
  const o1 = (lo + 1) * w;
  // cubic Hermite basis (the monotone interpolant of the u coordinates) and its derivatives in t
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = 3 * t2 - 2 * t3;
  const h11 = t3 - t2;
  const g00 = 6 * t2 - 6 * t;
  const g10 = 3 * t2 - 4 * t + 1;
  const g11 = 3 * t2 - 2 * t;
  const k00 = 12 * t - 6;
  const k10 = 6 * t - 4;
  const k11 = 6 * t - 2;
  for (let k = 0; k < w; k++) {
    const y0 = b.q[o0 + k]!;
    const y1 = b.q[o1 + k]!;
    const d0 = b.d[o0 + k]! * h;
    const d1 = b.d[o1 + k]! * h;
    const D0 = b.dd[o0 + k]! * h * h;
    const D1 = b.dd[o1 + k]! * h * h;
    // quintic Hermite p(t) = y0 + d0 t + D0/2 t² + c3 t³ + c4 t⁴ + c5 t⁵ with p, p', p'' = y1, d1, D1 at t = 1
    const r0 = y1 - y0 - d0 - D0 / 2;
    const r1 = d1 - d0 - D0;
    const r2 = D1 - D0;
    const c3 = 10 * r0 - 4 * r1 + r2 / 2;
    const c4 = -15 * r0 + 7 * r1 - r2;
    const c5 = 6 * r0 - 3 * r1 + r2 / 2;
    let s = y0 + t * (d0 + t * (D0 / 2 + t * (c3 + t * (c4 + t * c5))));
    let s1 = (d0 + t * (D0 + t * (3 * c3 + t * (4 * c4 + t * 5 * c5)))) / h;
    let s2 = (D0 + t * (6 * c3 + t * (12 * c4 + t * 20 * c5))) / (h * h);
    if ((k & 1) === 0) {
      // u coordinate: limit the quintic's excursion from the monotone cubic (see above)
      const m = h00 * y0 + h10 * d0 + h01 * y1 + h11 * d1;
      const mp = (g00 * (y0 - y1) + g10 * d0 + g11 * d1) / h;
      const mpp = (k00 * (y0 - y1) + k10 * d0 + k11 * d1) / (h * h);
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
