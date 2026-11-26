// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A contour's law along the board against the real rails store: the lane under the plan, a handle on each key
 * between the ends, dragged sideways to move the key along the board and up and down to set how deep it is (one
 * undo step, held to what the board allows), and moved a step at a time by the arrow keys.
 */
import type { RailsBoard } from '@openshaper/board2';
import { contourDials } from '@openshaper/store/rails';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lengthUnitByKey } from '../format';
import { activeStore, boardStore, railsStore } from '../store';
import { key, showRails } from '../test/rails-board';
import { resetBottomChoice } from './bottom-choice';
import { ContourPlan } from './ContourPlan';
import { LAW_HEIGHT, fitPlan, lawDepthAt, lawMax, lawPaths, lawY, planX } from './contour-plan';

const CM = lengthUnitByKey('cm');
const KEYS = [key(20, 0.5), key(100, 0.5), key(170, 0.4)];
const pointer = { pointerId: 9, isPrimary: true, button: 0 };

const doc = () => railsStore.getState().doc as RailsBoard;
const labels = () => railsStore.getState().past.map((p) => p.label);
const keysOf = () => doc().features[0]!.depth.keys;
const length = () => doc().outline.plus.knots[doc().outline.plus.knots.length - 1]!.p[0];
const fit = () => fitPlan(560, length(), 24);
const keyHandle = (n: number) => screen.getByTestId(`law-key-${n}`);
const max = () => lawMax(contourDials(doc(), doc().features[0]!.id)!.depth.max);

beforeEach(async () => {
  localStorage.clear();
  resetBottomChoice();
  await showRails({ plus: KEYS });
});
afterEach(() => {
  resetBottomChoice();
  activeStore.use(boardStore);
});

const mount = () => render(<ContourPlan units={CM} slice={3} onStation={() => {}} />);
const addConcave = () =>
  act(() => {
    railsStore.getState().addContour('single-concave');
  });

describe('the lane', () => {
  it('is not there for a board with no contour, and has a handle on each key between the ends for the chosen one', () => {
    mount();
    expect(screen.queryByTestId('contour-law')).toBeNull();
    addConcave();
    expect(screen.getByTestId('contour-law')).toBeTruthy();
    expect(screen.getByTestId('contour-law').textContent).toMatch(/Depth along the board, up to/);
    // a plateau: the two ends and two keys between them
    expect(keyHandle(1).getAttribute('role')).toBe('slider');
    expect(keyHandle(2).getAttribute('aria-label')).toBe('Key 2 of the law');
    expect(screen.queryByTestId('law-key-3')).toBeNull();
    expect(Number(keyHandle(1).getAttribute('aria-valuenow'))).toBeCloseTo(keysOf()[1]!.value, 9);
    expect(keyHandle(1).getAttribute('aria-valuetext')).toMatch(/deep at .* from the tail/);
  });

  it('stands each handle at its key: across at the key’s place along the board, up by its depth', () => {
    addConcave();
    mount();
    const k = keysOf()[1]!;
    expect(Number.parseFloat(keyHandle(1).style.left) + 7).toBeCloseTo(planX(fit(), k.s), 0);
    expect(Number.parseFloat(keyHandle(1).style.top) + 7).toBeCloseTo(lawY(k.value, max()), 0);
  });
});

describe('dragging a key', () => {
  it('moves it along the board and sets how deep it is, the whole drag one undo step', () => {
    addConcave();
    mount();
    const before = keysOf()[1]!;
    const to = { s: before.s + 6, value: 0.2 };
    const h = keyHandle(1);
    fireEvent.pointerDown(h, {
      ...pointer,
      clientX: planX(fit(), before.s),
      clientY: lawY(before.value, max()),
    });
    fireEvent.pointerMove(h, {
      ...pointer,
      clientX: planX(fit(), to.s),
      clientY: lawY(to.value, max()),
    });
    fireEvent.pointerMove(h, {
      ...pointer,
      clientX: planX(fit(), to.s),
      clientY: lawY(to.value, max()),
    });
    fireEvent.pointerUp(h, pointer);
    const now = keysOf()[1]!;
    expect(now.s).toBeCloseTo(to.s, 0);
    expect(now.value).toBeCloseTo(to.value, 1);
    expect(labels()).toEqual(['Add Single concave', 'Move a key of single concave']);
    act(() => railsStore.getState().undo());
    expect(keysOf()[1]).toEqual(before);
  });

  it('holds it between its neighbours and to the depth the board allows', () => {
    addConcave();
    mount();
    const h = keyHandle(1);
    fireEvent.pointerDown(h, { ...pointer, clientX: 100, clientY: 20 });
    fireEvent.pointerMove(h, {
      ...pointer,
      clientX: planX(fit(), keysOf()[2]!.s + 50),
      clientY: -3000,
    });
    fireEvent.pointerUp(h, pointer);
    const keys = keysOf();
    expect(keys[1]!.s).toBeLessThan(keys[2]!.s);
    expect(keys[1]!.value).toBeLessThanOrEqual(
      contourDials(doc(), doc().features[0]!.id)!.depth.max + 1e-9,
    );
    fireEvent.pointerDown(h, { ...pointer, clientX: 100, clientY: 20 });
    fireEvent.pointerMove(h, { ...pointer, clientX: planX(fit(), 0), clientY: 5000 });
    fireEvent.pointerUp(h, pointer);
    expect(keysOf()[1]!.value).toBe(0);
    expect(keysOf()[1]!.s).toBeGreaterThan(keysOf()[0]!.s);
  });
});

describe('the keys', () => {
  it('move a key a centimetre along the board with left and right, a step of depth with up and down', () => {
    addConcave();
    mount();
    const before = keysOf()[1]!;
    const h = keyHandle(1);
    fireEvent.keyDown(h, { key: 'ArrowRight' });
    fireEvent.keyDown(h, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyUp(h, { key: 'ArrowRight' });
    expect(keysOf()[1]!.s).toBeCloseTo(before.s + 11, 6);
    fireEvent.keyDown(h, { key: 'ArrowUp' });
    fireEvent.keyUp(h, { key: 'ArrowUp' });
    expect(keysOf()[1]!.value).toBeCloseTo(before.value + 0.02, 9);
    fireEvent.keyDown(h, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyUp(h, { key: 'ArrowDown' });
    expect(keysOf()[1]!.value).toBeCloseTo(Math.max(0, before.value + 0.02 - 0.1), 9);
    const kept = doc();
    fireEvent.keyDown(h, { key: 'a' });
    expect(doc()).toBe(kept);
  });
});

describe('the drawing of the law', () => {
  it('maps a depth to a height and back, and holds the lane to a centimetre', () => {
    expect(lawMax(5)).toBe(1);
    expect(lawMax(0.4)).toBe(0.4);
    expect(lawMax(0)).toBe(0.1);
    for (const d of [0, 0.1, 0.25, 1]) expect(lawDepthAt(lawY(d, 1), 1)).toBeCloseTo(d, 9);
    expect(lawY(0, 1)).toBeGreaterThan(lawY(1, 1));
    expect(lawY(0, 1)).toBeLessThan(LAW_HEIGHT);
  });

  it('is a curve along the run and an area down to the baseline', () => {
    addConcave();
    const f = doc().features[0]!;
    const { line, area } = lawPaths(fit(), f, 1);
    expect(line.startsWith('M')).toBe(true);
    expect(area.endsWith('Z')).toBe(true);
    expect((line.match(/L/g) ?? []).length).toBe(64);
  });
});
