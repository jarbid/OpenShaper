// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Named parameters of the rail-law study (`docs/design/rail-laws-test.md`). Scratch
 * module: the engine never imports it. Lengths cm, angles degrees unless said otherwise.
 */

/** Samples per section half when a stored section is turned into a real-coordinate polyline. */
export const SECTION_SAMPLES = 600;
/**
 * Stride of the coarse pass when a point's distance to a polyline is found. Both polylines
 * here are sampled evenly by arc length, so a stride this small cannot step over a minimum;
 * `rail-geom.test.ts` checks it against the exact scan on every station of every board.
 */
export const NEAREST_STRIDE = 8;

/** Samples along one fitted conic when its deviation from the section is measured. */
export const CONIC_SAMPLES = 250;

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
export const PINNED_TURNS: readonly number[] = [50, 60, 70, 80, 85, 88];

/** Search bracket for a conic's rho (= w / (1 + w)); 0.5 is a parabola. */
export const RHO_MIN = 0.05;
export const RHO_MAX = 0.95;
/** Golden-section iterations when rho is fitted at a fixed tangent point. */
export const RHO_ITERS = 26;
/** Turn-angle values tried for a tangent point, between the floor and the ceiling. */
export const TURN_STEPS = 13;
/** Local refinements of the turn angle around the grid's best rung. */
export const TURN_REFINE = 4;

/** Apex-tangent lean values tried for the five-parameter variant, in degrees off vertical. */
export const LEAN_RANGE = 12;
export const LEAN_STEPS = 9;
/**
 * Flat-at-the-apex heights tried for the other five-parameter variant, as a share of the
 * station's thickness either side of the apex (0 is the four-parameter model).
 */
export const FLAT_RANGE = 0.06;
export const FLAT_STEPS = 7;

/** Stations thinner or narrower than these are skipped: the tips are a lens, not a rail. */
export const MIN_THICKNESS = 0.6;
export const MIN_CHORD = 2.5;

/** Degrees of freedom tried for a parameter's law curve (3 = quadratic, 4 = one cubic span). */
export const LAW_DOFS: readonly number[] = [3, 4, 5];

/** Stations in the dense as-built set, per board. */
export const DENSE_STATIONS = 41;

/**
 * A fifth parameter must beat the four-parameter fit by this much (cm) to be preferred, so a
 * rounding difference is not read as an improvement.
 */
export const FIFTH_MARGIN = 1e-9;
/** Two tangent lines closer to parallel than this (cross product of unit directions) do not meet. */
export const LINE_PARALLEL = 1e-12;
/** A pivot below this is treated as zero when a law's small normal equations are solved. */
export const LAW_PIVOT = 1e-14;

/** The project's section tolerance, cm — what a residual is measured against. */
export const PROJECT_TOL_CM = 0.05;

// ---------------------------------------------------------------------------
// The law-swept mockup (`mockup.ts`)
// ---------------------------------------------------------------------------

/** Stations the mockup fits its two laws on: the study's own dense set. */
export const MOCKUP_FIT_STATIONS = 41;
/**
 * Stations the mockup *sweeps*. Four times the fit set, because the question is what the
 * surface does **between** the stations a law was fitted at — at 41 rows a ripple of one
 * period per fit interval is invisible, which is exactly the ripple to look for.
 */
export const MOCKUP_SWEEP_STATIONS = 181;
/** Columns per section half; the apex is the shared middle column, so `2 h + 1` in all. */
export const MOCKUP_HALF_COLUMNS = 80;
/**
 * Exponential bias of the column schedule towards the apex. The blend is some 30 mm of a
 * 250 mm half, so a uniform ladder would put eight columns on the thing being judged; at
 * this bias about two fifths of them land in the rail band.
 */
export const MOCKUP_COLUMN_BIAS = 3.2;
/** Degrees of freedom of each law curve: the study's recommendation. */
export const MOCKUP_LAW_DOF = 5;
/** Coordinate-descent sweeps and line-search iterations when a law is fitted. */
export const MOCKUP_LAW_SWEEPS = 2;
export const MOCKUP_LAW_ITERS = 14;
/**
 * Turn angles probed when asking whether a half has a blend at *any* allowed tangent point.
 * One-degree steps over the 18-degree band, which is finer than the band's own meaning.
 */
export const MOCKUP_TURN_PROBES = 18;
