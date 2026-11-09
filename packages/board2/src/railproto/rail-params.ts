// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Named parameters of the rail-law study (`docs/design/rail-laws-test.md`). Scratch
 * module: the engine never imports it. Lengths cm, angles degrees unless said otherwise.
 */

/** Samples per section half when a stored section is turned into a real-coordinate polyline. */
export const SECTION_SAMPLES = 600;
/** Samples along one fitted conic when its deviation from the section is measured. */
export const CONIC_SAMPLES = 400;

/**
 * The turn a blend must cover, in degrees from the vertical apex tangent. A tangent point
 * closer to the apex than this leaves the turn to the panel, which is where the model is
 * free to cheat: the panel is taken from the section itself, so a blend shrunk to nothing
 * fits perfectly and means nothing. The free fit may not go below the first rung.
 */
export const TURN_FLOOR = 70;
/** The largest turn a blend may cover: beyond this the "blend" has eaten the whole panel. */
export const TURN_CEIL = 88;
/** Fixed turn coverages measured with the tangent points pinned (degeneracy-free rows). */
export const PINNED_TURNS: readonly number[] = [60, 70, 80];

/** Search bracket for a conic's rho (= w / (1 + w)); 0.5 is a parabola. */
export const RHO_MIN = 0.05;
export const RHO_MAX = 0.95;
/** Golden-section iterations when rho is fitted at a fixed tangent point. */
export const RHO_ITERS = 42;
/** Turn-angle values tried for a tangent point, between the floor and the ceiling. */
export const TURN_STEPS = 19;
/** Local refinements of the turn angle around the grid's best rung. */
export const TURN_REFINE = 3;

/** Apex-tangent lean values tried for the five-parameter variant, in degrees off vertical. */
export const LEAN_RANGE = 12;
export const LEAN_STEPS = 13;

/** Stations thinner or narrower than these are skipped: the tips are a lens, not a rail. */
export const MIN_THICKNESS = 0.6;
export const MIN_CHORD = 2.5;

/** Degrees of freedom tried for a parameter's law curve (3 = quadratic, 4 = one cubic span). */
export const LAW_DOFS: readonly number[] = [3, 4, 5];

/** The project's section tolerance, cm — what a residual is measured against. */
export const PROJECT_TOL_CM = 0.05;
