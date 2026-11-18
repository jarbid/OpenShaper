// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The divider between the board and the drawing, as numbers: where it may sit, what the keys do to
 * it and how it is remembered. `SplitPane.tsx` draws it; nothing here touches the DOM.
 *
 * The position is the board's share of the column, a fraction from 0.25 to 0.75, 0.55 to begin
 * with. It is shown (`aria-valuenow`) and moved by keys in whole percent, so a key press is
 * always the 2 % the person sees.
 */
import { readStored, writeStored } from '../persisted';

export const SPLIT_MIN = 0.25;
export const SPLIT_MAX = 0.75;
export const SPLIT_DEFAULT = 0.55;
/** What an arrow key moves it, in percent. */
export const SPLIT_KEY_PERCENT = 2;
export const SPLIT_STORAGE_KEY = 'bs.workspaceSplit';

/** The nearest position the divider may take; a value that is not a number is the default. */
export const clampSplit = (fraction: number): number =>
  Number.isFinite(fraction) ? Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, fraction)) : SPLIT_DEFAULT;

/** The position as the whole percent that is shown. */
export const splitPercent = (fraction: number): number => Math.round(fraction * 100);

/**
 * Where the divider goes for a key, or null for a key it does not use. Up and Left move it up (the
 * board gets less), Down and Right move it down; Home and End go to the ends.
 */
export function splitAfterKey(key: string, fraction: number): number | null {
  const now = splitPercent(clampSplit(fraction));
  switch (key) {
    case 'ArrowUp':
    case 'ArrowLeft':
      return clampSplit((now - SPLIT_KEY_PERCENT) / 100);
    case 'ArrowDown':
    case 'ArrowRight':
      return clampSplit((now + SPLIT_KEY_PERCENT) / 100);
    case 'Home':
      return SPLIT_MIN;
    case 'End':
      return SPLIT_MAX;
    default:
      return null;
  }
}

/**
 * The position for a pointer at height `y` in a column that starts at `top` and is `height` tall,
 * with a divider `handle` tall: the divider's middle follows the pointer.
 */
export function splitAtPointer(y: number, top: number, height: number, handle: number): number {
  const room = height - handle;
  return room > 0 ? clampSplit((y - top - handle / 2) / room) : SPLIT_DEFAULT;
}

/** The remembered position, or the default; one that is out of range is brought in. */
export function readSplit(): number {
  return readStored(SPLIT_STORAGE_KEY, SPLIT_DEFAULT, (v) =>
    typeof v === 'number' ? clampSplit(v) : SPLIT_DEFAULT,
  );
}

export function writeSplit(fraction: number): void {
  writeStored(SPLIT_STORAGE_KEY, clampSplit(fraction));
}
