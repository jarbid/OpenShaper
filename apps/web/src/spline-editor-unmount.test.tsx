/**
 * Regression (P2): an editor that unmounts mid-drag must close the store's edit.
 *
 * A drag opens a grouped edit (beginEdit) and only pointerup closes it. Switching
 * view with a number key mid-drag — or a station change remounting the section
 * pane — unmounts the editor, so that pointerup never arrives. The store then stayed
 * `editing`: every later edit merged into the dead drag's single undo step, and the
 * settled specs (which wait for the edit to end) froze.
 */
import { fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  installLayoutStubs,
  mountEditor,
  MOUSE,
  removeLayoutStubs,
} from './test/spline-editor-harness';

beforeEach(installLayoutStubs);
afterEach(removeLayoutStubs);

describe('SplineEditor: unmounting mid-drag', () => {
  it('ends the grouped edit, so later edits get their own undo steps', () => {
    const { store, canvas, screenOf, midKnot, scale, unmount } = mountEditor();
    const on = screenOf(midKnot());
    fireEvent.pointerDown(canvas, { ...MOUSE, ...on });
    fireEvent.pointerMove(canvas, {
      ...MOUSE,
      clientX: on.clientX + 5 * scale(),
      clientY: on.clientY,
    });
    expect(store.getState().editing).toBe(true);

    unmount(); // e.g. the user pressed a view key while still holding the point

    expect(store.getState().editing).toBe(false);
    const steps = store.getState().past.length;
    store.getState().scaleBoard(1.1, 1, 1);
    expect(store.getState().past.length).toBe(steps + 1);
    expect(store.getState().past.at(-1)!.label).toBe('Resize board');
  });

  it('leaves the store alone when no drag is in progress', () => {
    const { store, unmount } = mountEditor();
    const before = store.getState();
    unmount();
    expect(store.getState().editing).toBe(false);
    expect(store.getState().past).toBe(before.past);
  });
});
