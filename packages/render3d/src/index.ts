/** @openshaper/render3d — Three.js board mesh + 3D scene. */
export {
  boardCenter,
  boardGeometry,
  boardSpan,
  curvatureAsync,
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
export {
  isExactAnalysis,
  type AnalysisMode,
  type AnalysisStatus,
  type ExactAnalysisMode,
} from './analysis';
export type { CurvatureScale } from './curvature-mesh';
export { Guides3D } from './Guides3D';
export { apexGuideLine, guideLines, type GuideLine, type GuideLines } from './guide-lines';
export { useBoardOffset, type BoardPlacement } from './use-board-offset';
