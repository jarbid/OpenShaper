// SPDX-License-Identifier: GPL-3.0-or-later
import { normalAngle, valueAt, valueAtReverse } from './bezier-spline';
import {
  getInterpolatedCrossSection,
  getLength,
  getRockerAtPos,
  widthBoundsAt,
  type BezierBoard,
} from './board';
import { vec2, type Vec2 } from './vec2';

/**
 * Board-surface evaluation at an arbitrary plan-view point (x = station along the
 * length, y = lateral distance from the centreline, both cm).
 *
 * The z assembly matches the mesh loft in `tessellate.ts` exactly: the interpolated
 * cross-section runs in (lateral, height) with the bottom branch read by `valueAt`
 * and the deck branch by `valueAtReverse`, plus the bottom rocker. On a concave-tail
 * (swallow / fish) board the section is laterally remapped into the foam band
 * [y_in, y_out], so these helpers agree with the rendered surface inside the notch
 * too. `y` is clamped into the local band; out-of-length stations return NaN.
 *
 * NOTE: `outlineInsetPointAt` / `outlineInsetHalfWidthAt` read the single-valued
 * outer rail via `valueAt(outline, x)` — on a cutout board they are only meaningful
 * forward of the notch (callers clamp their domain there).
 */

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

const sectionLateral = (b: BezierBoard, x: number, y: number): number | null => {
  const { yIn, yOut } = widthBoundsAt(b, x);
  if (yOut <= 1e-6) return 0;
  // Inverse of the tessellate cutout remap `mapped = yIn + p.x·scale`; identity
  // (scale = 1, yIn = 0) on a normal board.
  const scale = (yOut - yIn) / yOut;
  if (scale <= 1e-9) return null;
  return clamp((y - yIn) / scale, 0, yOut);
};

const surfaceZAt = (b: BezierBoard, x: number, y: number, side: 'deck' | 'bottom'): number => {
  if (x < 0 || x > getLength(b)) return NaN;
  const cs = getInterpolatedCrossSection(b, x);
  if (!cs) return NaN;
  const rocker = getRockerAtPos(b, x);
  if (!Number.isFinite(rocker)) return NaN;
  const lat = sectionLateral(b, x, y);
  if (lat === null) return NaN;
  const h = side === 'deck' ? valueAtReverse(cs.spline, lat) : valueAt(cs.spline, lat);
  return h + rocker;
};

/** Deck surface height (cm) at plan point (x, y). NaN outside the board length. */
export const deckZAt = (b: BezierBoard, x: number, y: number): number =>
  surfaceZAt(b, x, y, 'deck');

/** Bottom surface height (cm) at plan point (x, y). NaN outside the board length. */
export const bottomZAt = (b: BezierBoard, x: number, y: number): number =>
  surfaceZAt(b, x, y, 'bottom');

/**
 * Plan-view point at perpendicular distance `dist` INSIDE the outline, taken at the
 * outline point of station `x` (the legacy `getOutline` inset:
 * `(x − d·sin a, y − d·cos a)` with a = outline normal angle). This is the exact
 * parallel (offset) curve wherever `dist` is below the outline's curvature radius.
 */
export const outlineInsetPointAt = (b: BezierBoard, x: number, dist: number): Vec2 => {
  const a = normalAngle(b.outline, x);
  const oy = valueAt(b.outline, x);
  return vec2(x - dist * Math.sin(a), oy - dist * Math.cos(a));
};

/**
 * Half-width of the offset (inset) outline curve AT plan station `stationX`: solves
 * for the outline parameter whose inset point lands on `x = stationX` (bisection —
 * the robust replacement for the legacy `dist / sin(outlineAngle)`, which blows up
 * where the outline runs parallel to the centreline). Falls back to the direct
 * same-station inset where the solve has no bracket (blunt tips).
 */
export const outlineInsetHalfWidthAt = (b: BezierBoard, stationX: number, dist: number): number => {
  const len = getLength(b);
  const eps = Math.min(0.01, len * 1e-4);
  const lo0 = clamp(stationX - 3 * dist, eps, len - eps);
  const hi0 = clamp(stationX + 3 * dist, eps, len - eps);
  const f = (x: number): number => outlineInsetPointAt(b, x, dist).x - stationX;

  let lo = lo0;
  let hi = hi0;
  let flo = f(lo);
  let fhi = f(hi);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0) {
    // No sign change (tip region / degenerate normal): direct inset at the station.
    return outlineInsetPointAt(b, stationX, dist).y;
  }
  for (let i = 0; i < 60 && hi - lo > 1e-7; i++) {
    const mid = (lo + hi) / 2;
    const fm = f(mid);
    if (flo * fm <= 0) {
      hi = mid;
      fhi = fm;
    } else {
      lo = mid;
      flo = fm;
    }
  }
  return outlineInsetPointAt(b, (lo + hi) / 2, dist).y;
};
