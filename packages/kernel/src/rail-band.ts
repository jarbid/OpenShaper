// SPDX-License-Identifier: GPL-3.0-or-later
import { splineLengthToX, valueAt } from './bezier-spline';
import { getLength, type BezierBoard } from './board';
import { cachedOutlineSegments, hasTailCutout } from './outline-cutout';
import { bottomZAt, deckZAt, outlineInsetPointAt } from './surface';
import { vec2, type Vec2 } from './vec2';

/**
 * Hollow-wood rail-band templates.
 *
 * The rail band is the stack of laminated wood strips that builds the rail of a
 * hollow wooden surfboard: the builder bends strips around the internal frame at a
 * plan-view inset of `offset` from the outline (the rail apex curve), layer by
 * layer, then shapes the rail. One flat template per side suffices — it is
 * duplicated per lamination layer and the outer layers' excess is shaped away.
 *
 * Two constructions, two developments:
 *
 * - {@link developRailBand} — VERTICAL lamination: strips stand on edge, bent in
 *   plan around the offset curve. The band surface is that curve extruded
 *   vertically — a generalized cylinder, exactly developable with
 *   u = plan arc length, v = z (`flatten: false`). The default `flatten: true`
 *   instead models a strip that follows the rocker as it bends: u = the 3D arc
 *   length of the band's mid-curve and the edges are measured about that midline,
 *   giving a strip of ≈ board thickness that cuts from normal stock.
 *
 * - {@link developHorizontalRailBand} — HORIZONTAL lamination: layers lie flat,
 *   stacked from the bottom skin up, spanning the plan band between the outline
 *   and the offset curve. The layer bends over the rocker, so the template is the
 *   plan band developed longitudinally along the bottom rocker's arc length.
 *
 * Both replace the legacy BoardCAD rail template, which hard-coded 0.5 cm steps,
 * let the skin compensation diverge at the rail apex, and (in its flattened mode)
 * kept the plan arc length after removing rocker — printing a strip that is short
 * by the rocker's contribution to the bent length.
 */

export interface RailBandOptions {
  /** Rail-band stack thickness: plan inset of the band's inner face from the outline (cm). */
  offset: number;
  /** Stop the band this far from the tail (room for a tail block). Default 0. */
  tailTrim?: number;
  /** Stop the band this far from the nose. Default 0. */
  noseTrim?: number;
  /**
   * Deck/bottom skin thickness (cm): the band's edges pull in so the skins land on
   * top. Applied per edge as `skin · min(1/cos θ, 2)` with θ the local lateral
   * surface slope — the clamp keeps the legacy `t/cos θ` from diverging near the
   * rail apex. Default 0 (edges on the bare surface).
   */
  skinThickness?: number;
  /** Flattened strip (default true) vs exact vertical-ribbon development. */
  flatten?: boolean;
  /** Adaptive sampling tolerance (cm): max mid-sample deviation. Default 0.02. */
  tolerance?: number;
  /** Board-x stations (e.g. rib positions) to map onto the template's u axis. */
  stations?: readonly number[];
}

export interface RailBandResult {
  /** Deck edge, (u = developed length, v = height), tail→nose. Same u samples as `bottom`. */
  readonly deck: readonly Vec2[];
  /** Bottom edge, point-aligned with `deck`. */
  readonly bottom: readonly Vec2[];
  /** Total developed length (u of the last sample). */
  readonly length: number;
  /** u for each requested station; NaN where the station falls outside the domain. */
  readonly stationU: readonly number[];
  /** Effective board-x interval the band covers after trims and end clamping. */
  readonly domain: { readonly x0: number; readonly x1: number };
}

const EPS_Y = 0.05; // cm: min half-width of the offset curve for a sample to count
const EPS_H = 0.05; // cm: min deck-bottom height for a sample to count
const SLOPE_H = 0.2; // cm: lateral finite-difference step for the skin slope
const MAX_COMP_FACTOR = 2; // clamp of 1/cos θ (≈ 60° surface slope)
const SEED_POINTS = 17;
const MAX_DEPTH = 16;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

interface Sample {
  readonly x: number;
  readonly px: number;
  readonly py: number;
  readonly zd: number;
  readonly zb: number;
}

const sampleAt = (b: BezierBoard, len: number, offset: number, x: number): Sample | null => {
  const p = outlineInsetPointAt(b, x, offset);
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  if (p.y <= EPS_Y || p.x <= 0 || p.x >= len) return null;
  const zd = deckZAt(b, p.x, p.y);
  const zb = bottomZAt(b, p.x, p.y);
  if (!Number.isFinite(zd) || !Number.isFinite(zb)) return null;
  if (zd - zb <= EPS_H) return null;
  return { x, px: p.x, py: p.y, zd, zb };
};

/** Resolve the valid [x0, x1] and a seed scan; returns null when the band is empty. */
const resolveDomain = (
  b: BezierBoard,
  len: number,
  tailTrim: number,
  noseTrim: number,
  probe: (x: number) => Sample | null,
): { x0: number; x1: number } | null => {
  const eps = Math.min(0.01, len * 1e-4);
  let x0 = clamp(tailTrim, eps, len - eps);
  const x1 = clamp(len - noseTrim, eps, len - eps);
  if (hasTailCutout(b.outline)) {
    // The band follows the outer rail only: start past the notch apex.
    let apex = 0;
    for (const p of cachedOutlineSegments(b.outline).tailInner) apex = Math.max(apex, p.x);
    x0 = Math.max(x0, apex + 0.1);
  }
  if (x0 >= x1) return null;

  // Scan for the valid stretch, then bisect the exact boundaries.
  const M = 64;
  const at = (i: number): number => x0 + ((x1 - x0) * i) / M;
  let first = -1;
  let last = -1;
  for (let i = 0; i <= M; i++) {
    if (probe(at(i))) {
      if (first === -1) first = i;
      last = i;
    }
  }
  if (first === -1) return null;

  const bisect = (bad: number, good: number): number => {
    let lo = bad;
    let hi = good;
    for (let i = 0; i < 40 && Math.abs(hi - lo) > 1e-6; i++) {
      const mid = (lo + hi) / 2;
      if (probe(mid)) hi = mid;
      else lo = mid;
    }
    return hi;
  };
  const start = first === 0 ? x0 : bisect(at(first - 1), at(first));
  const end = last === M ? x1 : bisect(at(last + 1), at(last));
  return start < end ? { x0: start, x1: end } : null;
};

/** Adaptive subdivision on board-x, refining where any channel's midpoint leaves the chord. */
const adaptiveSamples = (
  probe: (x: number) => Sample | null,
  x0: number,
  x1: number,
  tol: number,
  channels: (s: Sample) => number[],
): Sample[] => {
  const out: Sample[] = [];
  const minDx = (x1 - x0) / 4096;

  const push = (s: Sample): void => {
    const prev = out[out.length - 1];
    // Dedupe and keep the plan path marching forward (guards offset-curve cusps).
    if (prev && s.px <= prev.px + 1e-9 && Math.abs(s.py - prev.py) < 1e-9) return;
    out.push(s);
  };

  const refine = (a: Sample, bS: Sample, depth: number): void => {
    const m = probe((a.x + bS.x) / 2);
    if (m === null || depth >= MAX_DEPTH || bS.x - a.x <= minDx) {
      push(bS);
      return;
    }
    const ca = channels(a);
    const cb = channels(bS);
    const cm = channels(m);
    let dev = 0;
    for (let i = 0; i < cm.length; i++) {
      dev = Math.max(dev, Math.abs(cm[i]! - (ca[i]! + cb[i]!) / 2));
    }
    if (dev > tol) {
      refine(a, m, depth + 1);
      refine(m, bS, depth + 1);
    } else {
      push(bS);
    }
  };

  let prev: Sample | null = null;
  for (let i = 0; i < SEED_POINTS; i++) {
    const x = x0 + ((x1 - x0) * i) / (SEED_POINTS - 1);
    const s = probe(x);
    if (!s) continue;
    if (!prev) {
      out.push(s);
    } else {
      refine(prev, s, 0);
    }
    prev = s;
  }
  return out;
};

/** u for each station by linear interpolation over the samples' board-x. */
const stationsToU = (
  stations: readonly number[],
  samples: readonly Sample[],
  us: readonly number[],
): number[] =>
  stations.map((sx) => {
    if (samples.length < 2) return NaN;
    if (sx < samples[0]!.x || sx > samples[samples.length - 1]!.x) return NaN;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1]!;
      const c = samples[i]!;
      if (sx <= c.x) {
        const t = c.x === a.x ? 0 : (sx - a.x) / (c.x - a.x);
        return us[i - 1]! + t * (us[i]! - us[i - 1]!);
      }
    }
    return us[us.length - 1]!;
  });

const emptyRailBand = (stations: readonly number[]): RailBandResult => ({
  deck: [],
  bottom: [],
  length: 0,
  stationU: stations.map(() => NaN),
  domain: { x0: 0, x1: 0 },
});

/** Slope-clamped skin compensation for one edge at plan point (px, py). */
const skinComp = (
  b: BezierBoard,
  px: number,
  py: number,
  skin: number,
  zAt: (b2: BezierBoard, x: number, y: number) => number,
): number => {
  const yLo = Math.max(0, py - SLOPE_H);
  const yHi = py + SLOPE_H;
  const zLo = zAt(b, px, yLo);
  const zHi = zAt(b, px, yHi);
  const dy = yHi - yLo;
  const slope = dy > 1e-9 && Number.isFinite(zLo) && Number.isFinite(zHi) ? (zHi - zLo) / dy : 0;
  return skin * Math.min(Math.hypot(1, slope), MAX_COMP_FACTOR);
};

/**
 * Develop the VERTICAL-lamination rail band into a flat template. See the module
 * doc for the geometry; returns point-aligned deck/bottom edges in (u, v) cm.
 */
export const developRailBand = (b: BezierBoard, opts: RailBandOptions): RailBandResult => {
  const {
    offset,
    tailTrim = 0,
    noseTrim = 0,
    skinThickness = 0,
    flatten = true,
    tolerance = 0.02,
    stations = [],
  } = opts;
  const len = getLength(b);
  if (!(len > 0) || !(offset > 0)) return emptyRailBand(stations);

  const probe = (x: number): Sample | null => sampleAt(b, len, offset, x);
  const domain = resolveDomain(b, len, tailTrim, noseTrim, probe);
  if (!domain) return emptyRailBand(stations);

  // Refinement channels are the RAW plan point and surface heights, so the sample
  // set is identical across flatten/skin variants (tests and parts stay aligned).
  const samples = adaptiveSamples(probe, domain.x0, domain.x1, tolerance, (s) => [
    s.px,
    s.py,
    s.zd,
    s.zb,
  ]);
  if (samples.length < 2) return emptyRailBand(stations);

  // Edge heights after skin compensation; collapse to the midline if the skins meet.
  const zDeck: number[] = [];
  const zBottom: number[] = [];
  for (const s of samples) {
    let zd = s.zd;
    let zb = s.zb;
    if (skinThickness > 0) {
      zd -= skinComp(b, s.px, s.py, skinThickness, deckZAt);
      zb += skinComp(b, s.px, s.py, skinThickness, bottomZAt);
      if (zd < zb) {
        const mid = (zd + zb) / 2;
        zd = mid;
        zb = mid;
      }
    }
    zDeck.push(zd);
    zBottom.push(zb);
  }

  // Developed u axis: plan arc length (exact vertical ribbon) or 3D mid-curve arc
  // length (flattened strip that follows the rocker).
  const us: number[] = [0];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const c = samples[i]!;
    const plan = Math.hypot(c.px - a.px, c.py - a.py);
    const du = flatten
      ? Math.hypot(plan, (zDeck[i]! + zBottom[i]!) / 2 - (zDeck[i - 1]! + zBottom[i - 1]!) / 2)
      : plan;
    us.push(us[i - 1]! + du);
  }

  const deck: Vec2[] = [];
  const bottom: Vec2[] = [];
  for (let i = 0; i < samples.length; i++) {
    const mid = flatten ? (zDeck[i]! + zBottom[i]!) / 2 : 0;
    deck.push(vec2(us[i]!, zDeck[i]! - mid));
    bottom.push(vec2(us[i]!, zBottom[i]! - mid));
  }

  return {
    deck,
    bottom,
    length: us[us.length - 1]!,
    stationU: stationsToU(stations, samples, us),
    domain,
  };
};

export interface HorizontalRailBandOptions {
  /** Plan width of the band: inset of its inner edge from the outline (cm). */
  offset: number;
  tailTrim?: number;
  noseTrim?: number;
  /** Adaptive sampling tolerance (cm). Default 0.02. */
  tolerance?: number;
  /** Board-x stations (rib positions) to map onto the developed u axis. */
  stations?: readonly number[];
}

export interface HorizontalRailBandResult {
  /** Outer (outline) edge, (u = developed length along the rocker, v = plan half-width). */
  readonly outer: readonly Vec2[];
  /** Inner (offset-curve) edge, point-aligned with `outer`. */
  readonly inner: readonly Vec2[];
  readonly length: number;
  readonly stationU: readonly number[];
  readonly domain: { readonly x0: number; readonly x1: number };
}

/**
 * Develop the HORIZONTAL-lamination rail band: the plan band between the outline
 * and the offset curve, stretched longitudinally to the bottom rocker's arc length
 * (the layer bends over the rocker as it is laminated onto the frame).
 */
export const developHorizontalRailBand = (
  b: BezierBoard,
  opts: HorizontalRailBandOptions,
): HorizontalRailBandResult => {
  const { offset, tailTrim = 0, noseTrim = 0, tolerance = 0.02, stations = [] } = opts;
  const len = getLength(b);
  const empty = (): HorizontalRailBandResult => ({
    outer: [],
    inner: [],
    length: 0,
    stationU: stations.map(() => NaN),
    domain: { x0: 0, x1: 0 },
  });
  if (!(len > 0) || !(offset > 0)) return empty();

  // A horizontal sample reuses the Sample shape: (px, py) = inner offset point,
  // zd = outer half-width, zb unused (0).
  const probe = (x: number): Sample | null => {
    const p = outlineInsetPointAt(b, x, offset);
    const oy = valueAt(b.outline, x);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(oy)) return null;
    if (p.y <= EPS_Y || p.y >= oy - 1e-6 || p.x <= 0 || p.x >= len) return null;
    return { x, px: p.x, py: p.y, zd: oy, zb: 0 };
  };

  const domain = resolveDomain(b, len, tailTrim, noseTrim, probe);
  if (!domain) return empty();

  const samples = adaptiveSamples(probe, domain.x0, domain.x1, tolerance, (s) => [
    s.px,
    s.py,
    s.zd,
  ]);
  if (samples.length < 2) return empty();

  const u0 = splineLengthToX(b.bottom, domain.x0);
  const uOuter = samples.map((s) => splineLengthToX(b.bottom, s.x) - u0);
  const uInner = samples.map((s) => splineLengthToX(b.bottom, clamp(s.px, 0, len)) - u0);

  const outer: Vec2[] = [];
  const inner: Vec2[] = [];
  for (let i = 0; i < samples.length; i++) {
    outer.push(vec2(uOuter[i]!, samples[i]!.zd));
    inner.push(vec2(uInner[i]!, samples[i]!.py));
  }

  return {
    outer,
    inner,
    length: uOuter[uOuter.length - 1]!,
    stationU: stationsToU(stations, samples, uOuter),
    domain,
  };
};
