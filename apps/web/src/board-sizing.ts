// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A rails board's length, widest width and thickness as the Resize section reads them, and the board
 * made again at another size by the Resize section's own code.
 *
 * Kept apart from `board-types.ts` (the five kinds of board, their ranges and what holds a value to
 * them), which is plain data: this module imports the rails store, and the documentation pages that
 * quote the ranges must not carry it.
 */
import type { RailsBoard } from '@openshaper/board2';
import { selectSpecs } from '@openshaper/store';
import { createRailsStore, projectRails } from '@openshaper/store/rails';
import type { BoardSize } from './board-types';

/**
 * The size of a board: the numbers the sidebar's specs show as Length, Width and Thickness, and the
 * ones its Resize section scales to. Length is the outline's, width is twice the greatest half width,
 * and thickness is the deck's height over the bottom's at mid-length (not the thickest place on the
 * board). All in cm.
 */
export function measureRails(board: RailsBoard): BoardSize {
  const specs = selectSpecs(projectRails(board, null), false);
  return { length: specs.length, width: specs.maxWidth, thickness: specs.thickness };
}

/**
 * A dimension within this many cm of the board's own (10 micrometres) is left as it is. A size that
 * came from the board's own numbers, rounded to be stored or shown, then opens the board unchanged
 * instead of scaling it by a factor of 1.00001.
 */
export const SAME_SIZE = 1e-3;

/** The factor that takes a dimension from `was` to `to`: exactly 1 when they are the same. */
const factor = (to: number, was: number): number =>
  !(was > 0) || !Number.isFinite(to) || Math.abs(to - was) < SAME_SIZE ? 1 : to / was;

/**
 * `board` at `size`: the board the Resize section makes when it is given this length, width and
 * thickness. It is that code: a private rails store loads the board and scales it by the factors the
 * Resize section computes from the same readings ({@link measureRails}), so the two cannot differ.
 *
 * What follows the scale (`scaleBoard` of the rails store, `rails/edits.ts`):
 * - the outline, the rocker and the deck line are stretched, the plan by the length and the width and the
 *   two lines by the length and the thickness; the tail stays at x = 0;
 * - the stations and the rail keys move to the same share of the length, and so do the keys of a bottom
 *   feature's depth; each station's curves are normalised to its half width and thickness, so they follow
 *   as they are (the same objects);
 * - a rail's band and tuck scale with the width, and its other numbers (the two edge angles, the
 *   hardness, the tuck shape and the apex) do not;
 * - the corner radii are lengths in cm and stay as they are, the fins' placement scales with the board.
 *
 * Pure in effect: nothing outside the call is read or changed. `board` itself when the size is the
 * board's own.
 */
export function sizeRailsBoard(board: RailsBoard, size: BoardSize): RailsBoard {
  const now = measureRails(board);
  const fL = factor(size.length, now.length);
  const fW = factor(size.width, now.width);
  const fT = factor(size.thickness, now.thickness);
  if (fL === 1 && fW === 1 && fT === 1) return board;
  const store = createRailsStore();
  store.getState().loadDoc(board);
  store.getState().scaleBoard(fL, fW, fT);
  return store.getState().doc ?? board;
}
