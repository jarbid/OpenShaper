// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The classic projection of a section document (docs/design/m2-editor.md §1).
 *
 * The panes, inspector, locks, Tunni controls and context menus all edit a classic `BezierBoard`
 * (`BoardState.board`). The section store keeps a `BoardDoc` and shows them this projection, so none
 * of that code changes:
 *
 * - **Lines.** The outline (plus half), rocker and deck chains map knot for knot to kernel splines
 *   (`p`, `in`, `out`, `smooth` are `end`, `tangentToPrev`, `tangentToNext`, `continuous`), exactly.
 *   Classic's deck carries a vertical wall at each end (tail and nose thickness), which the document
 *   drops (the converter does the same): the projection puts a collapsed corner knot back at the
 *   rocker's end heights, and {@link splineToDeckChain} takes it off again. Without it the junction
 *   pass would join the deck's first real knot to the rocker's tip and close the board's thickness.
 * - **Stations.** Each station becomes a physical slice `(u * w(xi), v * T(xi))`: `w` the half-width
 *   and `T` the stringer thickness at xi, the exact inverse of the converter's normalisation. Classic's
 *   dummy end slices bracket the list, so index-based code is unchanged (slice i is station i - 1).
 *   Inside a notch zone the true chord is longer than the plan half-width at x = xi: the chord comes
 *   from an injected {@link NotchChords} (board2's frame; this package may not import its code), and
 *   falls back to the plan's outer rail without one.
 * - **Fins** pass through (`doc.fins` is classic's fin configuration).
 *
 * Everything is cached by the identity of what it was made from, so an edit that touches one curve
 * gives back the same spline objects for the others, and React re-renders only what changed.
 */
import type { BoardDoc, Chain, ChainKnot, Pair, Section } from '@openshaper/board2';
import {
  board,
  crossSection,
  knot,
  knotLock,
  noFins,
  splineFromKnots,
  valueAt,
  vec2,
  widthBoundsAt,
  type BezierBoard,
  type CrossSection,
  type FinConfig,
  type Knot,
  type Spline,
} from '@openshaper/kernel';

const pairOf = (v: { readonly x: number; readonly y: number }): Pair => [v.x, v.y];

const unit = (p: Pair | undefined) => (p === undefined ? undefined : vec2(p[0], p[1]));

/** A chain knot as a kernel knot. */
export const knotOfChain = (k: ChainKnot): Knot =>
  knot(
    vec2(k.p[0], k.p[1]),
    vec2(k.in[0], k.in[1]),
    vec2(k.out[0], k.out[1]),
    k.smooth,
    false,
    k.lock && knotLock(unit(k.lock.prev), unit(k.lock.next)),
  );

/** A kernel knot as a chain knot; `first` and `last` knots have their unused handle on the point. */
const chainKnotOf = (k: Knot, first: boolean, last: boolean): ChainKnot => {
  const p = pairOf(k.end);
  const lock =
    k.lock === undefined
      ? undefined
      : {
          ...(k.lock.prev === undefined ? {} : { prev: pairOf(k.lock.prev) }),
          ...(k.lock.next === undefined ? {} : { next: pairOf(k.lock.next) }),
        };
  return {
    p,
    in: first ? p : pairOf(k.tangentToPrev),
    out: last ? p : pairOf(k.tangentToNext),
    smooth: k.continuous,
    ...(lock === undefined ? {} : { lock }),
  };
};

const chainSplines = new WeakMap<Chain, Spline>();

/** The chain as a kernel spline, one object per chain. */
export function chainToSpline(chain: Chain): Spline {
  let s = chainSplines.get(chain);
  if (s === undefined) {
    s = splineFromKnots(chain.knots.map(knotOfChain));
    chainSplines.set(chain, s);
  }
  return s;
}

/** The kernel spline as a chain; the exact inverse of {@link chainToSpline} for a chain it made. */
export function splineToChain(spline: Spline): Chain {
  const n = spline.knots.length;
  return { knots: spline.knots.map((k, i) => chainKnotOf(k, i === 0, i === n - 1)) };
}

// ---------------------------------------------------------------------------
// The deck and its end walls
// ---------------------------------------------------------------------------

interface DeckEntry {
  readonly tailY: number;
  readonly noseY: number;
  readonly length: number;
  readonly spline: Spline;
}

/** Below this (cm) a wall's x and its chain end's x are the same number, as the junction pass sees them. */
const WALL_EPS = 1e-9;
const snap = (x: number, to: number): number => (Math.abs(x - to) <= WALL_EPS ? to : x);
const deckSplines = new WeakMap<Chain, DeckEntry>();

const corner = (x: number, y: number): Knot => {
  const p = vec2(x, y);
  return knot(p, p, p, false);
};

/**
 * The deck as classic holds it: the chain with a wall knot at the rocker's tip height before it and
 * after it. One object per (deck chain, rocker end heights).
 */
export function deckToSpline(deck: Chain, rocker: Chain, length: number): Spline {
  const tailY = rocker.knots[0]!.p[1];
  const noseY = rocker.knots[rocker.knots.length - 1]!.p[1];
  const held = deckSplines.get(deck);
  if (
    held !== undefined &&
    held.tailY === tailY &&
    held.noseY === noseY &&
    held.length === length
  ) {
    return held.spline;
  }
  const first = deck.knots[0]!;
  const last = deck.knots[deck.knots.length - 1]!;
  // the walls sit at the board's ends: x = 0 and x = the length, where the junction pass puts them
  const spline = splineFromKnots([
    corner(snap(first.p[0], 0), tailY),
    ...deck.knots.map(knotOfChain),
    corner(snap(last.p[0], length), noseY),
  ]);
  deckSplines.set(deck, { tailY, noseY, length, spline });
  return spline;
}

/**
 * The deck chain of a classic deck spline: its wall knots taken off. A wall is vertical, so the chain's
 * end knots take the walls' x (the junction pass x-locks the walls to the tail and the nose, and the
 * chain must follow, or the deck would stop short of the board's end).
 */
export function splineToDeckChain(spline: Spline): Chain {
  const n = spline.knots.length;
  // the ends cannot be deleted, so a deck from this projection has both walls
  const inner = spline.knots.slice(1, n - 1);
  const m = inner.length;
  const tailX = spline.knots[0]!.end.x;
  const noseX = spline.knots[n - 1]!.end.x;
  return {
    knots: inner.map((k, i) => {
      const end = i === 0 ? tailX : i === m - 1 ? noseX : k.end.x;
      const dx = Math.abs(end - k.end.x) <= WALL_EPS ? 0 : end - k.end.x;
      const at =
        dx === 0
          ? k
          : knot(
              vec2(end, k.end.y),
              shift(k.tangentToPrev, dx),
              shift(k.tangentToNext, dx),
              k.continuous,
              false,
              k.lock,
            );
      return chainKnotOf(at, i === 0, i === m - 1);
    }),
  };
}

const shift = (v: { readonly x: number; readonly y: number }, dx: number) => vec2(v.x + dx, v.y);

// ---------------------------------------------------------------------------
// Sections as slices
// ---------------------------------------------------------------------------

/** A normalised section as a physical slice: `u` times the half-width `w`, `v` times the thickness `T`. */
export function sectionToSlice(section: Section, w: number, T: number): Spline {
  return splineFromKnots(
    section.chain.knots.map((k) =>
      knot(
        vec2(k.p[0] * w, k.p[1] * T),
        vec2(k.in[0] * w, k.in[1] * T),
        vec2(k.out[0] * w, k.out[1] * T),
        k.smooth,
        false,
        k.lock && knotLock(unit(k.lock.prev), unit(k.lock.next)),
      ),
    ),
  );
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * A physical slice as a normalised section: `x / w`, `y / T`, with every coordinate held to `0 <= u <= 1`
 * (the bound that keeps a section inside the blank). The inverse of {@link sectionToSlice} for a slice
 * it made, to rounding (1e-12 in the tests). `apex` is the section's apex knot index.
 */
export function sliceToSection(
  slice: Spline,
  w: number,
  T: number,
  apex: number,
  /** The height of the bottom centre, for a slice that does not start at y = 0. */
  y0 = 0,
): Section {
  const n = slice.knots.length;
  const norm = (v: { readonly x: number; readonly y: number }): Pair => [
    clamp01(v.x / w),
    (v.y - y0) / T,
  ];
  const knots: ChainKnot[] = slice.knots.map((k, i) => {
    const p = norm(k.end);
    const lock =
      k.lock === undefined
        ? undefined
        : {
            ...(k.lock.prev === undefined ? {} : { prev: pairOf(k.lock.prev) }),
            ...(k.lock.next === undefined ? {} : { next: pairOf(k.lock.next) }),
          };
    return {
      p,
      in: i === 0 ? p : norm(k.tangentToPrev),
      out: i === n - 1 ? p : norm(k.tangentToNext),
      smooth: k.continuous,
      ...(lock === undefined ? {} : { lock }),
    };
  });
  return { chain: { knots }, apex };
}

interface SliceEntry {
  readonly w: number;
  readonly T: number;
  readonly spline: Spline;
}
const slices = new WeakMap<Section, SliceEntry>();
const sliceDimensions = new WeakMap<Spline, { readonly w: number; readonly T: number }>();

const sliceOf = (section: Section, w: number, T: number): Spline => {
  const held = slices.get(section);
  if (held !== undefined && held.w === w && held.T === T) return held.spline;
  const spline = sectionToSlice(section, w, T);
  slices.set(section, { w, T, spline });
  sliceDimensions.set(spline, { w, T });
  return spline;
};

/**
 * The half-width (chord) and thickness a projected slice was scaled by, or undefined for a spline the
 * projection did not make. A slice edit is divided by these to become a section again.
 */
export const sliceDims = (slice: Spline): { readonly w: number; readonly T: number } | undefined =>
  sliceDimensions.get(slice);

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

const NO_FINS: FinConfig = noFins();

/**
 * The chord length `w(xi)` of a document's plus side, for a notched tail: the distance from the stringer
 * point to the outline point the station's chord ends at (board2's `createChordFn`). Injected by the app,
 * because this package may not import board2's code. The function it returns is cached by the provider on
 * what the chord depends on, so a section edit does not rebuild it.
 */
export type NotchChords = (doc: BoardDoc) => (xi: number) => number;

interface ListEntry {
  readonly outline: Spline;
  readonly rocker: Spline;
  readonly deck: Spline;
  readonly tail: BoardDoc['tail'];
  readonly chords: NotchChords | undefined;
  readonly list: readonly CrossSection[];
}
const lists = new WeakMap<object, ListEntry>();

function crossSectionsOf(
  doc: BoardDoc,
  outline: Spline,
  rocker: Spline,
  deck: Spline,
  chords: NotchChords | undefined,
) {
  const held = lists.get(doc.stations);
  if (
    held &&
    held.outline === outline &&
    held.rocker === rocker &&
    held.deck === deck &&
    held.tail === doc.tail &&
    held.chords === chords
  ) {
    return held.list;
  }
  const L = doc.outline.plus.knots[doc.outline.plus.knots.length - 1]!.p[0];
  // Half-width at x: the outline's value; for a notched tail (a non-function outline) the chord of the
  // station when a provider is injected, else the plan's outer rail at x.
  const notched = doc.tail.kind === 'notched';
  const chord = notched && chords ? chords(doc) : null;
  const bare = notched && !chord ? board(outline, rocker, deck, [], 'controlPoint', NO_FINS) : null;
  const halfWidthAt = (x: number): number =>
    Math.max(0, chord ? chord(x) : bare ? widthBoundsAt(bare, x).yOut : valueAt(outline, x));
  const dummy = (position: number): CrossSection =>
    crossSection(position, splineFromKnots([knot(vec2(0, 0), vec2(0, 0), vec2(0, 0), true)]));
  const list: CrossSection[] = [dummy(0)];
  for (const st of doc.stations) {
    const w = halfWidthAt(st.x);
    const T = valueAt(deck, st.x) - valueAt(rocker, st.x);
    list.push(crossSection(st.x, sliceOf(st.plus, w, T)));
  }
  list.push(dummy(L));
  lists.set(doc.stations, { outline, rocker, deck, tail: doc.tail, chords, list });
  return list;
}

const boards = new WeakMap<
  BoardDoc,
  { readonly chords: NotchChords | undefined; board: BezierBoard }
>();

/**
 * The classic board a document projects to, memoised per document. The pieces of one document that
 * another shares (an edit replaces the curves it touches) are the same objects in both projections.
 */
export function projectDoc(doc: BoardDoc, chords?: NotchChords): BezierBoard {
  const held = boards.get(doc);
  let b = held !== undefined && held.chords === chords ? held.board : undefined;
  if (b === undefined) {
    const outline = chainToSpline(doc.outline.plus);
    const rocker = chainToSpline(doc.rocker);
    const deck = deckToSpline(doc.deck, doc.rocker, doc.outline.plus.knots.at(-1)!.p[0]);
    const fins = doc.fins == null ? NO_FINS : (doc.fins as unknown as FinConfig);
    b = board(
      outline,
      rocker,
      deck,
      crossSectionsOf(doc, outline, rocker, deck, chords),
      'controlPoint',
      fins,
    );
    boards.set(doc, { chords, board: b });
  }
  return b;
}
