// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Test-only STEP helpers: the writer without its validity gate (for the
 * mutation suite, which writes deliberately broken B-reps to see what importers
 * and `checkBrep` make of them), re-exported next to the subset reader.
 */
import type { BrepReport } from '../brep/check';
import { writeStepCore } from '../step/write';
import type { StepWriteOptions } from '../step/write';
import type { Brep } from '../types';

/** A report claiming no measured gap: unchecked output declares only the floor uncertainty. */
const NO_GAPS: BrepReport = Object.freeze({
  ok: true,
  issues: Object.freeze([]),
  edgeGaps: new Float64Array(0),
  maxEdgeGap: 0,
  maxVertexGap: 0,
  euler: Object.freeze({ V: 0, E: 0, F: 0, L: 0, S: 0, G: 0, holds: true }),
  signedVolume: 0,
});

/**
 * The STEP text of `b` without `checkBrep`: it writes whatever it is given, so
 * only the mutation suite should call it. Gaps are not measured, so the
 * declared uncertainty is the floor.
 */
export function writeStepUnchecked(b: Brep, opts?: StepWriteOptions): string {
  return writeStepCore(b, opts, NO_GAPS).text;
}

export { readStepSubset } from '../step/read';
