/** @openshaper/render2d — canvas viewport + 2D editor draw layer. */
export {
  worldToScreen,
  screenToWorld,
  fitToBounds,
  zoomAt,
  pan,
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
  drawFins,
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
