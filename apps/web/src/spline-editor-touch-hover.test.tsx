/**
 * P20: a finger moving over empty canvas used to run the whole hover path (scrub
 * line, readout, hit tests, an app re-render) on every pointermove. Touch hover is
 * now applied once per animation frame, with the latest point; the mouse is
 * unchanged.
 */
import { act, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installLayoutStubs,
  MOUSE,
  mountEditor,
  removeLayoutStubs,
  TOUCH,
} from './test/spline-editor-harness';

beforeEach(installLayoutStubs);
afterEach(removeLayoutStubs);

const nextFrame = () =>
  act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

describe('hover from a finger (P20)', () => {
  it('coalesces a burst of touch moves into one update per frame, at the latest point', async () => {
    const onScrub = vi.fn();
    const { canvas, screenOf } = mountEditor({ onScrub });
    const at = (x: number) => ({ ...screenOf({ x, y: 40 }) });

    for (const x of [20, 30, 40, 50, 60]) fireEvent.pointerMove(canvas, { ...TOUCH, ...at(x) });
    expect(onScrub).not.toHaveBeenCalled();

    await nextFrame();
    expect(onScrub).toHaveBeenCalledTimes(1);
    expect(onScrub.mock.calls[0]![0]).toBeCloseTo(60, 6);
  });

  it('still answers every mouse move straight away', () => {
    const onScrub = vi.fn();
    const { canvas, screenOf } = mountEditor({ onScrub });
    for (const x of [20, 30, 40]) {
      fireEvent.pointerMove(canvas, { ...MOUSE, ...screenOf({ x, y: 40 }) });
    }
    expect(onScrub).toHaveBeenCalledTimes(3);
  });
});
