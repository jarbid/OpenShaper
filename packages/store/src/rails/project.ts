// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The classic projection of a rails board: what the panes, the inspector, the locks and the
 * context menus edit (`BoardState.board`), so none of them changes.
 *
 * - **Lines.** The outline (plus half), rocker and deck are the section store's pieces
 *   (`chainToSpline`, `deckToSpline`), the same objects for the same chains.
 * - **Station curves** ({@link RailsProjection}`.stationCurves`). Each station's bottom and deck
 *   curve, scaled from (u, v) to cm in the section's frame: `u` by the half width at the station
 *   (the outline with a notch filled in), `v` by the thickness (deck line over rocker). The minus
 *   half of an asymmetric board carries its own.
 * - **Closed sections** (`crossSections`): what every classic reader of a board's sections sees.
 *   The true closed section of a rails board needs the engine, so the app hands in the engine's
 *   slice at each station ({@link RailsSlices}), drawn here as straight segments. A station with no
 *   slice is drawn from its curves: the bottom curve, a straight wall at the half width up to the
 *   deck curve's end, and the deck curve back to the stringer. Classic's empty end slices bracket
 *   the list, as in every classic board: station `i` is slice `i + 1`.
 * - **Fins** pass through.
 *
 * Everything is cached by the identity of what it was made from, so the projections of two
 * documents that share a curve share its spline, and React re-renders only what changed.
 */
import type { Chain, RailsBoard } from '@openshaper/board2';
import {
  board,
  crossSection,
  knot,
  noFins,
  splineFromKnots,
  vec2,
  type BezierBoard,
  type CrossSection,
  type FinConfig,
  type Knot,
  type Spline,
} from '@openshaper/kernel';
import type { RailsProjection, StationHalf, StationSplines } from '../edits';
import { chainToSpline, deckToSpline, sectionToSlice } from '../sections/project';
import { halfWidthFn, thicknessAt } from './measure';
import type { RailsSlices, RailsStation, StationCurves } from './types';

type Side = 'plus' | 'minus';

const lengthOf = (c: Chain): number => c.knots[c.knots.length - 1]!.p[0];

// ---------------------------------------------------------------------------
// Station curves
// ---------------------------------------------------------------------------

/** A station curve in (u, v) as a spline in cm: `u` times the half width `w`, `v` times the thickness `T`. */
export const curveToSpline = (chain: Chain, w: number, T: number): Spline =>
  sectionToSlice({ chain, apex: 0 }, w, T);

/**
 * A station curve's spline in cm back in (u, v): divided by the `w` and `T` it was scaled by. The
 * first knot's in handle and the last knot's out handle are unused and sit on their points, as in
 * every chain.
 */
export function splineToCurve(spline: Spline, w: number, T: number): Chain {
  const n = spline.knots.length;
  const norm = (v: { readonly x: number; readonly y: number }) => [v.x / w, v.y / T] as const;
  return {
    knots: spline.knots.map((k, i) => {
      const p = norm(k.end);
      const lock =
        k.lock === undefined
          ? undefined
          : {
              ...(k.lock.prev === undefined
                ? {}
                : { prev: [k.lock.prev.x, k.lock.prev.y] as const }),
              ...(k.lock.next === undefined
                ? {}
                : { next: [k.lock.next.x, k.lock.next.y] as const }),
            };
      return {
        p,
        in: i === 0 ? p : norm(k.tangentToPrev),
        out: i === n - 1 ? p : norm(k.tangentToNext),
        smooth: k.continuous,
        ...(lock === undefined ? {} : { lock }),
      };
    }),
  };
}

// One cache per side: an asymmetric board starts with both sides sharing every curve object, and the
// two sides' widths part as soon as an outline is edited.
const entries = {
  plus: new WeakMap<StationCurves, StationSplines>(),
  minus: new WeakMap<StationCurves, StationSplines>(),
};
const splines = {
  plus: new WeakMap<Chain, { readonly w: number; readonly T: number; readonly spline: Spline }>(),
  minus: new WeakMap<Chain, { readonly w: number; readonly T: number; readonly spline: Spline }>(),
};

function splineOf(side: Side, chain: Chain, w: number, T: number): Spline {
  const held = splines[side].get(chain);
  if (held !== undefined && held.w === w && held.T === T) return held.spline;
  const spline = curveToSpline(chain, w, T);
  splines[side].set(chain, { w, T, spline });
  return spline;
}

function entryOf(side: Side, curves: StationCurves, w: number, T: number): StationSplines {
  const held = entries[side].get(curves);
  if (held !== undefined && held.w === w && held.T === T) return held;
  const entry: StationSplines = {
    bottom: splineOf(side, curves.bottom, w, T),
    deck: splineOf(side, curves.deck, w, T),
    w,
    T,
  };
  entries[side].set(curves, entry);
  return entry;
}

/** The curves of a station on one side: its own minus curves, or the plus ones on a mirror board. */
export const curvesOf = (st: RailsStation, side: Side): StationCurves =>
  side === 'minus' ? (st.minus ?? st.plus) : st.plus;

interface ListEntry {
  readonly outline: Chain;
  readonly rocker: Chain;
  readonly deck: Chain;
  readonly list: readonly StationSplines[];
}
const lists = {
  plus: new WeakMap<readonly RailsStation[], ListEntry>(),
  minus: new WeakMap<readonly RailsStation[], ListEntry>(),
};

/** The station curves of one side of a document, one entry per station. */
export function stationSplines(doc: RailsBoard, side: Side): readonly StationSplines[] {
  const outline = side === 'minus' ? (doc.outline.minus ?? doc.outline.plus) : doc.outline.plus;
  const held = lists[side].get(doc.stations);
  if (
    held !== undefined &&
    held.outline === outline &&
    held.rocker === doc.rocker &&
    held.deck === doc.deck
  ) {
    return held.list;
  }
  const width = halfWidthFn(doc.outline, side === 'minus' ? 'minus' : undefined);
  const list = doc.stations.map((st) =>
    entryOf(side, curvesOf(st, side), width(st.x), thicknessAt(doc.rocker, doc.deck, st.x)),
  );
  lists[side].set(doc.stations, { outline, rocker: doc.rocker, deck: doc.deck, list });
  return list;
}

// ---------------------------------------------------------------------------
// Closed sections
// ---------------------------------------------------------------------------

const third = (from: { x: number; y: number }, to: { x: number; y: number }) =>
  vec2(from.x + (to.x - from.x) / 3, from.y + (to.y - from.y) / 3);

const standIns = new WeakMap<StationSplines, Spline>();

/**
 * A station's closed section drawn from its curves alone: the bottom curve from the stringer out,
 * a straight wall at the half width up to the deck curve's end, and the deck curve back in to the
 * stringer. Where the two ends meet there is no wall.
 */
export function standInSection(entry: StationSplines): Spline {
  let held = standIns.get(entry);
  if (held !== undefined) return held;
  const b = entry.bottom.knots;
  const d = entry.deck.knots;
  const bEnd = b[b.length - 1]!;
  const dEnd = d[d.length - 1]!;
  const knots: Knot[] = b
    .slice(0, -1)
    .map((k) => knot(k.end, k.tangentToPrev, k.tangentToNext, k.continuous));
  // the deck runs the other way: each knot's handles swap
  const reversed = d
    .slice(0, -1)
    .reverse()
    .map((k) => knot(k.end, k.tangentToNext, k.tangentToPrev, k.continuous));
  const wall = bEnd.end.x !== dEnd.end.x || bEnd.end.y !== dEnd.end.y;
  if (wall) {
    knots.push(knot(bEnd.end, bEnd.tangentToPrev, third(bEnd.end, dEnd.end), false));
    knots.push(knot(dEnd.end, third(dEnd.end, bEnd.end), dEnd.tangentToPrev, false));
  } else {
    knots.push(knot(bEnd.end, bEnd.tangentToPrev, dEnd.tangentToPrev, false));
  }
  knots.push(...reversed);
  // the open ends' unused handles sit on their points
  const first = knots[0]!;
  const last = knots[knots.length - 1]!;
  knots[0] = knot(first.end, first.end, first.tangentToNext, first.continuous);
  knots[knots.length - 1] = knot(last.end, last.tangentToPrev, last.end, last.continuous);
  held = splineFromKnots(knots);
  standIns.set(entry, held);
  return held;
}

const polylines = new WeakMap<readonly number[], Spline | null>();

/**
 * A slice polyline `[y0, z0, y1, z1, …]` as a spline of straight segments (each handle a third of
 * the way along its segment, every knot a corner). Repeated points are dropped. Null for fewer than
 * two distinct points or a number that is not finite.
 */
export function polylineSpline(flat: readonly number[]): Spline | null {
  if (polylines.has(flat)) return polylines.get(flat)!;
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const p = vec2(flat[i]!, flat[i + 1]!);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      polylines.set(flat, null);
      return null;
    }
    const prev = pts[pts.length - 1];
    if (prev === undefined || prev.x !== p.x || prev.y !== p.y) pts.push(p);
  }
  const spline =
    pts.length < 2
      ? null
      : splineFromKnots(
          pts.map((p, i) =>
            knot(
              vec2(p.x, p.y),
              i === 0 ? vec2(p.x, p.y) : third(p, pts[i - 1]!),
              i === pts.length - 1 ? vec2(p.x, p.y) : third(p, pts[i + 1]!),
              false,
            ),
          ),
        );
  polylines.set(flat, spline);
  return spline;
}

const dummy = (position: number): CrossSection =>
  crossSection(position, splineFromKnots([knot(vec2(0, 0), vec2(0, 0), vec2(0, 0), true)]));

interface SectionsEntry {
  readonly slices: RailsSlices | null;
  readonly length: number;
  readonly list: readonly CrossSection[];
}
const sectionLists = {
  plus: new WeakMap<readonly StationSplines[], SectionsEntry>(),
  minus: new WeakMap<readonly StationSplines[], SectionsEntry>(),
};

function crossSectionsOf(
  side: Side,
  doc: RailsBoard,
  curves: readonly StationSplines[],
  slices: RailsSlices | null,
): readonly CrossSection[] {
  const length = lengthOf(doc.outline.plus);
  const held = sectionLists[side].get(curves);
  // the curve list is one per stations array (with its outline, rocker and deck), so it fixes
  // the stations' ids and places too
  if (held !== undefined && held.slices === slices && held.length === length) return held.list;
  const list: CrossSection[] = [dummy(0)];
  doc.stations.forEach((st, i) => {
    const flat = slices?.[st.id]?.[side];
    const slice = flat === undefined ? null : polylineSpline(flat);
    list.push(crossSection(st.x, slice ?? standInSection(curves[i]!)));
  });
  list.push(dummy(length));
  sectionLists[side].set(curves, { slices, length, list });
  return list;
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

const NO_FINS: FinConfig = noFins();

const boards = new WeakMap<
  RailsBoard,
  { readonly slices: RailsSlices | null; readonly board: RailsProjection }
>();

function half(
  side: Side,
  doc: RailsBoard,
  outline: Spline,
  rocker: Spline,
  deck: Spline,
  fins: FinConfig,
  slices: RailsSlices | null,
): StationHalf {
  const stationCurves = stationSplines(doc, side);
  const b: BezierBoard = board(
    outline,
    rocker,
    deck,
    crossSectionsOf(side, doc, stationCurves, slices),
    'controlPoint',
    fins,
  );
  return { ...b, stationCurves };
}

/**
 * The classic board a rails board projects to, memoised per document and slices. An asymmetric
 * board projects its plus half as the board and its minus half as `minus`, a second board over
 * the same rocker, deck and fins with the minus outline, curves and slices.
 */
export function projectRails(doc: RailsBoard, slices?: RailsSlices | null): RailsProjection {
  const s = slices ?? null;
  const held = boards.get(doc);
  if (held !== undefined && held.slices === s) return held.board;
  const rocker = chainToSpline(doc.rocker);
  const deck = deckToSpline(doc.deck, doc.rocker, lengthOf(doc.outline.plus));
  const fins = doc.fins == null ? NO_FINS : (doc.fins as unknown as FinConfig);
  const plus = half('plus', doc, chainToSpline(doc.outline.plus), rocker, deck, fins, s);
  const b: RailsProjection =
    doc.outline.minus === undefined
      ? plus
      : {
          ...plus,
          minus: half('minus', doc, chainToSpline(doc.outline.minus), rocker, deck, fins, s),
        };
  boards.set(doc, { slices: s, board: b });
  return b;
}
