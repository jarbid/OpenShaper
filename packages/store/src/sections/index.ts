// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `@openshaper/store/sections`: the section store, a `BoardState` over a NURBS section document
 * (docs/design/m2-editor.md §1), its classic projection and its pure document edits. Imports the
 * types of `@openshaper/board2`, never its code, so it can sit in the main chunk.
 */
export { createSectionStore, type SectionHistoryEntry, type SectionState } from './section-store';
export { applyBoardEdit, scaleLength, withChain } from './edits';
export {
  chainToSpline,
  deckToSpline,
  projectDoc,
  sectionToSlice,
  sliceToSection,
  splineToChain,
  splineToDeckChain,
} from './project';
