// SPDX-License-Identifier: GPL-3.0-or-later
import { nrOfCurves, pointByTT, type Spline } from './bezier-spline';
import type { Vec2 } from './vec2';

/**
 * Concave-tail (swallow / fish) support.
 *
 * OpenShaper's outline is normally a single-valued half-width curve `y(x)` that
 * starts at the tail tip on the stringer (x = 0, y = 0), sweeps out to the max
 * half-width and returns to the nose tip (x = length, y = 0). A swallow or fish
 * tail breaks that: the tail carries a notch, so the curve folds back in x — from
 * the tail tip it runs forward AND inward to the notch bottom on the stringer. In
 * the notch region a station therefore has TWO boundaries: an inner wall
 * `y_in(x) > 0` and the outer rail `y_out(x)`.
 *
 * Rather than store a tail parameter, we read the cutout straight off the outline
 * geometry (the AIShaper method): sample the curve to a polyline, find the tail
 * tip at its minimum x, and split it into the inner notch wall (`tailInner`) and
 * the outer rail (`mainRail`). A normal outline has its tip at index 0, so
 * `tailInner` collapses to a point, `y_in` is 0 everywhere, and every consumer
 * behaves exactly as before — fully backward compatible.
 *
 * Tail-only for now: the nose stays a collapsed tip (no `noseInner`).
 */

/** Default polyline resolution for sampling the outline (AIShaper uses ~400). */
export const OUTLINE_SAMPLES = 400;

/**
 * Half-widths below this (cm) are treated as 0 — both to decide whether an outline
 * actually has a cutout and to weld the section to the centerline at the notch
 * bottom (avoids floating-point z-fighting on the stringer).
 */
export const CUTOUT_EPS = 0.05;

/** Inner / outer half-width of the board at one longitudinal station. */
export interface WidthBounds {
  /** Inner notch wall half-width (0 outside a cutout). */
  readonly yIn: number;
  /** Outer rail half-width. */
  readonly yOut: number;
}

/**
 * The outline split into functional segments at the tail tip (its min-x point).
 *
 * `tailInner` runs from the first outline point (notch bottom, for a cutout) back
 * to the tip; `mainRail` runs from the tip forward to the nose. For a normal board
 * `tipIndex === 0`, so `tailInner` is a single point and there is no cutout.
 */
export interface OutlineSegments {
  readonly points: readonly Vec2[];
  readonly tipIndex: number;
  readonly tailInner: readonly Vec2[];
  readonly mainRail: readonly Vec2[];
}

/** Sample an outline spline to `n` points along its global parameter (tail → nose). */
export const sampleOutline = (outline: Spline, n: number = OUTLINE_SAMPLES): Vec2[] => {
  const pts: Vec2[] = [];
  if (nrOfCurves(outline) === 0) return pts;
  const steps = Math.max(2, Math.floor(n));
  for (let i = 0; i < steps; i++) {
    pts.push(pointByTT(outline, i / (steps - 1)));
  }
  return pts;
};

/**
 * Split a sampled outline at its tail tip (minimum x). Returns the inner notch
 * wall (start → tip) and the outer rail (tip → nose). Mirrors AIShaper's
 * `get_outline_segments` knot-order split.
 */
export const outlineSegments = (outline: Spline, n: number = OUTLINE_SAMPLES): OutlineSegments => {
  const points = sampleOutline(outline, n);
  if (points.length < 2) {
    return { points, tipIndex: 0, tailInner: points, mainRail: points };
  }
  let tipIndex = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i]!.x < points[tipIndex]!.x) tipIndex = i;
  }
  return {
    points,
    tipIndex,
    tailInner: points.slice(0, tipIndex + 1),
    mainRail: points.slice(tipIndex),
  };
};

/**
 * Interpolate |y| at `targetX` from a polyline segment (AIShaper `get_y_from_pts`).
 * Returns `defaultY` when the segment is too short or `targetX` is out of its
 * x-range. The segment is sorted by x first, so a back-folding notch wall works.
 */
const yFromPts = (targetX: number, pts: readonly Vec2[], defaultY: number): number => {
  if (pts.length < 2) return defaultY;
  const xs: number[] = [];
  let minX = Infinity;
  let maxX = -Infinity;
  for (const p of pts) {
    xs.push(p.x);
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
  }
  if (targetX < minX - 1e-3 || targetX > maxX + 1e-3) return defaultY;

  // Sort (x, |y|) pairs by x for a stable monotonic interpolation table.
  const table = pts.map((p) => ({ x: p.x, y: Math.abs(p.y) })).sort((a, b) => a.x - b.x);

  const tx = Math.min(maxX, Math.max(minX, targetX));
  if (tx <= table[0]!.x) return table[0]!.y;
  const last = table[table.length - 1]!;
  if (tx >= last.x) return last.y;
  for (let i = 1; i < table.length; i++) {
    const hi = table[i]!;
    if (tx <= hi.x) {
      const lo = table[i - 1]!;
      const span = hi.x - lo.x;
      if (span <= 0) return hi.y;
      const f = (tx - lo.x) / span;
      return lo.y + (hi.y - lo.y) * f;
    }
  }
  return last.y;
};

/**
 * Inner/outer half-widths at station `x` (AIShaper `get_y_in_out`). `yOut` comes
 * from the outer rail; `yIn` from the inner notch wall, but only where `x` falls
 * inside the cutout (else 0). `yOut` is clamped to be ≥ `yIn`.
 */
export const yInOut = (segments: OutlineSegments, x: number): WidthBounds => {
  const { tailInner, mainRail } = segments;
  let yOut = yFromPts(x, mainRail, 0);
  let yIn = 0;
  if (tailInner.length > 1) {
    let innerMaxX = -Infinity;
    for (const p of tailInner) if (p.x > innerMaxX) innerMaxX = p.x;
    if (x <= innerMaxX + 1e-3) yIn = yFromPts(x, tailInner, 0);
  }
  if (yOut < yIn) yOut = yIn;
  return { yIn, yOut };
};

/**
 * True when the outline folds back into a tail notch (swallow / fish). A normal
 * board has its tail tip at the first sample, so this is false and all the
 * single-valued paths stay in effect.
 */
export const hasTailCutout = (outline: Spline, n: number = OUTLINE_SAMPLES): boolean => {
  const seg = outlineSegments(outline, n);
  if (seg.tipIndex <= 0) return false;
  const tip = seg.points[seg.tipIndex]!;
  let innerMaxX = -Infinity;
  for (const p of seg.tailInner) if (p.x > innerMaxX) innerMaxX = p.x;
  // The notch must have real forward depth — guard against sampling noise.
  return innerMaxX - tip.x > CUTOUT_EPS;
};
