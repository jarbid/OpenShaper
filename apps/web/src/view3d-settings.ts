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
 * fitted B-spline hull, which a concave tail does not have; `ghost` the one that
 * measures against a loaded ghost board.
 *
 * `curvature` is the old screen-space mode, kept under its id so saved settings
 * still load, and labelled for what it measures: how fast the mesh normal turns
 * per pixel, which changes with zoom and triangle size.
 */
export const ANALYSIS_3D: {
  value: AnalysisMode;
  label: string;
  exact?: true;
  ghost?: true;
}[] = [
  { value: 'none', label: 'No analysis' },
  { value: 'zebra', label: 'Zebra' },
  { value: 'mean-curvature', label: 'Mean curvature', exact: true },
  { value: 'gaussian-curvature', label: 'Gaussian curvature', exact: true },
  { value: 'rail-radius', label: 'Rail radius', exact: true },
  { value: 'curvature', label: 'Normal change (approx.)' },
  { value: 'slope', label: 'Slope' },
  { value: 'ghost-deviation', label: 'Deviation from ghost', ghost: true },
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
  /**
   * Half-width (cm) of the "Deviation from ghost" colour band: full colour at ± this
   * much, saturated beyond. Within {@link DEVIATION_BAND}.
   */
  deviationBand: number;
}

/**
 * The deviation band's range and step (cm): 1 mm to 2 cm in half-millimetre steps,
 * 5 mm by default — wide enough that a deliberate change reads as a strong colour,
 * narrow enough that a sanding-sized one still shows.
 */
export const DEVIATION_BAND = { min: 0.1, max: 2, step: 0.05, initial: 0.5 } as const;

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
  deviationBand: DEVIATION_BAND.initial,
};

/** The menu label of an analysis mode. */
export const analysisLabel = (mode: AnalysisMode): string =>
  ANALYSIS_3D.find((o) => o.value === mode)?.label ?? mode;

/** Shown wherever an exact mode is offered or chosen for a board with a concave tail. */
export const EXACT_ANALYSIS_CONCAVE_TAIL =
  'Mean curvature, Gaussian curvature and rail radius need the fitted surface, which does not yet model concave (swallow / fish) tails. Normal change (approx.) still works on this board.';

/** Why analysis modes are off: in full, and short enough for a menu entry. */
export interface AnalysisBlock {
  readonly reason: string;
  readonly short: string;
}

/**
 * Why the exact analysis modes are unavailable for `board`, or null when they are
 * available. The same rule as the STEP export, for the same reason: both read the
 * fitted surface (`fitBoardSurface`).
 */
export const exactAnalysisUnavailable = (board: BezierBoard | null): AnalysisBlock | null =>
  board && hasTailCutout(board.outline)
    ? { reason: EXACT_ANALYSIS_CONCAVE_TAIL, short: 'not for concave tails' }
    : null;

/** Shown wherever the deviation map is offered or chosen with no ghost loaded. */
export const GHOST_DEVIATION_NO_GHOST =
  'Deviation from ghost compares this board with a reference board. Load one with Board ▸ Open ghost… first.';

/** Why the deviation map is unavailable — there is no ghost to measure against — or null. */
export const ghostDeviationUnavailable = (ghost: BezierBoard | null): AnalysisBlock | null =>
  ghost ? null : { reason: GHOST_DEVIATION_NO_GHOST, short: 'load a ghost first' };
