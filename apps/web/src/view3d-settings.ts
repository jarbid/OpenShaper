// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * 3D view settings: the type, its defaults, and the option lists the controls
 * render from.
 *
 * Deliberately free of React, so `view-state.ts` can sanitise a persisted blob
 * against these values without pulling the component tree into its tests.
 */
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

export const ANALYSIS_3D: { value: AnalysisMode; label: string }[] = [
  { value: 'none', label: 'No analysis' },
  { value: 'zebra', label: 'Zebra' },
  { value: 'curvature', label: 'Curvature' },
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
};
