// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * What the Tail step has chosen besides the tail itself: which corner (the one whose radius the panel's More lists
 * as chosen and whose handle the drawing shows chosen, whether it was picked on the drawing, in the list, or by a tap on
 * the board), which side an edit reaches where the two sides' tails differ, and a status line. One small
 * module-level store, like the Deck step's (`deck-choice.ts`), read by the panel and the drawing, so a choice re-renders
 * those and not the shell.
 *
 * - **The corner** is named as the store names it: the side whose radius list holds it (`plus`, `minus`, or `tail` for the
 *   notch crotch and the tail point) and its place in that list. Which board's corner it was is not kept: another board
 *   forgets it, and so does an edit that leaves no such corner.
 * - **The side** is both unless the shaper chooses one, and only matters where the tails differ.
 *
 * All of it is forgotten when another board is loaded.
 */
import { useSyncExternalStore } from 'react';
import { railsStore } from '../store';

/** A corner of the tail, as `TailCorner` of the store names it. */
export interface CornerChoice {
  readonly side: 'plus' | 'minus' | 'tail';
  readonly index: number;
}

/** Which side an edit reaches. */
export type TailSideChoice = 'both' | 'plus' | 'minus';

let corner: CornerChoice | null = null;
let side: TailSideChoice = 'both';
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
export const STATUS_MS = 6000;

/** Whether two choices name the same corner. */
export const sameCorner = (a: CornerChoice | null, b: CornerChoice | null): boolean =>
  a === b || (a !== null && b !== null && a.side === b.side && a.index === b.index);

export const getChosenCorner = (): CornerChoice | null => corner;
export const getTailSide = (): TailSideChoice => side;
export const getTailStatus = (): string => status;

export const useChosenCorner = (): CornerChoice | null =>
  useSyncExternalStore(subscribe, getChosenCorner, () => null);
export const useTailSide = (): TailSideChoice =>
  useSyncExternalStore(subscribe, getTailSide, () => 'both' as const);
export const useTailStatus = (): string => useSyncExternalStore(subscribe, getTailStatus, () => '');

/** Choose a corner, or none. */
export function setChosenCorner(next: CornerChoice | null): void {
  if (sameCorner(next, corner)) return;
  corner = next;
  emit();
}

/** Choose the side an edit reaches. */
export function setTailSide(next: TailSideChoice): void {
  if (next === side) return;
  side = next;
  emit();
}

/** Say something about the last action; it goes after a few seconds. */
export function setTailStatus(text: string): void {
  clearTimeout(statusTimer);
  if (status !== text) {
    status = text;
    emit();
  }
  if (text !== '') statusTimer = setTimeout(() => setTailStatus(''), STATUS_MS);
}

/** Forget everything: another board, and tests. */
export function resetTailChoice(): void {
  clearTimeout(statusTimer);
  if (corner === null && side === 'both' && status === '') return;
  corner = null;
  side = 'both';
  status = '';
  emit();
}

/** Follow a rails store, forgetting the choices when another board is loaded. Returns the function that stops. */
export function watchTailChoice(store: typeof railsStore): () => void {
  return store.subscribe((state, prev) => {
    if (state.loadCount !== prev.loadCount) resetTailChoice();
  });
}

watchTailChoice(railsStore);
