/**
 * The board turn: drawing nose-up in a pane that is taller than it is wide.
 *
 * A surfboard is about 4:1, so in a portrait pane the fit is decided by the width
 * and most of the height goes unused. Measured on a 334x451 phone pane the turn is
 * worth 1.52 -> 2.14 px/cm, and it costs the user nothing — no gesture, no setting.
 *
 * It is built by rotating the canvas ELEMENT in CSS, not the transform inside it,
 * so the canvas keeps an ordinary unrotated coordinate system and every hit test
 * and draw routine works exactly as before. Two things know about the rotation: the
 * CSS transform, and `localPoint`, which inverts it. **Everything that can go wrong
 * here goes wrong in that inversion**, and it goes wrong as "the point does not
 * follow my finger" — the bug this whole branch started from. Hence the emphasis
 * below on grabbing and dragging rather than on the arithmetic.
 */
import { fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  installLayoutStubs,
  mountEditor,
  pane,
  removeLayoutStubs,
  resizeTo,
  TOUCH,
} from './test/spline-editor-harness';

beforeEach(installLayoutStubs);
afterEach(removeLayoutStubs);

/** A phone-shaped pane: taller than wide, so the turn pays. */
const portrait = () => resizeTo(334, 451);

describe('a turned pane', () => {
  it('draws the board larger than the same pane would upright', () => {
    portrait();
    const upright = mountEditor().scale();
    const turned = mountEditor({ allowTurn: true }).scale();

    expect(turned, 'the whole point of the turn').toBeGreaterThan(upright);
    // The measured figure on a real 334x451 pane is 1.41x. The harness board has
    // its own proportions, so assert the direction and a meaningful margin rather
    // than pinning a number this fixture does not produce.
    expect(turned / upright).toBeGreaterThan(1.2);
  });

  it('leaves a wide pane alone, where turning would cost a factor of three', () => {
    // `pane` starts at 600x400. A 4:1 board is already height-limited there, so the
    // predicate must decline — this is the case that makes the feature safe to ship
    // without a breakpoint, and the one a naive "is it a phone" test would fail.
    resizeTo(600, 400);
    expect(mountEditor({ allowTurn: true }).scale()).toBe(mountEditor().scale());
  });

  it('does not turn a pane that did not ask', () => {
    portrait();
    expect(mountEditor({ allowTurn: false }).scale()).toBe(mountEditor().scale());
  });

  it('puts the nose up the screen', () => {
    portrait();
    const { screenOf } = mountEditor({ allowTurn: true });
    // The harness board runs x from 0 (tail) to 100 (nose).
    const tail = screenOf({ x: 0, y: 0 });
    const nose = screenOf({ x: 100, y: 0 });

    expect(nose.clientY, 'the nose should sit above the tail').toBeLessThan(tail.clientY);
    expect(
      Math.abs(nose.clientX - tail.clientX),
      'the length axis should be vertical',
    ).toBeLessThan(1);
  });
});

describe('editing on a turned pane', () => {
  it('does not move a point when it is grabbed', () => {
    // The same assertion as `spline-editor-grab.test.tsx`, which is where a wrong
    // pointer mapping surfaces: an inverse that is off teleports the handle to
    // wherever the bad mapping says the finger is, on the very first move.
    portrait();
    const { canvas, screenOf, midKnot } = mountEditor({ allowTurn: true });
    const before = midKnot();
    const on = screenOf(before);
    const off = { clientX: on.clientX - 5, clientY: on.clientY - 5 };

    fireEvent.pointerDown(canvas, { ...TOUCH, ...off });
    fireEvent.pointerMove(canvas, { ...TOUCH, ...off });

    const after = midKnot();
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('moves a point the way the finger moved, in the direction the board is drawn', () => {
    portrait();
    const { canvas, screenOf, midKnot, scale } = mountEditor({ allowTurn: true });
    const before = midKnot();
    const on = screenOf(before);

    fireEvent.pointerDown(canvas, { ...TOUCH, ...on });
    // Down the screen. The nose is up, so this is toward the tail: world -x.
    const travel = 40;
    fireEvent.pointerMove(canvas, { ...TOUCH, clientX: on.clientX, clientY: on.clientY + travel });

    const after = midKnot();
    expect(after.x, 'dragging down a nose-up board reduces x').toBeLessThan(before.x);
    expect(after.x).toBeCloseTo(before.x - travel / scale(), 4);
    expect(after.y, 'and does not drift sideways').toBeCloseTo(before.y, 6);
  });

  it('round-trips the pointer mapping', () => {
    // Every client point the harness reports for a world point must land back on
    // that world point once the editor has inverted the rotation. This is the
    // property the two exported halves of the mapping exist to guarantee.
    portrait();
    const { canvas, screenOf, store, knotAt } = mountEditor({ allowTurn: true });

    for (const index of [0, 1, 2]) {
      const target = knotAt(index).end;
      fireEvent.pointerDown(canvas, { ...TOUCH, ...screenOf(target) });
      expect(store.getState().selection, `knot ${index} should be hit where it is drawn`).toEqual({
        target: { kind: 'outline' },
        index,
        kind: 'end',
      });
      fireEvent.pointerUp(canvas, { ...TOUCH, ...screenOf(target) });
    }
  });

  it('keeps the canvas the size of the pane it is rotated into', () => {
    portrait();
    const { canvas } = mountEditor({ allowTurn: true });
    // Swapped: the drawing surface is landscape, the box it covers is portrait.
    expect(canvas.style.width).toBe(`${pane.h}px`);
    expect(canvas.style.height).toBe(`${pane.w}px`);
    expect(canvas.style.transform).toContain('rotate(-90deg)');
  });
});

describe('orientation during a gesture (P21)', () => {
  it('holds still until the finger lifts, then settles', () => {
    portrait();
    const { canvas, screenOf, midKnot } = mountEditor({ allowTurn: true });
    expect(canvas.style.transform).toContain('rotate(-90deg)');

    const on = screenOf(midKnot());
    fireEvent.pointerDown(canvas, { ...TOUCH, ...on });
    // Mid-drag the pane goes wide (a keyboard, a rotation, a nearly square pane
    // crossing the line): the board must not turn under the finger.
    resizeTo(600, 400);
    expect(canvas.style.transform, 'still turned while held').toContain('rotate(-90deg)');

    fireEvent.pointerUp(canvas, { ...TOUCH, ...on });
    expect(canvas.style.transform, 'upright once released').not.toContain('rotate');
  });
});
