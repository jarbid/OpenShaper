/** @openshaper/store — board document, command/undo, derived-spec selectors. */
export {
  createBoardStore,
  type BoardState,
  type HistoryEntry,
  type Selection,
} from './board-store';
export {
  alignTangentsHorizontal,
  alignTangentsVertical,
  canDeleteKnot,
  deleteKnot,
  enforceJunctions,
  extendKnotTangent,
  fairKnot,
  getTargetSpline,
  insertCrossSection,
  insertKnotAt,
  moveKnotEnd,
  moveKnotTangent,
  moveCrossSectionPosition,
  removeCrossSection,
  scaleBoard,
  setKnotContinuous,
  zeroKnotTangent,
  withCrossSections,
  withSpline,
  type SplineTarget,
} from './edits';
export { selectSpecs, type BoardSpecs } from './selectors';
