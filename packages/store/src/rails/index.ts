// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `@openshaper/store/rails`: the rails store, a `BoardState` over a rails board (board2's
 * `RailsBoard`), its classic projection and its pure document edits, and the rail's zones, dials
 * and built-in rails (`zones.ts`, `dials.ts`, `library.ts`). Imports the types of
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
export {
  RAIL_LIMITS,
  RAIL_NUMBERS,
  TIDY_TOLERANCE,
  ZONE_MIN_GAP,
  ZONE_SCALES,
  editSides,
  linkSides,
  moveZone,
  moveZoneEnd,
  railAt,
  railDistance,
  railZones,
  removeZone,
  sameRailKeys,
  sameRailSides,
  setZoneNumber,
  setZoneRail,
  sidesLinked,
  splitZoneAt,
  tidyRails,
  unlockSide,
  zoneIndexAt,
  type Blend,
  type RailNumber,
  type RailSide,
  type Zone,
} from './zones';
export { DIAL_RANGES, apexLabel, applyDials, dialsOf, type RailDials } from './dials';
export {
  BUILT_IN_RAILS,
  NAME_TOLERANCE,
  railName,
  type BuiltInRail,
  type NamedRail,
} from './library';
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
