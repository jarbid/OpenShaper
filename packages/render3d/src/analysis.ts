// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The 3D view's surface-analysis modes, and what the exact ones are doing at any
 * moment — pure, so the state logic is testable without a WebGL context.
 *
 * Four kinds of mode:
 *
 * - **Screen-space** (`zebra`, `curvature`, `slope`): a shader over the viewport
 *   mesh's averaged normals. Instant, but `curvature` is `fwidth(N)` — the normal's
 *   change per pixel — so it depends on zoom and triangle size and cannot tell a
 *   smooth join from a break. The UI calls it "Normal change (approx.)"; its id
 *   stays `curvature` so saved settings still load.
 * - **Exact** (`mean-curvature`, `gaussian-curvature`, `rail-radius`): principal
 *   curvatures of the fitted B-spline hull, computed in the worker
 *   (`curvature-mesh.ts`).
 * - **Deviation** (`ghost-deviation`): the signed distance from the hull to a ghost
 *   (reference) board, computed in the worker (`deviation-mesh.ts`).
 * - `none`.
 */
import type { BezierBoard } from '@openshaper/kernel';
import { DIVERGING_RAMP, NO_DATA_STRIPES, SEQUENTIAL_RAMP } from './analysis-palette';
import { curvatureUnsupported, type CurvatureMesh, type CurvatureScale } from './curvature-mesh';
import type { DeviationMesh } from './deviation-mesh';
import { boardCenter } from './geometry';

export type ExactAnalysisMode = 'mean-curvature' | 'gaussian-curvature' | 'rail-radius';

/** The modes computed in a worker, which report where they stand (`AnalysisStatus`). */
export type ComputedAnalysisMode = ExactAnalysisMode | 'ghost-deviation';

/** Surface-analysis overlay (replaces the shaded material). */
export type AnalysisMode = 'none' | 'zebra' | 'curvature' | 'slope' | ComputedAnalysisMode;

export const isExactAnalysis = (mode: AnalysisMode): mode is ExactAnalysisMode =>
  mode === 'mean-curvature' || mode === 'gaussian-curvature' || mode === 'rail-radius';

/**
 * Default half-width (cm) of the deviation map's colour band: full colour at ±5 mm.
 * The app passes the user's own setting; this is only the view's fallback.
 */
export const DEFAULT_DEVIATION_BAND = 0.5;

/** What the worker last answered, and for which board. */
export type CurvatureResult =
  | { readonly board: BezierBoard; readonly mesh: CurvatureMesh }
  | { readonly board: BezierBoard; readonly error: string };

/** What the deviation worker last answered, and for which board and ghost. */
export type DeviationResult =
  | { readonly board: BezierBoard; readonly ghost: BezierBoard; readonly mesh: DeviationMesh }
  | { readonly board: BezierBoard; readonly ghost: BezierBoard; readonly error: string };

/**
 * Where a computed analysis stands, for the view (which surface to draw) and for the
 * app (the legend and the "Computing…" indicator).
 */
export type AnalysisStatus =
  | { readonly state: 'off' }
  /**
   * Waiting for the worker. An exact mode: on first selection, and after every edit
   * until the fit lands. The deviation: until there is a result for this ghost.
   */
  | { readonly state: 'computing'; readonly mode: ComputedAnalysisMode }
  /** The board has a concave (swallow / fish) tail, which the fit does not model. */
  | {
      readonly state: 'unavailable';
      readonly mode: ExactAnalysisMode;
      readonly reason: 'concave-tail';
    }
  /** No ghost board is loaded, so there is nothing to measure against. */
  | {
      readonly state: 'unavailable';
      readonly mode: 'ghost-deviation';
      readonly reason: 'no-ghost';
    }
  | { readonly state: 'failed'; readonly mode: ComputedAnalysisMode; readonly message: string }
  | {
      readonly state: 'ready';
      readonly mode: ExactAnalysisMode;
      readonly scale: CurvatureScale;
      /** The colours the hull is painted with, low to high. */
      readonly ramp: readonly string[];
    }
  | {
      readonly state: 'ready';
      readonly mode: 'ghost-deviation';
      /** Full colour at ± this many cm; beyond it the colour saturates. */
      readonly band: number;
      /** The smallest and largest deviation on the board shown (cm); null with no data. */
      readonly range: readonly [number, number] | null;
      /** The colours the hull is painted with, less foam to more. */
      readonly ramp: readonly string[];
      /** The two greys striped where there is no data (past the ghost's ends, the tips). */
      readonly stripes: readonly [string, string];
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

/**
 * The status of the deviation map for the board on screen, given the latest worker
 * result.
 *
 * Unlike the curvature, a result for an earlier board still counts while the next
 * is on its way, as long as it was measured against this ghost: the job takes a
 * fraction of a second, and the map stays up through an edit — on its own mesh, a
 * step behind — rather than dropping to the plain hull and back after every move.
 * A result against another ghost never counts.
 */
export const deviationStatus = (
  board: BezierBoard | null,
  ghost: BezierBoard | null,
  result: DeviationResult | null,
  band: number,
): AnalysisStatus => {
  const mode = 'ghost-deviation';
  if (!board) return ANALYSIS_OFF;
  if (!ghost) return { state: 'unavailable', mode, reason: 'no-ghost' };
  if (!result || result.ghost !== ghost) return { state: 'computing', mode };
  if ('error' in result) {
    // An earlier board's failure: this board's own job is still to come.
    return result.board === board
      ? { state: 'failed', mode, message: result.error }
      : { state: 'computing', mode };
  }
  const { range } = result.mesh;
  return { state: 'ready', mode, band, range, ramp: DIVERGING_RAMP, stripes: NO_DATA_STRIPES };
};

/** Whether two statuses would show the same thing (so a report can be skipped). */
export const sameStatus = (a: AnalysisStatus, b: AnalysisStatus): boolean => {
  if (a.state !== b.state) return false;
  if (a.state === 'off' || b.state === 'off') return true;
  if (a.mode !== b.mode) return false;
  if (a.state === 'failed' && b.state === 'failed') return a.message === b.message;
  if (a.state === 'ready' && b.state === 'ready') {
    if (a.mode === 'ghost-deviation' && b.mode === 'ghost-deviation') {
      return a.band === b.band && a.range === b.range;
    }
    if (a.mode !== 'ghost-deviation' && b.mode !== 'ghost-deviation') return a.scale === b.scale;
  }
  return true;
};

/**
 * The centre the exact-analysis surface is placed around (negated, as for the hull).
 *
 * The hull's own centre when the hull on screen is meshed from this board, so the
 * painted surface sits exactly where the hull, fins and guides do. Otherwise (the
 * fit landed before the mesh, or the board's tessellation failed and the previous
 * hull stays) the curvature mesh's own bounding-box centre: a `ready` status then
 * always paints the surface it reports, instead of a legend over a plain hull.
 */
export const curvatureCenter = (
  hull: { readonly board: BezierBoard; readonly center: readonly [number, number, number] } | null,
  board: BezierBoard,
  mesh: CurvatureMesh,
): readonly [number, number, number] =>
  hull && hull.board === board ? hull.center : boardCenter(mesh);
