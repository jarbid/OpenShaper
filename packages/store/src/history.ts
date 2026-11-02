// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Undo / redo history shared by the two document stores (the classic board store and the section
 * store, docs/design/m2-editor.md §1). One implementation of the rules, so a drag coalesces into one
 * step, a refused drag leaves none, and `undo`, `redo` and `jumpTo` keep the same labels in both.
 *
 * A history entry is a snapshot of the document that was current before the action plus the action's
 * name. What a snapshot holds, and what making one current again means (the classic store also repairs
 * its selection), is the host's business; the stack logic here knows nothing of boards.
 */

/** The longest undo stack; older steps fall off the bottom. */
export const MAX_HISTORY = 200;

/** The fields of a store state the history reads and writes. */
export interface HistoryFields<E extends { label: string }> {
  past: E[];
  future: E[];
  /** True while a drag is in progress (edits coalesce into one undo step). */
  editing: boolean;
}

export interface HistoryHost<S extends HistoryFields<E>, E extends { label: string }> {
  /** An entry that restores the document `state` holds now, named `label`; null when none is loaded. */
  snapshot(state: S, label: string): E | null;
  /** The state patch that makes `entry`'s document current (its value, and whatever must follow). */
  restore(state: S, entry: E): Partial<S>;
}

export interface History<S extends HistoryFields<E>, E extends { label: string }> {
  /**
   * Record an action: `patch` is the new document (and anything that goes with it) and `label` its name.
   * Outside a drag this pushes a step and clears the redo stack. In a drag the first commit pushes the
   * step and later ones only rename it, keeping the same `past` array when the name is unchanged, so
   * history subscribers do not re-render per pointer move.
   */
  commit(patch: Partial<S>, label: string): void;
  beginEdit(): void;
  endEdit(): void;
  undo(): void;
  redo(): void;
  jumpTo(index: number): void;
  canUndo(): boolean;
  canRedo(): boolean;
}

export function createHistory<S extends HistoryFields<E>, E extends { label: string }>(
  get: () => S,
  set: (patch: Partial<S>) => void,
  host: HistoryHost<S, E>,
): History<S, E> {
  /** Whether the open grouped edit (`beginEdit`) has yet to record its undo step. */
  let stepPending = false;

  return {
    commit(patch, label) {
      const state = get();
      const before = host.snapshot(state, label);
      if (!before) return;
      if (state.editing && !stepPending) {
        // The drag's step is already recorded: give it this action's name.
        const { past } = state;
        const last = past[past.length - 1];
        set({
          ...patch,
          past: last && last.label !== label ? [...past.slice(0, -1), { ...last, label }] : past,
        });
      } else {
        // A new step: a single edit, or the first commit of a drag.
        stepPending = false;
        set({ ...patch, past: [...state.past, before].slice(-MAX_HISTORY), future: [] });
      }
    },

    beginEdit() {
      const state = get();
      if (state.editing || !host.snapshot(state, '')) return;
      stepPending = true;
      set({ editing: true } as Partial<S>);
    },

    endEdit() {
      set({ editing: false } as Partial<S>);
    },

    undo() {
      const state = get();
      const prev = state.past[state.past.length - 1];
      if (!prev) return;
      // The redo entry re-applies the action we just undid, so it keeps its label.
      const redo = host.snapshot(state, prev.label);
      if (!redo) return;
      set({
        ...host.restore(state, prev),
        past: state.past.slice(0, -1),
        future: [redo, ...state.future],
        editing: false,
      } as Partial<S>);
    },

    redo() {
      const state = get();
      const next = state.future[0];
      if (!next) return;
      const undo = host.snapshot(state, next.label);
      if (!undo) return;
      set({
        ...host.restore(state, next),
        past: [...state.past, undo],
        future: state.future.slice(1),
        editing: false,
      } as Partial<S>);
    },

    jumpTo(index) {
      const state = get();
      const { past, future } = state;
      if (index < 0 || index >= past.length) return;
      const top = host.snapshot(state, '');
      if (!top) return;
      // Equivalent to (past.length - index) undos in one step: walk back from the current document,
      // pushing each undone step onto the redo stack.
      let cur: E = top;
      const undone: E[] = [];
      for (let i = past.length - 1; i >= index; i--) {
        undone.push({ ...cur, label: past[i]!.label });
        cur = past[i]!;
      }
      set({
        ...host.restore(state, cur),
        past: past.slice(0, index),
        future: [...undone.reverse(), ...future],
        editing: false,
      } as Partial<S>);
    },

    canUndo: () => get().past.length > 0,
    canRedo: () => get().future.length > 0,
  };
}
