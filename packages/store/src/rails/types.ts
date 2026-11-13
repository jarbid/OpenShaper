// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The parts of a rails board the store names, read off `RailsBoard` (the one rails type board2
 * exports), and the slices the app hands the store.
 */
import type { RailsBoard } from '@openshaper/board2';

export type RailsStation = RailsBoard['stations'][number];
export type StationCurves = RailsStation['plus'];
export type RailKey = RailsBoard['rails']['plus'][number];
export type RailRecipe = RailKey['rail'];
export type RailsCorners = RailsBoard['corners'];

/**
 * The engine's closed section at one station, per side: a polyline in cm in the section's frame,
 * flat as `[y0, z0, y1, z1, …]` (y from the stringer, z above the rocker), from the bottom centre
 * over the rail to the deck centre, as board2's `probeRails` returns it. `minus` on an asymmetric
 * board only.
 */
export interface StationSlice {
  readonly plus: readonly number[];
  readonly minus?: readonly number[];
}

/** The slices of a board, by station id. A station with no entry is drawn from its curves alone. */
export type RailsSlices = Readonly<Record<string, StationSlice>>;

/**
 * The station index (into `doc.stations`, as the `stationBottom` and `stationDeck` targets count)
 * of a classic slice index (into the projection's `crossSections`, as the `crossSection` target
 * counts, whose first and last entries are empty end slices); null for an end slice or an index
 * past them. `stations` is the number of stations.
 */
export const stationOfSlice = (slice: number, stations: number): number | null =>
  Number.isInteger(slice) && slice >= 1 && slice <= stations ? slice - 1 : null;

/** The classic slice index of station `station`: the inverse of {@link stationOfSlice}. */
export const sliceOfStation = (station: number): number => station + 1;
