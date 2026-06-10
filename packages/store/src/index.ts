/** @openshaper/store — board document, command/undo, derived-spec selectors. */
export {
  createBoardStore,
  type BoardState,
  type HistoryEntry,
  type Selection,
} from './board-store';
export {
  canDeleteKnot,
  deleteKnot,
  enforceJunctions,
  getTargetSpline,
  insertCrossSection,
  insertKnotAt,
  moveKnotEnd,
  moveKnotTangent,
  removeCrossSection,
  scaleBoard,
  setKnotContinuous,
  withCrossSections,
  withSpline,
  type SplineTarget,
} from './edits';
export { selectSpecs, type BoardSpecs } from './selectors';
