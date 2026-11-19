// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `@openshaper/board2/defaults`: the few engine numbers that code outside the engine needs at run
 * time, such as the store, which writes them into a rails board when an edit makes a corner.
 *
 * This module imports nothing, so importing it pulls in no other engine code: the app's main
 * chunk can hold it without holding the engine. `params.ts` takes these values from here, so
 * there is one source for each. A test fails if this file ever gains an import.
 */

/** The default radius (cm) of the ball on a rails board's nose. */
export const RADIUS_NOSE = 0.8;

/**
 * The default radius (cm) of a rails board's tail: the tail point where the two sides meet, and
 * every corner knot of an outline (a squash tail's corners, a swallow's tips).
 */
export const RADIUS_TAIL = 0.6;

/** The default radius (cm) of the crotch of a notched tail (swallow, fish), where its two walls meet. */
export const RADIUS_CROTCH = 0.2;

/**
 * The narrowest a rail's band or tuck is built, cm: a hard edge is a very small blend, never a
 * missing one. The engine reads it as `TRIM.bandMin`.
 */
export const RAIL_BAND_MIN = 0.05;

/**
 * The widest a rail's band or tuck is built, cm: the engine holds a band to `TRIM.bandHard` (0.9)
 * of the local feature size, which the loop caps at `TRIM.featureCap` (60 cm); 0.9 × 60 = 54
 * (`params.test.ts` checks the product).
 */
export const RAIL_BAND_MAX = 54;

/** A conic's rho is kept this far from 0 and 1 (the engine's `TRIM.rhoInset`): at 0 or 1 the conic degenerates to its chord or its corner. */
export const RAIL_RHO_INSET = 0.05;

/** The apex is kept this far, as a share of the wall's height, from either end of the wall (the engine's `TRIM.apexInset`). */
export const RAIL_APEX_INSET = 0.02;

/**
 * The steepest edge angle, degrees. The engine reads an edge only through its tangent, which is
 * infinite at 90 degrees and negative beyond it; 89 degrees is a tangent of 57.
 */
export const RAIL_EDGE_MAX = 89;

/** The seven numbers of a rail (`RailRecipe` in `trim/rails.ts`), each with a range. */
export type RailRanges = Readonly<
  Record<
    'band' | 'hardness' | 'tuck' | 'tuckShape' | 'bottomEdge' | 'deckEdge' | 'apex',
    readonly [number, number]
  >
>;

/**
 * The range the engine holds each rail number to as it builds (`railLaws` in `trim/rails.ts`):
 * the band and the tuck from `RAIL_BAND_MIN` to `RAIL_BAND_MAX`, both rho from `RAIL_RHO_INSET`
 * to `1 - RAIL_RHO_INSET`, the apex from `RAIL_APEX_INSET` to `1 - RAIL_APEX_INSET`, and each
 * edge from 0 (tangent: no edge) to `RAIL_EDGE_MAX`. A number outside its range builds the rail
 * at the range's end. The store holds an edited number to this range, and the rail panel's dials
 * span it.
 */
export const RAIL_LIMITS: RailRanges = {
  band: [RAIL_BAND_MIN, RAIL_BAND_MAX],
  hardness: [RAIL_RHO_INSET, 1 - RAIL_RHO_INSET],
  tuck: [RAIL_BAND_MIN, RAIL_BAND_MAX],
  tuckShape: [RAIL_RHO_INSET, 1 - RAIL_RHO_INSET],
  bottomEdge: [0, RAIL_EDGE_MAX],
  deckEdge: [0, RAIL_EDGE_MAX],
  apex: [RAIL_APEX_INSET, 1 - RAIL_APEX_INSET],
};
