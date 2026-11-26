// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * What the Bottom step has chosen besides the station: which contour the panel, the slice and the plan are
 * about, whether the drawing shows the bottom curve's own points, and the last thing the panel said. One
 * small module-level store, like the Deck's (`deck-choice.ts`), read by the panel, the slice and the plan, so
 * a choice re-renders those and not the shell.
 *
 * - **The chosen contour** is named by its id in the document. The id can be one the board no longer has
 *   (the contour was removed, or another board was loaded): {@link resolveContour} gives the contour that is
 *   chosen in fact, the first one when the choice is gone.
 * - **Edit curve**: the drawing shows the station's bottom curve in the cross-section editor, knots and
 *   handles, in place of the slice. The bottom curve is the shaper's own either way; a contour never replaces it.
 * - **A status line**: what the last action said ("Held at the most this board allows here").
 *
 * All of it is forgotten when another board is loaded.
 */
import { useSyncExternalStore } from 'react';
import { railsStore } from '../store';

let chosen: string | null = null;
let editCurve = false;
let status = '';
let statusTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

const emit = () => {
  for (const l of [...listeners]) l();
};
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** How long a status line stays, ms. */
export const BOTTOM_STATUS_MS = 6000;

export const getChosenContour = (): string | null => chosen;
export const getBottomEditCurve = (): boolean => editCurve;
export const getBottomStatus = (): string => status;

export const useChosenContourId = (): string | null =>
  useSyncExternalStore(subscribe, getChosenContour, () => null);
export const useBottomEditCurve = (): boolean =>
  useSyncExternalStore(subscribe, getBottomEditCurve, () => false);
export const useBottomStatus = (): string =>
  useSyncExternalStore(subscribe, getBottomStatus, () => '');

/** Choose a contour by its id, or none with null. */
export function setChosenContour(id: string | null): void {
  if (id === chosen) return;
  chosen = id;
  emit();
}

/** Show the bottom curve's own points in the drawing, or the slice and the plan. */
export function setBottomEditCurve(next: boolean): void {
  if (next === editCurve) return;
  editCurve = next;
  emit();
}

/** Say something about the last action; it goes after a few seconds. */
export function setBottomStatus(text: string): void {
  clearTimeout(statusTimer);
  if (status !== text) {
    status = text;
    emit();
  }
  if (text !== '') statusTimer = setTimeout(() => setBottomStatus(''), BOTTOM_STATUS_MS);
}

/**
 * The contour that is chosen in fact: the one `choice` names if the board has it, else the first one the
 * board has, else none. `ids` are the ids of the board's contours in order.
 */
export function resolveContour(ids: readonly string[], choice: string | null): string | null {
  if (choice !== null && ids.includes(choice)) return choice;
  return ids[0] ?? null;
}

/** Forget everything: another board, and tests. */
export function resetBottomChoice(): void {
  clearTimeout(statusTimer);
  if (chosen === null && !editCurve && status === '') return;
  chosen = null;
  editCurve = false;
  status = '';
  emit();
}

/** Follow a rails store, forgetting the choices when another board is loaded. Returns the function that stops. */
export function watchBottomChoice(store: typeof railsStore): () => void {
  return store.subscribe((state, prev) => {
    if (state.loadCount !== prev.loadCount) resetBottomChoice();
  });
}

watchBottomChoice(railsStore);
