// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Where the Tail step's drawing puts things, with no React: the box the plan is zoomed to, the round handle of each corner
 * and how far a pointer has moved it, and the handle of the tail's width. Everything is in board cm (the chain's frame, the
 * tail at x = 0, the plus side at y >= 0) until a handle is placed; the overlay maps the places to the pane.
 *
 * **A radius handle** stands on the line from its corner to the centre of the arc that rounds it, as far out as the
 * far side of that arc, so it moves outward as the radius grows; where that is nearer the corner than
 * the layout's `reach` on the screen (a small radius, or a plan zoomed far out) it stands that far, so it never covers the
 * corner's own point. Where its square would overlap another handle's, it stands further out along the same line
 * ({@link placeRadiusHandles}): under a fingertip's 44 px squares the handles of a small tail are close, and a press must
 * land on one handle and no other. Dragging it is relative: the radius grows by how far the pointer has moved along that
 * line, from where it took hold, at the rate the arc's own geometry gives (the far side stands `1 + 1 / cos(turn / 2)` radii
 * from the corner), so it does not jump under the pointer.
 */
import type { RailsBoard } from '@openshaper/board2';
import type { Bounds } from '@openshaper/render2d';
import {
  TAIL_ZONE_SHARE,
  halfWidthFn,
  isNotchedShape,
  railKnotIndex,
  tailShapeOf,
  tailWidthPoint,
  tailWidthRange,
  type TailCorner,
  type TailShapeId,
  type TailSide,
} from '@openshaper/store/rails';

/**
 * How far in from the tail the plan is shown, in tail zones: the tail zone is the share of the board's length the tail
 * takes (`TAIL_ZONE_SHARE`), and the shapes' corners, a squash's flare and a pin's sides all lie within two of them.
 */
export const FRAME_ZONES = 2.2;
/** A notch is shown with this many notch depths of board beside it. */
export const FRAME_NOTCH_DEPTHS = 1.4;
/** How far behind the tail the plan reaches, as a share of how far in it does. */
export const FRAME_BEHIND = 0.1;
/**
 * Where, in tail zones in from the tail, the board's half width is read to set the plan's height (the tail's own knots and
 * its width handle are read too): half way through the zone, where a squash has flared out of its corners and a round has
 * not yet reached its width.
 */
export const FRAME_HEIGHT_AT = 0.5;

/**
 * The plan's height, as a share more than what the tail takes across the board: for a shape, the half width at the middle of its
 * range; for a tail drawn by hand, the greater of the board's half width read at {@link FRAME_HEIGHT_AT} and its own knots. The rail
 * runs off the pane's edges, and the share leaves room outside the corners for the width handle that stands there.
 */
export const FRAME_HEIGHT_SHARE = 1.35;

/**
 * The box the Tail step's drawing frames: the tail end and the board as far in as the tail's shape takes, derived from
 * the board's own length (the tail zone), the width a shape has in the middle of its range and a notch's depth. The same either
 * side of the stringer.
 */
export function tailFrame(doc: RailsBoard): Bounds {
  const plus = doc.outline.plus;
  const length = plus.knots[plus.knots.length - 1]!.p[0];
  const zone = TAIL_ZONE_SHARE * length;
  const notch = Math.max(0, plus.knots[0]!.p[0]);
  const xEnd = Math.max(FRAME_ZONES * zone, FRAME_NOTCH_DEPTHS * notch);
  const sides = doc.outline.minus === undefined ? ['plus' as const] : (['plus', 'minus'] as const);
  let half = 0;
  for (const side of sides) {
    const chain = side === 'minus' ? doc.outline.minus! : plus;
    const read = tailShapeOf(doc, side);
    if (read.shape === 'custom') {
      // a tail drawn by hand: the board's half width where it is read, and the tail's own knots, which are before the rail knot
      // (the rail knot is the board's, and may be its widest point)
      half = Math.max(
        half,
        halfWidthFn(doc.outline, side === 'minus' ? 'minus' : undefined)(FRAME_HEIGHT_AT * zone),
      );
      for (const k of chain.knots.slice(0, railKnotIndex(chain))) half = Math.max(half, k.p[1]);
    } else {
      // a shape: the half width the middle of its range gives. The box is the shape's alone, and does not follow the width
      // (nor the board's outline beside the tail, which is the tail's own curve) as it is dragged: the plan would rescale under
      // the hand. It holds the handles at the widths in between.
      const range = tailWidthRange(doc, read.shape, side);
      half = Math.max(half, (range.min + range.max) / 4);
    }
  }
  const tall = FRAME_HEIGHT_SHARE * half;
  return { minX: -FRAME_BEHIND * xEnd, maxX: xEnd, minY: -tall, maxY: tall };
}

/** How far (px) outside the place the width is measured its handle stands, so that the outline's own point there stays grabbable. */
export const WIDTH_HANDLE_OFFSET_PX = 22;

/** The least distance (px) from its corner a radius handle stands on the screen under a mouse. */
export const HANDLE_MIN_PX = 22;

/** A place on the pane, in px. */
export interface Spot {
  readonly x: number;
  readonly y: number;
}

/**
 * How the handles are laid out for the pointer in use. `target` is the side (px) of a handle's square, which is what a press
 * lands on: the 24 px of a mouse's button, a fingertip's 44. `reach` is the least distance (px) a radius handle stands from its
 * corner, so that the square leaves the corner's own point free: the editor takes that point within 8 px of a mouse and 22 px
 * of a finger, and half a square more (12 px, 22 px) is how far out the square's edge then is.
 */
export interface HandleLayout {
  readonly target: number;
  readonly reach: number;
}
export const FINE_HANDLES: HandleLayout = { target: 24, reach: HANDLE_MIN_PX };
export const COARSE_HANDLES: HandleLayout = { target: 44, reach: 44 };

/** The largest turn (radians) a corner's geometry is taken at: the arc's centre is a long way off as the turn nears a half circle. */
const TURN_CAP = (170 * Math.PI) / 180;

/** The distance (cm) from a corner to the far side of the arc that rounds it, `radius` and `turn` being its own. */
export const ringDistance = (radius: number, turn: number): number =>
  radius * (1 / Math.cos(Math.min(turn, TURN_CAP) / 2) + 1);

/** How much radius (cm) each cm of the far side's distance from the corner is. */
export const radiusPerDistance = (turn: number): number =>
  1 / (1 / Math.cos(Math.min(turn, TURN_CAP) / 2) + 1);

/** How far (cm) from its corner the handle stands, at a plan of `scale` pixels to the cm, before any pushing out for others. */
export const handleDistance = (
  radius: number,
  turn: number,
  scale: number,
  reach: number = HANDLE_MIN_PX,
): number => Math.max(ringDistance(radius, turn), reach / scale);

/**
 * The radius after the pointer, which took hold of the handle at `grabDistance` along the corner's line while the
 * radius was `grabRadius`, has moved to `distance` along it. Not held to a range: the store holds it.
 */
export const draggedRadius = (
  grabRadius: number,
  grabDistance: number,
  distance: number,
  turn: number,
): number => grabRadius + (distance - grabDistance) * radiusPerDistance(turn);

/** A corner as it stands on the plan: the chain's frame is mirrored for the minus side's image. */
export interface CornerImage {
  readonly corner: TailCorner;
  /** +1 for the image on the plus side of the stringer, -1 for the one below it. */
  readonly sign: 1 | -1;
  /** A name that is the same for the same image after every edit. */
  readonly key: string;
  /** The corner's own point, in board cm. */
  readonly vertex: readonly [number, number];
  /** The unit direction from it towards the centre of its arc, in board cm. */
  readonly axis: readonly [number, number];
}

/**
 * Where each corner of the tail stands on the plan. A mirror board's corner is on both sides of the stringer (the
 * one radius moves both), an asymmetric board's on its own, and the notch crotch or the tail point on the stringer.
 */
export function cornerImages(
  corners: readonly TailCorner[],
  mirror: boolean,
): readonly CornerImage[] {
  const out: CornerImage[] = [];
  for (const corner of corners) {
    const signs: readonly (1 | -1)[] =
      corner.side === 'tail' ? [1] : corner.side === 'minus' ? [-1] : mirror ? [1, -1] : [1];
    for (const sign of signs) {
      out.push({
        corner,
        sign,
        key: `${corner.side}:${corner.index}:${sign}`,
        vertex: [corner.point[0], sign * corner.point[1]],
        axis: [corner.toCenter[0], sign * corner.toCenter[1]],
      });
    }
  }
  return out;
}

/** How far (cm) a pointer at `at` is from a corner along its line. */
export const distanceAlong = (
  image: Pick<CornerImage, 'vertex' | 'axis'>,
  at: readonly [number, number],
): number => (at[0] - image.vertex[0]) * image.axis[0] + (at[1] - image.vertex[1]) * image.axis[1];

/** The handle of a tail's width on one side: where it stands, the side it edits and the sign of its image. */
export interface WidthImage {
  readonly key: string;
  readonly shape: TailShapeId;
  /** The side an edit reaches: undefined for both (a mirror board's). */
  readonly side: TailSide | undefined;
  readonly sign: 1 | -1;
  /** Where the width is measured, in board cm. */
  readonly point: readonly [number, number];
  /** The width there (cm, the whole width across). */
  readonly width: number;
}

/**
 * The handles of the tail's width: one on each side of the stringer where the tail has a width of its own (a Custom tail has
 * none, and its points are its handles). On a mirror board both move the one width; on an asymmetric board each moves its side.
 */
export function widthImages(doc: RailsBoard): readonly WidthImage[] {
  const out: WidthImage[] = [];
  const asym = doc.outline.minus !== undefined;
  for (const side of asym ? (['plus', 'minus'] as const) : (['plus'] as const)) {
    const read = tailShapeAtSide(doc, side);
    const point = tailWidthPoint(doc, side);
    if (read === null || point === null) continue;
    const signs: readonly (1 | -1)[] = asym ? [side === 'minus' ? -1 : 1] : [1, -1];
    for (const sign of signs) {
      out.push({
        key: `${side}:${sign}`,
        shape: read.shape,
        side: asym ? side : undefined,
        sign,
        point: [point[0], sign * point[1]],
        width: read.width,
      });
    }
  }
  return out;
}

/** Whether the squares, `size` px on a side, of two handles centred at `a` and `b` overlap. */
export const squaresOverlap = (a: Spot, b: Spot, size: number): boolean =>
  Math.abs(a.x - b.x) < size && Math.abs(a.y - b.y) < size;

/** Where a width handle stands on the pane, and the place its width is measured, which its tether joins it to. */
export function widthSpot(
  image: Pick<WidthImage, 'point' | 'sign'>,
  toPane: (p: { x: number; y: number }) => Spot,
): { readonly measured: Spot; readonly at: Spot } {
  const measured = toPane({ x: image.point[0], y: image.point[1] });
  // outside the board, in line with where the width is measured: the outline's own point is there
  const outside = toPane({ x: image.point[0], y: image.point[1] + image.sign });
  const length = Math.hypot(outside.x - measured.x, outside.y - measured.y) || 1;
  return {
    measured,
    at: {
      x: measured.x + ((outside.x - measured.x) / length) * WIDTH_HANDLE_OFFSET_PX,
      y: measured.y + ((outside.y - measured.y) / length) * WIDTH_HANDLE_OFFSET_PX,
    },
  };
}

/** The furthest (px) a radius handle is pushed out past its place to clear the others. */
export const PUSH_LIMIT_PX = 66;
/** The steps (px) it is pushed out by. */
const PUSH_STEP_PX = 4;
/** The steps (radians) it may turn from its line to the arc's centre, up to three each way: it stays in front of its corner. */
const TURN_STEP = Math.PI / 6;
const TURNS: readonly number[] = [0, 1, -1, 2, -2, 3, -3].map((k) => k * TURN_STEP);

/** The size (px) of the pane the handles stand on. */
export interface PaneSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Where each radius handle stands on the pane, the corners taken in order and the width handles (`fixed`, where they stand)
 * already there. A handle stands at its own place, {@link handleDistance} from its corner on the line to the centre of its arc,
 * unless a square is already there. It is then moved to the nearest place to its own, on that line pushed further out
 * ({@link PUSH_STEP_PX} at a time up to {@link PUSH_LIMIT_PX}) or on a line turned from it ({@link TURN_STEP}, up to a quarter
 * turn), where its square overlaps no other. Where a narrow tail on a short pane leaves none, it takes the nearest where its
 * centre is clear of every other square, so that each handle can still be pressed where it is drawn and the squares overlap at their edges only. A
 * handle stays on its corner's side of the stringer and inside the pane. Where even that is not to be had it stays at its own
 * place: the pane is too small for the handles. The tether from the corner shows whose it is wherever it stands, and a
 * drag is read along the corner's own line, so a handle that stands off it moves the radius as it always did.
 */
export function placeRadiusHandles(
  images: readonly CornerImage[],
  toPane: (p: { x: number; y: number }) => Spot,
  scale: number,
  layout: HandleLayout,
  fixed: readonly Spot[],
  pane: PaneSize,
): ReadonlyMap<string, Spot> {
  const taken: Spot[] = [...fixed];
  const out = new Map<string, Spot>();
  const stringer = toPane({ x: 0, y: 0 }).y;
  const half = layout.target / 2;
  const clearOf = (spot: Spot, size: number): boolean =>
    taken.every((t) => !squaresOverlap(spot, t, size));
  for (const image of images) {
    const corner = toPane({ x: image.vertex[0], y: image.vertex[1] });
    const along = toPane({
      x: image.vertex[0] + image.axis[0],
      y: image.vertex[1] + image.axis[1],
    });
    const length = Math.hypot(along.x - corner.x, along.y - corner.y) || 1;
    const line = { x: (along.x - corner.x) / length, y: (along.y - corner.y) / length };
    const nominal =
      handleDistance(image.corner.radius, image.corner.turn, scale, layout.reach) * scale;
    const home: Spot = { x: corner.x + line.x * nominal, y: corner.y + line.y * nominal };
    // a corner off the stringer keeps its handle on its own side of it
    const side = Math.abs(corner.y - stringer) < 1e-9 ? 0 : Math.sign(corner.y - stringer);
    const places: { spot: Spot; cost: number }[] = [];
    for (const turn of TURNS) {
      const c = Math.cos(turn);
      const s = Math.sin(turn);
      const to = { x: line.x * c - line.y * s, y: line.x * s + line.y * c };
      for (let d = nominal; d <= nominal + PUSH_LIMIT_PX + 1e-9; d += PUSH_STEP_PX) {
        const spot: Spot = { x: corner.x + to.x * d, y: corner.y + to.y * d };
        const inside =
          spot.x >= half &&
          spot.x <= pane.width - half &&
          spot.y >= half &&
          spot.y <= pane.height - half;
        if (inside && (side === 0 || Math.sign(spot.y - stringer) === side)) {
          places.push({ spot, cost: Math.hypot(spot.x - home.x, spot.y - home.y) });
        }
      }
    }
    // the nearest place to its own that is clear: the shortest tether
    places.sort((a, b) => a.cost - b.cost);
    const chosen =
      places.find((p) => clearOf(p.spot, layout.target))?.spot ??
      places.find((p) => clearOf(p.spot, half))?.spot ??
      home;
    out.set(image.key, chosen);
    taken.push(chosen);
  }
  return out;
}

function tailShapeAtSide(
  doc: RailsBoard,
  side: TailSide,
): { shape: TailShapeId; width: number } | null {
  const read = tailShapeOf(doc, side);
  return read.shape === 'custom' || read.width === null
    ? null
    : { shape: read.shape, width: read.width };
}

/** What a notched shape's width handle is for: the tip; named for the panel's tooltip. */
export const widthHandleName = (shape: TailShapeId): string =>
  isNotchedShape(shape) ? 'Tail width, tip to tip' : 'Tail width';
