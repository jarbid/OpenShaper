import type { BoardDoc, RailsBoard } from '@openshaper/board2';
import { createBoardStore, type BoardState } from '@openshaper/store';
import { createRailsStore, type RailsState } from '@openshaper/store/rails';
import { createSectionStore } from '@openshaper/store/sections';
import { createStoreSwitch } from './store-switch';

/**
 * App-wide classic board document store (single instance for the session). The classic document
 * stays the reference of what was opened, whichever engine is on.
 */
export const boardStore = createBoardStore();

/**
 * The NURBS section document store (docs/design/m2-editor.md §1). Empty until the engine converts a
 * board into it (`use-section-engine.ts`). Only the types of board2 reach this module, so the main chunk
 * carries neither board2 nor geom.
 */
export const sectionStore = createSectionStore();

/**
 * The rails board store: the document the editors edit with the rails engine on. Empty until a
 * rails board is made or opened (`rails-engine.ts`).
 */
export const railsStore = createRailsStore();

/**
 * The store the editors edit: the rails store with the rails engine on and a rails board in it, else
 * the section store with the NURBS engine on and a document in it, else the classic store. `App` points
 * it (`use-document-engines.ts`); everything else just reads it.
 */
export const activeStore = createStoreSwitch(boardStore);

/**
 * What the document panels (tail, symmetry, notch depth, bottom features) use of the document store
 * being edited. The section and rails stores have these actions with the same names and meanings.
 */
export type DocumentState = Pick<
  RailsState,
  | 'loadCount'
  | 'editing'
  | 'beginEdit'
  | 'endEdit'
  | 'setSymmetry'
  | 'setTail'
  | 'setNotchDepth'
  | 'addFeature'
  | 'featureLimits'
  | 'removeFeature'
  | 'setFeatureEnabled'
  | 'setFeatureParams'
  | 'setFeatureDepth'
  | 'setFeatureKey'
  | 'addFeatureKey'
  | 'removeFeatureKey'
> & { readonly doc: BoardDoc | RailsBoard | null };

/** The document store being edited: the rails store when it is the one shown, else the section store. */
export const docStore = createStoreSwitch<DocumentState>(sectionStore);

/** The NURBS document (of either kind) a store's state holds, if it is a document store's state. */
export const docOf = (state: BoardState): BoardDoc | RailsBoard | null =>
  (state as { doc?: BoardDoc | RailsBoard | null }).doc ?? null;

/**
 * The NURBS document being edited right now (of either kind), or null with the classic store shown.
 * Read at the moment of an action (save, share, export), not subscribed to.
 */
export const activeNurbsDoc = (): BoardDoc | RailsBoard | null => docOf(activeStore.getState());
