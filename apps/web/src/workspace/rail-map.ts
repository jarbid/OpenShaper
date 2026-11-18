// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The rail map's arithmetic, with no React and no DOM: where a place on the board is on the strip
 * and back, where each zone, blend and handle sits, what is under a point, how a drag and a key
 * move a zone's end, the gradient a blend is drawn with, the ruler under the strip, and how much of
 * a zone's name fits in its block. `RailMap.tsx` draws what these give.
 *
 * Places are cm from the tail (the tail is always at 0, the nose at the board's length), pixels are
 * across the strip, and the strip leaves {@link MAP_PAD} at each end so a handle at either end of
 * the board is whole.
 */
import { smooth } from '@openshaper/render3d/patches';
import { cmToUnitNumber, fmtLen, unitDecimals, unitSuffix, type LengthUnit } from '../format';
import type { SideZones } from '../rail-zones';

/** Pixels left at each end of the strip. */
export const MAP_PAD = 20;
/** How far from a zone's end a point still takes its handle, px. */
export const HANDLE_SLOP = 9;
/** How far right of a zone of no length its draw-out grip stands, px. */
export const STRETCH_OFFSET = 16;
/** The least width a block takes, so a zone of no length is a tick you can see. */
export const MIN_BLOCK = 4;
/** An arrow key nudges a zone's end by this many cm, and Shift with an arrow by {@link NUDGE_BIG}. */
export const NUDGE = 0.5;
export const NUDGE_BIG = 5;
/** A pointer must travel this far, px, from where it went down before it is a drag and not a click. */
export const DRAG_SLOP = 3;

/** The strip's geometry: its width in px and the board's length in cm. */
export interface Frame {
  readonly width: number;
  readonly length: number;
}

const usable = (f: Frame): number => Math.max(1, f.width - 2 * MAP_PAD);

/** Where a place on the board is across the strip. Not clamped: a place past the board is past the strip. */
export const xToPx = (x: number, f: Frame): number =>
  f.length > 0 ? MAP_PAD + (x / f.length) * usable(f) : MAP_PAD;

/** The place at a pixel across the strip, held to the board. */
export function pxToX(px: number, f: Frame): number {
  if (!(f.length > 0)) return 0;
  const x = ((px - MAP_PAD) / usable(f)) * f.length;
  return Math.min(f.length, Math.max(0, x));
}

// --- the layout of one side ----------------------------------------------------------------------

/** A block of a lane: left edge and width in px. */
export interface Span {
  readonly left: number;
  readonly width: number;
}

export interface ZoneBlock extends Span {
  readonly zone: number;
  /** The zone has no length: a tick, centred on its place. */
  readonly tick: boolean;
}

export interface BlendBlock extends Span {
  readonly blend: number;
  /** The zones it runs between. */
  readonly before: number;
  readonly after: number;
}

/** An end of a zone that can be dragged: which, and where it stands (px across the strip). */
export interface HandleSpot {
  readonly zone: number;
  readonly end: 'from' | 'to';
  /** Where it is drawn and taken hold of, px across the strip. */
  readonly px: number;
  /** The place of the end it moves, px: the same as `px` but for the grip, which stands beside its place. */
  readonly placePx: number;
  /** A zone of no length has its place's handle (`from`) and a grip beside it that draws it out (`to`). */
  readonly stretch: boolean;
}

export interface LaneLayout {
  readonly zones: readonly ZoneBlock[];
  readonly blends: readonly BlendBlock[];
  /**
   * The rail holds the first zone's rail from the tail to the zone, and the last zone's from the zone
   * to the nose: the stretches of the strip before the first and after the last zone, null when none.
   */
  readonly lead: (Span & { readonly zone: number }) | null;
  readonly trail: (Span & { readonly zone: number }) | null;
}

/** The blocks of one side across a strip. */
export function laneLayout(side: SideZones, f: Frame): LaneLayout {
  const { zones, blends } = side;
  const blocks = zones.map((z, i): ZoneBlock => {
    const a = xToPx(z.from, f);
    const b = xToPx(z.to, f);
    const tick = z.to === z.from;
    const width = Math.max(MIN_BLOCK, b - a);
    return { zone: i, tick, left: tick ? a - width / 2 : a, width };
  });
  const gaps = blends.map(
    (bl): BlendBlock => ({
      blend: bl.before,
      before: bl.before,
      after: bl.after,
      left: xToPx(bl.from, f),
      width: Math.max(0, xToPx(bl.to, f) - xToPx(bl.from, f)),
    }),
  );
  const first = zones[0];
  const last = zones[zones.length - 1];
  const start = xToPx(0, f);
  const end = xToPx(f.length, f);
  const lead =
    first && xToPx(first.from, f) - start > 0.5
      ? { zone: 0, left: start, width: xToPx(first.from, f) - start }
      : null;
  const trail =
    last && end - xToPx(last.to, f) > 0.5
      ? {
          zone: zones.length - 1,
          left: xToPx(last.to, f),
          width: end - xToPx(last.to, f),
        }
      : null;
  return { zones: blocks, blends: gaps, lead, trail };
}

/**
 * The handles of a lane, in board order. Every zone has one at its start; one of length has one at its
 * end too. A zone of no length offers the grip that draws it out only while it is `chosen`, so a row of
 * converted ticks is not a row of pairs.
 */
export function laneHandles(
  side: SideZones,
  f: Frame,
  chosen: number | null,
): readonly HandleSpot[] {
  const out: HandleSpot[] = [];
  side.zones.forEach((z, zone) => {
    const from = xToPx(z.from, f);
    const to = xToPx(z.to, f);
    out.push({ zone, end: 'from', px: from, placePx: from, stretch: false });
    if (z.to !== z.from) out.push({ zone, end: 'to', px: to, placePx: to, stretch: false });
    else if (chosen === zone) {
      out.push({ zone, end: 'to', px: to + STRETCH_OFFSET, placePx: to, stretch: true });
    }
  });
  return out;
}

// --- what is under a point -----------------------------------------------------------------------

/** What lies under a point of a lane. */
export type Hit =
  | { readonly kind: 'handle'; readonly zone: number; readonly end: 'from' | 'to' }
  | { readonly kind: 'zone'; readonly zone: number }
  | { readonly kind: 'blend'; readonly blend: number }
  | { readonly kind: 'empty' };

/**
 * What is at pixel `px` of a lane. A handle takes the points within {@link HANDLE_SLOP} of it (the
 * nearer one when two are close, the earlier on a tie); then a zone, a blend, or the stretch before the
 * first and after the last zone (the first or last zone: the rail holds theirs there); empty only on a
 * lane with no zone. `chosen` is the zone whose draw-out grip is showing.
 */
export function hitTest(side: SideZones, f: Frame, px: number, chosen: number | null = null): Hit {
  let best: HandleSpot | null = null;
  let bestAway = HANDLE_SLOP + 1e-9;
  for (const h of laneHandles(side, f, chosen)) {
    const away = Math.abs(px - h.px);
    if (away < bestAway) {
      best = h;
      bestAway = away;
    }
  }
  if (best) return { kind: 'handle', zone: best.zone, end: best.end };
  const layout = laneLayout(side, f);
  for (const b of layout.zones) {
    if (px >= b.left && px <= b.left + b.width) return { kind: 'zone', zone: b.zone };
  }
  for (const b of layout.blends) {
    if (px >= b.left && px <= b.left + b.width) return { kind: 'blend', blend: b.blend };
  }
  if (layout.lead && px < layout.lead.left + layout.lead.width) return { kind: 'zone', zone: 0 };
  if (layout.trail && px > layout.trail.left) {
    return { kind: 'zone', zone: layout.trail.zone };
  }
  return { kind: 'empty' };
}

/**
 * Whether a "+" at `px` would add a zone: not on a handle (it would take the drag), and not on a zone
 * of no length, which cannot be split.
 */
export function canAddAt(side: SideZones, f: Frame, px: number): boolean {
  if (side.zones.length === 0) return false;
  if (hitTest(side, f, px).kind === 'handle') return false;
  return !side.zones.some(
    (z) => z.to === z.from && Math.abs(px - xToPx(z.from, f)) < MIN_BLOCK * 2,
  );
}

// --- dragging and nudging ------------------------------------------------------------------------

/**
 * The place a dragged handle is asked to move to: the pointer's position (`clientX` against the strip's
 * left edge) plus the offset of where it took hold of the handle, held to the board. The store holds it
 * from there to the gap beside the neighbouring zone.
 */
export function dragTarget(
  clientX: number,
  stripLeft: number,
  grabOffset: number,
  f: Frame,
): number {
  return pxToX(clientX - stripLeft + grabOffset, f);
}

/** The offset to carry for a drag begun at `clientX` on a handle that stands at `handlePx`. */
export const grabOffsetOf = (handlePx: number, clientX: number, stripLeft: number): number =>
  handlePx - (clientX - stripLeft);

/** Whether a pointer that went down at `from` and is now at `to` has moved far enough to be a drag. */
export const isDrag = (from: { x: number; y: number }, to: { x: number; y: number }): boolean =>
  Math.hypot(to.x - from.x, to.y - from.y) > DRAG_SLOP;

/** A zone's end moved by a key: `dir` is -1 (towards the tail) or 1, `big` for Shift. Held to the board. */
export function nudged(x: number, dir: -1 | 1, big: boolean, length: number): number {
  const next = x + dir * (big ? NUDGE_BIG : NUDGE);
  return Math.min(length, Math.max(0, next));
}

/**
 * The place a click on a zone or blend moves the cursor to: where it landed (`px`, or null when the key
 * made the click) held inside `[from, to]`, else the middle of the span.
 */
export function clickPlace(from: number, to: number, px: number | null, f: Frame): number {
  if (px === null) return (from + to) / 2;
  return Math.min(Math.max(from, to), Math.max(Math.min(from, to), pxToX(px, f)));
}

// --- colours -------------------------------------------------------------------------------------

const toLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
const toSrgb = (c: number): number =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
const channels = (hex: string): [number, number, number] => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
};
const toHex = (c: readonly number[]): string =>
  `#${c
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;

/**
 * The colour a third of the way across a blend is on the board: the smoothstep mix of the two zones'
 * colours, made in linear light, as the board's shader makes it, so the strip and the board agree.
 */
export function blendColor(a: string, b: string, t: number): string {
  const s = smooth(Math.min(1, Math.max(0, t)));
  const ca = channels(a);
  const cb = channels(b);
  return toHex(
    ca.map((v, i) => {
      const la = toLinear(v / 255);
      const lb = toLinear(cb[i]! / 255);
      return 255 * toSrgb(la + (lb - la) * s);
    }),
  );
}

/** A blend's gradient as stops across its block, `steps` + 1 of them, the board's own mix. */
export function gradientStops(
  a: string,
  b: string,
  steps = 8,
): readonly { readonly offset: number; readonly color: string }[] {
  return Array.from({ length: steps + 1 }, (_, i) => ({
    offset: i / steps,
    color: blendColor(a, b, i / steps),
  }));
}

/** The CSS for a blend's background. */
export const gradientCss = (a: string, b: string): string =>
  `linear-gradient(to right, ${gradientStops(a, b)
    .map((s) => `${s.color} ${(s.offset * 100).toFixed(1)}%`)
    .join(', ')})`;

/** Black or white, whichever has the greater contrast on a block of colour `hex` (equal at a luminance of 0.179). */
export function readableOn(hex: string): '#111111' | '#ffffff' {
  const [r, g, b] = channels(hex).map((v) => toLinear(v / 255)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.179 ? '#111111' : '#ffffff';
}

// --- labels --------------------------------------------------------------------------------------

/** Approximate width of one character of the 11 px label, px. */
export const LABEL_CHAR = 6.4;
/** Padding either side of a label inside its block, px. */
export const LABEL_PAD = 5;

/**
 * The part of `name` that fits in a block `width` px wide: all of it, or as much as fits with an
 * ellipsis, or nothing when not even a few letters fit (a narrow zone is told by its colour and its
 * accessible name).
 */
export function fitLabel(name: string, width: number): string {
  const room = Math.floor((width - 2 * LABEL_PAD) / LABEL_CHAR);
  if (name.length <= room) return name;
  if (room < 4) return '';
  return `${name.slice(0, room - 1).trimEnd()}…`;
}

// --- the ruler -----------------------------------------------------------------------------------

/** The steps a ruler may take, in the unit it is read in, smallest first. */
const RULER_STEPS: Readonly<Record<string, readonly number[]>> = {
  mm: [10, 20, 50, 100, 200, 500, 1000, 2000],
  cm: [1, 2, 5, 10, 20, 50, 100, 200],
  in: [1, 2, 3, 6, 12, 24, 36, 72],
  ftin: [1, 2, 3, 6, 12, 24, 36, 72],
};

/** The least gap between two ruler labels, px. */
export const RULER_GAP = 64;

export interface RulerTick {
  /** The place, cm. */
  readonly x: number;
  readonly label: string;
}

/** A place as the ruler writes it: a plain number and the unit, or feet and inches for ft·in. */
export function rulerLabel(x: number, units: LengthUnit): string {
  if (units.large) return fmtLen(x, units);
  return `${Number(cmToUnitNumber(x, units).toFixed(unitDecimals(units)))} ${unitSuffix(units)}`;
}

/** The ruler across a strip: ticks at round numbers of the display unit, labelled in it. */
export function rulerTicks(f: Frame, units: LengthUnit): readonly RulerTick[] {
  if (!(f.length > 0)) return [];
  const perCm = cmToUnitNumber(1, units);
  const steps = RULER_STEPS[units.key] ?? RULER_STEPS.cm!;
  const pxPerCm = usable(f) / f.length;
  const stepCm =
    steps.map((s) => s / perCm).find((cm) => cm * pxPerCm >= RULER_GAP) ?? steps[steps.length - 1]! / perCm; // prettier-ignore
  const out: RulerTick[] = [];
  for (let k = 0; k * stepCm <= f.length + 1e-9; k++) {
    const x = k * stepCm;
    out.push({ x, label: rulerLabel(x, units) });
  }
  return out;
}
