// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `@openshaper/store/rails`: the rails store, a `BoardState` over a rails board (board2's
 * `RailsBoard`), its classic projection and its pure document edits. Imports the types of
 * `@openshaper/board2` and its code-free `defaults` module, never engine code, so it can sit in
 * the main chunk.
 */
export { createRailsStore, type RailsHistoryEntry, type RailsState } from './rails-store';
export {
  addStation,
  applyRailsEdit,
  applyRailsMinusEdit,
  cornerKnots,
  matchChainKnots,
  moveStation,
  remapCorners,
  removeStation,
  scaleRailWidths,
  scaleRailsLength,
} from './edits';
export {
  constrainHalfCurve,
  halfCurveFrame,
  obeysHalfCurveRules,
  type HalfCurveFrame,
} from './half-curve';
export { chainHeightAt, halfWidthFn, isNotched, thicknessAt } from './measure';
export {
  curveToSpline,
  polylineSpline,
  projectRails,
  splineToCurve,
  standInSection,
  stationSplines,
} from './project';
export { setNotchDepth, setSymmetry, setTail, tailTypeOf, toAsymmetric, toMirror } from './shape';
export { sliceOfStation, stationOfSlice } from './types';
export type {
  RailKey,
  RailRecipe,
  RailsCorners,
  RailsSlices,
  RailsStation,
  StationCurves,
  StationSlice,
} from './types';
export type { RailsProjection, StationHalf, StationSplines } from '../edits';
