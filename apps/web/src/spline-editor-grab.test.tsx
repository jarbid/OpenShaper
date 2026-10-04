/**
 * Regression: grabbing a handle must not move it.
 *
 * A drag used to assign the pointer's own world position to the handle, so the
 * very first move teleported the handle under the cursor — by up to the hit
 * radius, instantly, before the pointer had travelled at all. With a mouse that
 * is a few px and passes for precision. With a fingertip you are routinely at
 * the edge of the radius, and on a phone-width pane those pixels are centimetres
 * of board, so every grab knocked the shape out before the drag even began.
 */
import { fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  installLayoutStubs,
  mountEditor,
  MOUSE,
  removeLayoutStubs,
  TOUCH,
} from './test/spline-editor-harness';

beforeEach(installLayoutStubs);
afterEach(removeLayoutStubs);

describe('SplineEditor: grabbing a control point', () => {
  for (const [name, POINTER] of [
    ['mouse', MOUSE],
    ['touch', TOUCH],
  ] as const) {
    it(`does not move the point when grabbed off-centre by ${name}`, () => {
      const { store, canvas, screenOf, midKnot } = mountEditor();
      const before = midKnot();
      const on = screenOf(before);
      // Land 5px up and to the left of the handle — inside the hit radius, but
      // not on the handle's exact pixel, which is the normal case for a finger.
      const off = { clientX: on.clientX - 5, clientY: on.clientY - 5 };

      fireEvent.pointerDown(canvas, { ...POINTER, ...off });
      expect(store.getState().selection).toEqual({
        target: { kind: 'outline' },
        index: 1,
        kind: 'end',
      });

      fireEvent.pointerMove(canvas, { ...POINTER, ...off });

      const after = midKnot();
      expect(after.x).toBeCloseTo(before.x, 6);
      expect(after.y).toBeCloseTo(before.y, 6);
    });
  }

  it('moves the point by the pointer delta, not to the pointer', () => {
    const { canvas, screenOf, midKnot, scale } = mountEditor();
    const before = midKnot();
    const on = screenOf(before);
    const pxPerCm = scale();
    const off = { clientX: on.clientX - 6, clientY: on.clientY + 4 };

    fireEvent.pointerDown(canvas, { ...TOUCH, ...off });
    fireEvent.pointerMove(canvas, {
      ...TOUCH,
      clientX: off.clientX + 10 * pxPerCm,
      clientY: off.clientY - 3 * pxPerCm,
    });

    // Exactly the travel, with the grab offset carried through untouched.
    const after = midKnot();
    expect(after.x - before.x).toBeCloseTo(10, 6);
    expect(after.y - before.y).toBeCloseTo(3, 6);
  });

  it('drags a tangent handle by the pointer delta too', () => {
    const { canvas, screenOf, knotAt, scale } = mountEditor();
    const before = knotAt().tangentToNext;
    const on = screenOf(before);
    const pxPerCm = scale();
    const off = { clientX: on.clientX + 4, clientY: on.clientY - 4 };

    fireEvent.pointerDown(canvas, { ...TOUCH, ...off });
    fireEvent.pointerMove(canvas, {
      ...TOUCH,
      clientX: off.clientX + 5 * pxPerCm,
      clientY: off.clientY,
    });

    const after = knotAt().tangentToNext;
    expect(after.x - before.x).toBeCloseTo(5, 6);
    expect(after.y - before.y).toBeCloseTo(0, 6);
  });

  it('gives a fingertip a bigger target than a mouse cursor', () => {
    const { store, canvas, screenOf, midKnot } = mountEditor();
    const on = screenOf(midKnot());
    // 20px below (away from the tangent handles, which run along x): past the mouse radius (8), inside the touch one (22: the 44px
    // floor as a radius, P19 — it was 14, which missed this).
    const far = { clientX: on.clientX, clientY: on.clientY + 20 };

    fireEvent.pointerDown(canvas, { ...MOUSE, ...far });
    expect(store.getState().selection).toBeNull();
    fireEvent.pointerUp(canvas, { ...MOUSE, ...far });

    fireEvent.pointerDown(canvas, { ...TOUCH, ...far });
    expect(store.getState().selection).toEqual({
      target: { kind: 'outline' },
      index: 1,
      kind: 'end',
    });
  });

  it('does not reach past the touch radius', () => {
    const { store, canvas, screenOf, midKnot } = mountEditor();
    const on = screenOf(midKnot());
    fireEvent.pointerDown(canvas, { ...TOUCH, clientX: on.clientX, clientY: on.clientY + 30 });
    expect(store.getState().selection).toBeNull();
  });
});
