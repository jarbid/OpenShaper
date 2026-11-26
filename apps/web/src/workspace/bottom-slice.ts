// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The Bottom step's slice, with no React: the relief strip under the section, and the handle that sets the
 * chosen contour's depth.
 *
 * A contour is a few millimetres deep and a section is drawn to scale, so at the scale of the section a
 * contour is a pixel or two. The strip under the section draws what the contours raise the bottom by at the
 * chosen station across the bottom, with its height **magnified** (`reliefFactor`, written on the drawing),
 * from a baseline that is the bottom without them. It shows the contour's own profile, depth along the board
 * times the shape across it (`contourProfile`), before the mesh fades it along the rail; the section above
 * it is the engine's, as built.
 *
 * The depth handle stands where the chosen contour's relief is greatest (`handlePlace`). Dragging it up or
 * down says how much relief there should be there at this station; the contour's depth, its greatest along the
 * board, is that over the share of its depth the contour has at this station (`depthForRelief`). Where that
 * share is small (a station at the contour's ends, or outside it) the handle is off.
 */
import type { BottomFeature } from '@openshaper/board2';
import { contourDepth, contourProfile, contourShapeAt } from '@openshaper/store/rails';

/** The magnifications the strip uses, so the factor written on the drawing is one a shaper can say. */
export const RELIEF_FACTORS = [1, 2, 5, 10, 20, 25, 50, 100] as const;

/** The most relief (cm) the strip is made tall enough for: a contour is cut to a few millimetres. */
export const RELIEF_SPAN = 1;

/** The share of the strip's height the relief span fills. */
const STRIP_FILL = 0.9;

/**
 * How much taller than the section the relief is drawn: the greatest of {@link RELIEF_FACTORS} at which `span`
 * cm of relief still fits the strip `stripPx` tall, when the section is drawn at `pxPerCm`. Never under 1.
 */
export function reliefFactor(pxPerCm: number, stripPx: number, span: number): number {
  if (!(pxPerCm > 0 && stripPx > 0 && span > 0)) return 1;
  const fits = (stripPx * STRIP_FILL) / (span * pxPerCm);
  return RELIEF_FACTORS.reduce<number>((best, k) => (k <= fits ? k : best), 1);
}

/** Where across the bottom the contour's relief is greatest, cm from the stringer, at a place where the half width is `w`. */
export function handlePlace(f: BottomFeature, w: number): number {
  switch (f.kind) {
    case 'vee':
      return w;
    case 'concave':
      return f.layout === 'single' ? 0 : f.centre * w;
    case 'channels':
      return Math.max(0, w - (f.railInset + f.width / 2));
  }
}

/** The relief (cm) of a contour at a station: its depth there times its shape across the bottom, at `y` cm from the stringer. */
export function reliefAt(f: BottomFeature, x: number, y: number, w: number): number {
  if (!(w > 0)) return 0;
  return (
    contourDepth(f) * contourShapeAt(f, x) * contourProfile(f, Math.min(Math.abs(y) / w, 1), w)
  );
}

/**
 * The relief across half the bottom at a station, `n + 1` points `[y, relief]` from the stringer to the wall,
 * for the contours given summed (a board's contours add).
 */
export function reliefAcross(
  fs: readonly BottomFeature[],
  x: number,
  w: number,
  n = 64,
): readonly (readonly [number, number])[] {
  return Array.from({ length: n + 1 }, (_, i): readonly [number, number] => {
    const y = (w * i) / n;
    return [y, fs.reduce((t, f) => t + reliefAt(f, x, y, w), 0)];
  });
}

/** Under this share of its greatest depth a contour has too little at a station for the handle to set it from there. */
export const HANDLE_SHAPE_MIN = 0.05;

/**
 * The depth (cm) the contour needs for the relief at its handle to be `wanted` at the station `x`, with `w` the
 * half width there; null where the contour has too little depth there (`HANDLE_SHAPE_MIN`) to be set from
 * there. A negative `wanted` is none.
 */
export function depthForRelief(
  f: BottomFeature,
  x: number,
  w: number,
  wanted: number,
): number | null {
  const shape = contourShapeAt(f, x);
  const profile = contourProfile(f, Math.min(handlePlace(f, w) / w, 1), w);
  if (!(shape > HANDLE_SHAPE_MIN) || !(profile > 0)) return null;
  return Math.max(0, wanted) / (shape * profile);
}

/** The pointer's relief (cm) at a height `y` px, given the baseline's height, the strip's magnification and the section's scale. */
export const reliefAtPointer = (
  y: number,
  baseline: number,
  factor: number,
  pxPerCm: number,
): number => (baseline - y) / (factor * pxPerCm);
