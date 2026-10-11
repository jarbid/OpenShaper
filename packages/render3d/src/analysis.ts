// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The 3D view's surface-analysis modes, and what the exact ones are doing at any
 * moment — pure, so the state logic is testable without a WebGL context.
 *
 * Three kinds of mode:
 *
 * - **Screen-space** (`zebra`, `curvature`, `slope`): a shader over the viewport
 *   mesh's averaged normals. Instant, but `curvature` is `fwidth(N)` — the normal's
 *   change per pixel — so it depends on zoom and triangle size and cannot tell a
 *   smooth join from a break. The UI calls it "Normal change (approx.)"; its id
 *   stays `curvature` so saved settings still load.
 * - **Exact** (`mean-curvature`, `gaussian-curvature`, `rail-radius`): principal
 *   curvatures of the fitted B-spline hull, computed in the worker
 *   (`curvature-mesh.ts`).
 * - `none`.
 */
import type { BezierBoard } from '@openshaper/kernel';
import { DIVERGING_RAMP, SEQUENTIAL_RAMP } from './analysis-palette';
import { curvatureUnsupported, type CurvatureMesh, type CurvatureScale } from './curvature-mesh';

export type ExactAnalysisMode = 'mean-curvature' | 'gaussian-curvature' | 'rail-radius';

/** Surface-analysis overlay (replaces the shaded material). */
export type AnalysisMode = 'none' | 'zebra' | 'curvature' | 'slope' | ExactAnalysisMode;

export const isExactAnalysis = (mode: AnalysisMode): mode is ExactAnalysisMode =>
  mode === 'mean-curvature' || mode === 'gaussian-curvature' || mode === 'rail-radius';

/** What the worker last answered, and for which board. */
export type CurvatureResult =
  | { readonly board: BezierBoard; readonly mesh: CurvatureMesh }
  | { readonly board: BezierBoard; readonly error: string };

/**
 * Where an exact analysis stands, for the view (which surface to draw) and for the
 * app (the legend and the "Computing curvature…" indicator).
 */
export type AnalysisStatus =
  | { readonly state: 'off' }
  /** Waiting for the fit: on first selection, and after every edit until it lands. */
  | { readonly state: 'computing'; readonly mode: ExactAnalysisMode }
  /** The board has a concave (swallow / fish) tail, which the fit does not model. */
  | {
      readonly state: 'unavailable';
      readonly mode: ExactAnalysisMode;
      readonly reason: 'concave-tail';
    }
  | { readonly state: 'failed'; readonly mode: ExactAnalysisMode; readonly message: string }
  | {
      readonly state: 'ready';
      readonly mode: ExactAnalysisMode;
      readonly scale: CurvatureScale;
      /** The colours the hull is painted with, low to high. */
      readonly ramp: readonly string[];
    };

export const ANALYSIS_OFF: AnalysisStatus = { state: 'off' };

/** The colour ramp a mode is painted with. */
export const rampFor = (mode: ExactAnalysisMode): readonly string[] =>
  mode === 'rail-radius' ? SEQUENTIAL_RAMP : DIVERGING_RAMP;

/**
 * The status of `mode` for the board on screen, given the latest worker result.
 *
 * A result counts only if it is for this very board: after an edit the live board
 * is a new object, so an older result reads as `computing` and the view falls back
 * to the plain shaded hull rather than painting the old shape's curvature.
 */
export const analysisStatus = (
  mode: AnalysisMode,
  board: BezierBoard | null,
  result: CurvatureResult | null,
): AnalysisStatus => {
  if (!isExactAnalysis(mode) || !board) return ANALYSIS_OFF;
  if (curvatureUnsupported(board)) return { state: 'unavailable', mode, reason: 'concave-tail' };
  if (!result || result.board !== board) return { state: 'computing', mode };
  if ('error' in result) return { state: 'failed', mode, message: result.error };
  return { state: 'ready', mode, scale: result.mesh.scale, ramp: rampFor(mode) };
};

/** Whether two statuses would show the same thing (so a report can be skipped). */
export const sameStatus = (a: AnalysisStatus, b: AnalysisStatus): boolean => {
  if (a.state !== b.state) return false;
  if (a.state === 'off' || b.state === 'off') return true;
  if (a.mode !== b.mode) return false;
  if (a.state === 'failed' && b.state === 'failed') return a.message === b.message;
  if (a.state === 'ready' && b.state === 'ready') return a.scale === b.scale;
  return true;
};
