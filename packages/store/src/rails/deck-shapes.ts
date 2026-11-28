// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Deck shapes: how a station's deck curve is named, and how a name is applied to it.
 *
 * A station's deck curve runs from the stringer, at the board's thickness, to the wall (the
 * outline), where its height sets how full the rail is there. It has three readings:
 *
 * - **Flat**: level, at the thickness, over the whole half width.
 * - **Domed**: a dome that starts level at the stringer and falls to the wall along a parabola, one
 *   cubic segment of two knots. One number, how far it has fallen at the wall, says which dome; the
 *   shaper reads it as the **crown**.
 * - **Custom**: any other curve. A shape is never stored: it is read off the curve, as a rail's name
 *   is read off its numbers (`library.ts`), so a curve that is drawn, or a shape that is dragged as a
 *   curve, reads Custom, and nothing a shaper drew is replaced unless they choose a shape.
 *
 * ## Why a parabola
 *
 * A station's curves are stored in (u, v), as fractions of the half width and of the thickness, so a
 * station that is moved, a thickness changed in the rocker step and a width changed in the outline step
 * each stretch a stored curve along one axis and not the other. A parabola stays a parabola under that,
 * with the same share of the thickness fallen at the wall; a circle does not. So a Domed deck stays
 * Domed through every edit that is not of the deck itself, and a station added between two Domed ones
 * (its curve is the two neighbours' blended) is Domed exactly. To the eye it is the arc of a circle:
 * on the boards of the project, at the crowns they have, it is within 0.15 mm of the circle with the
 * same fall (`deck-shapes.test.ts`).
 *
 * ## The crown
 *
 * The crown is how far the deck falls from the stringer to the place where the rail starts to roll
 * over it, the band edge: put a straightedge across the deck from one band edge to the other and
 * the crown is the gap under it at the stringer. It is read at the recipe's band (`railAt`, the rail
 * as it is at that station on that side), held to {@link BAND_SHARE_MAX} of the half width where the
 * engine narrows a band on a thin board; the engine narrows it further than that near the tips, where
 * the crown is read slightly further out than the board's own band edge.
 *
 * The shape is read from the curve alone (how far it has fallen at the wall, whatever the rail), so
 * editing the rail never turns a Domed deck Custom; only the crown, which is a distance read at the band
 * edge, moves when the band does. The dome goes on past the band edge to the wall, so a Flat or a Domed
 * deck also sets the height of the deck where it meets the rail: a flatter deck makes a fuller rail.
 *
 * ## Applying a shape
 *
 * {@link applyDeckShape} rewrites a station's deck curve on both sides of the board (or the side it
 * is given) as the shape's own curve: two knots, for Flat and for Domed alike, holding the half-curve
 * rules (`half-curve.ts`). A crown the board cannot hold is held at the nearest it can
 * ({@link deckCrownRange}), never refused. A curve that already is the shape is left as the same
 * object, so applying a shape twice changes nothing.
 *
 * With **all stations**, a crown given is the crown at the chosen station and every station, on both sides,
 * falls the same share of its own thickness at the wall: one curve in (u, v) for the whole board, which is
 * what a board with one shape along its length is. The decks of the boards measured fall by 28 to 68
 * percent of the thickness at their wall, so the same length of fall at every station would take the rail to
 * nothing at the tips; and the same share of the thickness read at the band edge would do the same where the
 * band is wide beside the half width, as at the last station of the golden shortboard, whose band edge is
 * 1.3 cm out on a half width of 2.3. With no crown given, a station keeps the crown it has (a Custom deck
 * becomes the dome through the same band-edge point) and a station with none falls
 * {@link DEFAULT_WALL_FALL_SHARE} of its thickness at the wall.
 */
import type { Chain, RailsBoard } from '@openshaper/board2';
import { knot, splineFromKnots, vec2, type Spline } from '@openshaper/kernel';
import type { StationSplines } from '../edits';
import { splineToCurve, stationSplines } from './project';
import type { RailKey, RailsStation, StationCurves } from './types';
import { railAt } from './zones';

/** The shapes a shaper can choose; a deck that is neither reads `custom`. */
export const DECK_SHAPES = ['flat', 'domed'] as const;
export type DeckShapeId = (typeof DECK_SHAPES)[number];
export type DeckShapeName = DeckShapeId | 'custom';

/** A side of the board: the plus side is the one on the left of someone on the board facing the nose. */
export type DeckSide = 'plus' | 'minus';

/**
 * How far (cm) a curve may stand from level, anywhere, and still read Flat: a tenth of a millimetre,
 * below what a pencil or a plane can hold and above the rounding of a saved file.
 */
export const FLAT_TOLERANCE = 0.01;

/**
 * How far (cm) a curve may stand from the parabola its own fall at the wall makes, anywhere, and still
 * read Domed: a tenth of a millimetre. A knot dragged by a millimetre or more is well past it. The curves
 * this module writes are that parabola to rounding.
 */
export const DOME_READ_TOLERANCE = 0.01;

/**
 * How far a deck may stand from the dome through the stringer's height and its own crown, from the stringer to
 * the band edge, and still read Domed: three tenths of that crown, and never more than {@link DOME_CLOSE_MAX}.
 * A drawn deck is an arc and a roll, not a parabola: the 47 stations of the nine boards the project ships and
 * makes stand 4 to 25 percent of their crowns off one (the thick stations, those over 60 percent of the
 * board's greatest thickness, 4 to 17 percent), 1.3 to 3.5 millimetres on a deck that falls two centimetres. A
 * deck with a second hump or a hollow, a level middle with a steep edge, or a knot dragged a centimetre or more
 * is past it. Past the band edge the deck is under the rail and is not read.
 */
export const DOME_CLOSE_SHARE = 0.3;

/** The most (cm) a deck may stand from its dome and still read Domed, whatever its crown: four millimetres, above the 3.5 of the boards the project ships. */
export const DOME_CLOSE_MAX = 0.4;

/**
 * The steepest the deck may be where it meets the wall: a slope of tan 60 degrees, which a Domed deck
 * of half width `w` reaches at a fall of `w` tan(60 deg) / 2. Past it the dome would stand nearly upright
 * at the rail. The decks of the project fall at 17 degrees at most.
 */
export const WALL_SLOPE_MAX = Math.tan(Math.PI / 3);

/**
 * How near the stringer the band edge may stand, as a share of the half width: the engine holds a
 * band to 0.72 of the local feature size (`TRIM.bandShare`), which on a board's plain stretch is the
 * half width. A recipe band wider than that is read as that wide.
 */
export const BAND_SHARE_MAX = 0.72;

/**
 * The least height (cm) the deck keeps above the bottom's end at the wall: a millimetre, so the rail
 * there is never a knife edge. The engine's own limit is lower: it builds a closed board, at draft and
 * view quality, on every board measured (the made boards and the starter templates) with the deck's end
 * down to a thousandth of a millimetre above the bottom's, and level with it
 * (`deck-shapes.measure.test.ts`); the half-curve rule only asks the deck to end at or above it.
 */
export const WALL_MIN = 0.1;

/**
 * The least crown (cm) of a Domed deck: half a millimetre. A shallower deck is Flat for every
 * purpose, and it keeps a Domed deck off the flat tolerance.
 */
export const CROWN_MIN = 0.05;

/**
 * How far a new Domed deck falls at the wall where there is no crown to keep, as a share of the thickness at
 * the station: 0.50, the median of the fall at the wall over the thickness at the 47 stations of the nine boards
 * the project ships and makes (0.28 to 0.68; the thick stations, over 60 percent of the board's greatest
 * thickness, 0.34 to 0.56 with a median of 0.455). At the thickest station of a shortboard that is a crown of
 * 2.5 cm at the band edge, where the decks of the boards are 1.2 to 2.5 cm at their thick stations
 * (`deck-shapes.measure.test.ts`).
 */
export const DEFAULT_WALL_FALL_SHARE = 0.5;

/**
 * How far (cm) the crowns of the two sides of a station may differ and still be one crown: half a millimetre.
 * The sides of a board that is not symmetric have different half widths and bands, so one dome on both reads
 * a crown a little different on each.
 */
export const SIDES_TOLERANCE = 0.05;

/**
 * Two crowns (cm) that differ by less than this are the same: a curve that was written as a dome and
 * read back is its crown to rounding, and nothing a person can set is finer.
 */
export const SAME_CROWN = 1e-9;

/** Points of each segment a curve is sampled at when it is compared with a shape. */
const SEGMENT_SAMPLES = 48;

/** Steps of the bisection that finds a curve's height at a distance from the stringer: far below a micron. */
const BISECTION_STEPS = 60;

// ---------------------------------------------------------------------------
// Domes
// ---------------------------------------------------------------------------

/** The fall (cm) of a dome that has fallen `wallFall` at the wall (`w` from the stringer), at distance `y` from the stringer. */
export const domeFall = (wallFall: number, w: number, y: number): number =>
  w > 0 ? wallFall * (y / w) ** 2 : 0;

/** How far (cm) a dome falls at the wall when it has fallen `crown` at distance `edge` from the stringer, the wall being `w` out. */
export const wallFallFor = (crown: number, w: number, edge: number): number =>
  edge > 0 ? crown * (w / edge) ** 2 : 0;

/**
 * The distance (cm) from the stringer where the rail starts to roll over the deck: the half width less
 * the band, the band held to {@link BAND_SHARE_MAX} of the half width. A band that is not a number is
 * none.
 */
export const bandEdge = (w: number, band: number): number =>
  w - Math.min(Number.isFinite(band) ? Math.max(0, band) : 0, BAND_SHARE_MAX * w);

/**
 * The deck curve of a Domed station as a spline in cm in the station's frame: the parabola that starts
 * level at (0, `T`) and has fallen `wallFall` at the wall, x = `w`. It is one cubic segment, exactly: the
 * handles stand a third of the way along, the first level and the second a third of the fall down. The last
 * knot is exactly on the wall.
 */
export function domedSpline(w: number, T: number, wallFall: number): Spline {
  return splineFromKnots([
    knot(vec2(0, T), vec2(0, T), vec2(w / 3, T), true),
    knot(vec2(w, T - wallFall), vec2((2 * w) / 3, T - wallFall / 3), vec2(w, T - wallFall), true),
  ]);
}

/** The deck curve of a Flat station as a spline in cm: level at `T` from the stringer to the wall. */
export function flatSpline(w: number, T: number): Spline {
  return splineFromKnots([
    knot(vec2(0, T), vec2(0, T), vec2(w / 3, T), true),
    knot(vec2(w, T), vec2((2 * w) / 3, T), vec2(w, T), true),
  ]);
}

// ---------------------------------------------------------------------------
// Reading a curve
// ---------------------------------------------------------------------------

interface Point {
  readonly x: number;
  readonly y: number;
}

/** Points along a spline: every segment at {@link SEGMENT_SAMPLES} + 1 values of its parameter. */
function samples(s: Spline): Point[] {
  const out: Point[] = [];
  const k = s.knots;
  for (let i = 0; i + 1 < k.length; i++) {
    const a = k[i]!.end;
    const b = k[i]!.tangentToNext;
    const c = k[i + 1]!.tangentToPrev;
    const d = k[i + 1]!.end;
    for (let j = i === 0 ? 0 : 1; j <= SEGMENT_SAMPLES; j++) {
      const t = j / SEGMENT_SAMPLES;
      const u = 1 - t;
      const w0 = u * u * u;
      const w1 = 3 * u * u * t;
      const w2 = 3 * u * t * t;
      const w3 = t * t * t;
      out.push({
        x: w0 * a.x + w1 * b.x + w2 * c.x + w3 * d.x,
        y: w0 * a.y + w1 * b.y + w2 * c.y + w3 * d.y,
      });
    }
  }
  return out;
}

/**
 * The height of a half curve at distance `x` from the stringer: found by bisection on the segment that
 * holds `x`. A curve is a function of x (the half-curve rules), so one segment does; past either end,
 * the end's height.
 */
export function heightAt(s: Spline, x: number): number {
  const k = s.knots;
  if (x <= k[0]!.end.x) return k[0]!.end.y;
  for (let i = 0; i + 1 < k.length; i++) {
    const a = k[i]!.end;
    const b = k[i]!.tangentToNext;
    const c = k[i + 1]!.tangentToPrev;
    const d = k[i + 1]!.end;
    if (x > d.x) continue;
    let lo = 0;
    let hi = 1;
    for (let it = 0; it < BISECTION_STEPS; it++) {
      const t = (lo + hi) / 2;
      const u = 1 - t;
      const px = u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x;
      if (px < x) lo = t;
      else hi = t;
    }
    const t = (lo + hi) / 2;
    const u = 1 - t;
    return u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y;
  }
  return k[k.length - 1]!.end.y;
}

/** The greatest vertical distance of the curve's samples from `shape`, a height by distance from the stringer. */
function deviation(s: Spline, shape: (x: number) => number): number {
  let worst = 0;
  for (const p of samples(s)) worst = Math.max(worst, Math.abs(p.y - shape(p.x)));
  return worst;
}

/** The greatest vertical distance of the curve's samples out to distance `limit` from the stringer from `shape`. */
function deviationTo(s: Spline, limit: number, shape: (x: number) => number): number {
  let worst = 0;
  for (const p of samples(s)) if (p.x <= limit) worst = Math.max(worst, Math.abs(p.y - shape(p.x)));
  return worst;
}

/** What a station's deck curve is. */
export interface DeckReading {
  readonly shape: DeckShapeName;
  /**
   * The crown (cm): the fall of the deck from the stringer to the band edge. Zero for Flat, the dome's
   * for Domed, and for Custom the curve's own fall at the band edge.
   */
  readonly crown: number;
  /** A Domed deck's fall at the wall (cm), the number that says which dome it is; null for the others. */
  readonly wallFall: number | null;
}

/**
 * What the deck curve of a station is, on one side: Flat, Domed (with its crown), or Custom (with the
 * curve's own crown). A Domed deck is a parabola, or a deck close to one ({@link DOME_CLOSE_SHARE}). `band` is the rail's band (cm) at the station on that side, which only places
 * the band edge the crown is read at: the shape itself is read from the curve alone. Null for a
 * station with no width or no thickness, which has no curve to read.
 */
export function deckShapeOf(entry: StationSplines, band: number): DeckReading | null {
  const { w, T, deck } = entry;
  if (!(w > 0 && T > 0)) return null;
  const knots = deck.knots;
  const last = knots[knots.length - 1]!.end;
  const edge = bandEdge(w, band);
  // a curve that stops short of the wall, or does not start at the stringer's height, is nobody's shape
  if (Math.abs(last.x - w) <= FLAT_TOLERANCE) {
    if (deviation(deck, () => T) <= FLAT_TOLERANCE)
      return { shape: 'flat', crown: 0, wallFall: null };
    const fall = T - last.y;
    if (fall > 0 && deviation(deck, (x) => T - domeFall(fall, w, x)) <= DOME_READ_TOLERANCE) {
      return { shape: 'domed', crown: domeFall(fall, w, edge), wallFall: fall };
    }
    // a close dome: inside the band edge, within a share of its own crown of the dome that crown makes
    const crown = T - heightAt(deck, edge);
    if (
      fall > 0 &&
      edge > 0 &&
      crown >= CROWN_MIN &&
      deviationTo(deck, edge, (x) => T - crown * (x / edge) ** 2) <=
        Math.max(DOME_READ_TOLERANCE, Math.min(DOME_CLOSE_SHARE * crown, DOME_CLOSE_MAX))
    ) {
      return { shape: 'domed', crown, wallFall: fall };
    }
  }
  return { shape: 'custom', crown: Math.max(0, T - heightAt(deck, edge)), wallFall: null };
}

// ---------------------------------------------------------------------------
// What a station can hold
// ---------------------------------------------------------------------------

/** The crowns (cm) a station can hold on one side. */
export interface DeckCrownRange {
  readonly min: number;
  readonly max: number;
}

/**
 * The crowns a station's deck can have on one side, or null where it can have none (no width or no
 * thickness, or too thin to hold {@link CROWN_MIN} and still keep {@link WALL_MIN} above the bottom).
 *
 * The most is the crown of the deepest dome the station allows. The dome may fall at the wall no more than
 * the deck's height over the bottom's end there, less {@link WALL_MIN} (the half-curve rule that a deck
 * ends at or above the bottom, with a margin the engine builds a closed rail at), and no more than a
 * slope of {@link WALL_SLOPE_MAX} at the wall makes.
 */
export function deckCrownRange(entry: StationSplines, band: number): DeckCrownRange | null {
  const { w, T, bottom } = entry;
  if (!(w > 0 && T > 0)) return null;
  const bottomEnd = bottom.knots[bottom.knots.length - 1]!.end.y;
  const wall = Math.min(T - bottomEnd - WALL_MIN, (w * WALL_SLOPE_MAX) / 2);
  if (!(wall > 0)) return null;
  const max = domeFall(wall, w, bandEdge(w, band));
  return max >= CROWN_MIN ? { min: CROWN_MIN, max } : null;
}

// ---------------------------------------------------------------------------
// Applying a shape
// ---------------------------------------------------------------------------

/** A shape asked for, and for Domed the crown (cm) at the station it is measured at. */
export interface DeckShapeRequest {
  readonly shape: DeckShapeId;
  /**
   * Domed only: the crown. Left out, each station keeps the crown it has, or takes
   * {@link DEFAULT_WALL_FALL_SHARE} of its thickness at the wall when it has none.
   */
  readonly crown?: number;
}

/**
 * Which stations a shape reaches. `station` is an index into the board's stations: the one that is
 * changed, or with `all` the one the crown is measured at, every other station following it in
 * proportion to its thickness.
 */
export interface DeckScope {
  readonly station: number;
  readonly all: boolean;
}

const keysOf = (doc: RailsBoard, side: DeckSide): readonly RailKey[] =>
  side === 'minus' ? (doc.rails.minus ?? doc.rails.plus) : doc.rails.plus;

/** The rail's band (cm) at a place on one side of the board: what the crown's band edge is read from. */
export const bandAt = (doc: RailsBoard, side: DeckSide, x: number): number =>
  railAt(keysOf(doc, side), x).band;

/** The sides a call reaches at a station: both where the station has a minus side, else the plus side; or the one named. */
function sidesOf(st: RailsStation, side: DeckSide | undefined): readonly DeckSide[] {
  if (side === 'plus') return ['plus'];
  if (side === 'minus') return st.minus === undefined ? [] : ['minus'];
  return st.minus === undefined ? ['plus'] : ['plus', 'minus'];
}

/** A station's curves on one side, with the numbers the crown is read with. */
function stationOn(doc: RailsBoard, side: DeckSide, i: number) {
  return {
    entry: stationSplines(doc, side)[i]!,
    band: bandAt(doc, side, doc.stations[i]!.x),
  };
}

const hold = (crown: number, range: DeckCrownRange): number =>
  Math.min(range.max, Math.max(range.min, crown));

/** The crowns both of two ranges allow, or the one that is there: null when neither is. */
function commonRange(ranges: readonly (DeckCrownRange | null)[]): DeckCrownRange | null {
  const held = ranges.filter((r): r is DeckCrownRange => r !== null);
  if (held.length === 0) return null;
  return {
    min: Math.max(...held.map((r) => r.min)),
    max: Math.min(...held.map((r) => r.max)),
  };
}

/**
 * The deck curve of a station after a shape is applied to it on one side: the curve it has when it is
 * already that shape (the same object), else the shape's own. `crown` is held to what the station can
 * hold; a station too thin to hold one stays level.
 */
function curveFor(
  curves: StationCurves,
  entry: StationSplines,
  band: number,
  shape: DeckShapeId,
  crown: number,
): Chain {
  const { w, T } = entry;
  const now = deckShapeOf(entry, band);
  const range = shape === 'domed' ? deckCrownRange(entry, band) : null;
  if (range === null) {
    return now?.shape === 'flat' ? curves.deck : splineToCurve(flatSpline(w, T), w, T);
  }
  const wanted = hold(crown, range);
  if (now?.shape === 'domed' && Math.abs(now.crown - wanted) <= SAME_CROWN) return curves.deck;
  return splineToCurve(domedSpline(w, T, wallFallFor(wanted, w, bandEdge(w, band))), w, T);
}

/**
 * The crown (cm) a side keeps when no crown is asked for: the one it has, or where it has none the dome that falls
 * {@link DEFAULT_WALL_FALL_SHARE} of the thickness at the wall.
 */
function keptCrown(entry: StationSplines, band: number): number {
  const own = deckShapeOf(entry, band);
  if (own !== null && own.crown >= CROWN_MIN) return own.crown;
  return domeFall(DEFAULT_WALL_FALL_SHARE * entry.T, entry.w, bandEdge(entry.w, band));
}

/**
 * The board with `request.shape` applied to the deck curves of the stations in `scope`, on both sides
 * (where a station has a minus side) or on `side` alone. Returns `doc` itself when no curve changes,
 * and every part an edit does not touch by reference. A station with no width or no thickness is left
 * alone, and so is a call whose station is not one of the board's.
 *
 * A crown given for one station reaches both its sides as the same number, held to what both can hold. With
 * all stations the crown given is the chosen station's, and every station falls the same share of its own
 * thickness at the wall, so each side reads the crown that curve has at its own band edge. Where none is given
 * each side keeps the crown it has, so the sides of an asymmetric board that differ go on differing.
 */
export function applyDeckShape(
  doc: RailsBoard,
  request: DeckShapeRequest,
  scope: DeckScope,
  side?: DeckSide,
): RailsBoard {
  const at = scope.station;
  const chosen = doc.stations[at];
  if (!Number.isInteger(at) || chosen === undefined) return doc;
  const asked =
    request.crown !== undefined && Number.isFinite(request.crown) ? request.crown : null;
  const domed = request.shape === 'domed';

  /** The curves of a station's sides this call reaches, with what they are read by. */
  const reach = (i: number) =>
    sidesOf(doc.stations[i]!, side)
      .map((s) => ({ s, ...stationOn(doc, s, i) }))
      .filter((r) => r.entry.w > 0 && r.entry.T > 0);

  // with all stations the crown given is the chosen station's: the share of its thickness it falls at the wall is every station's
  let share = 0;
  if (domed && asked !== null && scope.all) {
    const here = reach(at);
    const range = commonRange(here.map((r) => deckCrownRange(r.entry, r.band)));
    if (here.length === 0 || range === null) return doc;
    const { entry, band } = here[0]!;
    share = wallFallFor(hold(asked, range), entry.w, bandEdge(entry.w, band)) / entry.T;
  }

  let stations: RailsStation[] | null = null;
  const last = scope.all ? doc.stations.length - 1 : at;
  for (let i = scope.all ? 0 : at; i <= last; i++) {
    const st = doc.stations[i]!;
    const sides = reach(i);
    // a crown given for one station is one number on both its sides, held to what both can hold
    const common =
      asked === null || scope.all
        ? null
        : commonRange(sides.map((r) => deckCrownRange(r.entry, r.band)));
    let next = st;
    for (const { s, entry, band } of sides) {
      const crown =
        asked === null
          ? keptCrown(entry, band)
          : scope.all
            ? domeFall(share * entry.T, entry.w, bandEdge(entry.w, band))
            : common === null
              ? asked
              : hold(asked, common);
      const curves = s === 'minus' ? st.minus! : st.plus;
      const deck = curveFor(curves, entry, band, request.shape, crown);
      if (deck !== curves.deck) next = { ...next, [s]: { ...curves, deck } };
    }
    if (next !== st) {
      stations ??= [...doc.stations];
      stations[i] = next;
    }
  }
  return stations === null ? doc : { ...doc, stations };
}

/** What the deck of a station is on the board, with whether the two sides of the board differ in it. */
export interface DeckStationReading extends DeckReading {
  /**
   * The two sides do not read the same: a different shape, or a crown more than
   * {@link SIDES_TOLERANCE} apart. The reading is then the plus side's, and Custom when the
   * shapes differ.
   */
  readonly sidesDiffer: boolean;
}

/**
 * What the deck of a station is on the board, both sides read together: where they agree, the one
 * reading; where both are Flat or both Domed with crowns apart, the plus side's reading, saying so; and
 * where the shapes differ, Custom. Null for a station that is not one of the board's, or has no width
 * or no thickness.
 */
export function deckShapeAt(doc: RailsBoard, station: number): DeckStationReading | null {
  const st = doc.stations[station];
  if (st === undefined) return null;
  const [a, b] = sidesOf(st, undefined).map((s) => {
    const { entry, band } = stationOn(doc, s, station);
    return deckShapeOf(entry, band);
  });
  if (a == null) return b == null ? null : { ...b, sidesDiffer: false };
  if (b == null) return { ...a, sidesDiffer: false };
  if (a.shape !== b.shape)
    return { shape: 'custom', crown: a.crown, wallFall: null, sidesDiffer: true };
  return { ...a, sidesDiffer: Math.abs(a.crown - b.crown) > SIDES_TOLERANCE };
}

/**
 * The crowns a station can hold on the board, both sides together: from the least to the most both
 * can hold. Null where neither side can hold one.
 */
export function deckCrownRangeAt(doc: RailsBoard, station: number): DeckCrownRange | null {
  const st = doc.stations[station];
  if (st === undefined) return null;
  return commonRange(
    sidesOf(st, undefined).map((s) => {
      const { entry, band } = stationOn(doc, s, station);
      return deckCrownRange(entry, band);
    }),
  );
}
