// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The converter's named parameters (docs/design/board2.md §12.2). Like the
 * core's `params.ts`, this file is where the converter's thresholds are
 * written down (`no-magic-tolerances.test.ts` exempts it by name); the reason
 * for every value is in the design table, and for the one S6 added
 * (`lineSampleSpacing`) below and in "S6 as built".
 */
import { deepFreeze } from '../freeze';
import type { ConvertOptions } from './types';

const DEG = Math.PI / 180;

/**
 * Parameter-correction passes of the plan-loop fit (§9.3). One pass moves
 * every sample to its foot point on the fitted loop (geom's Newton iteration,
 * to `paramRel`) and refits, so the error the adaptive loop judges is the
 * sample's distance to the loop rather than a parametric error with a
 * tangential part. Measured on the three goldens: the first pass cuts the
 * knots from 490–534 to 116–224; a second or third changes them by under 3 %
 * and costs a fit each. The stringer lines are graphs over x with exact
 * parameters and need none.
 */
export const LINE_CORRECTION_PASSES = 1;

/**
 * Most knot-refinement passes of a line fit (§9.3, §9.4; review of S6). A
 * pass splits every failing span at its middle distinct parameter, so a start
 * span (`surfaceKnotSpacing.x`, 10 cm, of samples `lineSampleSpacing`, 0.05 cm,
 * apart: 200 of them) holds fewer than two samples after ⌈log₂ 200⌉ = 8 passes;
 * a span can fail again after a refit elsewhere, so twice that. Measured: at
 * most 6 on the fourteen files. A fit that stops above `lineTol` (here, or
 * because no failing span can be split) is reported as `not-converged`.
 */
export const LINE_REFINE_PASSES = 16;

/**
 * The §12.2 defaults, frozen.
 *
 * `maxBandCorrectionPasses`, `bandCorrectionStall` (review of S7, replacing a
 * fixed two passes): the band's parameter correction stops once a pass improves
 * the judged maximum distance by less than 2 % of it, or after 4 passes. A pass
 * costs 0.7–1.0 s (assembly, fairness search, re-projection) and the goldens
 * still gain 5–8 % per pass at the fourth (0.067 → 0.059 cm on the shortboard;
 * the plateau, 0.056 cm, takes 6 passes and +41 % conversion time, 4 passes
 * +21 %); the synthetic files gain 0.1 % per pass and stop after one.
 *
 * `lineSampleSpacing` (S6): the outline and the rocker and deck lines are
 * sampled exactly on the classic curves at this arc-length spacing. A tenth of
 * `sampleSpacingX`: near a fillet (radius `cornerFilletRadius`, so a curvature
 * jump of 2 cm⁻¹ where it meets a straight side) a C² cubic needs knot spans of
 * a few millimetres to stay within `lineTol`, and the adaptive fit only splits
 * a span that holds data on both sides of its new knot.
 */
export const DEFAULT_CONVERT_OPTIONS: ConvertOptions = deepFreeze({
  lineTol: 0.001,
  surfaceTol: 0.005,
  deckInsetFraction: 0.21,
  tuckInsetFraction: 0.08,
  cornerAngleMin: 2 * DEG,
  cornerFilletRadius: 0.5,
  sampleSpacingX: 0.5,
  ringSamples: 128,
  lineSampleSpacing: 0.05,
  creaseProbe: 0.01,
  endGap: 0.001,
  surfaceKnotSpacing: { x: 10, y: 5 },
  minKnotSpacing: 1.5,
  creaseWindow: 3,
  tipWindow: 2,
  trimDataMargin: 1,
  maxRefinePasses: 6,
  maxBandCorrectionPasses: 4,
  bandCorrectionStall: 0.02,
  fairnessRatioBracket: [1e-10, 1],
  fairnessSearchSteps: 12,
});
