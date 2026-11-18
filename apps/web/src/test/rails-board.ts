// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Test-only: a real rails board (the sample shortboard, converted once) to put into the rails store
 * with rails of a test's choosing, so the rail map, panel and slice are tried against the real store,
 * its actions and its undo history.
 */
import type { RailsBoard } from '@openshaper/board2';
import { parseBrd } from '@openshaper/io';
import type { RailKey, RailRecipe } from '@openshaper/store/rails';
import sampleBrd from '../sample-board.brd?raw';
import { resetRailChoice } from '../rail-choice';
import { activeStore, railsStore } from '../store';

let converted: RailsBoard | undefined;

/** The sample board as a rails board (188 cm long). Converted on the first call, then kept. */
export async function sampleRailsBoard(): Promise<RailsBoard> {
  if (converted) return converted;
  const core = await import('../workers/nurbs-core');
  const made = core.toRails({ classic: parseBrd(sampleBrd).board });
  if (!made.ok) throw new Error(made.error);
  converted = made.board as RailsBoard;
  return converted;
}

/** The board's length, cm. */
export const SAMPLE_LENGTH = 187.96;

/** A rail with every number as `Round` has it, except the apex. */
export const rail = (apex: number, patch: Partial<RailRecipe> = {}): RailRecipe => ({
  band: 2,
  hardness: 0.5,
  tuck: 1.4,
  tuckShape: 0.45,
  bottomEdge: 0,
  deckEdge: 0,
  apex,
  ...patch,
});

/** A key of the rail at `x`. */
export const key = (x: number, apex: number, patch: Partial<RailRecipe> = {}): RailKey => ({
  x,
  rail: rail(apex, patch),
});

/**
 * Make the sample board, with `rails`, the board being edited: the rails store holds it (history
 * clear, the choice and the place reset) and is the active store.
 */
export async function showRails(rails: RailsBoard['rails']): Promise<RailsBoard> {
  const base = await sampleRailsBoard();
  const doc: RailsBoard = { ...base, rails };
  activeStore.use(railsStore);
  railsStore.getState().loadDoc(doc);
  resetRailChoice();
  return doc;
}
