// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The built-in rails: seven named rails for the middle of a board, and how a rail is named, as one
 * of them, as one of a shaper's own, or as Custom. A rail's name is never stored; it is read off its
 * numbers.
 *
 * Band and tuck are in cm, so near a narrow tip the engine holds a zone to what fits the board
 * there; these are the rails of a board's middle, and `tip` is the one for its ends.
 */
import type { RailRecipe } from './types';
import { railDistance, usableTolerance } from './zones';

/** A named rail: the built-in rails, and a shaper's own saved ones. */
export interface NamedRail {
  readonly name: string;
  readonly rail: RailRecipe;
}

/** One of the built-in rails. */
export interface BuiltInRail extends NamedRail {
  /** A stable key for the rail: what a list or a test refers to it by. */
  readonly id: string;
  /** What it is, in a sentence of a shaper's words. */
  readonly summary: string;
}

const make = (
  id: string,
  name: string,
  summary: string,
  [band, hardness, tuck, tuckShape, bottomEdge, deckEdge, apex]: readonly [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ],
): BuiltInRail =>
  Object.freeze({
    id,
    name,
    summary,
    rail: Object.freeze({ band, hardness, tuck, tuckShape, bottomEdge, deckEdge, apex }),
  });

/**
 * The built-in rails, calibrated on the golden boards (mid-board: a band of 2.0 to 3.1 cm,
 * hardness about 0.5, a tuck of 1.5 to 2.3 cm, a tuck shape of 0.4 to 0.5, an apex of 0.52 to 0.55; at
 * the tips: a band of 0.1 to 0.25 cm and a tuck of 0.05 cm). Each is the seven numbers in the order
 * band, hardness, tuck, tuck shape, bottom edge, deck edge, apex.
 */
export const BUILT_IN_RAILS: readonly BuiltInRail[] = Object.freeze([
  make(
    'round',
    'Round',
    'A full, even rail with its widest point at mid-height: forgiving and stable, the usual rail for the middle of a board.',
    [2.0, 0.5, 1.4, 0.45, 0, 0, 0.5],
  ),
  make(
    'soft',
    'Soft 60/40',
    'The widest point sits a little below mid-height, so the lower edge is tighter than a 50/50: still soft, and a touch freer in a turn.',
    [2.2, 0.5, 1.2, 0.45, 0, 0, 0.4],
  ),
  make(
    'down',
    'Down rail 80/20',
    'The widest point sits low with a slight edge under it, so the rail holds a line and lets go quickly, as on a performance shortboard.',
    [2.4, 0.55, 0.8, 0.5, 10, 0, 0.22],
  ),
  make(
    'tucked',
    'Tucked',
    'The bottom rolls well in before the rail, with no edge: water leaves the board smoothly and the board stays forgiving.',
    [2.0, 0.5, 2.2, 0.4, 0, 0, 0.5],
  ),
  make(
    'boxy',
    'Boxy',
    'A narrow roll on top and a square shoulder: a full, flat-sided rail that is stable and floaty, as on a mini-mal or a fun shape.',
    [1.2, 0.7, 1.0, 0.7, 0, 0, 0.5],
  ),
  make(
    'hard',
    'Hard edge',
    'A short tuck and a defined edge where the bottom meets the rail: crisp and fast off the tail, and less forgiving.',
    [1.0, 0.6, 0.3, 0.8, 35, 0, 0.35],
  ),
  make(
    'tip',
    'Fine tip',
    'A thin, nearly knife-sharp rail for the last stretch of the nose and tail, where the board narrows to nothing.',
    [0.15, 0.45, 0.05, 0.9, 0, 0, 0.4],
  ),
]);

/**
 * How near a rail's numbers must be to a named rail's for it to take the name, in the units of
 * `ZONE_SCALES`: a hundredth, which is a tenth of a millimetre of band or tuck. A rail passes through
 * dials, typed numbers and saved files, which round; one that has been moved by a dial or a number
 * is Custom.
 */
export const NAME_TOLERANCE = 0.01;

/**
 * A rail's name: that of the built-in rail, or of one of `mine` (a shaper's saved rails), whose
 * numbers it equals within `tolerance` (`NAME_TOLERANCE` by default, read as `railZones` reads one),
 * the nearest if several are within it and the first of those if several are as near; otherwise
 * 'Custom'. The built-in rails come before `mine`.
 */
export function railName(
  rail: RailRecipe,
  mine: readonly NamedRail[] = [],
  tolerance: number = NAME_TOLERANCE,
): string {
  const within = usableTolerance(tolerance);
  let name = 'Custom';
  let nearest = Infinity;
  for (const candidate of [...BUILT_IN_RAILS, ...mine]) {
    const far = railDistance(rail, candidate.rail);
    if (far <= within && far < nearest) {
      nearest = far;
      name = candidate.name;
    }
  }
  return name;
}
