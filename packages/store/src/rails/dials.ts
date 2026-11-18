// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The three dials of the rail panel, and how each sets one of the rail's seven numbers: Apex sets
 * `apex`, Tuck sets `tuck` and Edge sets `bottomEdge`. The other four numbers (`band`, `hardness`,
 * `tuckShape` and `deckEdge`) belong to the panel's More and are never touched here.
 */
import type { RailRecipe } from './types';
import { RAIL_LIMITS } from './zones';

/** The three dials as the numbers they set: the apex as a fraction of the wall, the tuck in cm, the edge in degrees. */
export interface RailDials {
  /** Where the widest point sits: the fraction of the wall up from the bottom. */
  readonly apex: number;
  /** How far in from the outline the bottom starts to turn, cm. */
  readonly tuck: number;
  /** The angle the rail leaves the bottom at, degrees. */
  readonly edge: number;
}

/**
 * The range of each dial, from the value at its first end to the value at its last, in the order
 * the dial is read: the apex from 0.6 (40/60) to 0.2 (80/20), the tuck from the least the engine
 * builds ("none") to 4 cm ("deep"), the edge from 0 ("none") to 60 degrees ("hard"). A dial's
 * position along it is `(value - start) / (end - start)`, which holds for the apex running downward too.
 */
export const DIAL_RANGES: Readonly<{
  apex: readonly [number, number];
  tuck: readonly [number, number];
  edge: readonly [number, number];
}> = {
  apex: [0.6, 0.2],
  tuck: [RAIL_LIMITS.tuck[0], 4],
  edge: [0, 60],
};

/** The dials as a rail has them: the numbers themselves, not held to the ranges. */
export function dialsOf(rail: RailRecipe): RailDials {
  return { apex: rail.apex, tuck: rail.tuck, edge: rail.bottomEdge };
}

/**
 * A number set to `wanted` within a dial's range: held to it when it changes, left alone when it
 * is as it was (a rail outside the ranges keeps its own numbers until a dial is moved), and not
 * set when it is not a number.
 */
function held(
  current: number,
  wanted: number | undefined,
  range: readonly [number, number],
): number {
  if (wanted === undefined || wanted === current) return current;
  if (typeof wanted !== 'number' || !Number.isFinite(wanted)) return current;
  return Math.min(Math.max(range[0], range[1]), Math.max(Math.min(range[0], range[1]), wanted));
}

/**
 * `rail` with the dials in `dials` set, each held to its range in {@link DIAL_RANGES} where it
 * changes. The other numbers are as they were, and the rail itself comes back when no dial changes:
 * `applyDials(r, dialsOf(r))` is `r` for every rail, inside the ranges or not.
 */
export function applyDials(rail: RailRecipe, dials: Partial<RailDials>): RailRecipe {
  const apex = held(rail.apex, dials.apex, DIAL_RANGES.apex);
  const tuck = held(rail.tuck, dials.tuck, DIAL_RANGES.tuck);
  const bottomEdge = held(rail.bottomEdge, dials.edge, DIAL_RANGES.edge);
  if (apex === rail.apex && tuck === rail.tuck && bottomEdge === rail.bottomEdge) return rail;
  return { ...rail, apex, tuck, bottomEdge };
}

/**
 * How the apex reads: the share of the wall above it to the share below, each to the nearest ten,
 * so an apex of 0.5 is '50/50', 0.4 is '60/40' and 0.2 is '80/20'. A share halfway between two
 * tens reads as the more even of them, so 0.45 and 0.55 are both '50/50'. An apex outside the wall
 * reads as the end it is past, and one that is not a number as '50/50'.
 */
export function apexLabel(apex: number): string {
  if (!Number.isFinite(apex)) return '50/50';
  const tenths = (1 - Math.min(1, Math.max(0, apex))) * 10;
  const nearest = Math.round(tenths);
  // a tie goes towards the middle; the epsilon makes 4.5 and 5.5 ties however they were computed
  const tie = Math.abs(tenths - Math.floor(tenths) - 0.5) < 1e-9;
  const above = tie ? (tenths > 5 ? Math.floor(tenths) : Math.ceil(tenths)) : nearest;
  return `${above * 10}/${100 - above * 10}`;
}
