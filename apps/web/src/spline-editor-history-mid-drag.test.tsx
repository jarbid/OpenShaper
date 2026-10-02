/**
 * Regression (P4): undo, redo or Delete pressed while a point is still held.
 *
 * Undo closed the drag's edit, so every further move of the still-held point became
 * its own undo step — enough to push real history out of the 200-step cap. Delete
 * mid-drag relabelled the drag's step and left the drag writing to a knot index that
 * now named a different point. The editor now drops a drag whose edit was closed
 * under it, and Delete closes the drag's step before recording its own.
 */
import { act, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  installLayoutStubs,
  mountEditor,
  MOUSE,
  removeLayoutStubs,
} from './test/spline-editor-harness';

beforeEach(installLayoutStubs);
afterEach(removeLayoutStubs);

const startDrag = () => {
  const ed = mountEditor();
  const on = ed.screenOf(ed.midKnot());
  const px = ed.scale();
  const moveBy = (cm: number) =>
    fireEvent.pointerMove(ed.canvas, {
      ...MOUSE,
      clientX: on.clientX + cm * px,
      clientY: on.clientY,
    });
  fireEvent.pointerDown(ed.canvas, { ...MOUSE, ...on });
  moveBy(2);
  return { ...ed, moveBy, on };
};

describe('SplineEditor: history keys during a drag', () => {
  it('undo mid-drag reverts the drag and stops it, instead of one step per later move', () => {
    const { store, moveBy, midKnot } = startDrag();
    const before = store.getState().past[0]!.board;
    act(() => store.getState().undo());
    const reverted = midKnot();

    moveBy(4);
    moveBy(6);
    moveBy(8);

    expect(store.getState().past).toHaveLength(0);
    expect(store.getState().board).toBe(before);
    expect(midKnot()).toEqual(reverted);
    expect(store.getState().future.map((h) => h.label)).toEqual(['Move control point']);
  });

  it('Delete mid-drag records the drag and the deletion as two steps, and stops the drag', () => {
    const { store, moveBy } = startDrag();
    act(() => store.getState().deleteControlPoint({ kind: 'outline' }, 1));
    const knots = store.getState().board!.outline.knots.length;

    moveBy(5);

    expect(store.getState().past.map((h) => h.label)).toEqual([
      'Move control point',
      'Delete control point',
    ]);
    expect(store.getState().board!.outline.knots).toHaveLength(knots);
    expect(store.getState().editing).toBe(false);
  });
});
