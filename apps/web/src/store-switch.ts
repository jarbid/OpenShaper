// SPDX-License-Identifier: GPL-3.0-or-later
import type { StoreApi } from 'zustand/vanilla';

/**
 * A store that is whichever of two stores the engine setting picks (docs/design/m2-editor.md §1).
 *
 * The panes, inspector, sidebar, shortcuts and the 3D view all read and edit "the board store". With
 * the NURBS engine on that is the section store, with it off the classic one; both implement
 * `BoardState`, so the editors cannot tell. This switch is the one object they hold, so the choice is
 * made in one place (`App`) and no editor needs to know about it.
 *
 * `use` swaps the target and tells every subscriber, which re-read their snapshots (a hook that selected
 * `getState().board` sees the other store's board). Listeners attach to the current target only, so a
 * store that is not shown costs nothing.
 */
export interface StoreSwitch<S> extends StoreApi<S> {
  /** Make `target` the store this switch stands for. A no-op if it already is. */
  use(target: StoreApi<S>): void;
  /** The store the switch stands for now. */
  readonly target: StoreApi<S>;
}

export function createStoreSwitch<S>(initial: StoreApi<S>): StoreSwitch<S> {
  let target = initial;
  const listeners = new Set<(state: S, prev: S) => void>();
  const forward = (state: S, prev: S): void => {
    for (const l of [...listeners]) l(state, prev);
  };
  let detach = target.subscribe(forward);
  return {
    getState: () => target.getState(),
    getInitialState: () => target.getInitialState(),
    setState: ((...args: Parameters<StoreApi<S>['setState']>) =>
      target.setState(...args)) as StoreApi<S>['setState'],
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    use(next) {
      if (next === target) return;
      detach();
      target = next;
      detach = target.subscribe(forward);
      const state = target.getState();
      forward(state, state);
    },
    get target() {
      return target;
    },
  };
}
