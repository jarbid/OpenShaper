// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The board-shape edits of a rails board: symmetry, tail type and notch depth. Pure functions of a
 * `RailsBoard`; every part an edit does not touch is passed through by reference.
 *
 * **Tails.** The outline surgery is the section store's (`sections/shape.ts`): a standard tail
 * starts at the tip (0, 0); a notched tail (swallow, fish) starts at the notch bottom (d, 0) on the
 * stringer, runs along the inner wall to the corner tip (0, w) and on along the outer rail. A rails
 * board stores no tail: it is notched when its outline's first knot lies past x = 0. Its corner
 * radii follow the outline: a corner knot a tail change creates takes the default corner radius,
 * the crotch of a new notch the default crotch radius, and a tail made standard again the default
 * tail radius; every other corner keeps its own.
 */
import type { Chain, RailsBoard } from '@openshaper/board2';
import { RADIUS_CROTCH, RADIUS_TAIL } from '@openshaper/board2/defaults';
import type { ChordProvider } from '../sections/features';
import { refitFeatures } from '../sections/features';
import {
  clampDepth,
  defaultNotchDepth,
  movedNotch,
  notchedOutline,
  standardOutline,
  stationsFrom,
  tailTypeOfChain,
  tipIndex,
  type KeepSide,
  type TailType,
} from '../sections/shape';
import { remapCorners } from './edits';
import { isNotched } from './measure';
import type { RailsStation } from './types';

const lengthOf = (c: Chain): number => c.knots[c.knots.length - 1]!.p[0];
const firstX = (c: Chain): number => c.knots[0]!.p[0];

// ---------------------------------------------------------------------------
// Symmetry
// ---------------------------------------------------------------------------

/**
 * The board made asymmetric: the minus outline, corner radii, station curves and rail keys start
 * as the plus side's, **sharing the objects**. The board itself when it already is.
 */
export function toAsymmetric(doc: RailsBoard): RailsBoard {
  if (doc.symmetry === 'asymmetric') return doc;
  return {
    ...doc,
    symmetry: 'asymmetric',
    outline: { plus: doc.outline.plus, minus: doc.outline.plus },
    corners: { ...doc.corners, minus: doc.corners.plus },
    stations: doc.stations.map((s): RailsStation => ({ ...s, minus: s.plus })),
    rails: { plus: doc.rails.plus, minus: doc.rails.plus },
  };
}

/**
 * The board made mirror-symmetric, keeping the `keep` side's outline, corner radii, station curves
 * and rail keys (the objects themselves; the other side is dropped). The board itself when it
 * already is.
 */
export function toMirror(doc: RailsBoard, keep: KeepSide): RailsBoard {
  if (doc.symmetry === 'mirror') return doc;
  const useMinus = keep === 'minus' && doc.outline.minus !== undefined;
  const { minus: _corners, ...corners } = doc.corners;
  return {
    ...doc,
    symmetry: 'mirror',
    outline: { plus: useMinus ? doc.outline.minus! : doc.outline.plus },
    corners: {
      ...corners,
      plus: useMinus ? (doc.corners.minus ?? doc.corners.plus) : doc.corners.plus,
    },
    stations: doc.stations.map((s): RailsStation => {
      const { minus: m, ...rest } = s;
      return useMinus && m !== undefined ? { ...rest, plus: m } : rest;
    }),
    rails: { plus: useMinus ? (doc.rails.minus ?? doc.rails.plus) : doc.rails.plus },
  };
}

/** `setSymmetry(doc, 'mirror', keep)` keeps that side; `keep` is ignored when going asymmetric. */
export const setSymmetry = (
  doc: RailsBoard,
  symmetry: RailsBoard['symmetry'],
  keep?: KeepSide,
): RailsBoard => (symmetry === 'asymmetric' ? toAsymmetric(doc) : toMirror(doc, keep ?? 'plus'));

// ---------------------------------------------------------------------------
// Tail type
// ---------------------------------------------------------------------------

/** The tail type of a rails board: standard, or the swallow or fish its notch wall is. */
export const tailTypeOf = (doc: RailsBoard): TailType =>
  tailTypeOfChain(doc.outline.plus, isNotched(doc.outline));

/**
 * The corner radii of one side after a tail change rebuilt its outline from `was` to `now`. The
 * surgery keeps the rest of the outline's knot objects, so knots pair up by identity; a notch tip
 * that is rebuilt in place (swallow to fish, a deeper notch) pairs with the old tip.
 */
function tailCorners(was: Chain, now: Chain, radii: readonly number[]): readonly number[] {
  const match = now.knots.map((k) => was.knots.indexOf(k));
  if (now.knots[0]!.p[0] > 0 && was.knots[0]!.p[0] > 0) match[tipIndex(now)] = tipIndex(was);
  return remapCorners(was, now, radii, match, RADIUS_TAIL);
}

/** The board with its outline replaced on both sides, and the corner radii following it. */
function withOutline(
  doc: RailsBoard,
  rebuild: (c: Chain) => Chain,
  tail: number,
): Pick<RailsBoard, 'outline' | 'corners'> {
  const plus = rebuild(doc.outline.plus);
  const minus = doc.outline.minus === undefined ? undefined : rebuild(doc.outline.minus);
  const cPlus = tailCorners(doc.outline.plus, plus, doc.corners.plus);
  const cMinus =
    minus === undefined || doc.corners.minus === undefined
      ? doc.corners.minus
      : doc.corners.minus === doc.corners.plus && doc.outline.minus === doc.outline.plus
        ? cPlus
        : tailCorners(doc.outline.minus!, minus, doc.corners.minus);
  const same =
    cPlus === doc.corners.plus && cMinus === doc.corners.minus && tail === doc.corners.tail;
  return {
    outline: { plus, ...(minus === undefined ? {} : { minus }) },
    corners: same
      ? doc.corners
      : { ...doc.corners, tail, plus: cPlus, ...(cMinus === undefined ? {} : { minus: cMinus }) },
  };
}

/**
 * The board with its tail changed to `type`, as the section store changes it (`sections/shape.ts`
 * `setTail`): a notch of depth `d` (the type's default when the board is not notched yet and `d` is
 * omitted, the current depth otherwise), the stations behind the notch bottom dropped, swallow and
 * fish differing only in the wall, both sides alike. The features are squeezed into the station
 * range that is left. The board itself for no change, or when fewer than two stations would remain.
 */
export function setTail(
  doc: RailsBoard,
  type: TailType,
  d?: number,
  chords?: ChordProvider<RailsBoard>,
): RailsBoard {
  const L = lengthOf(doc.outline.plus);
  const was = tailTypeOf(doc);
  if (type === 'standard') {
    if (was === 'standard') return doc;
    const next = { ...doc, ...withOutline(doc, standardOutline, RADIUS_TAIL) };
    return { ...next, features: refitFeatures(next, chords) };
  }
  const fromStandard = was === 'standard';
  const current = fromStandard ? undefined : firstX(doc.outline.plus);
  const depth = clampDepth(d ?? current ?? defaultNotchDepth(type, L), L);
  if (!fromStandard && was === type && depth === current) return doc;
  const stations = stationsFrom(doc.stations, depth, fromStandard ? undefined : current);
  if (stations === null) return doc;
  const next: RailsBoard = {
    ...doc,
    ...withOutline(
      doc,
      (c) => notchedOutline(c, type, depth, fromStandard),
      fromStandard ? RADIUS_CROTCH : doc.corners.tail,
    ),
    stations:
      stations.length === doc.stations.length && stations.every((s, i) => s === doc.stations[i])
        ? doc.stations
        : stations,
  };
  return { ...next, features: refitFeatures(next, chords) };
}

/**
 * The notch bottom moved to depth `d` (held between 0.5% and 30% of the length), as the section
 * store moves it: the wall's x scales with it, the tail tip stays at x = 0, a station on the old
 * notch bottom follows it and stations it passes are dropped. The corner knots are the same, so
 * the radii are too. The board itself on a standard tail, for no change, or when fewer than two
 * stations would remain.
 */
export function setNotchDepth(
  doc: RailsBoard,
  d: number,
  chords?: ChordProvider<RailsBoard>,
): RailsBoard {
  if (!isNotched(doc.outline) || !Number.isFinite(d)) return doc;
  const L = lengthOf(doc.outline.plus);
  const was = firstX(doc.outline.plus);
  const depth = clampDepth(d, L);
  if (depth === was) return doc;
  const stations = stationsFrom(doc.stations, depth, was);
  if (stations === null) return doc;
  const minus = doc.outline.minus;
  const next: RailsBoard = {
    ...doc,
    outline: {
      plus: movedNotch(doc.outline.plus, depth),
      ...(minus === undefined ? {} : { minus: movedNotch(minus, depth) }),
    },
    stations,
  };
  return { ...next, features: refitFeatures(next, chords) };
}
