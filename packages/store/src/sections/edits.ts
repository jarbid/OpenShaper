// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Pure edits of a section document (docs/design/m2-editor.md §2). Each takes a `BoardDoc` and returns
 * one; every part an edit does not touch (a `Chain`, a `Section`, a `Station`) is passed through **by
 * reference**, so `buildBoard`'s fit cache stays warm: an outline, rocker or deck edit refits nothing.
 *
 * The line editors do not change a chain by hand. The store projects the document to the classic board
 * (`project.ts`), applies the classic spline edit and junction rules (`board-actions.ts`), and
 * {@link applyBoardEdit} writes back whichever curves the edit changed.
 */
import type {
  BoardDoc,
  BottomFeature,
  Chain,
  ChainKnot,
  JsonValue,
  KeyedCurve,
  Pair,
  Section,
  Station,
} from '@openshaper/board2';
import type { BezierBoard, Spline } from '@openshaper/kernel';
import { insertCrossSection, minusHalf, sectionApexIndex, type SplineTarget } from '../edits';
import {
  projectDoc,
  sliceDims,
  sliceToSection,
  splineToChain,
  splineToDeckChain,
  type NotchChords,
} from './project';

/**
 * `doc` with the chain `target` names replaced. The outline, rocker and deck, and a station's section
 * (`index` is the classic slice index, so station `index - 1`; `side: 'minus'` on an asymmetric board
 * edits the minus half). A target the document has no such chain for (a station curve, which only a
 * rails board has) returns the document itself.
 */
export function withChain(doc: BoardDoc, target: SplineTarget, chain: Chain): BoardDoc {
  switch (target.kind) {
    case 'outline':
      if (target.side === 'minus') {
        if (doc.outline.minus === undefined) return doc;
        return { ...doc, outline: { ...doc.outline, minus: chain } };
      }
      return { ...doc, outline: { ...doc.outline, plus: chain } };
    case 'bottom':
      return { ...doc, rocker: chain };
    case 'deck':
      return { ...doc, deck: chain };
    case 'crossSection': {
      const i = target.index - 1;
      const st = doc.stations[i];
      if (st === undefined) return doc;
      const key = target.side === 'minus' ? 'minus' : 'plus';
      if (key === 'minus' && st.minus === undefined) return doc;
      const section: Section = { chain, apex: st[key]!.apex };
      const stations = doc.stations.map(
        (s, j): Station => (j === i ? { ...s, [key]: section } : s),
      );
      return { ...doc, stations };
    }
    // a section document has no station curves (those are a rails board's)
    case 'stationBottom':
    case 'stationDeck':
      return doc;
  }
}

const scaleKeys = (c: KeyedCurve, f: number): KeyedCurve => ({
  keys: c.keys.map((k) => ({ ...k, s: k.s * f })),
});

/**
 * The document with the board stretched along its length by `f`: every station, and the keys of every
 * bottom feature, move with it (the end stations stay at the ends). Sections are untouched.
 */
export function scaleLength(doc: BoardDoc, f: number): BoardDoc {
  if (f === 1) return doc;
  const features = doc.features.map(
    (ft): BottomFeature => ({ ...ft, depth: scaleKeys(ft.depth, f) }),
  );
  return {
    ...doc,
    stations: doc.stations.map((s) => ({ ...s, x: s.x * f })),
    features,
  };
}

/** `chain` scaled in the plan: x by `fL`, y by `fW`. */
export function scalePlan(chain: Chain, fL: number, fW: number): Chain {
  const q = (p: Pair): Pair => [p[0] * fL, p[1] * fW];
  return { knots: chain.knots.map((k) => ({ ...k, p: q(k.p), in: q(k.in), out: q(k.out) })) };
}

const lengthOf = (c: Chain): number => c.knots[c.knots.length - 1]!.p[0];

/** Whether two splines have the same knots, handles and flags (exact). */
export const sameSlice = (a: Spline, b: Spline): boolean =>
  a === b ||
  (a.knots.length === b.knots.length &&
    a.knots.every((k, i) => {
      const o = b.knots[i]!;
      return (
        k.end.x === o.end.x &&
        k.end.y === o.end.y &&
        k.tangentToPrev.x === o.tangentToPrev.x &&
        k.tangentToPrev.y === o.tangentToPrev.y &&
        k.tangentToNext.x === o.tangentToNext.x &&
        k.tangentToNext.y === o.tangentToNext.y &&
        k.continuous === o.continuous &&
        k.lock?.prev?.x === o.lock?.prev?.x &&
        k.lock?.prev?.y === o.lock?.prev?.y &&
        k.lock?.next?.x === o.lock?.next?.x &&
        k.lock?.next?.y === o.lock?.next?.y
      );
    }));

/**
 * The section an edited slice is. The apex knot is a knot at u = 1 exactly: the old one when it still
 * is (and the knot count is unchanged), else the knot of an inserted or deleted profile that is the old
 * apex's point, else the first widest knot, as classic picks it.
 */
function sectionOfSlice(slice: Spline, was: Spline, dims: { w: number; T: number }, old: Section) {
  const { w, T } = dims;
  const widest: number[] = [];
  slice.knots.forEach((k, i) => {
    if (i > 0 && i < slice.knots.length - 1 && k.end.x >= w) widest.push(i);
  });
  let apex = widest[0] ?? sectionApexIndex(slice);
  if (slice.knots.length === was.knots.length) {
    if (widest.includes(old.apex)) apex = old.apex;
  } else {
    const wasApex = was.knots[old.apex]?.end;
    const same = widest.find(
      (i) =>
        wasApex !== undefined &&
        slice.knots[i]!.end.x === wasApex.x &&
        slice.knots[i]!.end.y === wasApex.y,
    );
    if (same !== undefined) apex = same;
  }
  const section = sliceToSection(slice, w, T, apex);
  // the widest knot sits on the apex line to rounding at most
  const k = section.chain.knots[apex];
  if (k && k.p[0] !== 1 && Math.abs(k.p[0] - 1) < 1e-9) {
    const knots = section.chain.knots.map((c, i) =>
      i === apex ? { ...c, p: [1, c.p[1]] as const } : c,
    );
    return { chain: { knots }, apex };
  }
  return section;
}

/**
 * The stations of `doc` with every slice the edit changed written back as a section of `side`. A slice is
 * divided by the half-width (chord) and thickness it was projected with, so a section edit moves one
 * `Section` and leaves every other object alone: `buildBoard` refits exactly that section.
 */
function writeSlices(
  doc: BoardDoc,
  before: BezierBoard,
  after: BezierBoard,
  side: 'plus' | 'minus' = 'plus',
): BoardDoc {
  let stations: Station[] | null = null;
  for (let i = 1; i < before.crossSections.length - 1; i++) {
    const was = before.crossSections[i]!.spline;
    const is = after.crossSections[i]?.spline;
    if (is === undefined || sameSlice(was, is)) continue;
    const dims = sliceDims(was);
    const st = doc.stations[i - 1];
    const old = st === undefined ? undefined : side === 'minus' ? st.minus : st.plus;
    // a station with no width or no thickness (a tip, a blunt end) is a point or a line: nothing to edit
    if (dims === undefined || st === undefined || old === undefined || !(dims.w > 0 && dims.T > 0))
      continue;
    stations ??= [...doc.stations];
    stations[i - 1] = { ...st, [side]: sectionOfSlice(is, was, dims, old) };
  }
  return stations === null ? doc : { ...doc, stations };
}

/**
 * `minus` with its first and last knots on the stringer points `plus` starts and ends at (the validator
 * requires both halves to meet there): the knot and its handle move by the same offset. The chain itself
 * when it already does.
 */
export function alignEnds(minus: Chain, plus: Chain): Chain {
  const n = minus.knots.length;
  const want = [plus.knots[0]!.p[0], plus.knots[plus.knots.length - 1]!.p[0]] as const;
  const dx0 = want[0] - minus.knots[0]!.p[0];
  const dx1 = want[1] - minus.knots[n - 1]!.p[0];
  if (dx0 === 0 && dx1 === 0) return minus;
  const shift = (k: ChainKnot, dx: number): ChainKnot => ({
    ...k,
    p: [k.p[0] + dx, k.p[1]],
    in: [k.in[0] + dx, k.in[1]],
    out: [k.out[0] + dx, k.out[1]],
  });
  return {
    knots: minus.knots.map((k, i) =>
      i === 0 && dx0 !== 0 ? shift(k, dx0) : i === n - 1 && dx1 !== 0 ? shift(k, dx1) : k,
    ),
  };
}

/**
 * The document after the classic board `before` (the projection of `doc`) was edited into `after`.
 *
 * - A curve whose spline object is the one `before` had is untouched and keeps its `Chain`.
 * - A changed outline, rocker or deck is written back. The edit's junction pass can change more than
 *   the curve that was dragged (a deck tip joined to the rocker's), so all three are compared.
 * - Fins are written back when they changed.
 * - A section edit (the lines untouched) writes back the slices that changed, each divided by the
 *   half-width and thickness it was projected with (`writeSlices`). A whole-board resize changes the
 *   lines too, and scales the slices with them: the normalised sections do not change, so they are left.
 * - When the nose moved (the board's length changed), the stations and feature keys scale with it.
 *
 * Returns `doc` itself when nothing changed.
 */
export function applyBoardEdit(doc: BoardDoc, before: BezierBoard, after: BezierBoard): BoardDoc {
  let next = doc;
  if (after.outline !== before.outline) {
    const plus = splineToChain(after.outline);
    // the shared end points (the nose, a notch bottom) move on both halves
    const minus = next.outline.minus && alignEnds(next.outline.minus, plus);
    next = { ...next, outline: { plus, ...(minus === undefined ? {} : { minus }) } };
  }
  if (after.bottom !== before.bottom) next = { ...next, rocker: splineToChain(after.bottom) };
  if (after.deck !== before.deck) next = { ...next, deck: splineToDeckChain(after.deck) };
  if (after.fins !== before.fins) next = { ...next, fins: after.fins as unknown as JsonValue };
  if (
    after.outline === before.outline &&
    after.bottom === before.bottom &&
    after.deck === before.deck
  ) {
    next = writeSlices(next, before, after);
  }
  if (next === doc) return doc;
  const was = lengthOf(doc.outline.plus);
  const now = lengthOf(next.outline.plus);
  if (was > 0 && now > 0 && now !== was) next = scaleLength(next, now / was);
  return next;
}

/**
 * The document after the minus half of an asymmetric board (`before`, the projection's `minus`) was edited
 * into `after`. Only the minus outline and the minus sections are written back: the rocker, deck, features
 * and fins are shared with the plus half, so they are the plus half's to edit, and the minus outline's
 * end points are held on the plus outline's (`alignEnds`). Returns `doc` itself when nothing changed.
 */
export function applyMinusEdit(doc: BoardDoc, before: BezierBoard, after: BezierBoard): BoardDoc {
  if (doc.outline.minus === undefined) return doc;
  let next = doc;
  if (after.outline !== before.outline) {
    const minus = alignEnds(splineToChain(after.outline), doc.outline.plus);
    next = { ...next, outline: { ...next.outline, minus } };
  }
  return writeSlices(next, before, after, 'minus');
}

// ---------------------------------------------------------------------------
// Stations
// ---------------------------------------------------------------------------

/** Stations stay at least this far (cm) from each other and from the ends, as classic keeps them. */
const STATION_GAP = 1e-3;

/** The fewest stations a board keeps. */
export const MIN_STATIONS = 2;

const stationIdFor = (stations: readonly Station[]): string => {
  const ids = new Set(stations.map((s) => s.id));
  for (let n = stations.length + 1; ; n++) {
    const id = `s${n}`;
    if (!ids.has(id)) return id;
  }
};

/**
 * A station added at `x`: classic's `insertCrossSection` on the projection (the surface section at x,
 * already scaled to the board's width and thickness there, so the board does not change), normalised
 * by its own width and thickness. Returns the new document and the station's classic slice index
 * (station index + 1), or null for an x outside the station range, on top of a station, or where the
 * section has no width or thickness.
 */
export function addStation(
  doc: BoardDoc,
  x: number,
  chords?: NotchChords,
): { readonly doc: BoardDoc; readonly index: number } | null {
  const xi0 = doc.outline.plus.knots[0]!.p[0];
  const L = lengthOf(doc.outline.plus);
  if (!(x > xi0 + STATION_GAP && x < L - STATION_GAP)) return null;
  if (doc.stations.some((s) => Math.abs(s.x - x) < STATION_GAP)) return null;
  const projected = projectDoc(doc, chords);
  const plus = insertedSection(projected, x);
  if (plus === null) return null;
  // an asymmetric board gets the new section from each half
  let minus: Section | undefined;
  const half = minusHalf(projected);
  if (doc.outline.minus !== undefined && half !== undefined) {
    const m = insertedSection(half, x);
    if (m === null) return null;
    minus = m;
  }
  const at = doc.stations.findIndex((s) => s.x > x);
  const index = at < 0 ? doc.stations.length : at;
  const station: Station = {
    id: stationIdFor(doc.stations),
    x,
    plus,
    ...(minus === undefined ? {} : { minus }),
  };
  const stations = [...doc.stations.slice(0, index), station, ...doc.stations.slice(index)];
  return { doc: { ...doc, stations }, index: index + 1 };
}

/** The section classic's `insertCrossSection` puts at `x` on `board`, normalised by its own width and thickness. */
function insertedSection(board: BezierBoard, x: number): Section | null {
  const result = insertCrossSection(board, x);
  if (!result) return null;
  const slice = result.board.crossSections[result.index]!.spline;
  const apex = sectionApexIndex(slice);
  if (apex < 0) return null;
  const first = slice.knots[0]!.end;
  const w = slice.knots[apex]!.end.x;
  const T = slice.knots[slice.knots.length - 1]!.end.y - first.y;
  if (!(w > 0 && T > 0)) return null;
  return sliceToSection(slice, w, T, apex, first.y);
}

/** The document without station `index` (classic slice index; the end dummies are not stations). */
export function removeStation(doc: BoardDoc, index: number): BoardDoc {
  const i = index - 1;
  if (i < 0 || i >= doc.stations.length || doc.stations.length <= MIN_STATIONS) return doc;
  return { ...doc, stations: doc.stations.filter((_, j) => j !== i) };
}

/**
 * Station `index` moved to `x`, held between its neighbours (or the ends of the station range) so a drag
 * never starts editing one station and finishes editing another. Its section is untouched.
 */
export function moveStation(doc: BoardDoc, index: number, x: number): BoardDoc {
  const i = index - 1;
  const st = doc.stations[i];
  if (st === undefined || !Number.isFinite(x)) return doc;
  const lo = (doc.stations[i - 1]?.x ?? doc.outline.plus.knots[0]!.p[0]) + STATION_GAP;
  const hi = (doc.stations[i + 1]?.x ?? lengthOf(doc.outline.plus)) - STATION_GAP;
  if (lo > hi) return doc;
  const at = Math.min(hi, Math.max(lo, x));
  if (at === st.x) return doc;
  return { ...doc, stations: doc.stations.map((s, j) => (j === i ? { ...s, x: at } : s)) };
}
