/** @openshaper/render3d — Three.js board mesh + 3D scene. */
export { boardGeometry, boardSpan, tessellateAsync, meshToGeometry } from './geometry';
export {
  Board3DView,
  type Board3DViewProps,
  type Board3DMode,
  type LightingPreset,
  type MaterialPreset,
  type AnalysisMode,
  type CameraPose,
} from './Board3DView';
