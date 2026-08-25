import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { downloadBoard, type BoardMeta } from './file-io';
import { matches, SHORTCUTS, VIEW_KEYS } from './shortcuts';
import { boardStore } from './store';
import type { View } from './view-toolkit';

/**
 * Global editor keyboard shortcuts.
 *
 * The chords themselves live in `shortcuts.ts` so the docs page, the tooltips and
 * this handler can't drift apart; this module only maps a shortcut id to what it
 * does. Adding a shortcut means adding a row there and a case here.
 *
 * `metaRef` keeps the save handler reading the latest board metadata without
 * re-binding the listener.
 */
export function useKeyboardShortcuts({
  setView,
  setCsIndex,
  metaRef,
  onCommandPalette,
  clearSectionFocus,
}: {
  setView: Dispatch<SetStateAction<View>>;
  setCsIndex: Dispatch<SetStateAction<number>>;
  metaRef: MutableRefObject<BoardMeta>;
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
        case 'save': {
          const b = boardStore.getState().board;
          if (b) downloadBoard(b, metaRef.current);
          return true;
        }
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
      const hit = SHORTCUTS.find((s) => matches(s, e, inField));
      if (!hit) return;
      if (run(hit.id)) e.preventDefault();
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setView, setCsIndex, metaRef, onCommandPalette, clearSectionFocus]);
}
