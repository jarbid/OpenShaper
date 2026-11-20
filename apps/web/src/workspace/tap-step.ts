// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A tap on the board chooses a step.
 *
 * The Patches look reports what a tap found (`usePatchPick`, `patch-look.ts`); this maps it to the
 * design step that edits it. The patch stays highlighted as it always has: choosing the step does
 * not touch the pick.
 *
 * | The tap found | Chooses |
 * | ------------- | ------- |
 * | the deck | Deck |
 * | the bottom | Bottom |
 * | a rail (a zone, a blend, the whole rail) | Rails |
 * | the tail's edge | Tail |
 * | a corner in the tail half of the board | Tail |
 * | a corner in the nose half | Outline |
 *
 * A tap on the deck also chooses the station nearest the tap, so the deck the step shows is the deck at
 * the place that was tapped ({@link stationForPick}). A tap on nothing is no pick, and changes no step.
 */
import { getLength } from '@openshaper/kernel';
import type { PatchPick } from '@openshaper/render3d';
import { sliceOfStation } from '@openshaper/store/rails';
import { useEffect, useRef } from 'react';
import { usePatchPick } from '../patch-look';
import { activeStore, railsStore } from '../store';
import { nearestStation, type StationMark } from './station-strip';
import type { StepId } from './steps';

/**
 * The step for a pick, or null for none. `pick.x` is in board coordinates, cm from the tail (the
 * tail is always at x = 0, nose toward +x), so the tail half is the half below `boardLength / 2`.
 */
export function stepForPick(
  pick: Pick<PatchPick, 'patch' | 'x'> | null,
  boardLength: number,
): StepId | null {
  if (!pick) return null;
  switch (pick.patch) {
    case 'deck':
      return 'deck';
    case 'bottom':
      return 'bottom';
    case 'rail':
      return 'rails';
    case 'tailEdge':
      return 'tail';
    case 'corner':
      return pick.x < boardLength / 2 ? 'tail' : 'outline';
    default:
      return null;
  }
}

/**
 * The classic slice index of the station a tap chooses, or null for a tap that chooses none. Only a tap on
 * the deck does: the station nearest the tap along the board (the earlier of two equally near).
 */
export function stationForPick(
  pick: Pick<PatchPick, 'patch' | 'x'> | null,
  stations: readonly StationMark[],
): number | null {
  if (pick?.patch !== 'deck') return null;
  const nearest = nearestStation(stations, pick.x);
  return nearest === null ? null : sliceOfStation(nearest);
}

/**
 * Choose the step a tap names and, for a tap on the deck, the station nearest it (`setStation`, given the
 * classic slice index). A pick that was already there when this mounted (made in another
 * layout) is not a tap on this one; a pick that is cleared (Escape, a tap on nothing) is not one
 * at all.
 */
export function useTapChoosesStep(
  setStep: (step: StepId) => void,
  setStation?: (slice: number) => void,
): void {
  const pick = usePatchPick();
  const seen = useRef(pick);
  useEffect(() => {
    if (pick === seen.current) return;
    seen.current = pick;
    // Read when the tap lands, not subscribed to: the board changes on every drag move.
    const board = activeStore.getState().board;
    const step = stepForPick(pick, board ? getLength(board) : 0);
    if (step) setStep(step);
    const slice = stationForPick(pick, railsStore.getState().doc?.stations ?? []);
    if (slice !== null) setStation?.(slice);
  }, [pick, setStep, setStation]);
}
