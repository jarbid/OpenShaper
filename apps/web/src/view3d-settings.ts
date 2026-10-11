// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * 3D view settings: the type, its defaults, and the option lists the controls
 * render from.
 *
 * Deliberately free of React, so `view-state.ts` can sanitise a persisted blob
 * against these values without pulling the component tree into its tests.
 */
import { hasTailCutout, type BezierBoard } from '@openshaper/kernel';
import type {
  AnalysisMode,
  Board3DMode,
  LightingPreset,
  MaterialPreset,
} from '@openshaper/render3d';

/** Viewport mesh density. Maps to a kernel target face size (cm) — smaller = finer. */
export type MeshQuality = 'draft' | 'standard' | 'fine';

export const MODE_3D: { value: Board3DMode; label: string }[] = [
  { value: 'shaded', label: 'Shaded' },
  { value: 'shaded-wire', label: '+Wire' },
  { value: 'wireframe', label: 'Wire' },
  { value: 'normals', label: 'Normals' },
];

export const LIGHTING_3D: { value: LightingPreset; label: string }[] = [
  { value: 'studio', label: 'Studio' },
  { value: 'shaping-bay', label: 'Shaping bay' },
  { value: 'neutral', label: 'Neutral' },
];

export const MATERIAL_3D: { value: MaterialPreset; label: string }[] = [
  { value: 'gloss', label: 'Glassed gloss' },
  { value: 'foam', label: 'Raw foam' },
  { value: 'matte', label: 'Matte' },
];

/**
 * Surface-analysis modes, in menu order. `exact` marks the ones computed from the
 * fitted B-spline hull, which a concave tail does not have.
 *
 * `curvature` is the old screen-space mode, kept under its id so saved settings
 * still load, and labelled for what it measures: how fast the mesh normal turns
 * per pixel, which changes with zoom and triangle size.
 */
export const ANALYSIS_3D: { value: AnalysisMode; label: string; exact?: true }[] = [
  { value: 'none', label: 'No analysis' },
  { value: 'zebra', label: 'Zebra' },
  { value: 'mean-curvature', label: 'Mean curvature', exact: true },
  { value: 'gaussian-curvature', label: 'Gaussian curvature', exact: true },
  { value: 'rail-radius', label: 'Rail radius', exact: true },
  { value: 'curvature', label: 'Normal change (approx.)' },
  { value: 'slope', label: 'Slope' },
];

export const QUALITY_3D: { value: MeshQuality; label: string }[] = [
  { value: 'draft', label: 'Draft' },
  { value: 'standard', label: 'Standard' },
  { value: 'fine', label: 'Fine' },
];

const FACE_SIZE: Record<MeshQuality, number> = {
  draft: 1.5,
  standard: 0.9,
  fine: 0.5,
};

/** Resolve a mesh-quality setting to a kernel target face size in cm. */
export const faceSizeFor = (q: MeshQuality): number => FACE_SIZE[q];

/** All 3D-view appearance + analysis settings, lifted so quad + full views share them. */
export interface View3DSettings {
  mode: Board3DMode;
  lighting: LightingPreset;
  material: MaterialPreset;
  color: string;
  analysis: AnalysisMode;
  meshQuality: MeshQuality;
  /** Draw the stringer plane's silhouette on the hull. */
  showStringer: boolean;
  /** Draw a ring at every real cross-section, the active one highlighted. */
  showSections: boolean;
  /** Draw the rail apex line — each station's widest point — on both rails. */
  showApex: boolean;
}

export const DEFAULT_VIEW_3D: View3DSettings = {
  mode: 'shaded',
  lighting: 'studio',
  material: 'gloss',
  color: '#E8EEF5',
  analysis: 'none',
  meshQuality: 'standard',
  showStringer: false,
  showSections: false,
  showApex: false,
};

/** The menu label of an analysis mode. */
export const analysisLabel = (mode: AnalysisMode): string =>
  ANALYSIS_3D.find((o) => o.value === mode)?.label ?? mode;

/** Shown wherever an exact mode is offered or chosen for a board with a concave tail. */
export const EXACT_ANALYSIS_CONCAVE_TAIL =
  'Mean curvature, Gaussian curvature and rail radius need the fitted surface, which does not yet model concave (swallow / fish) tails. Normal change (approx.) still works on this board.';

/** Why the exact modes are off: in full, and short enough for a menu entry. */
export interface ExactAnalysisBlock {
  readonly reason: string;
  readonly short: string;
}

/**
 * Why the exact analysis modes are unavailable for `board`, or null when they are
 * available. The same rule as the STEP export, for the same reason: both read the
 * fitted surface (`fitBoardSurface`).
 */
export const exactAnalysisUnavailable = (board: BezierBoard | null): ExactAnalysisBlock | null =>
  board && hasTailCutout(board.outline)
    ? { reason: EXACT_ANALYSIS_CONCAVE_TAIL, short: 'not for concave tails' }
    : null;
