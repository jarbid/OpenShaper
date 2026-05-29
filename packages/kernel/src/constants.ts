/**
 * Numerical constants ported from the legacy `cadcore.BezierSpline` (and
 * `MathUtils`). The legacy hard-coded these; here they are named and exported so
 * callers can override per-operation where it matters (see CLAUDE.md principle 3).
 *
 * Units note: the board model works in centimeters, so POS_TOLERANCE = 0.003 cm
 * (0.03 mm) and LENGTH_TOLERANCE = 0.001 cm.
 */
export const DEG_TO_RAD = Math.PI / 180;
export const RAD_TO_DEG = 180 / Math.PI;

/** Parameter-domain guards (legacy BezierSpline.ZERO / ONE). */
export const T_ZERO = 0.0000000001;
export const T_ONE = 0.9999999999;

/** getTForX / getYForX Newton iteration. */
export const POS_TOLERANCE = 0.003; // 0.03 mm
export const POS_MAX_ITERATIONS = 30;

/** Arc-length subdivision. */
export const LENGTH_TOLERANCE = 0.001;

/** Tangent-angle search. */
export const ANGLE_TOLERANCE = 0.05 * DEG_TO_RAD; // ~0.05 degrees
export const ANGLE_T_TOLERANCE = 0.000002;
export const ANGLE_MAX_ITERATIONS = 50;

/** Numerical min/max search. */
export const MIN_MAX_TOLERANCE = 0.0001;
export const MIN_MAX_SPLITS = 96;

/** Closest-point / distance search. */
export const DISTANCE_TOLERANCE = 0.0001;
