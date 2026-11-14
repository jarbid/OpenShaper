// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { createTapTracker, TAP_LIMITS, type TapPointer } from './tap';

const p = (over: Partial<TapPointer> = {}): TapPointer => ({
  id: 1,
  x: 100,
  y: 100,
  time: 0,
  primary: true,
  button: 0,
  touch: false,
  ...over,
});

describe('tap or drag', () => {
  it('is a tap when the pointer comes up where it went down', () => {
    const t = createTapTracker();
    t.down(p());
    expect(t.up(p({ time: 120 }))).toBe(true);
  });

  it('is a tap with a little wobble, and a drag past the slop', () => {
    const t = createTapTracker();
    t.down(p());
    t.move(p({ x: 100 + TAP_LIMITS.mousePx, time: 10 }));
    expect(t.up(p({ x: 103, time: 100 }))).toBe(true);
    t.down(p());
    t.move(p({ x: 100 + TAP_LIMITS.mousePx + 1, time: 10 }));
    // coming back to the start does not undo a drag: orbiting and returning is still orbiting
    expect(t.up(p({ time: 100 }))).toBe(false);
  });

  it('allows a finger more slop than a mouse', () => {
    const t = createTapTracker();
    t.down(p({ touch: true }));
    t.move(p({ touch: true, x: 100 + TAP_LIMITS.mousePx + 3, time: 10 }));
    expect(t.up(p({ touch: true, x: 108, time: 100 }))).toBe(true);
  });

  it('is not a tap when held too long', () => {
    const t = createTapTracker();
    t.down(p());
    expect(t.up(p({ time: TAP_LIMITS.ms + 1 }))).toBe(false);
  });

  it('is not a tap with a second pointer down (a pinch)', () => {
    const t = createTapTracker();
    t.down(p());
    t.down(p({ id: 2, primary: false, x: 140 }));
    expect(t.up(p({ id: 2, primary: false, x: 140, time: 50 }))).toBe(false);
    expect(t.up(p({ time: 60 }))).toBe(false);
    // and the next gesture starts clean
    t.down(p({ time: 1000 }));
    expect(t.up(p({ time: 1050 }))).toBe(true);
  });

  it('is not a tap with the right or middle button, or a pointer that is not the primary', () => {
    const t = createTapTracker();
    t.down(p({ button: 2 }));
    expect(t.up(p({ time: 50 }))).toBe(false);
    t.down(p({ button: 1 }));
    expect(t.up(p({ time: 50 }))).toBe(false);
    t.down(p({ primary: false }));
    expect(t.up(p({ time: 50 }))).toBe(false);
  });

  it('is not a tap after a cancel, and an up with no down is nothing', () => {
    const t = createTapTracker();
    t.down(p());
    t.cancel();
    expect(t.up(p({ time: 20 }))).toBe(false);
    expect(t.up(p())).toBe(false);
  });
});
