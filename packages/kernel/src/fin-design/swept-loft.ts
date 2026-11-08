// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The sides of the fin's profile (owner proposal, 2026-10): the base, the leading edge up
 * to the tip line, the tip line, straight across between two points on the outline
 * ({@link FinDesign.tipLine}, or {@link defaultTipLine}), and the trailing edge. The smooth
 * blade (smooth-blade.ts) is laid out over them. Also the thickness path.
 */
import { value, xDeriv, xDeriv2, yDeriv, yDeriv2 } from '../bezier-curve';
import type { Spline } from '../bezier-spline';
import type { Vec2 } from '../vec2';
import {
  FIN_THICKNESS_PATH_LIMITS,
  type FinDesign,
  type FinThicknessPath,
  type FinTipLine,
} from './fin-design';
import { findRaisedRear } from './raised-rear';

/** A polyline with its running length, read by fraction of that length. */
interface Path {
  readonly pts: readonly Vec2[];
  readonly cum: Float64Array;
}

const pathOf = (pts: readonly Vec2[]): Path => {
  const cum = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) {
    cum[i] = cum[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
  }
  return { pts, cum };
};

/** Samples per outline segment: fine enough that the polyline is the curve to a micron. */
const OUTLINE_SAMPLES = 400;

interface OutlineSamples {
  readonly pts: readonly Vec2[];
  /** Radius of curvature at each (cm), Infinity where straight. */
  readonly radius: Float64Array;
  /** Running length, as a fraction of the whole outline. */
  readonly frac: Float64Array;
}

const samplesCache = new WeakMap<Spline, OutlineSamples>();

/** The outline, densely sampled from the leading-edge root to the trailing-edge root. */
const sampleOutline = (outline: Spline): OutlineSamples => {
  const hit = samplesCache.get(outline);
  if (hit) return hit;
  const pts: Vec2[] = [];
  const radius: number[] = [];
  outline.coeffs.forEach((k, seg) => {
    for (let j = seg === 0 ? 0 : 1; j <= OUTLINE_SAMPLES; j++) {
      const t = j / OUTLINE_SAMPLES;
      const dx = xDeriv(k, t);
      const dy = yDeriv(k, t);
      const cross = dx * yDeriv2(k, t) - dy * xDeriv2(k, t);
      const speed = Math.hypot(dx, dy);
      pts.push(value(k, t));
      radius.push(Math.abs(cross) > 1e-12 ? (speed * speed * speed) / Math.abs(cross) : Infinity);
    }
  });
  const { cum } = pathOf(pts);
  const total = cum[cum.length - 1]! || 1;
  const s = { pts, radius: Float64Array.from(radius), frac: cum.map((c) => c / total) };
  samplesCache.set(outline, s);
  return s;
};

/** The sample nearest a fraction of the outline's length. */
const indexAtFraction = (s: OutlineSamples, f: number): number => {
  let lo = 0;
  let hi = s.frac.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s.frac[mid]! <= f) lo = mid;
    else hi = mid;
  }
  return f - s.frac[lo]! <= s.frac[hi]! - f ? lo : hi;
};

/** The point a fraction of the way along the outline by length. */
export const outlineAtFraction = (outline: Spline, f: number): Vec2 => {
  const s = sampleOutline(outline);
  return s.pts[indexAtFraction(s, f)]!;
};

/** The fraction of the outline's length nearest a point (the closest sample's). */
export const outlineFractionNear = (outline: Spline, p: Vec2): number => {
  const s = sampleOutline(outline);
  let best = 0;
  let dist = Infinity;
  s.pts.forEach((q, i) => {
    const dd = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
    if (dd < dist) [dist, best] = [dd, i];
  });
  return s.frac[best]!;
};

/**
 * Where the tip starts on each edge, as a fraction of the fin's depth: walked down each
 * edge from the tip's furthest point, the tip line sits where the outline first curves
 * more gently than this radius. "Where the front and rear curve radii start to
 * diminish", going up.
 */
export const FIN_TIP_RADIUS = 0.2;

/** Samples the tip line's ends keep from the tip's furthest point along each edge, at least. */
const TIP_MIN_SAMPLES = 8;

/** The tip's furthest point along the rake, as a sample index. */
const tipApex = (s: OutlineSamples): number => {
  const { pts } = s;
  // From the middle of the root toward the highest point. A hooked tip curls past the
  // highest point, and this finds the curl.
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  let high = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i]!.y > pts[high]!.y) high = i;
  const rx = pts[high]!.x - (first.x + last.x) / 2;
  const ry = pts[high]!.y - (first.y + last.y) / 2;
  let top = high;
  let best = -Infinity;
  pts.forEach((p, i) => {
    const a = p.x * rx + p.y * ry;
    if (a > best) [best, top] = [a, i];
  });
  return top;
};

/**
 * How near level (deg) the leading edge runs where it turns onto the top. The default tip
 * line's leading-edge end is no further round the tip than that: the top above it is
 * part of the tip (owner's rules). The user may still drag it round (owner testing: held
 * there, the end seemed frozen). Left on the leading edge, a long, flat top swept steep
 * sections from it down to the hook, and every cut near the top came out thickest toward
 * its trailing edge (owner testing).
 */
export const FIN_TIP_TURN = 20;

/**
 * Where the leading edge, walked up from its root, first runs within
 * {@link FIN_TIP_TURN} of level, over its top half (sample index); the tip's furthest
 * point if it never does.
 */
const leadingTurn = (s: OutlineSamples): number => {
  const top = tipApex(s);
  const half = Math.max(...s.pts.map((p) => p.y)) / 2;
  const k = Math.tan((FIN_TIP_TURN * Math.PI) / 180);
  // Over a few samples, not one: steady, not a passing wobble.
  const run = 4;
  for (let i = 1; i + run < top; i++) {
    const a = s.pts[i]!;
    const b = s.pts[i + run]!;
    if (a.y > half && Math.abs(b.y - a.y) <= k * Math.abs(b.x - a.x)) return i;
  }
  return top;
};

/** The tip line's ends as sample indices, from the design's tip line or the default. */
const tipLineIndices = (d: FinDesign, s: OutlineSamples): [number, number] => {
  const [a, b] = tipLineEnds(d, s);
  // A moved tip line is where it was put (owner's rules). The default's leading-edge end
  // goes no further round than where the leading edge turns onto the top.
  if (d.tipLine) return [a, b];
  const start = Math.max(1, Math.min(a, leadingTurn(s)));
  return [start, Math.max(start + 1, b)];
};

const tipLineEnds = (d: FinDesign, s: OutlineSamples): [number, number] => {
  const n = s.pts.length;
  if (d.tipLine) {
    const a = Math.min(n - 3, Math.max(1, indexAtFraction(s, d.tipLine.start)));
    const b = Math.min(n - 2, Math.max(a + 1, indexAtFraction(s, d.tipLine.end)));
    return [a, b];
  }
  const top = tipApex(s);
  const r = FIN_TIP_RADIUS * Math.max(...s.pts.map((p) => p.y));
  // Gentle for a run of samples, not one: an inflection is momentarily straight.
  const run = OUTLINE_SAMPLES / 20;
  const walk = (dir: 1 | -1): number => {
    let gentle = 0;
    for (let i = top + dir * TIP_MIN_SAMPLES; i > 0 && i < n - 1; i += dir) {
      gentle = s.radius[i]! >= r ? gentle + 1 : 0;
      if (gentle >= run) return i - dir * (run - 1);
    }
    return Math.min(n - 2, Math.max(1, top + dir * TIP_MIN_SAMPLES));
  };
  return [walk(-1), walk(1)];
};

/**
 * Where the leading edge turns onto the top, as a fraction of the outline: the furthest
 * round the default tip line's leading-edge end goes ({@link FIN_TIP_TURN}).
 */
export const tipTurnFraction = (outline: Spline): number => {
  const s = sampleOutline(outline);
  return s.frac[leadingTurn(s)]!;
};

/** The tip line's ends as fractions of the outline: the design's, or the default. */
export const tipLineOf = (d: FinDesign): FinTipLine => {
  const s = sampleOutline(d.outline);
  const [a, b] = tipLineIndices(d, s);
  return { start: s.frac[a]!, end: s.frac[b]! };
};

/** The default tip line's ends (tab frame, cm): leading-edge side, trailing-edge side. */
export const defaultTipLine = (d: FinDesign): [Vec2, Vec2] => {
  const s = sampleOutline(d.outline);
  const [a, b] = tipLineIndices({ ...d, tipLine: undefined }, s);
  return [s.pts[a]!, s.pts[b]!];
};

/**
 * The tip's furthest point as a fraction of the outline: a tip line's two ends stay
 * either side of it (fin-edits.ts).
 */
export const tipApexFraction = (outline: Spline): number => {
  const s = sampleOutline(outline);
  return s.frac[tipApex(s)]!;
};

/** The four sides of the sweep and the tip edge beyond it (tab frame, cm). */
export interface SweepFrame {
  /** Leading-edge root to the trailing edge's foot: the root, then any raised rear's underside. */
  readonly base: Path;
  /** Leading-edge root up to the tip line. */
  readonly leading: Path;
  /** The trailing edge's foot (its root, or a raised rear's corner) up to the tip line. */
  readonly trailing: Path;
  /** The tip edge, from the tip line's leading-edge end round to its trailing-edge end. */
  readonly tipEdge: Path;
  readonly tipStart: Vec2;
  readonly tipEnd: Vec2;
}

export const sweepFrame = (d: FinDesign): SweepFrame => {
  const s = sampleOutline(d.outline);
  const pts = s.pts;
  const [iS, iE] = tipLineIndices(d, s);
  const last = pts.length - 1;
  // A raised rear's underside belongs to the base: the trailing edge starts at its corner.
  const rear = findRaisedRear(d.outline);
  let iC = last;
  if (rear) {
    let best = Infinity;
    for (let i = iE; i <= last; i++) {
      const dd = Math.hypot(pts[i]!.x - rear.cornerX, pts[i]!.y - rear.cornerZ);
      if (dd < best) [best, iC] = [dd, i];
    }
  }
  return {
    base: pathOf([pts[0]!, ...pts.slice(iC).reverse()]),
    leading: pathOf(pts.slice(0, iS + 1)),
    trailing: pathOf(pts.slice(iE, iC + 1).reverse()),
    tipEdge: pathOf(pts.slice(iS, iE + 1)),
    tipStart: pts[iS]!,
    tipEnd: pts[iE]!,
  };
};

/** The thickness path's fraction along the section at `t` (0 the base, 1 the tip line). */
export const thicknessPathAt = (path: FinThicknessPath, t: number): number => {
  const s = Math.min(1, Math.max(0, t));
  // The quadratic through the three points (base, middle, tip line).
  const [p0, p1, p2] = path;
  const v = p0 * (1 - s) * (1 - 2 * s) + 4 * p1 * s * (1 - s) + p2 * s * (2 * s - 1);
  return Math.min(FIN_THICKNESS_PATH_LIMITS.max, Math.max(FIN_THICKNESS_PATH_LIMITS.min, v));
};

/** The tip edge past the tip line (tab frame): the cap's outline, tip line end to end. */
export const sweepTipEdge = (d: FinDesign): Vec2[] => [...sweepFrame(d).tipEdge.pts];
