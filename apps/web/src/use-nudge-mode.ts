// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef } from 'react';
import { isTextEntry, NUDGE } from './shortcuts';

/** What the arrow keys do to the selected point or handle. */
export type NudgeMode = 'move' | 'rotate' | 'length';

const modeForKey = (key: string): NudgeMode | undefined => {
  const k = key.toLowerCase();
  return k === NUDGE.rotateKey ? 'rotate' : k === NUDGE.lengthKey ? 'length' : undefined;
};

/**
 * Which nudge mode the held keys select: hold R to turn, T to change length (see
 * {@link NUDGE}). Read `.current` when an arrow key arrives; holding and releasing a
 * key never re-renders.
 *
 * - A hold key typed into a text field is typing, not a mode. With Ctrl, Cmd or
 *   Alt it is another chord (⌘R reloads the page), so that is ignored too.
 * - A hold key does nothing by itself, and its default is left alone.
 * - Holding both, the one pressed last wins; letting it go hands back to the other.
 * - A mode ends on its key's keyup, wherever the focus is by then, and whenever a
 *   keyup can be missed: the window losing focus, the tab being hidden, and Cmd
 *   being released (macOS sends no keyup for a key let go while Cmd is down).
 */
export function useNudgeMode(): { readonly current: NudgeMode } {
  const mode = useRef<NudgeMode>('move');
  useEffect(() => {
    const held: NudgeMode[] = [];
    const sync = () => {
      mode.current = held.at(-1) ?? 'move';
    };
    const clear = () => {
      held.length = 0;
      sync();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const m = modeForKey(e.key);
      if (!m || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTextEntry(e.target as HTMLElement | null)) return;
      if (!held.includes(m)) held.push(m);
      sync();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Meta') return clear();
      const m = modeForKey(e.key);
      const i = m ? held.indexOf(m) : -1;
      if (i < 0) return;
      held.splice(i, 1);
      sync();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') clear();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', clear);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      clear();
    };
  }, []);
  return mode;
}
