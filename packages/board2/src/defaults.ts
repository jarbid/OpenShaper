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
