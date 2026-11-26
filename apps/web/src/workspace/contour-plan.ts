// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The bottom seen from below, with no React: how the board is fitted to its box, the paths its outline and
 * each contour's bands are drawn with, how the depth shades a band along the board, and what a pointer
 * means on the chosen contour's ends and middle.
 *
 * ## Which way up
 *
 * The camera is under the board looking up, the tail on the left and the nose on the right, as the ruler and
 * every other drawing along the board have them. Seen that way the plus side of the board (the left of
 * someone standing on it facing the nose) is the **lower** one; seen from above it is the upper. A point at
 * board `y` is drawn at `cy + y * scale`, so a tap on the 3D bottom at `(x, y)` lands on the band drawn
 * there.
 *
 * The horizontal mapping is the rail map's and the station strip's (`rail-map.ts`): `x` cm from the tail at
 * `MAP_PAD + x / length * usable`, so a ruler and the stations' ticks are the same here as there. One scale
 * serves both axes, so the bottom has the shape it has.
 */
import type { BottomFeature } from '@openshaper/board2';
import { contourBands, contourDepth, contourDepthAt } from '@openshaper/store/rails';
import { MAP_PAD, pxToX, xToPx, type Frame } from './rail-map';

/** Height of the ruler along the top, px. */
export const PLAN_RULER = 16;
/** Room between the ruler and the board, and under the board, px. */
export const PLAN_GAP = 8;
/** Samples along a contour's run when its bands are drawn. */
export const BAND_SAMPLES = 48;

/** How the board is fitted to its box. */
export interface PlanFit {
  /** The horizontal mapping, the rail map's. */
  readonly frame: Frame;
  /** px per cm, both ways. */
  readonly scale: number;
  /** The stringer's height, px from the top of the drawing. */
  readonly cy: number;
  /** The drawing's height, px: the ruler, the board and the gaps. */
  readonly height: number;
}

/**
 * The fit for a board `length` cm long and `halfMax` cm from its stringer at the widest, in a box `width` px
 * across. The scale is the width's; the height follows from it, so the card is as tall as the board needs.
 */
export function fitPlan(width: number, length: number, halfMax: number): PlanFit {
  const frame: Frame = { width, length };
  const usable = Math.max(1, width - 2 * MAP_PAD);
  const scale = length > 0 ? usable / length : 1;
  const half = Math.max(0, halfMax) * scale;
  const cy = PLAN_RULER + PLAN_GAP + half;
  return { frame, scale, cy, height: cy + half + PLAN_GAP };
}

/** Where a place along the board is, px. */
export const planX = (fit: PlanFit, x: number): number => xToPx(x, fit.frame);

/** Where a place across the board is, px: `y` signed cm from the stringer, the plus side below it. */
export const planY = (fit: PlanFit, y: number): number => fit.cy + y * fit.scale;

/** The place along the board (cm from the tail) at a pixel across the drawing. */
export const planXAt = (fit: PlanFit, px: number): number => pxToX(px, fit.frame);

/** The place across the board (signed cm from the stringer) at a pixel down the drawing. */
export const planYAt = (fit: PlanFit, py: number): number => (py - fit.cy) / fit.scale;

const fixed = (n: number): string => (Math.round(n * 10) / 10).toString();

/**
 * The outline as a closed path: the plus side's points tail to nose, then the minus side's back. Each is a
 * flat run `[x0, y0, x1, y1, …]` of the half outline in board coordinates (y from the stringer).
 */
export function outlinePath(
  fit: PlanFit,
  plus: readonly number[],
  minus: readonly number[],
): string {
  const pts: string[] = [];
  const add = (x: number, y: number, side: 1 | -1) =>
    pts.push(
      `${pts.length === 0 ? 'M' : 'L'}${fixed(planX(fit, x))} ${fixed(planY(fit, side * y))}`,
    );
  for (let i = 0; i + 1 < plus.length; i += 2) add(plus[i]!, plus[i + 1]!, 1);
  for (let i = minus.length - 2; i >= 0; i -= 2) add(minus[i]!, minus[i + 1]!, -1);
  return pts.length === 0 ? '' : `${pts.join(' ')} Z`;
}

/** The places along a contour's run its bands are sampled at, both ends included. */
export function runSamples(from: number, to: number, n = BAND_SAMPLES): number[] {
  return Array.from({ length: n + 1 }, (_, i) => from + ((to - from) * i) / n);
}

/** A half width as a function of the place along the board, for each side. */
export interface HalfWidths {
  readonly plus: (x: number) => number;
  readonly minus: (x: number) => number;
}

/**
 * The bands of a contour as closed paths, one for each band on each side: its hollow (a concave), the whole
 * bottom (a vee), each channel. A band is the stretch across the bottom the contour acts over (`contourBands`)
 * along its run, so a channel follows the rail and a concave narrows with the board.
 */
export function bandPaths(fit: PlanFit, f: BottomFeature, half: HalfWidths): readonly string[] {
  const keys = f.depth.keys;
  const xs = runSamples(keys[0]!.s, keys[keys.length - 1]!.s);
  const out: string[] = [];
  for (const side of [1, -1] as const) {
    const w = side === 1 ? half.plus : half.minus;
    const perX = xs.map((x) => contourBands(f, w(x)));
    const count = perX[0]?.length ?? 0;
    for (let b = 0; b < count; b++) {
      const edge = (pick: 'from' | 'to', x: number, i: number) =>
        `${fixed(planX(fit, x))} ${fixed(planY(fit, side * perX[i]![b]![pick]))}`;
      const near = xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${edge('from', x, i)}`);
      const far = xs.map((x, i) => `L${edge('to', x, i)}`).reverse();
      out.push(`${near.join(' ')} ${far.join(' ')} Z`);
    }
  }
  return out;
}

/**
 * A channel's centre line along the run, one path for each channel on each side: the channels are lines, drawn
 * as thick as they are wide (never under `minWidth` px). Empty for any other kind.
 */
export function channelLines(
  fit: PlanFit,
  f: BottomFeature,
  half: HalfWidths,
  minWidth = 1.5,
): readonly { readonly d: string; readonly width: number }[] {
  if (f.kind !== 'channels') return [];
  const keys = f.depth.keys;
  const xs = runSamples(keys[0]!.s, keys[keys.length - 1]!.s);
  const out: { d: string; width: number }[] = [];
  for (const side of [1, -1] as const) {
    const w = side === 1 ? half.plus : half.minus;
    for (let k = 0; k < f.count; k++) {
      const offset = f.railInset + f.width / 2 + k * f.pitch;
      const d = xs
        .map(
          (x, i) =>
            `${i === 0 ? 'M' : 'L'}${fixed(planX(fit, x))} ${fixed(planY(fit, side * Math.max(0, w(x) - offset)))}`,
        )
        .join(' ');
      out.push({ d, width: Math.max(minWidth, f.width * fit.scale) });
    }
  }
  return out;
}

/** Faintest and strongest a band is shaded: the ends of the run, and where the depth is greatest. */
export const SHADE_MIN = 0.12;
export const SHADE_MAX = 0.62;

/**
 * How a band is shaded along its run: stops at even shares of the run, the opacity following the depth there
 * (zero depth at the ends, the greatest in the middle), so the shading is the contour's law along the board.
 */
export function depthStops(
  f: BottomFeature,
  n = 16,
): readonly { readonly offset: number; readonly opacity: number }[] {
  const keys = f.depth.keys;
  const from = keys[0]!.s;
  const to = keys[keys.length - 1]!.s;
  const peak = contourDepth(f);
  return Array.from({ length: n + 1 }, (_, i) => {
    const share = peak > 0 ? contourDepthAt(f, from + ((to - from) * i) / n) / peak : 0;
    return { offset: i / n, opacity: SHADE_MIN + (SHADE_MAX - SHADE_MIN) * Math.min(1, share) };
  });
}

/** What a pointer on the chosen contour's drawing is doing. */
export type PlanGrab = 'from' | 'to' | 'move';

/**
 * The extent a drag asks for. A pointer at board place `x` that took hold of an end (`grab` is how far past
 * the end the pointer was when it took hold, so the end does not jump) asks for that end; one that took hold
 * of the middle asks for the run to slide, its start where it was less the distance the pointer has gone.
 * The store holds the result to the board.
 */
export function grabbedExtent(
  grab: PlanGrab,
  x: number,
  start: { readonly from: number; readonly to: number; readonly at: number },
): { readonly from?: number; readonly to?: number } {
  if (grab === 'from') return { from: x - (start.at - start.from) };
  if (grab === 'to') return { to: x - (start.at - start.to) };
  return { from: start.from + (x - start.at) };
}

/** An arrow key's step along the board, cm: a centimetre, ten with Shift. */
export const planNudge = (big: boolean): number => (big ? 10 : 1);

// --- the law along the board ----------------------------------------------------------------------

/** Height of the lane that draws a contour's depth along the board, px. */
export const LAW_HEIGHT = 56;
/** Room above the lane's curve and under its baseline, px. */
const LAW_TOP = 8;
const LAW_FOOT = 12;

/** The greatest depth (cm) the law lane shows: the board's own most, held to a centimetre so a few millimetres are readable. */
export const lawMax = (depthMax: number): number => Math.max(0.1, Math.min(1, depthMax));

/** The lane's height for a depth (cm), px from its top, `max` cm being the top of the curve. */
export const lawY = (depth: number, max: number): number => {
  const inner = LAW_HEIGHT - LAW_TOP - LAW_FOOT;
  return LAW_TOP + inner - (Math.min(Math.max(depth, 0), max) / max) * inner;
};

/** The depth (cm) at a height `py` px from the lane's top: the inverse of {@link lawY}, not held to the lane. */
export const lawDepthAt = (py: number, max: number): number => {
  const inner = LAW_HEIGHT - LAW_TOP - LAW_FOOT;
  return ((LAW_TOP + inner - py) / inner) * max;
};

/** The depth curve along the run as a path, and as a closed one down to the baseline for its fill. */
export function lawPaths(
  fit: PlanFit,
  f: BottomFeature,
  max: number,
): { readonly line: string; readonly area: string } {
  const keys = f.depth.keys;
  const xs = runSamples(keys[0]!.s, keys[keys.length - 1]!.s, 64);
  const pts = xs.map((x) => `${fixed(planX(fit, x))} ${fixed(lawY(contourDepthAt(f, x), max))}`);
  const base = fixed(lawY(0, max));
  const line = `M${pts.join(' L')}`;
  return {
    line,
    area: `${line} L${fixed(planX(fit, xs[xs.length - 1]!))} ${base} L${fixed(planX(fit, xs[0]!))} ${base} Z`,
  };
}
