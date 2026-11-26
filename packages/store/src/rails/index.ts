// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `@openshaper/store/rails`: the rails store, a `BoardState` over a rails board (board2's
 * `RailsBoard`), its classic projection and its pure document edits, and the rail's zones, dials
 * and built-in rails (`zones.ts`, `dials.ts`, `library.ts`), the deck's shapes and crown
 * (`deck-shapes.ts`) and the bottom's contours (`contours.ts`). Imports the types of
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
export {
  BAND_SHARE_MAX,
  CROWN_MIN,
  DECK_SHAPES,
  DEFAULT_WALL_FALL_SHARE,
  DOME_READ_TOLERANCE,
  FLAT_TOLERANCE,
  SIDES_TOLERANCE,
  WALL_MIN,
  WALL_SLOPE_MAX,
  applyDeckShape,
  bandAt,
  bandEdge,
  deckCrownRange,
  deckCrownRangeAt,
  deckShapeAt,
  deckShapeOf,
  domeFall,
  domedSpline,
  flatSpline,
  heightAt,
  wallFallFor,
  type DeckCrownRange,
  type DeckReading,
  type DeckScope,
  type DeckShapeId,
  type DeckShapeName,
  type DeckShapeRequest,
  type DeckSide,
  type DeckStationReading,
} from './deck-shapes';
export {
  CONTOUR_DEFAULTS,
  CONTOUR_KINDS,
  EXTENT_DIALS,
  MAX_CONTOURS,
  WALL_SHARE,
  addContour,
  canAddContour,
  chordsOf,
  contourAt,
  contourBands,
  contourDepth,
  contourDepthAt,
  contourDepthMax,
  contourDials,
  contourExtent,
  contourKeys,
  contourKindInfo,
  contourProfile,
  contourReliefAt,
  contourShapeAt,
  contourRoom,
  contoursOf,
  moveContour,
  setContourDepth,
  setContourExtent,
  setContourKey,
  setContourParams,
  type Band,
  type Contour,
  type ContourDial,
  type ContourDials,
  type ContourKey,
  type ContourKind,
  type ContourKindInfo,
  type DialInfo,
  type DialKey,
} from './contours';
export { blendMatched, insertStation, splitChainAt, withKnotsLike } from './station-insert';
export { MIN_STATIONS } from '../sections/edits';
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
