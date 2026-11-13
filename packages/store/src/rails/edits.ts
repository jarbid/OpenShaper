// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Pure edits of a rails board. Each takes a `RailsBoard` and returns one; every part an edit does
 * not touch (a `Chain`, a station's curves, a station, a rail key list) is passed through **by
 * reference**, so the engine's caches stay warm. An edit that changes nothing returns the board
 * itself.
 *
 * The line and curve editors do not change a chain by hand. The store projects the board to a
 * classic board (`project.ts`), applies the classic spline edit and junction rules
 * (`board-actions.ts`), and {@link applyRailsEdit} writes back whichever curves changed.
 */
import type { Chain, JsonValue, KeyedCurve, Pair, RailsBoard } from '@openshaper/board2';
import { RADIUS_TAIL } from '@openshaper/board2/defaults';
import type { BezierBoard } from '@openshaper/kernel';
import { stationCurvesOf, type StationSplines } from '../edits';
import { MIN_STATIONS, alignEnds, sameSlice, scalePlan } from '../sections/edits';
import { splineToChain, splineToDeckChain } from '../sections/project';
import { splineToCurve } from './project';
import {
  sliceOfStation,
  stationOfSlice,
  type RailKey,
  type RailsStation,
  type StationCurves,
} from './types';

const lengthOf = (c: Chain): number => c.knots[c.knots.length - 1]!.p[0];

// ---------------------------------------------------------------------------
// Corners
// ---------------------------------------------------------------------------

/** Indices of a chain's corner knots: the interior knots that are not smooth, tail to nose. */
export function cornerKnots(chain: Chain): number[] {
  const out: number[] = [];
  for (let k = 1; k < chain.knots.length - 1; k++) if (!chain.knots[k]!.smooth) out.push(k);
  return out;
}

const samePair = (a: readonly number[], b: readonly number[]): boolean =>
  a[0] === b[0] && a[1] === b[1];

/**
 * For each knot of `now`, the index of the same knot in `was`, or -1 for a new one. With equal
 * counts the knots pair up in order (an edit moved them). Otherwise knots were inserted or
 * deleted, which leaves every other knot's point where it was: they pair up from the front while
 * their points agree, then from the back, and what is left in between is new.
 */
export function matchChainKnots(was: Chain, now: Chain): number[] {
  const a = was.knots;
  const b = now.knots;
  if (a.length === b.length) return b.map((_, i) => i);
  const n = Math.min(a.length, b.length);
  let head = 0;
  while (head < n && samePair(a[head]!.p, b[head]!.p)) head++;
  let tail = 0;
  while (tail < n - head && samePair(a[a.length - 1 - tail]!.p, b[b.length - 1 - tail]!.p)) tail++;
  return b.map((_, i) => (i < head ? i : i >= b.length - tail ? i - b.length + a.length : -1));
}

/**
 * The corner radii of one side after its outline chain went from `was` to `now`: a corner knot of
 * `now` that `match` pairs with a corner knot of `was` keeps that corner's radius, and any other
 * takes `fresh` (the default corner radius). `radii` itself when nothing changed.
 */
export function remapCorners(
  was: Chain,
  now: Chain,
  radii: readonly number[],
  match: readonly number[],
  fresh = RADIUS_TAIL,
): readonly number[] {
  const place = new Map(cornerKnots(was).map((k, j) => [k, j]));
  const next = cornerKnots(now).map((i) => {
    const j = place.get(match[i] ?? -1);
    return j === undefined ? fresh : (radii[j] ?? fresh);
  });
  return next.length === radii.length && next.every((r, i) => r === radii[i]) ? radii : next;
}

/** `doc` with the corners of `side` following its outline from `was` to `now` (knots matched by place). */
function cornersAfter(
  doc: RailsBoard,
  side: 'plus' | 'minus',
  was: Chain,
  now: Chain,
): RailsBoard['corners'] {
  const radii = side === 'minus' ? doc.corners.minus : doc.corners.plus;
  if (radii === undefined) return doc.corners;
  const next = remapCorners(was, now, radii, matchChainKnots(was, now));
  return next === radii ? doc.corners : { ...doc.corners, [side]: next };
}

// ---------------------------------------------------------------------------
// Along the board
// ---------------------------------------------------------------------------

const scaleKeys = (c: KeyedCurve, f: number): KeyedCurve => ({
  keys: c.keys.map((k) => ({ ...k, s: k.s * f })),
});

/** Each side's rail keys mapped by `fn`; a minus list shared with the plus list stays shared. */
function mapRails(doc: RailsBoard, fn: (k: RailKey) => RailKey): RailsBoard['rails'] {
  const plus = doc.rails.plus.map(fn);
  const minus = doc.rails.minus;
  return {
    plus,
    ...(minus === undefined ? {} : { minus: minus === doc.rails.plus ? plus : minus.map(fn) }),
  };
}

/**
 * The board stretched along its length by `f`: every station, rail key and bottom-feature key
 * moves with it. The curves are normalised and stay as they are.
 */
export function scaleRailsLength(doc: RailsBoard, f: number): RailsBoard {
  if (f === 1) return doc;
  return {
    ...doc,
    stations: doc.stations.map((s) => ({ ...s, x: s.x * f })),
    rails: mapRails(doc, (k) => ({ ...k, x: k.x * f })),
    features: doc.features.map((ft) => ({ ...ft, depth: scaleKeys(ft.depth, f) })),
  };
}

/**
 * The rails scaled across the board by `fW`: a rail's band and tuck (cm in from the outline) scale
 * with the width; its shape numbers (the two rho, the two edge angles and the apex share) do not.
 */
export function scaleRailWidths(doc: RailsBoard, fW: number): RailsBoard {
  if (fW === 1) return doc;
  return {
    ...doc,
    rails: mapRails(doc, (k) => ({
      ...k,
      rail: { ...k.rail, band: k.rail.band * fW, tuck: k.rail.tuck * fW },
    })),
  };
}

// ---------------------------------------------------------------------------
// Writing an edit back
// ---------------------------------------------------------------------------

/**
 * The stations of `doc` with every station curve the edit changed written back on `side`: each is
 * divided by the half width and thickness it was projected with. A station with no width or no
 * thickness (a point or a line) has nothing to edit and is left.
 */
function writeCurves(
  doc: RailsBoard,
  before: readonly StationSplines[] | undefined,
  after: readonly StationSplines[] | undefined,
  side: 'plus' | 'minus',
): RailsBoard {
  if (before === undefined || after === undefined || before === after) return doc;
  let stations: RailsStation[] | null = null;
  for (let i = 0; i < doc.stations.length; i++) {
    const was = before[i];
    const is = after[i];
    if (was === undefined || is === undefined || is === was) continue;
    const st = doc.stations[i]!;
    const old = side === 'minus' ? st.minus : st.plus;
    if (old === undefined || !(was.w > 0 && was.T > 0)) continue;
    const bottom = sameSlice(was.bottom, is.bottom)
      ? old.bottom
      : splineToCurve(is.bottom, was.w, was.T);
    const deck = sameSlice(was.deck, is.deck) ? old.deck : splineToCurve(is.deck, was.w, was.T);
    if (bottom === old.bottom && deck === old.deck) continue;
    const curves: StationCurves = { bottom, deck };
    stations ??= [...doc.stations];
    stations[i] = { ...st, [side]: curves };
  }
  return stations === null ? doc : { ...doc, stations };
}

/**
 * The board after its projection `before` was edited into the classic board `after`.
 *
 * - A curve whose spline object is the one `before` had is untouched and keeps its `Chain`.
 * - A changed outline, rocker or deck is written back (the junction pass can change more than the
 *   curve that was dragged, so all three are compared). The minus outline's ends follow the plus
 *   outline's (`alignEnds`), and the plus side's corner radii follow its corner knots.
 * - Fins are written back when they changed.
 * - A changed station curve is divided by the half width and thickness it was projected with.
 * - When the nose moved (the length changed), stations, rail keys and feature keys scale with it.
 *
 * Returns `doc` itself when nothing changed.
 */
export function applyRailsEdit(
  doc: RailsBoard,
  before: BezierBoard,
  after: BezierBoard,
): RailsBoard {
  let next = doc;
  if (after.outline !== before.outline) {
    const plus = splineToChain(after.outline);
    const minus = next.outline.minus && alignEnds(next.outline.minus, plus);
    next = {
      ...next,
      outline: { plus, ...(minus === undefined ? {} : { minus }) },
      corners: cornersAfter(doc, 'plus', doc.outline.plus, plus),
    };
  }
  if (after.bottom !== before.bottom) next = { ...next, rocker: splineToChain(after.bottom) };
  if (after.deck !== before.deck) next = { ...next, deck: splineToDeckChain(after.deck) };
  if (after.fins !== before.fins) next = { ...next, fins: after.fins as unknown as JsonValue };
  next = writeCurves(next, stationCurvesOf(before), stationCurvesOf(after), 'plus');
  if (next === doc) return doc;
  const was = lengthOf(doc.outline.plus);
  const now = lengthOf(next.outline.plus);
  if (was > 0 && now > 0 && now !== was) next = scaleRailsLength(next, now / was);
  return next;
}

/**
 * The board after the minus half of an asymmetric board (`before`, the projection's `minus`) was
 * edited into `after`. Only the minus outline (its ends held on the plus outline's), its corner
 * radii and the minus station curves are written back: the rocker, deck, features and fins are
 * shared with the plus half and are the plus half's to edit. Returns `doc` itself when nothing changed.
 */
export function applyRailsMinusEdit(
  doc: RailsBoard,
  before: BezierBoard,
  after: BezierBoard,
): RailsBoard {
  if (doc.outline.minus === undefined) return doc;
  let next = doc;
  if (after.outline !== before.outline) {
    const minus = alignEnds(splineToChain(after.outline), doc.outline.plus);
    next = {
      ...next,
      outline: { ...next.outline, minus },
      corners: cornersAfter(doc, 'minus', doc.outline.minus, minus),
    };
  }
  return writeCurves(next, stationCurvesOf(before), stationCurvesOf(after), 'minus');
}

/** The minus outline of a board being resized: the old one scaled, with its ends on the new plus outline. */
export const scaledMinus = (was: Chain, plus: Chain, fL: number, fW: number): Chain =>
  alignEnds(scalePlan(was, fL, fW), plus);

// ---------------------------------------------------------------------------
// Stations
// ---------------------------------------------------------------------------

/** Stations stay at least this far (cm) from each other and from the ends, as the section store keeps them. */
const STATION_GAP = 1e-3;

const stationIdFor = (stations: readonly RailsStation[]): string => {
  const ids = new Set(stations.map((s) => s.id));
  for (let n = stations.length + 1; ; n++) {
    const id = `s${n}`;
    if (!ids.has(id)) return id;
  }
};

const lerp = (a: Pair, b: Pair, t: number): Pair => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
];

/**
 * The curve a station added between two others takes: where both neighbours' curves have the same
 * number of knots, each point and handle blended linearly by x (`t` the new station's share of the
 * way from `a` to `b`; each knot smooth only when both are); otherwise the nearer neighbour's curve
 * itself.
 */
function blendCurve(a: Chain, b: Chain, t: number): Chain {
  if (a.knots.length !== b.knots.length) return t <= 0.5 ? a : b;
  if (a === b) return a;
  return {
    knots: a.knots.map((ka, i) => {
      const kb = b.knots[i]!;
      return {
        p: lerp(ka.p, kb.p, t),
        in: lerp(ka.in, kb.in, t),
        out: lerp(ka.out, kb.out, t),
        smooth: ka.smooth && kb.smooth,
      };
    }),
  };
}

function blendCurves(a: StationCurves, b: StationCurves, t: number): StationCurves {
  if (a === b) return a;
  const bottom = blendCurve(a.bottom, b.bottom, t);
  const deck = blendCurve(a.deck, b.deck, t);
  return bottom === a.bottom && deck === a.deck
    ? a
    : bottom === b.bottom && deck === b.deck
      ? b
      : { bottom, deck };
}

/**
 * A station added at `x`. Its curves on each side are its neighbours' blended by x
 * ({@link blendCurve}); beyond the first or last station, that station's. Returns the new board and
 * the station's classic slice index (station index + 1), or null for an x outside the board, on top
 * of a station, or on a board with no station to take curves from.
 */
export function addStation(
  doc: RailsBoard,
  x: number,
): { readonly doc: RailsBoard; readonly index: number } | null {
  const xi0 = doc.outline.plus.knots[0]!.p[0];
  const L = lengthOf(doc.outline.plus);
  if (!(x > xi0 + STATION_GAP && x < L - STATION_GAP)) return null;
  if (doc.stations.length === 0) return null;
  if (doc.stations.some((s) => Math.abs(s.x - x) < STATION_GAP)) return null;
  const at = doc.stations.findIndex((s) => s.x > x);
  const index = at < 0 ? doc.stations.length : at;
  const lo = doc.stations[index - 1] ?? doc.stations[index]!;
  const hi = doc.stations[index] ?? lo;
  const t = hi.x > lo.x ? (x - lo.x) / (hi.x - lo.x) : 0;
  const plus = blendCurves(lo.plus, hi.plus, t);
  const minus =
    doc.symmetry === 'asymmetric' && lo.minus !== undefined && hi.minus !== undefined
      ? blendCurves(lo.minus, hi.minus, t)
      : undefined;
  const station: RailsStation = {
    id: stationIdFor(doc.stations),
    x,
    plus,
    ...(minus === undefined ? {} : { minus }),
  };
  const stations = [...doc.stations.slice(0, index), station, ...doc.stations.slice(index)];
  return { doc: { ...doc, stations }, index: sliceOfStation(index) };
}

/** The board without station `index` (classic slice index; the end dummies are not stations). */
export function removeStation(doc: RailsBoard, index: number): RailsBoard {
  const i = stationOfSlice(index, doc.stations.length);
  if (i === null || doc.stations.length <= MIN_STATIONS) return doc;
  return { ...doc, stations: doc.stations.filter((_, j) => j !== i) };
}

/**
 * Station `index` (classic slice index) moved to `x`, held between its neighbours (or the ends of
 * the board) so a drag never starts editing one station and finishes editing another. Its curves
 * are untouched: they are normalised, so they take the width and thickness of their new place.
 */
export function moveStation(doc: RailsBoard, index: number, x: number): RailsBoard {
  const i = stationOfSlice(index, doc.stations.length);
  const st = i === null ? undefined : doc.stations[i];
  if (i === null || st === undefined || !Number.isFinite(x)) return doc;
  const lo = (doc.stations[i - 1]?.x ?? doc.outline.plus.knots[0]!.p[0]) + STATION_GAP;
  const hi = (doc.stations[i + 1]?.x ?? lengthOf(doc.outline.plus)) - STATION_GAP;
  if (lo > hi) return doc;
  const to = Math.min(hi, Math.max(lo, x));
  if (to === st.x) return doc;
  return { ...doc, stations: doc.stations.map((s, j) => (j === i ? { ...s, x: to } : s)) };
}
