/** @openshaper/render2d — canvas viewport + 2D editor draw layer. */
export {
  CSS_PX_PER_CM,
  worldToScreen,
  screenToWorld,
  fitToBounds,
  zoomAt,
  pan,
  lifeSizeViewport,
  type Viewport,
  type Bounds,
  type ScreenPoint,
} from './viewport';
export { sampleSpline, boundsOf } from './sample';
export { hitTest, type Hit, type HandleKind } from './hit';
export {
  drawSpline,
  drawGhostSpline,
  drawControlPoints,
  drawGrid,
  gridStep,
  drawSectionMarkers,
  drawCurvatureComb,
  drawVerticalMarkers,
  drawDistribution,
  drawFinsPlan,
  drawFinsProfile,
  hitFin,
  drawMeasureCursor,
  drawVProbe,
  MEASURE_COLORS,
  hitSectionMarker,
  clear,
  defaultStyle,
  type DrawStyle,
  type Mirror,
  type SectionMarker,
  type EditorOverlays,
} from './draw';
export { SplineEditor, type SplineEditorProps } from './SplineEditor';
