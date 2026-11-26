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
 * A tap on the deck or the bottom also chooses the station nearest the tap, so the section the step shows is the
 * one at the place that was tapped ({@link stationForPick}); a tap on the bottom that is over a contour also
 * chooses that contour ({@link contourForPick}). A tap on nothing is no pick, and changes no step.
 */
import type { RailsBoard } from '@openshaper/board2';
import { getLength } from '@openshaper/kernel';
import type { PatchPick } from '@openshaper/render3d';
import { contourAt, sliceOfStation } from '@openshaper/store/rails';
import { useEffect, useRef } from 'react';
import { usePatchPick } from '../patch-look';
import { activeStore, railsStore } from '../store';
import { setChosenContour } from './bottom-choice';
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
 * the deck or the bottom does: the station nearest the tap along the board (the earlier of two equally near).
 */
export function stationForPick(
  pick: Pick<PatchPick, 'patch' | 'x'> | null,
  stations: readonly StationMark[],
): number | null {
  if (pick?.patch !== 'deck' && pick?.patch !== 'bottom') return null;
  const nearest = nearestStation(stations, pick.x);
  return nearest === null ? null : sliceOfStation(nearest);
}

/**
 * The id of the contour a tap on the bottom is over, or null: the narrowest enabled contour whose run and
 * stretch across the bottom hold the tapped place (`contourAt`), read on the side of the board the tap is on.
 * A tap anywhere else, or on the bottom where no contour acts, is over none.
 */
export function contourForPick(
  pick: Pick<PatchPick, 'patch' | 'x' | 'y' | 'side'> | null,
  doc: RailsBoard | null,
): string | null {
  if (pick?.patch !== 'bottom' || !doc) return null;
  return contourAt(doc, pick.x, pick.y, pick.side);
}

/**
 * Choose the step a tap names and, for a tap on the deck or the bottom, the station nearest it (`setStation`,
 * given the classic slice index) and, for a tap over a contour, that contour. A pick that was already there when this mounted (made in another
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
    const doc = railsStore.getState().doc;
    const slice = stationForPick(pick, doc?.stations ?? []);
    if (slice !== null) setStation?.(slice);
    const contour = contourForPick(pick, doc);
    if (contour !== null) setChosenContour(contour);
  }, [pick, setStep, setStation]);
}
