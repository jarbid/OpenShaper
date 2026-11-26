/** @openshaper/render3d — Three.js board mesh + 3D scene. */
export {
  boardBox,
  boardCenter,
  boardGeometry,
  boardSpan,
  curvatureAsync,
  deviationAsync,
  tessellateAsync,
  meshToGeometry,
} from './geometry';
export {
  Board3DView,
  type Board3DViewProps,
  type Board3DMode,
  type LightingPreset,
  type MaterialPreset,
  type CameraPose,
} from './Board3DView';
export { defaultCameraPosition, type DefaultView } from './view-framing';
export {
  DEFAULT_DEVIATION_BAND,
  isDeviationAnalysis,
  isExactAnalysis,
  type AnalysisMode,
  type AnalysisStatus,
  type ComputedAnalysisMode,
  type DeviationAnalysisMode,
  type ExactAnalysisMode,
} from './analysis';
export type { CurvatureMesh, CurvatureScale } from './curvature-mesh';
export type { DeviationMesh } from './deviation-mesh';
export { sameHull, surfaceApplies, type ExternalSurface } from './external-surface';
export { Guides3D } from './Guides3D';
export { apexGuideLine, guideLines, type GuideLine, type GuideLines } from './guide-lines';
export { RefPoints3D, refPointMarks, type RefPointMark } from './RefPoints3D';
export { useBoardOffset, type BoardPlacement } from './use-board-offset';
export {
  MAX_ZONES,
  PATCH,
  PATCH_COLORS,
  PATCH_NAMES,
  RAIL_ZONE_COLORS,
  locateZone,
  railZoneColor,
  type PatchName,
  type PatchPick,
  type PatchSeams,
  type PatchSelection,
  type RailZone,
  type RailZones,
  type Side,
} from './patches';
