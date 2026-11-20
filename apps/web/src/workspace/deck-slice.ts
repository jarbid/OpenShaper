// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The Deck step's slice, with no React: how the station is fitted to its box, the paths its curves are
 * drawn with, where the crown handle stands on the deck curve, and the crown a pointer at a height
 * means. It uses the rail slice's frame (`rail-slice.ts`): one scale for both axes, so the section has the
 * proportions the board has, the plus side on the left of the stringer and the minus side on the right.
 *
 * A station's curves are in cm in the section's frame: `x` the distance from the stringer, `y` the height
 * above the bottom at the stringer.
 */
import type { Spline } from '@openshaper/kernel';
import { bandEdge, heightAt } from '@openshaper/store/rails';
import { fitSlices, toScreen, type SliceFrame, type SliceMeasure } from './rail-slice';

/** Room, px, round the section: the crown's label above it, and a little at the sides and below. */
export const SLICE_MARGIN = { x: 24, top: 30, bottom: 10 } as const;

/** Samples of each segment of a curve that is flattened to points. */
const SEGMENT_POINTS = 12;

/** A curve with more knots than this is the engine's own polyline: its knots are its points. */
const POLYLINE_KNOTS = 24;

/**
 * The frame that fits a station in a box: both halves (`widths`, the half width of each side), the thickness
 * `T` at the stringer, and `zMin`, the lowest the bottom goes. It is fitted to those alone, never to the
 * deck curve, so dragging the crown does not move the drawing under the pointer. Null when there is nothing
 * to fit or no room.
 */
export function fitStation(
  widths: readonly number[],
  T: number,
  zMin: number,
  box: { readonly width: number; readonly height: number },
): SliceFrame | null {
  const measures: SliceMeasure[] = widths.map((w) => ({
    halfWidth: w,
    thickness: T,
    apex: { y: w, z: T },
    zMin: Math.min(0, zMin),
    zMax: T,
  }));
  return fitSlices(measures, box, SLICE_MARGIN);
}

const fixed = (n: number): string => (Math.round(n * 100) / 100).toString();

/**
 * A spline as a flat run of points `[x0, y0, x1, y1, …]`: the knots themselves for a polyline (the engine's
 * section, which is straight between its knots), the curve sampled for anything else.
 */
export function flattenSpline(s: Spline, perSegment = SEGMENT_POINTS): number[] {
  const k = s.knots;
  if (k.length > POLYLINE_KNOTS) return k.flatMap((q) => [q.end.x, q.end.y]);
  const out: number[] = [];
  for (let i = 0; i + 1 < k.length; i++) {
    const a = k[i]!.end;
    const b = k[i]!.tangentToNext;
    const c = k[i + 1]!.tangentToPrev;
    const d = k[i + 1]!.end;
    for (let j = i === 0 ? 0 : 1; j <= perSegment; j++) {
      const t = j / perSegment;
      const u = 1 - t;
      out.push(
        u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x,
        u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y,
      );
    }
  }
  return out;
}

/** Samples of each segment of the deck curve when it is drawn: enough that an arc of the board's size has no corners. */
const DECK_POINTS = 32;

/**
 * The deck curve as two SVG paths on one side of the stringer: `visible`, from the stringer to the band edge `edge`
 * (cm from the stringer), where the rail starts to roll over the deck, and `hidden`, from there to the wall, where
 * the deck is under the rail and the board's surface is the rail's. The curve is the same curve; the second part is
 * what a dashed line draws. `hidden` is empty for a curve that ends at the band edge.
 */
export function deckPaths(
  s: Spline,
  edge: number,
  frame: SliceFrame,
  side: 'left' | 'right',
): { readonly visible: string; readonly hidden: string } {
  const pts = flattenSpline(s, DECK_POINTS);
  const at = { x: edge, y: heightAt(s, edge) };
  const near: { x: number; y: number }[] = [];
  const far: { x: number; y: number }[] = [at];
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const p = { x: pts[i]!, y: pts[i + 1]! };
    if (p.x < edge) near.push(p);
    else if (p.x > edge) far.push(p);
  }
  near.push(at);
  const path = (run: readonly { x: number; y: number }[]) =>
    run.length < 2
      ? ''
      : run
          .map((p, i) => {
            const q = toScreen(frame, p.x, p.y, side);
            return `${i === 0 ? 'M' : 'L'}${fixed(q.x)} ${fixed(q.y)}`;
          })
          .join(' ');
  return { visible: path(near), hidden: path(far) };
}

/** Where the crown is shown on one side: the handle on the deck curve at the band edge, and the stringer's height above it. */
export interface CrownMark {
  readonly handle: { readonly x: number; readonly y: number };
  readonly top: { readonly x: number; readonly y: number };
  /** The crown (cm) the curve has there: the fall from the stringer's height to the handle. */
  readonly crown: number;
}

/** The crown's mark on one side's deck curve, given the half width, the thickness and the rail's band there. */
export function crownMark(
  frame: SliceFrame,
  deck: Spline,
  w: number,
  T: number,
  band: number,
  side: 'left' | 'right',
): CrownMark {
  const edge = bandEdge(w, band);
  const z = heightAt(deck, edge);
  return {
    handle: toScreen(frame, edge, z, side),
    top: toScreen(frame, edge, T, side),
    crown: T - z,
  };
}

/**
 * The crown (cm) a pointer at screen height `y` means: the thickness at the stringer less the height the
 * handle would stand at, with `grab` the distance (px) the handle was below the pointer when it was taken,
 * so the handle does not jump to the pointer.
 */
export function crownAtPointer(frame: SliceFrame, T: number, y: number, grab = 0): number {
  const z = frame.zMid - (y + grab - frame.cy) / frame.scale;
  return T - z;
}

/** The distance (px) the handle stands below a pointer that took hold of it at height `y`. */
export const grabOf = (handleY: number, y: number): number => handleY - y;
