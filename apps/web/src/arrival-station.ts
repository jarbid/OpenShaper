// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The station a board opens on when it arrives: the one nearest the middle of the board.
 *
 * The Deck and Bottom steps of the workspace show the section at the chosen station, and the shell's
 * choice is raw state that nothing resets for a new board: the tail's first station on a fresh load, a tip
 * that holds about a centimetre of rail. The middle is the one station that means the same on every board
 * (`nearestMidpointSection`), and a shared board has always opened there.
 *
 * Every way a board arrives (a file, a template, the New board gallery, a recent board, a restored session,
 * a share link) is chosen here, once, not by each path that opens a board:
 *
 * - **A rails board.** However it arrived, it ends the same way: the rails store holds the board of the
 *   classic store's load (`boardStore.loadCount`) and is the one shown. The choice is made the first time
 *   that is true for a load. A board converted from a classic one gets there a moment after the classic
 *   board loads, and is chosen for then.
 * - **A shared board.** Opening one resets its presentation (`presentSharedBoard` in `App.tsx`), the station
 *   with it, whatever kind of board it is: that path counts its resets in an epoch, and a new count is a
 *   choice.
 *
 * Nothing else is touched: with the rails engine off, or a sections document open, a board that is not
 * shared keeps the station the shell had, so the tabbed layout with a classic board opens as it always did.
 */
import type { BezierBoard } from '@openshaper/kernel';
import { useState, useSyncExternalStore } from 'react';
import { useRailsCurrent } from './rails-engine';
import { nearestMidpointSection } from './section-index';
import { activeStore, boardStore, railsStore } from './store';

/** What a choice is made for: the load whose rails board is shown, and how many shared boards were presented. */
export interface Arrival {
  /** `boardStore.loadCount` whose rails board is the one being edited; null when none is. */
  readonly rails: number | null;
  /** The number of shared boards presented so far. */
  readonly shared: number;
}

/**
 * The station to open on, or null to leave the station as it is.
 *
 * @param now What is shown now.
 * @param placed What a station was last chosen for.
 * @param board The board the editors show (the rails store's, when a rails board is the one shown).
 */
export function arrivalStation(
  now: Arrival,
  placed: Arrival,
  board: BezierBoard | null,
): number | null {
  if (board === null) return null;
  const railsArrived = now.rails !== null && now.rails !== placed.rails;
  const sharedArrived = now.shared !== placed.shared;
  return railsArrived || sharedArrived ? nearestMidpointSection(board) : null;
}

/**
 * Choose the station a board opens on when it arrives. The choice is made while rendering, not in an
 * effect, so the tip is never drawn first and no second commit is paid.
 *
 * Turning the rails engine on for a board that is already open is an arrival too: a station number chosen
 * on the classic board does not name the same place on the rails board, whose stations are its own.
 * Turning it off and on again for the same board is not: the person's station stays.
 *
 * @param board The board the editors show.
 * @param setStation The shell's station setter.
 * @param shared How many shared boards have been presented (counted by the caller).
 */
export function useArrivalStation(
  board: BezierBoard | null,
  setStation: (index: number) => void,
  shared: number,
): void {
  const loadCount = useSyncExternalStore(
    boardStore.subscribe,
    () => boardStore.getState().loadCount,
  );
  // Read from the switch itself, not from the engines: the switch is pointed in a layout effect, and until
  // it is the board shown is still the classic one, whose stations differ.
  const railsShown = useSyncExternalStore(
    activeStore.subscribe,
    () => activeStore.target === railsStore,
  );
  const railsOfLoad = useRailsCurrent();
  const [placed, setPlaced] = useState<Arrival>({ rails: null, shared });

  const now: Arrival = { rails: railsShown && railsOfLoad ? loadCount : null, shared };
  const station = arrivalStation(now, placed, board);
  if (station !== null) {
    // The rails load stays what it was while no rails board is shown, so showing the same one again is not a new arrival.
    setPlaced({ rails: now.rails ?? placed.rails, shared });
    setStation(station);
  }
}
