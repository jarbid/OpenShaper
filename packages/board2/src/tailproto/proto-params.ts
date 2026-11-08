// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Named parameters of the tail-model prototype (`docs/design/tail-model.md`). Scratch
 * module: the engine never imports it. Lengths cm, angles radians.
 */

/**
 * Lengths of option D's C-infinity transition, in multiples of the notch depth `d`
 * (floored at the document's stored zone, so the fan is never shorter than today's).
 * The shortest whose map is increasing and whose chords clear the validator's angle wins.
 */
export const SMOOTH_LAMBDA_LADDER: readonly number[] = [1.5, 2, 3, 4, 6, 8, 12, 16];
/**
 * Floor of option D's start slope at the notch bottom, as a share of the forward branch's
 * slope there: keeps the map increasing when the quintic's `m0` would be tiny.
 */
export const SMOOTH_MIN_SLOPE_SHARE = 0.02;
/** Samples across a prototype map when its monotonicity and chord angles are checked. */
export const PROTO_ANGLE_SAMPLES = 192;
/** Bisections that invert a prototype map (ξ from the outline parameter, and back). */
export const NORMAL_FOOT_BISECT = 60;
/** Central-difference step, as a share of the outline's parameter range, for option B's second derivative. */
export const NORMAL_FOOT_STEP = 1e-5;
/** Samples along a stringer row when the fold is measured (`step.test.ts` uses the same count). */
export const FOLD_SAMPLES = 300;
/** Offset in t at which the cross direction of a stringer row is taken (`step.test.ts`'s step). */
export const FOLD_STEP = 1e-6;
