// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `@openshaper/store/sections`: the section store, a `BoardState` over a NURBS section document
 * (docs/design/m2-editor.md §1), its classic projection and its pure document edits. Imports the
 * types of `@openshaper/board2`, never its code, so it can sit in the main chunk.
 */
export { createSectionStore, type SectionHistoryEntry, type SectionState } from './section-store';
export {
  MIN_STATIONS,
  addStation,
  alignEnds,
  applyBoardEdit,
  applyMinusEdit,
  moveStation,
  removeStation,
  scaleLength,
  withChain,
} from './edits';
export {
  defaultNotchDepth,
  notchDepthRange,
  setNotchDepth,
  setSymmetry,
  setTail,
  tailTypeOf,
  toAsymmetric,
  toMirror,
  type KeepSide,
  type TailType,
} from './shape';
export {
  chainToSpline,
  deckToSpline,
  projectDoc,
  sectionToSlice,
  sliceDims,
  sliceToSection,
  splineToChain,
  splineToDeckChain,
  type NotchChords,
} from './project';
