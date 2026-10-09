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
  canLockKnot,
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
  sameTarget,
  scaleBoard,
  setKnotContinuous,
  setKnotLock,
  setKnotTangentLength,
  zeroKnotTangent,
  withCrossSections,
  withSpline,
  type SplineTarget,
} from './edits';
export { selectSpecs, type BoardSpecs } from './selectors';
