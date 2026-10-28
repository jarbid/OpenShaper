// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The section fit and the smooth blend along the board (docs/design/m1-model.md §2).
 *
 * **Fit.** A station's section chain (normalised u-v) is resampled by arc-length
 * fraction, separately on each half (bottom to apex, apex to deck), and fitted by
 * a least-squares cubic B-spline (`approximateCurve`) on a knot vector that all
 * stations of a side share: `m` equal spans per half, a triple knot at t = ½ (the
 * apex). The fit holds the centre points, the horizontal centre tangents and the
 * apex point exactly; a vertical apex tangent is held when the stored one is.
 * `m` climbs a ladder until every station is within {@link SECTION_FIT_TOL} cm.
 *
 * **Blend.** Each control coordinate is interpolated along ξ by the complete
 * cubic spline through the stations (zero end slopes), held constant beyond the
 * end stations. The spline is C2 at every interior station; the result is
 * therefore C2 along the board. (At an end station that lies inside the board the
 * curvature may jump: put the end stations at the board's ends.)
 */
import { approximateCurve, controlPointsInto } from '@openshaper/geom';
import type { CurveConstraint } from '@openshaper/geom';
import { arcFractionParams, chainEval, compileChain } from './chain';
import {
  SECTION_EXACT_TOL,
  SECTION_FIT_TOL,
  SECTION_HALF_SAMPLES,
  SECTION_SPAN_LADDER,
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

function computeFit(section: Section, m: number): SectionFit | null {
  const chain = compileChain(section.chain);
  const knots = section.chain.knots;
  const n = knots.length;
  const a = section.apex;
  const apex = knots[a]!;
  const vertical =
    Math.abs(apex.in[0] - 1) <= SECTION_EXACT_TOL && Math.abs(apex.out[0] - 1) <= SECTION_EXACT_TOL;
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
  const bottom: CurveConstraint<2>[] = [
    pt(0, 0, 0),
    dir(0, horizontal),
    pt(1, apex.p[0], apex.p[1]),
  ];
  const deck: CurveConstraint<2>[] = [pt(0, apex.p[0], apex.p[1]), pt(1, 0, 1), dir(1, horizontal)];
  if (vertical) {
    bottom.push(dir(1, upward));
    deck.push(dir(0, upward));
  }
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
  pin(1, 1, 0);
  pin(count - 1, 0, 0);
  pin(count - 1, 1, 1);
  pin(count - 2, 1, 1);
  pin(nb - 1, 0, apex.p[0]);
  ctrl[2 * (nb - 1) + 1] = apex.p[1];
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
  /** Fitted controls per station, `width` each, and the spline's second derivatives (moments). */
  readonly q: Float64Array;
  readonly mom: Float64Array;
  /** Per station: the fit error in cm (error × scale). */
  readonly stationError: Float64Array;
  /** Controls the fit pulled back into bounds, all stations. */
  readonly clamped: number;
}

/**
 * Fits every station on a common knot vector and prepares the blend. Returns
 * `null` if no rung of the ladder could fit every section (the geom refusal);
 * otherwise the last rung is used even if it misses {@link SECTION_FIT_TOL}
 * (the miss is in `stationError`).
 */
export function fitSide(items: readonly SideItem[]): SideBlend | null {
  let chosen: { m: number; fits: SectionFit[] } | null = null;
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
    chosen = { m, fits };
    let worst = 0;
    for (let i = 0; i < items.length; i++)
      worst = Math.max(worst, fits[i]!.error * items[i]!.scale);
    if (worst <= SECTION_FIT_TOL) break;
  }
  if (chosen === null) return null;
  const { m, fits } = chosen;
  const n = items.length;
  const width = 2 * controlCount(m);
  const xs = Float64Array.from(items.map((i) => i.x));
  const q = new Float64Array(n * width);
  const stationError = new Float64Array(n);
  let clamped = 0;
  for (let i = 0; i < n; i++) {
    q.set(fits[i]!.ctrl, i * width);
    stationError[i] = fits[i]!.error * items[i]!.scale;
    clamped += fits[i]!.clamped;
  }
  const mom = moments(xs, q, n, width);
  return Object.freeze({ m, knots: sectionKnots(m), width, xs, q, mom, stationError, clamped });
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
 */
export function blendAt(
  b: SideBlend,
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
      if (order >= 2) c2[k] = on ? b.mom[i * w + k]! : 0;
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
    const m0 = b.mom[o0 + k]!;
    const m1 = b.mom[o1 + k]!;
    c[k] = A * y0 + B * y1 + kA * m0 + kB * m1;
    if (order >= 1) c1[k] = (y1 - y0) / h + dA * m0 + dB * m1;
    if (order >= 2) c2[k] = A * m0 + B * m1;
  }
}
