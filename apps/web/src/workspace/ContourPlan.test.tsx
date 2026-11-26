// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The plan from below against the real rails store: the board and each contour on it, the stations along its foot,
 * choosing (a band, the bare board, a tick), and the chosen contour's three handles: dragged they change where it
 * runs (one undo step, the number shown while the pointer is down), moved by the keys a centimetre at a time.
 */
import type { RailsBoard } from '@openshaper/board2';
import { contoursOf } from '@openshaper/store/rails';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lengthUnitByKey } from '../format';
import { activeStore, boardStore, railsStore } from '../store';
import { key, showRails } from '../test/rails-board';
import { getChosenContour, resetBottomChoice, setChosenContour } from './bottom-choice';
import { ContourPlan } from './ContourPlan';
import { fitPlan, planX } from './contour-plan';

const CM = lengthUnitByKey('cm');
const KEYS = [key(20, 0.5), key(100, 0.5), key(170, 0.4)];
const pointer = { pointerId: 8, isPrimary: true, button: 0 };

const doc = () => railsStore.getState().doc as RailsBoard;
const labels = () => railsStore.getState().past.map((p) => p.label);
const length = () => doc().outline.plus.knots[doc().outline.plus.knots.length - 1]!.p[0];
/** No layout in jsdom: the plan is its fallback 560 px wide. */
const px = (x: number) => planX(fitPlan(560, length(), 24), x);
const run = (id: string) => {
  const f = doc().features.find((q) => q.id === id)!;
  return { from: f.depth.keys[0]!.s, to: f.depth.keys[f.depth.keys.length - 1]!.s };
};
const handle = (name: 'from' | 'move' | 'to') => screen.getByTestId(`plan-${name}`);
const band = (id: string) => document.querySelector(`[data-contour-band="${id}"]`)!;

beforeEach(async () => {
  localStorage.clear();
  resetBottomChoice();
  await showRails({ plus: KEYS });
});
afterEach(() => {
  resetBottomChoice();
  activeStore.use(boardStore);
});

const mount = (slice = 3, onStation: (s: number) => void = () => {}) =>
  render(<ContourPlan units={CM} slice={slice} onStation={onStation} />);
const addTwo = () =>
  act(() => {
    railsStore.getState().addContour('vee');
    railsStore.getState().addContour('single-concave');
  });

describe('what it draws', () => {
  it('is the bottom seen from below, named so, with the plus side the lower one', () => {
    mount();
    const label = screen.getByRole('img').getAttribute('aria-label')!;
    expect(label).toContain('seen from below');
    expect(label).toContain('tail on the left');
    expect(label).toContain('no contour');
    expect(label).toContain('plus side is the lower one');
    expect(screen.getByTestId('plan-board').getAttribute('d')).toMatch(/^M.*Z$/);
  });

  it('draws a band for each contour, labelled with where it runs, and the chosen one’s handles', () => {
    addTwo();
    mount();
    expect(band('vee').getAttribute('aria-label')).toMatch(/^Vee, .* to .*/);
    expect(band('single-concave')).toBeTruthy();
    expect(band('vee').querySelectorAll('path').length).toBeGreaterThan(0);
    // the first contour is chosen when none is named: its handles are there, the other's are not
    expect(handle('from').getAttribute('aria-label')).toBe('Start of Vee');
    expect(handle('move').getAttribute('aria-label')).toBe('Position of Vee');
    expect(handle('to').getAttribute('aria-label')).toBe('End of Vee');
    for (const name of ['from', 'move', 'to'] as const) {
      expect(handle(name).getAttribute('role')).toBe('slider');
    }
  });

  it('draws a channel as lines and a contour switched off outlined and not shaded', () => {
    act(() => {
      railsStore.getState().addContour('channels');
      railsStore.getState().addContour('vee');
      railsStore.getState().setFeatureEnabled('vee', false);
    });
    mount();
    // two channels each side: four lines besides the four bands
    expect(band('channels').querySelectorAll('path[stroke-linecap="round"]')).toHaveLength(4);
    expect(band('vee').querySelector('path')!.getAttribute('fill')).toBe('none');
    expect(band('vee').getAttribute('opacity')).toBe('0.55');
    expect(band('channels').querySelector('path')!.getAttribute('fill')).toMatch(/^url\(#/);
  });

  it('has a tick for each station along the foot, the chosen one pressed', () => {
    mount(3);
    const lane = screen.getByRole('toolbar', { name: 'Stations along the board' });
    const ticks = within(lane).getAllByRole('button');
    expect(ticks).toHaveLength(doc().stations.length);
    expect(ticks.map((t) => t.getAttribute('aria-pressed'))).toEqual(
      ticks.map((_, i) => String(i === 2)),
    );
    expect(ticks[2]!.getAttribute('aria-label')).toMatch(/^Station 3 of /);
  });
});

describe('the stations the slice can show the chosen contour at', () => {
  it('are marked on the foot in the contour’s colour: the ones its run goes over', () => {
    act(() => {
      railsStore.getState().addContour('single-concave');
    });
    mount();
    const lane = screen.getByRole('toolbar', { name: 'Stations along the board' });
    const ticks = within(lane).getAllByRole('button');
    const { from, to } = run('single-concave');
    const inside = doc().stations.map((s) => s.x > from && s.x < to);
    expect(inside.some(Boolean) && !inside.every(Boolean)).toBe(true);
    ticks.forEach((t, i) =>
      expect(t.querySelector('[data-in-run]') !== null, `tick ${i + 1}`).toBe(inside[i]),
    );
  });

  it('are none for a board with no contour', () => {
    mount();
    expect(document.querySelector('[data-in-run]')).toBeNull();
  });
});

describe('choosing', () => {
  it('a tap on a band chooses that contour, and moves the handles to it', () => {
    addTwo();
    mount();
    expect(getChosenContour()).toBeNull();
    fireEvent.pointerDown(band('single-concave').querySelector('path')!, {
      ...pointer,
      clientX: 150,
      clientY: 80,
    });
    expect(getChosenContour()).toBe('single-concave');
    expect(handle('from').getAttribute('aria-label')).toBe('Start of Single concave');
  });

  it('a tap on the bare board chooses the station nearest, and a tick chooses its station', () => {
    const onStation = vi.fn();
    mount(3, onStation);
    fireEvent.pointerUp(screen.getByTestId('plan-board'), { ...pointer, clientX: px(92.7) });
    expect(onStation).toHaveBeenLastCalledWith(3);
    fireEvent.pointerUp(screen.getByTestId('plan-board'), { ...pointer, clientX: px(1) });
    expect(onStation).toHaveBeenLastCalledWith(1);
    const ticks = within(
      screen.getByRole('toolbar', { name: 'Stations along the board' }),
    ).getAllByRole('button');
    fireEvent.click(ticks[4]!);
    expect(onStation).toHaveBeenLastCalledWith(5);
  });

  it('moves the station by the arrow keys on a tick, to the ends with Home and End', () => {
    const onStation = vi.fn();
    mount(3, onStation);
    const lane = screen.getByRole('toolbar', { name: 'Stations along the board' });
    const ticks = within(lane).getAllByRole('button');
    fireEvent.keyDown(ticks[2]!, { key: 'ArrowRight' });
    expect(onStation).toHaveBeenLastCalledWith(4);
    fireEvent.keyDown(ticks[2]!, { key: 'ArrowLeft' });
    expect(onStation).toHaveBeenLastCalledWith(2);
    fireEvent.keyDown(ticks[2]!, { key: 'Home' });
    expect(onStation).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(ticks[2]!, { key: 'End' });
    expect(onStation).toHaveBeenLastCalledWith(doc().stations.length);
  });
});

describe('dragging the chosen contour', () => {
  it('moves its end where the pointer goes, shows the number while it is down, and is one undo step', () => {
    act(() => {
      railsStore.getState().addContour('vee');
    });
    mount();
    const before = run('vee');
    fireEvent.pointerDown(handle('to'), { ...pointer, clientX: px(before.to), clientY: 80 });
    fireEvent.pointerMove(handle('to'), { ...pointer, clientX: px(120), clientY: 80 });
    expect(run('vee').to).toBeCloseTo(120, 0);
    expect(screen.getByTestId('plan-number').textContent).toMatch(/^To 12\d\.\d+ cm$/);
    fireEvent.pointerMove(handle('to'), { ...pointer, clientX: px(130), clientY: 80 });
    fireEvent.pointerUp(handle('to'), { ...pointer, clientX: px(130), clientY: 80 });
    expect(run('vee').to).toBeCloseTo(130, 0);
    expect(run('vee').from).toBe(before.from);
    expect(screen.queryByTestId('plan-number')).toBeNull();
    expect(labels()).toEqual(['Add Vee', 'Set extent of vee']);
    act(() => railsStore.getState().undo());
    expect(run('vee')).toEqual(before);
  });

  it('moves its start, held a least span from the end, and says when it is held', () => {
    act(() => {
      railsStore.getState().addContour('single-concave');
    });
    mount();
    const before = run('single-concave');
    fireEvent.pointerDown(handle('from'), { ...pointer, clientX: px(before.from), clientY: 80 });
    fireEvent.pointerMove(handle('from'), { ...pointer, clientX: px(60), clientY: 80 });
    expect(run('single-concave').from).toBeCloseTo(60, 0);
    expect(screen.getByTestId('plan-number').textContent).toMatch(/^From 6\d\.\d+ cm$/);
    fireEvent.pointerMove(handle('from'), { ...pointer, clientX: px(before.to + 40), clientY: 80 });
    expect(run('single-concave').from).toBeCloseTo(before.to - 2, 6);
    fireEvent.pointerUp(handle('from'), { ...pointer, clientX: px(60), clientY: 80 });
    expect(run('single-concave').to).toBe(before.to);
  });

  it('slides it from the middle handle, or from the band itself, its length kept', () => {
    act(() => {
      railsStore.getState().addContour('single-concave');
    });
    mount();
    const before = run('single-concave');
    const length0 = before.to - before.from;
    fireEvent.pointerDown(handle('move'), {
      ...pointer,
      clientX: px((before.from + before.to) / 2),
      clientY: 80,
    });
    fireEvent.pointerMove(handle('move'), {
      ...pointer,
      clientX: px((before.from + before.to) / 2 + 12),
      clientY: 80,
    });
    expect(screen.getByTestId('plan-number').textContent).toMatch(/ to /);
    fireEvent.pointerUp(handle('move'), pointer);
    const slid = run('single-concave');
    expect(slid.to - slid.from).toBeCloseTo(length0, 6);
    expect(slid.from).toBeCloseTo(before.from + 12, 0);
    // the chosen band itself slides it too
    const body = band('single-concave').querySelector('path')!;
    fireEvent.pointerDown(body, { ...pointer, clientX: px(slid.from + 30), clientY: 80 });
    fireEvent.pointerMove(body, { ...pointer, clientX: px(slid.from + 20), clientY: 80 });
    fireEvent.pointerUp(body, pointer);
    expect(run('single-concave').from).toBeCloseTo(slid.from - 10, 0);
    expect(labels()).toEqual(['Add Single concave', 'Move single concave', 'Move single concave']);
  });

  it('keeps the run inside the station range and a least span long, whatever the pointer does', () => {
    act(() => {
      railsStore.getState().addContour('vee');
    });
    mount();
    const start = run('vee');
    fireEvent.pointerDown(handle('move'), { ...pointer, clientX: px(50), clientY: 80 });
    fireEvent.pointerMove(handle('move'), { ...pointer, clientX: px(1e5), clientY: 80 });
    const far = run('vee');
    expect(far.to).toBeLessThan(length());
    expect(far.to - far.from).toBeCloseTo(start.to - start.from, 6);
    fireEvent.pointerMove(handle('move'), { ...pointer, clientX: px(-1e5), clientY: 80 });
    expect(run('vee').from).toBeGreaterThan(0);
    fireEvent.pointerUp(handle('move'), pointer);
  });

  it('is a function of the pointer: out to the nose and back leaves the contour as it was', () => {
    act(() => {
      railsStore.getState().addContour('channels');
    });
    mount();
    const origin = doc();
    const before = run('channels');
    fireEvent.pointerDown(handle('to'), { ...pointer, clientX: px(before.to), clientY: 80 });
    fireEvent.pointerMove(handle('to'), { ...pointer, clientX: px(length()), clientY: 80 });
    fireEvent.pointerMove(handle('to'), { ...pointer, clientX: px(before.to), clientY: 80 });
    fireEvent.pointerUp(handle('to'), pointer);
    expect(run('channels')).toEqual(before);
    expect(doc().features[0]).toEqual(origin.features[0]);
  });
});

describe('the keys on a handle', () => {
  it('move an end a centimetre, ten with Shift, to its least and greatest with Home and End', () => {
    act(() => {
      railsStore.getState().addContour('vee');
    });
    mount();
    const before = run('vee');
    const to = handle('to');
    fireEvent.keyDown(to, { key: 'ArrowRight' });
    fireEvent.keyDown(to, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyUp(to, { key: 'ArrowRight' });
    expect(run('vee').to).toBeCloseTo(before.to + 11, 6);
    expect(labels()).toEqual(['Add Vee', 'Set extent of vee']);
    fireEvent.keyDown(to, { key: 'ArrowLeft' });
    fireEvent.keyUp(to, { key: 'ArrowLeft' });
    expect(run('vee').to).toBeCloseTo(before.to + 10, 6);
    fireEvent.keyDown(handle('from'), { key: 'End' });
    fireEvent.keyUp(handle('from'), { key: 'End' });
    expect(run('vee').to - run('vee').from).toBeCloseTo(2, 6);
    fireEvent.keyDown(handle('from'), { key: 'Home' });
    fireEvent.keyUp(handle('from'), { key: 'Home' });
    expect(run('vee').from).toBeCloseTo(0.5, 6);
  });

  it('slide the whole run from the middle handle, stopping where it meets the board', () => {
    act(() => {
      railsStore.getState().addContour('double-concave');
    });
    mount();
    const before = run('double-concave');
    const mid = handle('move');
    fireEvent.keyDown(mid, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyUp(mid, { key: 'ArrowRight' });
    expect(run('double-concave').from).toBeCloseTo(before.from + 10, 6);
    expect(run('double-concave').to - run('double-concave').from).toBeCloseTo(
      before.to - before.from,
      6,
    );
    fireEvent.keyDown(mid, { key: 'End' });
    fireEvent.keyUp(mid, { key: 'End' });
    expect(run('double-concave').to).toBeCloseTo(length() - 0.5, 6);
    // a key the handle has no use for is left alone
    const kept = doc();
    fireEvent.keyDown(mid, { key: 'a' });
    expect(doc()).toBe(kept);
  });

  it('read in the display unit', () => {
    act(() => {
      railsStore.getState().addContour('vee');
    });
    mount();
    const to = handle('to');
    expect(Number(to.getAttribute('aria-valuenow'))).toBeCloseTo(run('vee').to, 6);
    expect(to.getAttribute('aria-valuetext')).toMatch(/cm$/);
    act(() => setChosenContour(contoursOf(doc())[0]!.id));
  });
});
