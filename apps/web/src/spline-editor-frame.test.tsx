// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The two things the editor lets its owner add: a `frame` to fit in place of its curves' own, and an `overlay` drawn over it that
 * is told where the board lies on the pane. A frame is fitted on mount, by the fit command and, while nothing has moved the view,
 * again when the pane is resized or the frame changes; an overlay's mapping is the one a pointer is read through, the turned pane included.
 */
import { fitToBounds, type EditorFrame } from '@openshaper/render2d';
import { act, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  installLayoutStubs,
  mountEditor,
  pane,
  removeLayoutStubs,
  resizeTo,
} from './test/spline-editor-harness';

beforeEach(installLayoutStubs);
afterEach(removeLayoutStubs);

/** A box taller than the board is, the way the Tail step frames the tail: the fit is decided by its height. */
const FRAME = { minX: -4, maxX: 36, minY: -20, maxY: 20 };
const fitOf = (w: number, h: number) => fitToBounds(FRAME, w, h).scale;

describe('a frame', () => {
  it('is what the editor fits, in place of its curves', () => {
    const { scale } = mountEditor({ frame: FRAME });
    expect(scale()).toBeCloseTo(fitOf(pane.w, pane.h), 6);
    // the board is 100 cm long: its own fit would be decided by its length
    expect(scale()).toBeGreaterThan(mountEditorScale() * 1.5);
  });

  it('is fitted again when the pane is resized and nothing has moved the view, so a pane still settling ends up framed', () => {
    const { scale } = mountEditor({ frame: FRAME });
    resizeTo(600, 200);
    expect(scale()).toBeCloseTo(fitOf(600, 200), 6);
    resizeTo(600, 500);
    expect(scale()).toBeCloseTo(fitOf(600, 500), 6);
  });

  it('is not fitted again once the user has zoomed: the framing they made is carried over a resize', () => {
    const { canvas, scale } = mountEditor({ frame: FRAME });
    fireEvent.wheel(canvas, { deltaY: -1, clientX: 300, clientY: 200 });
    const zoomed = scale();
    expect(zoomed).toBeCloseTo(fitOf(pane.w, pane.h) * 1.1, 6);
    resizeTo(600, 200);
    expect(scale()).toBeCloseTo(zoomed, 6);
  });

  it('is fitted again when the frame changes and nothing has moved the view: another shape is another box', () => {
    const { scale, rerender } = mountEditor({ frame: FRAME });
    const taller = { minX: -4, maxX: 36, minY: -32, maxY: 32 };
    rerender({ frame: taller });
    expect(scale()).toBeCloseTo(fitToBounds(taller, pane.w, pane.h).scale, 6);
    // the same box again (a new object, the same numbers) is not a change
    rerender({ frame: { ...taller } });
    expect(scale()).toBeCloseTo(fitToBounds(taller, pane.w, pane.h).scale, 6);
  });

  it('keeps the view the user has zoomed when the frame changes', () => {
    const { canvas, scale, rerender } = mountEditor({ frame: FRAME });
    fireEvent.wheel(canvas, { deltaY: -1, clientX: 300, clientY: 200 });
    const zoomed = scale();
    rerender({ frame: { minX: -4, maxX: 36, minY: -32, maxY: 32 } });
    expect(scale()).toBeCloseTo(zoomed, 6);
  });

  it('is what the fit command returns to, and the new fit is again one a resize refits', () => {
    const { canvas, scale, rerender } = mountEditor({ frame: FRAME });
    fireEvent.wheel(canvas, { deltaY: -1, clientX: 300, clientY: 200 });
    rerender({ frame: FRAME, viewCommand: { seq: 1, kind: 'fit' } });
    expect(scale()).toBeCloseTo(fitOf(pane.w, pane.h), 6);
    resizeTo(600, 250);
    expect(scale()).toBeCloseTo(fitOf(600, 250), 6);
  });

  it('changes nothing for a board with no frame: a resize carries the framing over, as it always did', () => {
    const { scale } = mountEditor();
    const was = scale();
    resizeTo(600, 300);
    expect(scale()).toBeCloseTo(was, 6);
  });
});

/** The scale the editor fits the board's own 100 cm outline at in the stub pane. */
function mountEditorScale(): number {
  const { scale, unmount } = mountEditor();
  const s = scale();
  unmount();
  return s;
}

describe('an overlay', () => {
  /** The frames the overlay was given, newest last. */
  const capture = (props: Parameters<typeof mountEditor>[0] = {}) => {
    const frames: EditorFrame[] = [];
    const mounted = mountEditor({
      ...props,
      overlay: (f) => {
        frames.push(f);
        return <div data-testid="overlay" />;
      },
    });
    return { ...mounted, frames, last: () => frames[frames.length - 1]! };
  };

  it('is drawn inside the pane, and is told its size and how many pixels a centimetre is', () => {
    const { last, scale, canvas } = capture({ frame: FRAME });
    expect(canvas.parentElement!.querySelector('[data-testid="overlay"]')).not.toBeNull();
    expect(last().width).toBe(pane.w);
    expect(last().height).toBe(pane.h);
    expect(last().scale).toBeCloseTo(scale(), 6);
  });

  it('maps the world to the pane and back as the pointer is read', () => {
    const { last, screenOf, knotAt } = capture({ frame: FRAME });
    const world = knotAt().end;
    const there = last().toPane(world);
    const read = screenOf(world);
    expect(there.x).toBeCloseTo(read.clientX, 6);
    expect(there.y).toBeCloseTo(read.clientY, 6);
    const back = last().fromPane(there);
    expect(back.x).toBeCloseTo(world.x, 9);
    expect(back.y).toBeCloseTo(world.y, 9);
  });

  it('is told the new mapping after the view moves', () => {
    const { last, canvas, knotAt } = capture({ frame: FRAME });
    const before = last().toPane(knotAt().end);
    fireEvent.wheel(canvas, { deltaY: -1, clientX: 100, clientY: 100 });
    const after = last().toPane(knotAt().end);
    expect(after.x === before.x && after.y === before.y).toBe(false);
  });

  it('keeps the mapping a pointer is read through in a turned pane', () => {
    act(() => resizeTo(334, 451));
    const { last, screenOf, knotAt } = capture({ allowTurn: true });
    const world = knotAt().end;
    const there = last().toPane(world);
    const read = screenOf(world);
    expect(there.x).toBeCloseTo(read.clientX, 6);
    expect(there.y).toBeCloseTo(read.clientY, 6);
    expect(last().width).toBe(334);
    expect(last().height).toBe(451);
    const back = last().fromPane(there);
    expect(back.x).toBeCloseTo(world.x, 9);
    expect(back.y).toBeCloseTo(world.y, 9);
  });
});
