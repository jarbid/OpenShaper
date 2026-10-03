/**
 * Regression: a long-press must not steal a drag that is already underway.
 *
 * Press a control point, nudge it a couple of pixels, hold half a second to check
 * the line against the rest of the curve — and the long-press timer fired. It called
 * `endEdit()`, cleared `drag.current` and dropped a context menu over the board while
 * the finger was still on the point. The point stopped following, which is exactly
 * the "impossible to get the desired result" the bug report described, and it is
 * visible in the reported screen recording at about 6.5s.
 *
 * The old guard cancelled the timer only past `TAP_SLOP` = 4px, a mouse-sized budget.
 * On a phone-width pane at roughly 1.5px/cm, a deliberate 1cm nudge is under two
 * pixels — so the gesture most worth protecting was precisely the one that never
 * cleared the bar. Fine adjustment is the whole reason someone presses slowly.
 *
 * What replaces it is asymmetric on purpose: with a live edit, any movement at all
 * means "drag"; with nothing under the finger there is no drag to protect, so blank
 * canvas gets a touch-sized budget instead of a mouse-sized one.
 */
import { act, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installLayoutStubs,
  mountEditor,
  removeLayoutStubs,
  TOUCH,
} from './test/spline-editor-harness';

beforeEach(() => {
  installLayoutStubs();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  removeLayoutStubs();
});

/** Long enough for the 500ms hold timer, with room to spare. The timer's callback
 * sets React state, so it has to flush inside `act` or the menu never renders and
 * every "no menu appeared" assertion passes for the wrong reason. */
const holdOut = () => act(() => vi.advanceTimersByTime(600));

const menu = (container: HTMLElement) => container.ownerDocument.body.querySelector('[role=menu]');

describe('SplineEditor: holding a finger on a control point', () => {
  it('keeps dragging after a nudge too small to clear the old 4px budget', () => {
    const { store, canvas, screenOf, midKnot } = mountEditor();
    const start = screenOf(midKnot());

    fireEvent.pointerDown(canvas, { ...TOUCH, ...start });
    // Pressing selects; the undo step opens with the first real move (P3), so a
    // tap that only selects never touches history.
    expect(store.getState().editing, 'a press alone opens no undo step').toBe(false);

    // Two pixels: a real adjustment on a phone, and under the budget that used to
    // be the only thing standing between this drag and the context menu.
    const nudged = { clientX: start.clientX + 2, clientY: start.clientY };
    fireEvent.pointerMove(canvas, { ...TOUCH, ...nudged });
    expect(store.getState().editing, 'the first move begins the edit').toBe(true);
    const moved = midKnot();

    holdOut();

    expect(menu(canvas), 'the menu must not open over a live drag').toBeNull();
    expect(store.getState().editing, 'the drag must survive the hold').toBe(true);

    // And it must still be a drag afterwards: more movement still moves the point.
    fireEvent.pointerMove(canvas, {
      ...TOUCH,
      clientX: start.clientX + 20,
      clientY: start.clientY,
    });
    expect(midKnot().x).not.toBeCloseTo(moved.x, 6);
  });

  it('still opens the menu for a finger that genuinely holds still', () => {
    // The feature has to keep working — this is touch's only route to the menu.
    const { canvas, screenOf, midKnot } = mountEditor();
    fireEvent.pointerDown(canvas, { ...TOUCH, ...screenOf(midKnot()) });

    holdOut();

    expect(menu(canvas), 'a stationary hold is still a long-press').not.toBeNull();
  });

  it('tolerates a fingertip wobbling on empty canvas', () => {
    // Nothing is under the finger, so there is no drag to protect and the threshold
    // is the finger's own noise floor. 6px of centroid drift is normal for a hand
    // that believes it is holding still, and used to cancel the gesture outright.
    const { canvas } = mountEditor();
    fireEvent.pointerDown(canvas, { ...TOUCH, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(canvas, { ...TOUCH, clientX: 26, clientY: 20 });

    holdOut();

    expect(menu(canvas), 'a wobble is not a drag when nothing is being dragged').not.toBeNull();
  });

  it('finds a point at the touch radius, the same one a drag would grab', () => {
    // `hitAny` defaulted to the 8px mouse radius here while the drag path passed 14px
    // for a finger, so "long-press this point for its menu" had a target barely half
    // the size of "press this point to drag it" — land between the two and you got
    // the empty-canvas menu for a point you could plainly grab.
    const { store, canvas, screenOf, midKnot } = mountEditor();
    const on = screenOf(midKnot());
    fireEvent.pointerDown(canvas, { ...TOUCH, clientX: on.clientX + 12, clientY: on.clientY });

    holdOut();

    expect(store.getState().selection, 'the point under the finger should be picked').toEqual({
      target: { kind: 'outline' },
      index: 1,
      kind: 'end',
    });
    const labels = [...(menu(canvas)?.querySelectorAll('[role=menuitem]') ?? [])].map(
      (i) => i.textContent,
    );
    expect(labels, 'this should be the control-point menu, not the empty-canvas one').toContain(
      'Fair curve',
    );
  });

  it('treats a real swipe on empty canvas as a pan, not a press', () => {
    const { canvas } = mountEditor();
    fireEvent.pointerDown(canvas, { ...TOUCH, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(canvas, { ...TOUCH, clientX: 60, clientY: 20 });

    holdOut();

    expect(menu(canvas)).toBeNull();
  });
});
