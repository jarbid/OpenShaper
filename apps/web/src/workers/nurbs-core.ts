// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The NURBS viewer's compute (docs/design/m1-model.md §3). `nurbs-worker.ts` runs it
 * in a Web Worker; the synchronous fallback (tests, no `Worker`) imports it directly.
 *
 * **NOT YET WIRED (M1 step 3).** The viewer used to convert a classic board with the
 * retired rail-law model and tessellate its B-rep. That model is deleted; the
 * section-based model (`@openshaper/board2`: `buildBoard`, `createEvaluator`) has an
 * evaluator but not yet the grid mesh (step 2) or the direct converter (step 2), so
 * until step 3 rewires this module every job answers with a refusal the viewer shows
 * as an ordinary error. The protocol, the client and the display modes keep their code.
 */
import type { BezierBoard } from '@openshaper/kernel';
import type {
  NurbsIssue,
  NurbsMeshData,
  NurbsStage,
  NurbsSummary,
  NurbsTimings,
} from './nurbs-protocol';

/** The progress callback of a job; the worker posts it, tests record it. */
export type Progress = (stage: NurbsStage) => void;

/** The outcome of a job: what the worker answers with, minus the request id. */
export type NurbsOutcome =
  | {
      readonly ok: true;
      readonly docJson: string;
      readonly issues: readonly NurbsIssue[];
      readonly summary: NurbsSummary | null;
      readonly timings: NurbsTimings;
      readonly mesh: NurbsMeshData;
    }
  | { readonly ok: false; readonly error: string; readonly issues: readonly NurbsIssue[] };

/** The refusal every job gets until step 3. */
export const NOT_WIRED =
  'The NURBS viewer is being rebuilt on the section-based model (not yet wired).';

const notWired = (): NurbsOutcome => ({ ok: false, error: NOT_WIRED, issues: [] });

/** Convert a classic board and mesh it (not yet wired, M1 step 3). */
export const convertAndMesh = (
  _modelId: number,
  _board: BezierBoard,
  _faceSize: number,
  _progress?: Progress,
): NurbsOutcome => notWired();

/** Mesh an already converted board at another face size (not yet wired, M1 step 3). */
export const remesh = (
  _modelId: number,
  _docJson: string,
  _board: BezierBoard,
  _faceSize: number,
  _progress?: Progress,
): NurbsOutcome => notWired();
