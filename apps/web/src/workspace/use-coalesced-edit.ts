// SPDX-License-Identifier: GPL-3.0-or-later
import { useMemo } from 'react';
import { railsStore } from '../store';

/**
 * Make a run of edits one undo step: a slider dragged, or an arrow key held down. `begin` opens the
 * store's edit (once), `end` closes it; both are safe to call twice. The caller begins on the first
 * pointer-down or key-down and ends on the pointer-up, the key-up and the blur.
 */
export function useCoalescedEdit(): { begin: () => void; end: () => void } {
  return useMemo(() => {
    let open = false;
    return {
      begin: () => {
        if (open) return;
        const s = railsStore.getState();
        if (s.editing) return;
        open = true;
        s.beginEdit();
      },
      end: () => {
        if (!open) return;
        open = false;
        const s = railsStore.getState();
        if (s.editing) s.endEdit();
      },
    };
  }, []);
}
