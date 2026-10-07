import { useEffect, type Dispatch, type SetStateAction } from 'react';
import { getTargetSpline } from '@openshaper/store';
import { isTextEntry, matches, SHORTCUTS, VIEW_KEYS } from './shortcuts';
import { boardStore } from './store';
import type { View } from './view-toolkit';

/**
 * Global editor keyboard shortcuts.
 *
 * The chords themselves live in `shortcuts.ts` so the docs page, the tooltips and
 * this handler can't drift apart; this module only maps a shortcut id to what it
 * does. Adding a shortcut means adding a row there and a case here.
 *
 * Save goes through `onSave`, the same path as File > Save, so it records the
 * save and refreshes Open recent like the menu does.
 */
export function useKeyboardShortcuts({
  setView,
  setCsIndex,
  onSave,
  onCommandPalette,
  clearSectionFocus,
}: {
  /** Switching is gated by layout tier, so this is the app's `selectView`, not a raw setter. */
  setView: (view: View) => void;
  setCsIndex: Dispatch<SetStateAction<number>>;
  /** Ctrl/Cmd+S. Pass a stable callback — the listener re-binds when it changes. */
  onSave: () => void;
  /** Ctrl/Cmd+K. Pass a stable callback — the listener re-binds when it changes. */
  onCommandPalette: () => void;
  /**
   * Release the focused station marker. Returns whether one was focused, so a
   * stray Escape still reaches whatever else is listening (menus, dialogs).
   */
  clearSectionFocus: () => boolean;
}): void {
  useEffect(() => {
    /** Step the cross-section index, clamped to the editable stations. */
    const pageCrossSection = (delta: -1 | 1) => {
      const b = boardStore.getState().board;
      const last = Math.max(1, (b?.crossSections.length ?? 0) - 2);
      setCsIndex((i) => {
        const cur = Math.min(Math.max(i, 1), last);
        return delta === -1 ? Math.max(1, cur - 1) : Math.min(last, cur + 1);
      });
    };

    const run = (id: string): boolean => {
      switch (id) {
        case 'undo':
          boardStore.getState().undo();
          return true;
        case 'redo':
        case 'redo-alt':
          boardStore.getState().redo();
          return true;
        case 'save':
          onSave();
          return true;
        case 'command-palette':
          onCommandPalette();
          return true;
        case 'delete-point': {
          const sel = boardStore.getState().selection;
          // Nothing selected: let the key through rather than swallowing it.
          if (!sel) return false;
          boardStore.getState().deleteControlPoint(sel.target, sel.index);
          return true;
        }
        case 'toggle-lock': {
          const { board, selection, setLocked } = boardStore.getState();
          const knot =
            board && selection && getTargetSpline(board, selection.target).knots[selection.index];
          // Nothing selected: let the key through rather than swallowing it.
          if (!selection || !knot) return false;
          setLocked(selection.target, selection.index, !knot.lock);
          return true;
        }
        case 'cross-section-prev':
          pageCrossSection(-1);
          return true;
        case 'cross-section-next':
          pageCrossSection(1);
          return true;
        // Clear either kind of editor focus. With nothing selected, let Escape
        // through to menus and dialogs instead of swallowing it.
        case 'cross-section-blur': {
          const hadSplineSelection = boardStore.getState().selection !== null;
          if (hadSplineSelection) boardStore.getState().select(null);
          return clearSectionFocus() || hadSplineSelection;
        }
        default: {
          const view = VIEW_KEYS.find((v) => `view-${v.key}` === id);
          if (!view) return false;
          setView(view.view);
          return true;
        }
      }
    };

    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const inField =
        !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

      // First match wins. `⇧⌘Z` is listed before `⌘Z`-without-shift can claim it,
      // and `matches` rejects a bare `⌘Z` when Shift is held, so the two can't collide.
      const hit = SHORTCUTS.find((s) => matches(s, e, inField, isTextEntry(t)));
      if (!hit) return;
      // Behind an open dialog the board is not what the user is working on: only
      // Save, and the palette's own toggle (Ctrl/Cmd+K closes it), stay live.
      const modal = document.querySelector<HTMLElement>('[data-modal]');
      if (
        modal &&
        hit.id !== 'save' &&
        !(hit.id === 'command-palette' && modal.dataset.modal === 'command-palette')
      ) {
        return;
      }
      if (run(hit.id)) e.preventDefault();
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setView, setCsIndex, onSave, onCommandPalette, clearSectionFocus]);
}
