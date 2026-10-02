/**
 * Regression (P3): clicking a point without moving it must not touch history.
 *
 * The drag's undo step used to open on pointer-down, so a click that only selected a
 * point recorded an empty "Edit" step — and, being a new step, wiped the redo stack.
 * It now opens on the first real move, as section drags already did.
 */
import { act, fireEvent } from '@testing-library/react';
import { vec2 } from '@openshaper/kernel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  installLayoutStubs,
  mountEditor,
  MOUSE,
  removeLayoutStubs,
} from './test/spline-editor-harness';

beforeEach(installLayoutStubs);
afterEach(removeLayoutStubs);

describe('SplineEditor: a click that only selects', () => {
  it('records no undo step and keeps the redo stack', () => {
    const { store, canvas, screenOf, midKnot } = mountEditor();
    act(() => {
      store.getState().moveControlPoint({ kind: 'outline' }, 1, vec2(50, 22));
      store.getState().undo();
    });
    const { past, future } = store.getState();
    expect(future).toHaveLength(1);

    const on = screenOf(midKnot());
    fireEvent.pointerDown(canvas, { ...MOUSE, ...on });
    fireEvent.pointerMove(canvas, { ...MOUSE, ...on }); // a same-spot move is not a drag
    fireEvent.pointerUp(canvas, { ...MOUSE, ...on });

    expect(store.getState().selection?.index).toBe(1);
    expect(store.getState().past).toBe(past);
    expect(store.getState().future).toBe(future);
    expect(store.getState().editing).toBe(false);
  });

  it('still records exactly one step once the point actually moves', () => {
    const { store, canvas, screenOf, midKnot, scale } = mountEditor();
    const on = screenOf(midKnot());
    fireEvent.pointerDown(canvas, { ...MOUSE, ...on });
    fireEvent.pointerMove(canvas, {
      ...MOUSE,
      clientX: on.clientX + 3 * scale(),
      clientY: on.clientY,
    });
    fireEvent.pointerMove(canvas, {
      ...MOUSE,
      clientX: on.clientX + 6 * scale(),
      clientY: on.clientY,
    });
    fireEvent.pointerUp(canvas, {
      ...MOUSE,
      clientX: on.clientX + 6 * scale(),
      clientY: on.clientY,
    });

    expect(store.getState().past.map((h) => h.label)).toEqual(['Move control point']);
    expect(store.getState().editing).toBe(false);
  });
});
