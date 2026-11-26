// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Tail shapes: how the tail of a rails board is named, and how a name is applied to it.
 *
 * ## What a tail is in the data
 *
 * An outline chain runs from the tail to the nose. Its **tail knots** are the first few of them: those
 * before the first knot at or beyond {@link TAIL_ZONE_SHARE} of the board's length (the **rail knot**,
 * the first the shaper would call the rail's), and for a notched tail the notch bottom and the tip
 * with them. A shape rewrites those knots and nothing else: the rail knot, its handles and every
 * knot beyond it stay the shaper's. The corner radii (`doc.corners`) are the rounding of the corner
 * knots among them, of the notch crotch and of the tail point.
 *
 * ## The shapes
 *
 * Each is a small family, written in the tail's own knots, and every number that says which member a tail is
 * is read back from the knots: the width, and for a notch its depth, for a pin how far its first handle leans
 * out, for a diamond how far in its corner stands. The coordinates are written so that a shape survives the
 * per-axis stretch of Resize and of a new board made at a size (x by the length, y by the width): a squash's
 * knots are at x = 0 and its heights are shares of its half width, a notch's wall handles are shares of its depth
 * in x and of its half width in y. A pin's lean and a diamond's depth are lengths of their own and not shares of the
 * board's length, so that editing the board's length, which moves the end of the tail zone and no knot of the
 * tail, leaves the tail the shape it was.
 *
 * - **Squash**: a straight tail end square to the stringer, ending in a corner knot on each side.
 *   The width is that between the corners.
 * - **Round**: no corner and no tail end: the outline leaves the tail point square to the stringer
 *   and runs to the rail knot in one curve. The width is read at the end of the tail zone.
 * - **Pin**: the same, leaving the tail point at a slant (a first handle leaning out {@link PIN_LEAD_MIN} or more)
 *   so the two sides meet at a point.
 * - **Diamond**: straight sides from the tail point to a corner knot on each side, the corner standing
 *   {@link DIAMOND_DEPTH_MIN} or more in from the tail. The width is that between the corners.
 * - **Swallow** and **Fish**: a notch cut into the tail, the tip a corner knot at x = 0 and the notch
 *   bottom on the stringer; the swallow's wall is straight, the fish's rounded. The width is tip to tip
 *   and the notch depth is where the notch bottom stands.
 * - **Custom**: any other tail.
 *
 * ## Reading
 *
 * A shape is never stored. It is read off the outline, as a rail's name is read off its numbers
 * (`library.ts`) and a deck's shape off its curve (`deck-shapes.ts`): a tail is a shape when its own
 * knots are what {@link applyTailShape} writes for that shape at the numbers they read, to
 * {@link TAIL_READ_TOLERANCE}, and Custom otherwise. A tail that is applied and then has a point
 * dragged reads Custom, and nothing the shaper drew is replaced unless they choose a shape. What is
 * not compared is the handle where the tail knots hand over to the rail: the rail leaves a corner as
 * it did (a shape keeps that handle's offset from its knot), and the handles of the rail knot are
 * never read or written.
 *
 * ## The width
 *
 * A shaper's tail width is the width across the tail's corners: tip to tip on a swallow or a fish,
 * corner to corner on a squash or a diamond. A round or a pin tail has no corner to measure between, so
 * its width is read where the tail zone ends, {@link TAIL_ZONE_SHARE} of the board's length in from the
 * tail. (The width twelve inches in, which the specs show, is the Outline's: the rail's, not the tail's.)
 */
import type { Chain, ChainKnot, Outline, Pair, RailsBoard } from '@openshaper/board2';
import { RADIUS_TAIL } from '@openshaper/board2/defaults';
import { refitFeatures, type ChordProvider } from '../sections/features';
import { clampDepth, notchedOutline, notchDepthRange, tipIndex } from '../sections/shape';
import { cornerKnots, remapCorners } from './edits';
import { halfWidthFn, isNotched } from './measure';
import { setTail } from './shape';

/** The shapes a shaper can choose, in the order the picker lists them; a tail that is none reads `custom`. */
export const TAIL_SHAPES = ['squash', 'round', 'pin', 'diamond', 'swallow', 'fish'] as const;
export type TailShapeId = (typeof TAIL_SHAPES)[number];
export type TailShapeName = TailShapeId | 'custom';

/** A side of the board: the plus side is the one on the left of someone on the board facing the nose. */
export type TailSide = 'plus' | 'minus';

/** Whether a shape is cut with a notch. */
export const isNotchedShape = (shape: TailShapeName): shape is 'swallow' | 'fish' =>
  shape === 'swallow' || shape === 'fish';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The share of the board's length that the tail takes: outline knots nearer the tail than this belong
 * to it (the section store's notch surgery replaces the same ones, `TAIL_KNOT_SHARE` of
 * `sections/shape.ts`; `tail-shapes.test.ts` holds the two to each other). The width of a round or a pin tail
 * is read this far in.
 */
export const TAIL_ZONE_SHARE = 0.08;

/**
 * How far (cm) a tail's knot or handle may stand from the one a shape writes and the tail still read as that
 * shape: a tenth of a millimetre, below what a pencil or a plane can hold and above the rounding of a saved
 * file. A knot dragged by a millimetre or more is well past it.
 */
export const TAIL_READ_TOLERANCE = 0.01;

/** Two numbers (cm) that differ by less are the same: a shape written and read back is its numbers to rounding. */
export const SAME_NUMBER = 1e-9;

/**
 * How far (cm) the tails of the two sides of a board may differ in width or depth and still be one tail: half
 * a millimetre. The sides of a board that is not symmetric have their own outlines.
 */
export const TAIL_SIDES_TOLERANCE = 0.05;

/**
 * How far a new pin's first handle leans out from the tail point's square, as a share of the tail zone: at the
 * width the golden shortboard has at the end of its zone the two sides of the pin meet at about a right angle. A
 * pin keeps the lean it has when its width is changed, and any lean of at least {@link PIN_LEAD_MIN} is a pin.
 */
export const PIN_LEAD_SHARE = 1;

/**
 * The least lean (cm) of a pin's first handle: a lean under it, and over the tolerance, is neither a round nor a pin.
 * It is a length of its own and not a share of the board's, so that a board whose length is edited, which moves
 * the end of the tail zone and no knot of the tail, is still the shape it was.
 */
export const PIN_LEAD_MIN = 1;

/**
 * How far in from the tail a new diamond's corner stands, as a share of the tail zone: 6 cm on a zone of 15, which at
 * the width a new diamond takes makes its two straight sides meet at about a right angle. A diamond keeps the depth it has when its
 * width is changed, and a corner at least {@link DIAMOND_DEPTH_MIN} in on straight sides is a diamond.
 */
export const DIAMOND_DEPTH_SHARE = 0.4;

/** The least depth (cm) of a diamond's corner: a corner nearer the tail than this, and over the tolerance, is neither a squash nor a diamond. A length of its own, as {@link PIN_LEAD_MIN} is. */
export const DIAMOND_DEPTH_MIN = 1;

/** How far a diamond's corner turns the outline (radians): the rail leaves it this far off the diamond's own side, outward. */
export const DIAMOND_TURN = Math.PI / 4;

/**
 * Where a corner's rail leaves it, when nothing says otherwise: the handle runs out this share of the
 * board's greatest half width and up the lesser of the next share of it and half the way to the rail knot. These
 * are the section store's swallow tip handle (`notchedOutline`), so every corner a shape makes leaves the tail as
 * the project's own swallow and fish do.
 */
export const FLARE_RUN_SHARE = 0.13;
export const FLARE_RISE_SHARE = 0.15;

/**
 * The least height (cm) of the first handle of a round or a pin: a tail point whose handle is shorter leaves it
 * at the slant of the rail beyond, so it is neither square nor a pin, and the width at the end of the zone
 * has only a rail's own to give.
 */
export const TAIL_LEAD_MIN = 1;

/**
 * The tail width a new squash or diamond takes, as a share of the board's width: the two soft squashes of
 * the project (the golden shortboard, 0.246 of its width across its corners, and the longboard, 0.326) and
 * their mean.
 */
export const DEFAULT_CORNER_WIDTH_SHARE = 0.286;

/**
 * The corner of the loop that the engine rounds: two sides that turn less than this (a sine) join
 * smoothly and get no arc, so a radius there changes nothing. `TRIM.cornerMinTurn` of the engine.
 */
export const CORNER_MIN_TURN = 0.03;

/**
 * A corner turning less than this (a sine; about 6 degrees) is not listed as one. The engine rounds a corner by
 * crossing offsets of its two pieces, and for pieces nearly in line the crossing is a long way off or
 * not found, so a radius there changes nothing that can be seen. `CORNER_MIN_TURN` is the least it tries.
 */
export const CORNER_LISTED_TURN = 0.1;

/**
 * The least radius (cm) of a corner that is an end of the board (a swallow's or a fish's tip, a pin's or a
 * diamond's point): a board never ends in a point, its tips are a ball of 5 to 10 mm.
 */
export const TIP_RADIUS_MIN = 0.5;

/**
 * The least radius (cm) of any other corner (a squash's or a diamond's corner, the crotch of a notch): half a
 * millimetre. The engine builds no arc at all for a radius of 0.3 mm or less (a corner of `TRIM.cornerFloor`, 0.2 mm,
 * stays a sharp one) and builds one from 0.4 mm (`tail-shapes.measure.test.ts`).
 */
export const CORNER_RADIUS_MIN = 0.05;

/**
 * The narrowest and the widest tail a shape is held to, as shares of the board's width (twice its greatest half
 * width); the widest is also held to the rail knot's own width, so a tail never narrows again before the rail.
 *
 * The engine builds every width in the ranges, and well beyond them down to a few percent of the board's width (the
 * study `tail-shapes.measure.test.ts` scans nine boards and six shapes), with no issue and a closed mesh; the suite builds each
 * end on every board (`tail-shapes.test.ts`) and at the least and the greatest size of every gallery type
 * (`apps/web/src/tail-shapes.gate.test.ts`). So the ends are not the engine's limit: they are where a shape stops
 * looking like itself, which is what they are for. Drawn on the golden shortboard, a round tail
 * narrower than 0.4 of the board's width at the end of its zone is a point, a pin narrower than 0.35 turns to a
 * needle with a kink in its side, a diamond narrower than 0.2 is a bump on the rail, and a notch is a slot where the
 * tips are narrower than 0.3. The project's own tails are well inside: its squashes are 0.25 and 0.33 of the board's
 * width across their corners, its swallow 0.42 and its fish 0.5.
 */
export const TAIL_WIDTH_SHARE: Readonly<
  Record<TailShapeId, readonly [least: number, greatest: number]>
> = {
  squash: [0.12, 0.5],
  round: [0.4, 0.9],
  pin: [0.35, 0.9],
  diamond: [0.2, 0.5],
  swallow: [0.3, 0.7],
  fish: [0.3, 0.7],
};

/**
 * The walls of a notch, as the section store draws them (`wall` in `sections/shape.ts`): the notch bottom's
 * out handle and the tip's in handle, as shares of the notch depth `d` in x and of the half width `w` at the tip in y.
 */
const WALLS: Readonly<Record<'swallow' | 'fish', { out: Pair; tipIn: Pair }>> = {
  swallow: { out: [2 / 3, 1 / 3], tipIn: [1 / 3, 2 / 3] },
  fish: { out: [0.6, 0.4], tipIn: [0.1, 0.6] },
};

// ---------------------------------------------------------------------------
// The tail in a chain
// ---------------------------------------------------------------------------

const lengthOf = (c: Chain): number => c.knots[c.knots.length - 1]!.p[0];

/** The half width of the board at its widest control point. */
const widestOf = (c: Chain): number => Math.max(...c.knots.map((k) => k.p[1]));

const chainOf = (outline: Outline, side: TailSide): Chain =>
  side === 'minus' ? (outline.minus ?? outline.plus) : outline.plus;

/** The end of the tail zone (cm from the tail). */
const zoneOf = (c: Chain): number => TAIL_ZONE_SHARE * lengthOf(c);

/**
 * The index of a chain's rail knot: the first knot at or beyond the end of the tail zone (past the tip, on a
 * notched tail), or the last when none is. The tail knots are those before it.
 */
export function railKnotIndex(chain: Chain): number {
  const zone = zoneOf(chain);
  const first = chain.knots[0]!.p[0] > 0 ? tipIndex(chain) + 1 : 1;
  for (let i = first; i < chain.knots.length - 1; i++) if (chain.knots[i]!.p[0] >= zone) return i;
  return chain.knots.length - 1;
}

const near = (a: readonly number[], b: readonly number[], tol = TAIL_READ_TOLERANCE): boolean =>
  Math.abs(a[0]! - b[0]!) <= tol && Math.abs(a[1]! - b[1]!) <= tol;

const third = (p: Pair, k: number): Pair => [p[0] * k, p[1] * k];

/** A corner knot: a knot the editor does not keep smooth, so the outline turns there and the engine rounds it. */
const corner = (p: Pair, out?: Pair, inn?: Pair): ChainKnot => ({
  p,
  in: inn ?? p,
  out: out ?? p,
  smooth: false,
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** What a tail is: its shape and the numbers that say which member of the shape it is. */
export interface TailReading {
  readonly shape: TailShapeName;
  /** The tail width (cm, the whole width across): see the module's note. Null for Custom. */
  readonly width: number | null;
  /** The notch depth (cm): where the notch bottom stands. Null unless a swallow or a fish. */
  readonly notch: number | null;
}

const CUSTOM: TailReading = { shape: 'custom', width: null, notch: null };

/** The width (cm, whole) a tail has at the end of its zone, read from the outline as the engine does. */
const widthAtZone = (outline: Outline, side: TailSide): number =>
  2 * halfWidthFn(outline, side === 'minus' ? 'minus' : undefined)(zoneOf(chainOf(outline, side)));

function readNotched(own: readonly ChainKnot[]): TailReading {
  if (own.length !== 2) return CUSTOM;
  const [bottom, tip] = own as [ChainKnot, ChainKnot];
  const d = bottom.p[0];
  const w = tip.p[1];
  if (!(d > 0 && w > 0) || tip.smooth) return CUSTOM;
  if (Math.abs(bottom.p[1]) > TAIL_READ_TOLERANCE || Math.abs(tip.p[0]) > TAIL_READ_TOLERANCE)
    return CUSTOM;
  for (const shape of ['swallow', 'fish'] as const) {
    const wall = WALLS[shape];
    if (
      near(bottom.out, [d * wall.out[0], w * wall.out[1]]) &&
      near(tip.in, [d * wall.tipIn[0], w * wall.tipIn[1]])
    ) {
      return { shape, width: 2 * w, notch: d };
    }
  }
  return CUSTOM;
}

function readStandard(outline: Outline, side: TailSide, own: readonly ChainKnot[]): TailReading {
  const tail = own[0]!;
  if (Math.abs(tail.p[0]) > TAIL_READ_TOLERANCE || Math.abs(tail.p[1]) > TAIL_READ_TOLERANCE)
    return CUSTOM;
  const lead: Pair = [tail.out[0] - tail.p[0], tail.out[1] - tail.p[1]];
  if (own.length === 1) {
    if (!(lead[1] > 0)) return CUSTOM;
    const shape =
      Math.abs(lead[0]) <= TAIL_READ_TOLERANCE ? 'round' : lead[0] >= PIN_LEAD_MIN ? 'pin' : null;
    return shape === null ? CUSTOM : { shape, width: widthAtZone(outline, side), notch: null };
  }
  if (own.length !== 2) return CUSTOM;
  const c = own[1]!;
  if (c.smooth || !(c.p[1] > 0)) return CUSTOM;
  const straight = near(tail.out, third(c.p, 1 / 3)) && near(c.in, third(c.p, 2 / 3));
  if (Math.abs(c.p[0]) <= TAIL_READ_TOLERANCE) {
    // a squash: the tail end runs straight across, square to the stringer
    return straight ? { shape: 'squash', width: 2 * c.p[1], notch: null } : CUSTOM;
  }
  if (c.p[0] >= DIAMOND_DEPTH_MIN && straight) {
    return { shape: 'diamond', width: 2 * c.p[1], notch: null };
  }
  return CUSTOM;
}

/**
 * What the tail of a board is on one side (the plus side by default; a mirror board's minus side is the
 * plus side's). The shape is read off the outline, never stored; see the module's note.
 */
export function tailShapeOf(doc: RailsBoard, side: TailSide = 'plus'): TailReading {
  const chain = chainOf(doc.outline, side);
  const own = chain.knots.slice(0, railKnotIndex(chain));
  return chain.knots[0]!.p[0] > 0 ? readNotched(own) : readStandard(doc.outline, side, own);
}

/** What the tail of a board is, both sides read together. */
export interface TailBoardReading extends TailReading {
  /**
   * The two sides do not read the same: a different shape, or a width or a depth more than
   * {@link TAIL_SIDES_TOLERANCE} apart. The reading is then the plus side's, and Custom when the shapes differ.
   */
  readonly sidesDiffer: boolean;
}

/** What the tail of a board is, with whether its two sides differ (they cannot on a mirror board). */
export function tailShapeAt(doc: RailsBoard): TailBoardReading {
  const a = tailShapeOf(doc, 'plus');
  if (doc.outline.minus === undefined) return { ...a, sidesDiffer: false };
  const b = tailShapeOf(doc, 'minus');
  if (a.shape !== b.shape) return { ...CUSTOM, sidesDiffer: true };
  const apart = (x: number | null, y: number | null): boolean =>
    x !== null && y !== null && Math.abs(x - y) > TAIL_SIDES_TOLERANCE;
  return { ...a, sidesDiffer: apart(a.width, b.width) || apart(a.notch, b.notch) };
}

// ---------------------------------------------------------------------------
// What a tail can hold
// ---------------------------------------------------------------------------

/** The widths (cm, whole) a tail can have. */
export interface TailWidthRange {
  readonly min: number;
  readonly max: number;
}

/**
 * The widths the tail of a board can have as `shape`: from the shape's least share of the board's width to its
 * greatest, the greatest held to the rail knot's own width, so a tail never narrows again before the rail. A round
 * or a pin has no less than what its curve gives with the least first handle there is, which on a board whose rail knot is near
 * is more than the share. With no `side`, a board with a minus side gets the widths both sides can have (the
 * narrowest of the greatest, the widest of the least); a board that has no room for a tail (an outline of two knots) gets the
 * one width its rail knot has.
 */
export function tailWidthRange(
  doc: RailsBoard,
  shape: TailShapeId,
  side?: TailSide,
): TailWidthRange {
  if (side === undefined && doc.outline.minus !== undefined) {
    const a = tailWidthRange(doc, shape, 'plus');
    const b = tailWidthRange(doc, shape, 'minus');
    const max = Math.min(a.max, b.max);
    return { min: Math.min(Math.max(a.min, b.min), max), max };
  }
  const s = side ?? 'plus';
  const chain = chainOf(doc.outline, s);
  const rail = chain.knots[railKnotIndex(chain)]!;
  const board = 2 * widestOf(chain);
  const [least, greatest] = TAIL_WIDTH_SHARE[shape];
  const max = Math.min(greatest * board, 2 * rail.p[1]);
  let min = Math.min(least * board, max);
  if (shape === 'round' || shape === 'pin') {
    const probe = leadReadings(chain, shape === 'pin' ? pinLead(chain) : 0);
    min = Math.min(max, Math.max(min, 2 * (probe.at0 + probe.slope * TAIL_LEAD_MIN)));
  }
  return { min, max };
}

/** The notch depths (cm) a board can have: the section store's, from 0.5% to 30% of the length. */
export const tailNotchRange = (doc: RailsBoard): { readonly min: number; readonly max: number } =>
  notchDepthRange(lengthOf(doc.outline.plus));

const hold = (v: number, range: { readonly min: number; readonly max: number }): number =>
  Math.min(range.max, Math.max(range.min, v));

/**
 * Where the tail's width is measured on one side, for a handle to stand there: the corner on a squash, a diamond, a
 * swallow or a fish, and the outline at the end of the tail zone on a round or a pin. Null for a tail that reads Custom.
 * The point is on the chain's side of the stringer (y >= 0); the width is twice its y.
 */
export function tailWidthPoint(doc: RailsBoard, side: TailSide = 'plus'): Pair | null {
  const reading = tailShapeOf(doc, side);
  if (reading.shape === 'custom' || reading.width === null) return null;
  const chain = chainOf(doc.outline, side);
  return reading.shape === 'round' || reading.shape === 'pin'
    ? [zoneOf(chain), reading.width / 2]
    : chain.knots[railKnotIndex(chain) - 1]!.p;
}

// ---------------------------------------------------------------------------
// Writing a tail
// ---------------------------------------------------------------------------

/** Where a corner's rail leaves it by default: the section store's swallow tip handle (see {@link FLARE_RUN_SHARE}). */
function flareFrom(chain: Chain, at: Pair): Pair {
  const rail = chain.knots[railKnotIndex(chain)]!;
  const widest = widestOf(chain);
  const rise = Math.max(0, Math.min(FLARE_RISE_SHARE * widest, 0.5 * (rail.p[1] - at[1])));
  return [at[0] + FLARE_RUN_SHARE * widest, at[1] + rise];
}

/**
 * The last of the tail knots when it is a corner knot (a squash's or a diamond's corner, a swallow's or
 * fish's tip): the knot the rail leaves the tail from, whose handle a new shape keeps.
 */
function cornerOf(chain: Chain): ChainKnot | null {
  const r = railKnotIndex(chain);
  const last = chain.knots[r - 1];
  return r >= 2 && last !== undefined && !last.smooth ? last : null;
}

/**
 * What a rewrite takes from the tail it replaces. A tail that already is the shape keeps what a width or a depth dial
 * does not set: the way the rail leaves its corner, a pin's lean, a diamond's depth. A tail that is not (a different
 * shape, or Custom) is replaced by the new shape's own, so that a shape looks the same at a width whatever was chosen
 * before it. A notch's tip keeps the way the rail leaves it whenever the tail stays notched.
 */
interface Carry {
  readonly flare: boolean;
  readonly lead: number | null;
  readonly depth: number | null;
}

/** The handle with which a corner at `at` leaves: the old corner's offset from its knot where it is carried, else the default. */
function flare(chain: Chain, at: Pair, carry: Carry): Pair {
  const old = carry.flare ? cornerOf(chain) : null;
  return old === null
    ? flareFrom(chain, at)
    : [at[0] + old.out[0] - old.p[0], at[1] + old.out[1] - old.p[1]];
}

/**
 * The handle with which a diamond's corner at `c` leaves: the old corner's offset where it is carried, else one of
 * the default flare's length turned {@link DIAMOND_TURN} off the diamond's own side, so that the corner is a corner
 * whatever the board's width.
 */
function diamondFlare(chain: Chain, c: Pair, carry: Carry): Pair {
  if (carry.flare && cornerOf(chain) !== null) return flare(chain, c, carry);
  const run = FLARE_RUN_SHARE * widestOf(chain);
  const len = Math.hypot(run, FLARE_RISE_SHARE * widestOf(chain));
  const heading = Math.atan2(c[1], c[0]) - DIAMOND_TURN;
  // a handle below the stringer would cross the board to its other side (the engine refuses an outline that does)
  return [c[0] + len * Math.cos(heading), Math.max(0, c[1] + len * Math.sin(heading))];
}

/** The lean of a pin's first handle: the one the tail has where it is a pin's, else a new pin's. */
function pinLead(chain: Chain): number {
  const first = chain.knots[0]!;
  const lean = first.out[0] - first.p[0];
  return Math.abs(first.p[0]) <= TAIL_READ_TOLERANCE &&
    railKnotIndex(chain) === 1 &&
    lean >= PIN_LEAD_MIN
    ? lean
    : PIN_LEAD_SHARE * zoneOf(chain);
}

/** The chain with its tail knots (those before the rail knot) replaced by `own`. */
const withTail = (chain: Chain, own: readonly ChainKnot[]): Chain => ({
  knots: [...own, ...chain.knots.slice(railKnotIndex(chain))],
});

/** The chain of a round or a pin tail whose first handle runs out `lead` along x and up `h`. */
const leadTail = (chain: Chain, lead: number, h: number): Chain =>
  withTail(chain, [corner([0, 0], [lead, h])]);

/**
 * The half width, at the end of the tail zone, of a round or a pin tail with a first handle of height 0 (`at0`) and
 * how much each unit of its height adds (`slope`). The width at a place on a curve is linear in a handle's height with
 * the rest held, so two readings give every other.
 */
function leadReadings(chain: Chain, lead: number): { at0: number; slope: number } {
  const at = (h: number): number => halfWidthFn({ plus: leadTail(chain, lead, h) })(zoneOf(chain));
  const at0 = at(0);
  return { at0, slope: at(1) - at0 };
}

/**
 * The chain of a round or a pin tail whose width at the end of the tail zone is `width`: the first handle's height is
 * found so that the outline stands half the width out there.
 */
function leadChain(chain: Chain, lead: number, width: number): Chain {
  const { at0, slope } = leadReadings(chain, lead);
  const h = slope > 0 ? Math.max(TAIL_LEAD_MIN, (width / 2 - at0) / slope) : TAIL_LEAD_MIN;
  return leadTail(chain, lead, h);
}

/**
 * The chain with its tail written as `shape` at `width` (cm, whole) and, for a notch, depth `d`. Every x is a
 * share of the zone or of the notch depth and every y a share of the half width, as the module's note says. The
 * rail knot and everything beyond are the chain's own objects.
 */
function writeShape(
  chain: Chain,
  shape: TailShapeId,
  width: number,
  d: number,
  carry: Carry,
): Chain {
  const hw = width / 2;
  const zone = zoneOf(chain);
  switch (shape) {
    case 'squash':
      return withTail(chain, [
        corner([0, 0], [0, hw / 3]),
        corner([0, hw], flare(chain, [0, hw], carry), [0, (2 * hw) / 3]),
      ]);
    case 'diamond': {
      const c: Pair = [carry.depth ?? DIAMOND_DEPTH_SHARE * zone, hw];
      return withTail(chain, [
        corner([0, 0], third(c, 1 / 3)),
        corner(c, diamondFlare(chain, c, carry), third(c, 2 / 3)),
      ]);
    }
    case 'round':
      return leadChain(chain, 0, width);
    case 'pin':
      return leadChain(chain, carry.lead ?? PIN_LEAD_SHARE * zone, width);
    case 'swallow':
    case 'fish': {
      // the section store's own surgery builds the wall from the tip's half width and the notch depth
      const at: Pair = [0, hw];
      const base: Chain = {
        knots: [
          corner([d, 0]),
          corner(at, flare(chain, at, carry)),
          ...chain.knots.slice(railKnotIndex(chain)),
        ],
      };
      return notchedOutline(base, shape, d, false);
    }
  }
}

/** What a call asks of a tail: a shape and, where the shape has them, its numbers. */
export interface TailShapeRequest {
  readonly shape: TailShapeId;
  /**
   * The tail width (cm, whole). Left out, a tail that already is the shape keeps its width, a new squash or
   * diamond takes {@link DEFAULT_CORNER_WIDTH_SHARE} of the board's width, a new round or pin keeps the width the
   * board has at the end of its tail zone, and a new swallow or fish the section store's default tip.
   */
  readonly width?: number;
  /** The notch depth (cm) of a swallow or a fish. Left out, the one it has, or the section store's default for a new notch. */
  readonly notch?: number;
}

const chordsOf: ChordProvider<RailsBoard> = (doc, side) => halfWidthFn(doc.outline, side);

/** The default width (cm) of `shape` on a chain that does not read as it. */
function defaultWidth(outline: Outline, side: TailSide, shape: TailShapeId): number {
  return shape === 'round' || shape === 'pin'
    ? widthAtZone(outline, side)
    : DEFAULT_CORNER_WIDTH_SHARE * 2 * widestOf(chainOf(outline, side));
}

/**
 * The corner radii of one side after its tail was rewritten from `was` to `now`: the rest of the outline keeps
 * its corners' radii (the knots are the same objects), the first corner among the new tail's knots has the old
 * tail's first corner's radius where it had one, and every corner a shape creates takes the default radius.
 */
function tailRadii(was: Chain, now: Chain, radii: readonly number[]): readonly number[] {
  const firstOwn = (c: Chain): number => cornerKnots(c).find((k) => k < railKnotIndex(c)) ?? -1;
  const oldFirst = firstOwn(was);
  const newFirst = firstOwn(now);
  const match = now.knots.map((k, i) => (i === newFirst ? oldFirst : was.knots.indexOf(k)));
  return remapCorners(was, now, radii, match, RADIUS_TAIL);
}

/**
 * The board with `request` applied to its tail, on both sides (where the outline has a minus side) or on `side`
 * alone. Only the tail knots change (see the module's note); the other knots, the stations and the rails are the
 * board's own, except that a notch is the section store's surgery (`setTail` of `shape.ts`), which drops the
 * stations behind the notch bottom, and the channels are refitted inside the new outline.
 *
 * A width or a depth the board cannot hold is held at the nearest it can, never refused. A corner a shape creates
 * takes the default radius (the crotch of a notch the crotch's); the first corner of the old tail keeps its radius.
 * A notch is one for the whole board: choosing a notched shape on one side, or leaving one, is applied to both.
 *
 * Returns `doc` itself when the tail already is the shape at the numbers asked, and every part an edit does not
 * touch by reference.
 */
export function applyTailShape(
  doc: RailsBoard,
  request: TailShapeRequest,
  side?: TailSide,
): RailsBoard {
  const { shape } = request;
  const both = doc.outline.minus !== undefined;
  const notchedNow = isNotched(doc.outline);
  const wantNotched = isNotchedShape(shape);
  const flip = notchedNow !== wantNotched;
  // a notch is one for the whole board, so a call that makes or leaves one reaches both sides
  const reach: readonly TailSide[] = !both
    ? ['plus']
    : side === undefined || flip || wantNotched
      ? ['plus', 'minus']
      : [side];
  const finite = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v);
  // the widths the board as given can hold: a notch's surgery leaves a tail point that is not the shaper's, so it is not read
  const range = tailWidthRange(doc, shape, reach.length === 2 || !both ? undefined : reach[0]);
  const asked = finite(request.width) ? hold(request.width, range) : null;
  const depth = finite(request.notch)
    ? clampDepth(request.notch, lengthOf(doc.outline.plus))
    : null;

  // is every side reached already the shape, at the numbers asked?
  const already = reach.every((s) => {
    const now = tailShapeOf(doc, s);
    return (
      now.shape === shape &&
      (asked === null || (now.width !== null && Math.abs(now.width - asked) <= SAME_NUMBER)) &&
      (depth === null || (now.notch !== null && Math.abs(now.notch - depth) <= SAME_NUMBER))
    );
  });
  if (already) return doc;

  // a notch, or the loss of one, is the section store's: its stations, features and corner radii follow
  let base = doc;
  if (wantNotched) {
    base = setTail(doc, shape, depth ?? undefined, chordsOf);
    if (base === doc && !notchedNow) return doc;
  } else if (notchedNow) {
    base = setTail(doc, 'standard', undefined, chordsOf);
    if (base === doc) return doc;
  }

  // the width each reached side is written at: the one asked; else what it has, if it already is the shape; else, for a
  // side that is not, the width of a side that is, or the shape's default (the mean of the sides' where both need it)
  const reads = new Map(reach.map((s) => [s, tailShapeOf(base, s)]));
  const own = (s: TailSide): number | null => {
    const r = reads.get(s)!;
    return r.shape === shape ? r.width : null;
  };
  const tip = (s: TailSide): number => {
    const c = chainOf(base.outline, s);
    return 2 * c.knots[tipIndex(c)]!.p[1];
  };
  const lacking = reach.filter((s) => own(s) === null);
  const shared =
    asked ??
    // a new notch has one width for both sides, the mean of the two the section store gave them
    (flip && wantNotched && reach.length === 2
      ? (tip('plus') + tip('minus')) / 2
      : lacking.length === reach.length || lacking.length === 0
        ? null
        : (own(reach.find((s) => own(s) !== null)!) as number));
  const fallback = (s: TailSide): number =>
    wantNotched
      ? tip(s)
      : lacking.reduce((sum, q) => sum + defaultWidth(base.outline, q, shape), 0) / lacking.length;
  const rewritten = new Map<TailSide, Chain>();
  for (const s of reach) {
    const width = shared ?? own(s) ?? fallback(s);
    const chain = chainOf(base.outline, s);
    // a tail the section store has just made standard is nobody's shape to keep
    const same = !flip && reads.get(s)!.shape === shape;
    const carry: Carry = {
      flare: same || wantNotched,
      lead: same && shape === 'pin' ? pinLead(chain) : null,
      depth: same && shape === 'diamond' ? chain.knots[1]!.p[0] : null,
    };
    rewritten.set(s, writeShape(chain, shape, hold(width, range), chain.knots[0]!.p[0], carry));
  }

  const plus = rewritten.get('plus') ?? base.outline.plus;
  // a minus side that was the plus side's own object stays so when both are written alike
  const shareMinus = both && doc.outline.minus === doc.outline.plus && reach.length === 2;
  const minus = both
    ? shareMinus
      ? plus
      : (rewritten.get('minus') ?? base.outline.minus)
    : undefined;
  // the radii follow the board as it was given, so a corner that the notch's surgery drops and the shape makes again keeps its own
  const cornersPlus = tailRadii(doc.outline.plus, plus, doc.corners.plus);
  const cornersMinus =
    minus === undefined || doc.corners.minus === undefined
      ? doc.corners.minus
      : shareMinus && doc.corners.minus === doc.corners.plus
        ? cornersPlus
        : tailRadii(doc.outline.minus!, minus, doc.corners.minus);
  const next: RailsBoard = {
    ...base,
    outline: { plus, ...(minus === undefined ? {} : { minus }) },
    corners: {
      ...base.corners,
      plus: cornersPlus,
      ...(cornersMinus === undefined ? {} : { minus: cornersMinus }),
    },
  };
  return { ...next, features: refitFeatures(next, chordsOf) };
}

// ---------------------------------------------------------------------------
// Corners
// ---------------------------------------------------------------------------

/**
 * How much of the shorter of the two pieces beside a corner its arc may use: the engine rounds a corner by
 * an arc tangent to both pieces, and an arc that does not fit is retried at 0.6 of its radius, so the radius
 * a corner is held to is the one whose tangent length is this share of the piece (`tail-shapes.measure.test.ts`
 * builds each corner at the greatest radius it is offered and measures the arc the engine made).
 */
export const CORNER_FIT_SHARE = 0.25;

/** A turn (radians) at which a corner's arc grows without bound; a corner is held short of it. */
const TURN_MAX = (179 * Math.PI) / 180;

/** What a tail corner is: where a shaper would point to it. */
export type TailCornerRole = 'tip' | 'corner' | 'crotch' | 'point';

/** The range (cm) a corner's radius is held to. */
export interface CornerRadiusRange {
  readonly min: number;
  readonly max: number;
}

/**
 * A corner of the tail, the half of the board that holds it: a corner knot of the outline, the notch crotch or
 * the point where the two sides meet at the tail. `side` and `index` name its radius in the document: a corner
 * knot's is `doc.corners[side][index]`, and the tail's is `doc.corners.tail`.
 */
export interface TailCorner {
  readonly side: TailSide | 'tail';
  readonly index: number;
  readonly role: TailCornerRole;
  /** Where it stands (cm; the chain's frame, y >= 0 on either side). */
  readonly point: Pair;
  /** The outline knot's place on its chain (0 for the crotch and the point). */
  readonly knot: number;
  readonly radius: number;
  readonly range: CornerRadiusRange;
  /** The turn (radians) the outline makes at it. */
  readonly turn: number;
  /**
   * The direction (a unit vector, the chain's frame) from the corner to the centre of the arc that rounds it: into the
   * board for a corner that turns the outline inward, and out into the notch for a crotch.
   */
  readonly toCenter: Pair;
  /** A shaper's name for it: "tail corner, left", "notch crotch". */
  readonly label: string;
}

const dist = (a: Pair, b: Pair): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** The unit direction from `a` to `b`, or null when they are one place. */
function unit(a: Pair, b: Pair): Pair | null {
  const l = dist(a, b);
  return l > 0 ? [(b[0] - a[0]) / l, (b[1] - a[1]) / l] : null;
}

/** Where a segment of a chain heads at its start (`atEnd` false) or at its end: the first control point that is not the knot's own. */
function segmentHeading(a: ChainKnot, b: ChainKnot, atEnd: boolean): Pair | null {
  const pts: Pair[] = atEnd ? [b.in, a.out, a.p] : [a.out, b.in, b.p];
  const from = atEnd ? b.p : a.p;
  for (const q of pts) {
    const u = atEnd ? unit(q, from) : unit(from, q);
    if (u !== null) return u;
  }
  return null;
}

/** The direction the outline travels as it arrives at knot `k` of a chain, and as it leaves it, tail to nose. */
function headings(chain: Chain, k: number): { into: Pair | null; out: Pair | null } {
  const kn = chain.knots;
  return {
    into: k > 0 ? segmentHeading(kn[k - 1]!, kn[k]!, true) : null,
    out: k + 1 < kn.length ? segmentHeading(kn[k]!, kn[k + 1]!, false) : null,
  };
}

/** The unit vector along `v`, or `fallback` for one of no length. */
function normal(v: Pair, fallback: Pair): Pair {
  const l = Math.hypot(v[0], v[1]);
  return l > 0 ? [v[0] / l, v[1] / l] : fallback;
}

/** The turn (radians, 0 to pi) between two directions of travel, and the sine the engine tests it by. */
function turnBetween(a: Pair | null, b: Pair | null): { turn: number; sine: number } {
  if (a === null || b === null) return { turn: 0, sine: 0 };
  const cross = a[0] * b[1] - a[1] * b[0];
  const dot = a[0] * b[0] + a[1] * b[1];
  return { turn: Math.atan2(Math.abs(cross), dot), sine: Math.abs(cross) };
}

/**
 * The turn the outline makes at knot `k` of a chain: the angle between the way it arrives and the way it
 * leaves. A knot at either end has none.
 */
export function cornerTurn(chain: Chain, k: number): number {
  const { into, out } = headings(chain, k);
  return turnBetween(into, out).turn;
}

/** The length (cm) of the outline's piece beside knot `k`, summed along its knots, to the next corner knot or the chain's end. */
function pieceLength(chain: Chain, k: number, dir: 1 | -1): number {
  const kn = chain.knots;
  let len = 0;
  for (let i = k; i + dir >= 0 && i + dir < kn.length; i += dir) {
    len += dist(kn[i]!.p, kn[i + dir]!.p);
    if (i + dir > 0 && i + dir < kn.length - 1 && !kn[i + dir]!.smooth) break;
  }
  return len;
}

/** The radius whose arc, for a turn, takes {@link CORNER_FIT_SHARE} of a piece `length` long, held to the board's half width. */
function fitRadius(length: number, turn: number, half: number): number {
  const t = Math.tan(Math.min(turn, TURN_MAX) / 2);
  return Math.min(half, t > 0 ? (CORNER_FIT_SHARE * length) / t : half);
}

const sideName = (s: TailSide, both: boolean): string =>
  both ? (s === 'plus' ? ', left' : ', right') : '';

/** The half of the board (the tail half: nearer the tail than the middle) a corner has to be in to belong to the tail. */
const inTailHalf = (chain: Chain, p: Pair): boolean => p[0] < lengthOf(chain) / 2;

/**
 * The corners of the tail, from the tail, each with its radius and the range it is held to: the notch crotch or
 * the tail point, then the corner knots in the tail half of each side. The nose's corner is the Outline's. A
 * corner where the outline turns too little for the engine to round it (`CORNER_MIN_TURN`) is not a corner, and
 * is left out; so is the tail point where the two sides leave it square, which is no corner at all. A mirror board's
 * corners are listed once, for the side that holds their radii.
 */
export function tailCorners(doc: RailsBoard): readonly TailCorner[] {
  const out: TailCorner[] = [];
  const asym = doc.outline.minus !== undefined;
  const sides: readonly TailSide[] = asym ? ['plus', 'minus'] : ['plus'];
  const notched = isNotched(doc.outline);
  const plus = doc.outline.plus;
  const half = widestOf(plus);

  // the crotch of a notch, or the point the two sides meet in
  const lead = (c: Chain): Pair | null => {
    const first = c.knots[0]!;
    return unit(first.p, first.out) ?? unit(first.p, c.knots[1]!.p);
  };
  const a = lead(plus);
  const b = lead(chainOf(doc.outline, 'minus'));
  if (a !== null && b !== null) {
    // the sides leave the tail point mirrored in y: arriving along one and leaving along the other
    const { turn, sine } = turnBetween([-a[0], -a[1]], [b[0], -b[1]]);
    if (sine >= CORNER_LISTED_TURN) {
      const wall = Math.min(...sides.map((s) => pieceLength(chainOf(doc.outline, s), 0, 1)));
      out.push({
        side: 'tail',
        index: 0,
        role: notched ? 'crotch' : 'point',
        point: [plus.knots[0]!.p[0], 0],
        knot: 0,
        radius: doc.corners.tail,
        range: {
          min: notched ? CORNER_RADIUS_MIN : TIP_RADIUS_MIN,
          // a point's ball cannot be wider than the tail it ends
          max: Math.max(
            notched ? CORNER_RADIUS_MIN : TIP_RADIUS_MIN,
            fitRadius(
              wall,
              turn,
              notched ? half : Math.min(half, widthAtZone(doc.outline, 'plus') / 2),
            ),
          ),
        },
        turn,
        // the centre lies between the two sides as they leave the point, the second reflected to this side
        toCenter: normal([a[0] + b[0], a[1] - b[1]], [notched ? -1 : 1, 0]),
        label: notched ? 'notch crotch' : 'tail point',
      });
    }
  }

  for (const s of sides) {
    const chain = chainOf(doc.outline, s);
    const radii = s === 'minus' ? (doc.corners.minus ?? doc.corners.plus) : doc.corners.plus;
    const tip = notched ? tipIndex(chain) : -1;
    cornerKnots(chain).forEach((k, index) => {
      const p = chain.knots[k]!.p;
      if (!inTailHalf(chain, p)) return;
      const { into, out: leaving } = headings(chain, k);
      const { turn, sine } = turnBetween(into, leaving);
      if (sine < CORNER_LISTED_TURN) return;
      const role: TailCornerRole = k === tip ? 'tip' : 'corner';
      const min = role === 'tip' ? TIP_RADIUS_MIN : CORNER_RADIUS_MIN;
      const fit = fitRadius(
        Math.min(pieceLength(chain, k, -1), pieceLength(chain, k, 1)),
        turn,
        half,
      );
      out.push({
        side: s,
        index,
        role,
        point: p,
        knot: k,
        radius: radii[index] ?? RADIUS_TAIL,
        range: { min, max: Math.max(min, fit) },
        turn,
        // the centre lies on the inside of the turn: from the way in to the way out
        toCenter: normal([leaving![0] - into![0], leaving![1] - into![1]], [1, 0]),
        label: `${role === 'tip' ? 'tail tip' : 'tail corner'}${sideName(s, asym)}`,
      });
    });
  }
  return out.sort((x, y) => x.point[0] - y.point[0]);
}

/**
 * `doc` with the radius of one corner set to `radius` (cm), held to the range it has ({@link tailCorners}). `corner`
 * is the corner knot's place among its side's corner knots, or `'tail'` for the notch crotch or the tail point.
 * A mirror board has one list of radii, for both sides; on an asymmetric board `side` names the side whose corner
 * is meant, and both when it is left out. A radius that is not a number is not set. The board itself when nothing
 * changes, and every other part by reference.
 */
export function setCornerRadius(
  doc: RailsBoard,
  corner: number | 'tail',
  radius: number,
  side?: TailSide,
): RailsBoard {
  if (!Number.isFinite(radius)) return doc;
  const corners = tailCorners(doc);
  const rangeOf = (s: TailSide | 'tail', index: number): CornerRadiusRange =>
    corners.find((c) => c.side === s && c.index === index)?.range ?? {
      min: CORNER_RADIUS_MIN,
      max: widestOf(doc.outline.plus),
    };
  if (corner === 'tail') {
    const to = hold(radius, rangeOf('tail', 0));
    return to === doc.corners.tail ? doc : { ...doc, corners: { ...doc.corners, tail: to } };
  }
  if (!Number.isInteger(corner) || corner < 0) return doc;
  const asym = doc.outline.minus !== undefined && doc.corners.minus !== undefined;
  const sides: readonly TailSide[] = !asym
    ? ['plus']
    : side === undefined
      ? ['plus', 'minus']
      : [side];
  let plus = doc.corners.plus;
  let minus = doc.corners.minus;
  for (const s of sides) {
    const radii = s === 'minus' ? minus : plus;
    if (radii === undefined || corner >= radii.length) continue;
    const to = hold(radius, rangeOf(s, corner));
    if (radii[corner] === to) continue;
    const next = radii.map((r, i) => (i === corner ? to : r));
    if (s === 'minus') minus = next;
    else plus = next;
  }
  if (plus === doc.corners.plus && minus === doc.corners.minus) return doc;
  return {
    ...doc,
    corners: { ...doc.corners, plus, ...(minus === undefined ? {} : { minus }) },
  };
}
