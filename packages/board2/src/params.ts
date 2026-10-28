// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Named parameters of the section-based model (docs/design/m1-model.md; one
 * tolerance, 0.5 mm, in docs/design/nurbs-plan.md). Every numeric threshold in
 * `src` lives here (`no-magic-tolerances.test.ts` exempts this file only).
 * Lengths are cm, angles radians.
 */
import type { BuildSettings } from './types';

/** The document's format tag, version and model (the plan's "v2"; classic `.board.json` is already v2). */
export const BOARD_FORMAT = 'openshaper';
export const BOARD_VERSION = 3;
export const BOARD_MODEL = 'sections';

/** Defaults of {@link BuildSettings}: the mesh tolerance (0.5 mm) and the share of the bottom half over which features fade. */
export const DEFAULT_BUILD: BuildSettings = Object.freeze({ tolerance: 0.05, railFade: 0.2 });

// ---------------------------------------------------------------------------
// Section fit (m1-model.md §2, "Smooth blend")
// ---------------------------------------------------------------------------

/** A station's fitted section must be within this of the stored one (cm). */
export const SECTION_FIT_TOL = 0.01;
/** Samples per half section (bottom to apex, apex to deck) taken at equal arc-length fractions. */
export const SECTION_HALF_SAMPLES = 192;
/** Spans per half of the common knot vector, tried in order until every station fits. */
export const SECTION_SPAN_LADDER: readonly number[] = [12, 16, 24, 32, 48];
/** Polyline samples per Bézier segment when measuring arc length. */
export const CHAIN_ARC_SAMPLES = 48;

// ---------------------------------------------------------------------------
// Frame and evaluation
// ---------------------------------------------------------------------------

/** Newton/bisection iteration cap of the inverse function solves (x → parameter). */
export const SOLVE_MAX_ITER = 80;
/** Relative parameter step at which an inverse solve stops. */
export const SOLVE_PARAM_REL = 1e-15;
/**
 * Floor of dx/ds where a plan end is vertical (a blunt tail or nose): derivatives
 * there are singular and are evaluated with this floor so they stay finite.
 */
export const TIP_SLOPE_FLOOR = 1e-9;
/** Smallest chord length (cm) for which the chord-length derivatives of a channel are formed. */
export const CHORD_FLOOR = 1e-9;

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/** Rounding slack of the exact-equality rules (centre points, apex u, bounds), in normalised units. */
export const SECTION_EXACT_TOL = 1e-12;
/** Smallest angle (rad) at which a notch-zone chord may cross the outline: 20 degrees. */
export const MIN_CHORD_ANGLE = (20 * Math.PI) / 180;
/** Samples per outline segment for the monotonicity and notch checks. */
export const OUTLINE_CHECK_SAMPLES = 24;
/** Samples across a notch zone for p' > 0 and the chord angles. */
export const NOTCH_CHECK_SAMPLES = 96;
/** Samples per line segment of the rocker/deck thickness check. */
export const LINE_CHECK_SAMPLES = 16;
/** Smallest thickness (cm) the rocker and deck may leave anywhere. */
export const MIN_THICKNESS = 0;
/** Samples per station interval when reporting blend overshoot. */
export const BLEND_CHECK_SAMPLES = 8;

/** Slack (cm) of the plan's exact coordinates: a standard tail at x = 0, a notch tip at x = 0, stringer points at y = 0. */
export const PLAN_EXACT_TOL = 1e-9;

/** Smallest ratio of wall distance to stringer distance at the start of a notch zone's chord map. */
export const NOTCH_MIN_LAMBDA = 0.05;
