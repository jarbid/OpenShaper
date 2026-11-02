import { createBoardStore } from '@openshaper/store';
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
 * The store the editors edit: the section store with the NURBS engine on and a document in it, the
 * classic store otherwise. `App` points it (`activeStore.use`); everything else just reads it.
 */
export const activeStore = createStoreSwitch(boardStore);
