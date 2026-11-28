// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Test-only: a real rails board (the sample shortboard, converted once) to put into the rails store
 * with rails of a test's choosing, so the rail map, panel and slice are tried against the real store,
 * its actions and its undo history.
 */
import type { RailsBoard } from '@openshaper/board2';
import { parseBrd } from '@openshaper/io';
import { knot, splineFromKnots, vec2 } from '@openshaper/kernel';
import {
  splineToCurve,
  stationSplines,
  type RailKey,
  type RailRecipe,
} from '@openshaper/store/rails';
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

/**
 * The board in the rails store with the deck of every station drawn as a slab: level over most of the half
 * width and steep at the edge, which is not close to a dome and so reads Custom. The sample board's own
 * decks are arcs with a roll, close enough to a dome to read Domed.
 */
export function drawDecksAsSlabs(): void {
  const doc = railsStore.getState().doc as RailsBoard;
  const plus = stationSplines(doc, 'plus');
  const minus = doc.outline.minus ? stationSplines(doc, 'minus') : null;
  const slab = (w: number, T: number) =>
    splineToCurve(
      splineFromKnots([
        knot(vec2(0, T), vec2(0, T), vec2(0.7 * w, T), true),
        knot(vec2(w, T - T / 2), vec2(0.95 * w, T), vec2(w, T - T / 2), true),
      ]),
      w,
      T,
    );
  railsStore.getState().loadDoc({
    ...doc,
    stations: doc.stations.map((st, i) => {
      const p = plus[i]!;
      const m = minus?.[i];
      return {
        ...st,
        plus: p.w > 0 && p.T > 0 ? { ...st.plus, deck: slab(p.w, p.T) } : st.plus,
        ...(st.minus
          ? { minus: m && m.w > 0 && m.T > 0 ? { ...st.minus, deck: slab(m.w, m.T) } : st.minus }
          : {}),
      };
    }),
  });
}
