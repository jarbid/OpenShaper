// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The fin designer's keyboard shortcuts. The chords live in `shortcuts.ts` with the
 * board editor's (one table, so `/docs/shortcuts` lists both); this maps the ids the
 * fin page uses to fin store actions. Ids it doesn't use (`[`, the view keys) are
 * left to the browser.
 */
import { finOutward, type FinHand } from '@openshaper/kernel';
import type { FinState } from '@openshaper/store';
import { useEffect } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import { isTextEntry, matches, SHORTCUTS } from '../shortcuts';

/** Nudge steps (cm): the arrow keys and the arrow buttons share them. */
export const NUDGE_FORE_CM = 0.05;
export const NUDGE_LATERAL_CM = 0.01;

/**
 * Slide the blade across the tab toward the screen's left or right as the view from
 * above shows it (nose up the screen). Which of those is outboard depends on the fin's
 * hand: a left fin's outside face is on the left, a right fin's on the right.
 */
export const nudgeAcross = (s: FinState, side: 'left' | 'right'): boolean =>
  s.nudgeLateral(acrossSign(s.design?.hand ?? null, side) * NUDGE_LATERAL_CM);

/** +1 where `side` (as seen from above) is outboard for this hand, −1 where inboard. */
export const acrossSign = (hand: FinHand | null, side: 'left' | 'right'): number =>
  side === 'left' ? finOutward(hand) : -finOutward(hand);

export function useFinShortcuts(
  store: StoreApi<FinState>,
  { onSave }: { onSave: () => void },
): void {
  useEffect(() => {
    const run = (id: string): boolean => {
      const s = store.getState();
      switch (id) {
        case 'undo':
          s.undo();
          return true;
        case 'save':
          onSave();
          return true;
        case 'redo':
        case 'redo-alt':
          s.redo();
          return true;
        case 'delete-point':
          if (!s.selection) return false;
          s.deleteSelectedPoints();
          return true;
        case 'cross-section-blur':
          if (!s.selection) return false;
          s.select(null);
          return true;
        // The nudges move the whole fin: off while a cant line is selected, as their buttons are.
        case 'fin-nudge-forward':
        case 'fin-nudge-back':
        case 'fin-nudge-left':
        case 'fin-nudge-right':
          if (s.activeCantLine > 0) return false;
          // On a US box the arrows are fore and aft only, as the buttons are.
          if (s.design?.base === 'us-box' && (id === 'fin-nudge-left' || id === 'fin-nudge-right'))
            return false;
          return nudge(id);
        default:
          return false;
      }
    };
    const nudge = (id: string): boolean => {
      const s = store.getState();
      switch (id) {
        case 'fin-nudge-forward':
          s.nudgeFore(NUDGE_FORE_CM);
          return true;
        case 'fin-nudge-back':
          s.nudgeFore(-NUDGE_FORE_CM);
          return true;
        case 'fin-nudge-left':
          nudgeAcross(s, 'left');
          return true;
        case 'fin-nudge-right':
          nudgeAcross(s, 'right');
          return true;
        default:
          return false;
      }
    };
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const inField =
        !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      const hit = SHORTCUTS.find((sc) => matches(sc, e, inField, isTextEntry(t)));
      if (hit && run(hit.id)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store, onSave]);
}
