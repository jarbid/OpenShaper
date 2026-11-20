// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * What the Deck step has chosen besides the station: how far a shape reaches, and whether the drawing
 * shows the curve's own points. One small module-level store, like the rail map's (`rail-choice.ts`),
 * read by the panel, the slice and the drawing, so a choice re-renders those and not the shell.
 *
 * - **The scope**: a shape and a crown reach every station (`all`) or the chosen one alone
 *   (`station`). It starts as every station, since a board's deck is usually one shape along its
 *   length, and it is not remembered between sessions: a shape applied to one station by mistake
 *   because an old choice was still on would be a silent surprise.
 * - **Edit curve**: the drawing shows the deck curve's knots and handles in the cross-section editor,
 *   whatever the shape. A Custom curve is always shown that way, since its points are all there is to
 *   it; the choice here is for the curve of a Flat or a Domed deck.
 * - **A status line**: what the last action said ("Held at the most this station can hold").
 *
 * All of it is forgotten when another board is loaded.
 */
import { useSyncExternalStore } from 'react';
import { railsStore } from '../store';

/** How far a shape reaches. */
export type DeckScopeChoice = 'all' | 'station';

let scope: DeckScopeChoice = 'all';
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
export const STATUS_MS = 6000;

export const getDeckScope = (): DeckScopeChoice => scope;
export const getDeckEditCurve = (): boolean => editCurve;
export const getDeckStatus = (): string => status;

export const useDeckScope = (): DeckScopeChoice =>
  useSyncExternalStore(subscribe, getDeckScope, () => 'all' as const);
export const useDeckEditCurve = (): boolean =>
  useSyncExternalStore(subscribe, getDeckEditCurve, () => false);
export const useDeckStatus = (): string => useSyncExternalStore(subscribe, getDeckStatus, () => '');

/** Reach every station, or the chosen one alone. */
export function setDeckScope(next: DeckScopeChoice): void {
  if (next === scope) return;
  scope = next;
  emit();
}

/** Show the deck curve's own points in the drawing, or the shape's one handle. */
export function setDeckEditCurve(next: boolean): void {
  if (next === editCurve) return;
  editCurve = next;
  emit();
}

/** Say something about the last action; it goes after a few seconds. */
export function setDeckStatus(text: string): void {
  clearTimeout(statusTimer);
  if (status !== text) {
    status = text;
    emit();
  }
  if (text !== '') statusTimer = setTimeout(() => setDeckStatus(''), STATUS_MS);
}

/** Forget everything: another board, and tests. */
export function resetDeckChoice(): void {
  clearTimeout(statusTimer);
  if (scope === 'all' && !editCurve && status === '') return;
  scope = 'all';
  editCurve = false;
  status = '';
  emit();
}

/** Follow a rails store, forgetting the choices when another board is loaded. Returns the function that stops. */
export function watchDeckChoice(store: typeof railsStore): () => void {
  return store.subscribe((state, prev) => {
    if (state.loadCount !== prev.loadCount) resetDeckChoice();
  });
}

watchDeckChoice(railsStore);
