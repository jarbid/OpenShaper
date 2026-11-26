// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The text of a saved NURBS document that a restored session could not revive, kept for the classic
 * board that was loaded with it.
 *
 * A session stores the classic board it opened beside the text of the document that was edited. When the
 * text is not revived at restore (the NURBS engine is off, the code would not load, or the text is a rails
 * board of a newer version or of the wrong shape), the autosave writes it back unchanged, so the saved
 * board is not lost to a conversion of the classic board that stands in for it.
 *
 * The hold belongs to one load of the classic store (`boardStore.loadCount`): the next board opened or
 * started loads another, which ends it, and the autosave then writes that board's own text. A held text
 * that is a rails board stays held while the engines run: neither engine converts the classic board over
 * it ({@link useKeptRails}).
 */
import { useSyncExternalStore } from 'react';
import { isRailsText } from './rails-files';
import { boardStore } from './store';

/**
 * Why a rails board's text was not revived at restore: `invalid` (a version this app does not read, or
 * the wrong shape) or `unavailable` (the code that reads it would not load: offline, a stale app shell).
 */
export type HeldReason = 'invalid' | 'unavailable';

export interface Held {
  /** `boardStore.loadCount` of the classic board the text was held for. */
  readonly loadCount: number;
  readonly text: string;
  /** The text is a rails board's, which no engine revives from here: it is kept as it is. */
  readonly rails: boolean;
  /** Why a rails text was not revived; null when it is not one, or the reason is not known. */
  readonly reason: HeldReason | null;
}

let held: Held | null = null;
const listeners = new Set<() => void>();
const set = (next: Held | null): void => {
  held = next;
  for (const l of [...listeners]) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** Keep `text` for the classic board just loaded (call it right after the classic store loaded that board). */
export const holdText = (text: string, reason?: HeldReason): void =>
  set({
    loadCount: boardStore.getState().loadCount,
    text,
    rails: isRailsText(text),
    reason: reason ?? null,
  });

/** Let go of the held text (a document was attached, or a test starts over). */
export const releaseHeld = (): void => {
  if (held !== null) set(null);
};

/** The held text for the classic board now open, if any. */
export const heldFor = (loadCount: number): string | null =>
  held && held.loadCount === loadCount ? held.text : null;

/** The held text of a rails board for the classic board now open, if there is one. */
export const keptRailsFor = (loadCount: number): Held | null =>
  held && held.loadCount === loadCount && held.rails ? held : null;

/**
 * The held text of a rails board that did not read, for the classic board now open (null when none).
 * The engines wait on it: converting the classic board would replace the text at the next autosave.
 */
export function useKeptRails(loadCount: number): Held | null {
  const current = useSyncExternalStore(subscribe, () => held);
  return current && current.loadCount === loadCount && current.rails ? current : null;
}
