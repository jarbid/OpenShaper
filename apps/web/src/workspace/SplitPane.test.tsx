// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The divider: a separator with a value, moved by keys and by a drag, kept inside its limits and
 * remembered. It is the only splitter in the app.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { SplitPane } from './SplitPane';
import { SPLIT_STORAGE_KEY } from './split';

beforeEach(() => localStorage.clear());

/** The column, 612 px tall from y = 0, so a divider of 12 leaves 600 to share. */
function setup(ui = <SplitPane top={<p>board</p>} bottom={<p>drawing</p>} />) {
  const view = render(ui);
  const separator = screen.getByRole('separator');
  const column = separator.parentElement!;
  column.getBoundingClientRect = () =>
    ({ top: 0, left: 0, bottom: 612, right: 800, width: 800, height: 612, x: 0, y: 0 }) as DOMRect;
  return { ...view, separator, column };
}

const now = () => Number(screen.getByRole('separator').getAttribute('aria-valuenow'));
const stored = () => JSON.parse(localStorage.getItem(SPLIT_STORAGE_KEY) ?? 'null') as number | null;
const pointer = { pointerId: 7, isPrimary: true, button: 0 };

describe('the divider', () => {
  it('is a focusable horizontal separator with a value between 25 and 75, at 55', () => {
    const { separator } = setup();
    expect(separator.getAttribute('aria-orientation')).toBe('horizontal');
    expect(separator.getAttribute('aria-valuemin')).toBe('25');
    expect(separator.getAttribute('aria-valuemax')).toBe('75');
    expect(separator.getAttribute('aria-valuenow')).toBe('55');
    expect(separator.tabIndex).toBe(0);
    expect(separator.getAttribute('aria-label')).toBe('Resize the board and the drawing');
  });

  it('puts the board over the drawing, with the divider between, sharing the column 55 to 45', () => {
    const { column } = setup();
    const kids = Array.from(column.children);
    expect(kids.map((k) => k.textContent)).toEqual(['board', '', 'drawing']);
    expect(column.style.gridTemplateRows).toBe('minmax(0, 0.55fr) 12px minmax(0, 0.45fr)');
  });

  it('can be named', () => {
    setup(<SplitPane top="a" bottom="b" label="Split" />);
    expect(screen.getByRole('separator', { name: 'Split' })).toBeTruthy();
  });
});

describe('the keys', () => {
  it('move it 2 % a press, down and up', () => {
    const { separator } = setup();
    fireEvent.keyDown(separator, { key: 'ArrowDown' });
    expect(now()).toBe(57);
    fireEvent.keyDown(separator, { key: 'ArrowDown' });
    expect(now()).toBe(59);
    fireEvent.keyDown(separator, { key: 'ArrowUp' });
    expect(now()).toBe(57);
  });

  it('move the panes with it', () => {
    const { separator, column } = setup();
    fireEvent.keyDown(separator, { key: 'ArrowDown' });
    expect(column.style.gridTemplateRows).toBe('minmax(0, 0.57fr) 12px minmax(0, 0.43fr)');
  });

  it('snap to the limits on Home and End, and stop at them', () => {
    const { separator } = setup();
    fireEvent.keyDown(separator, { key: 'Home' });
    expect(now()).toBe(25);
    fireEvent.keyDown(separator, { key: 'ArrowUp' });
    expect(now()).toBe(25);
    fireEvent.keyDown(separator, { key: 'End' });
    expect(now()).toBe(75);
    fireEvent.keyDown(separator, { key: 'ArrowDown' });
    expect(now()).toBe(75);
  });

  it('consume the keys they use, so the point editor does not nudge on them, and no others', () => {
    const seen: [string, boolean][] = [];
    const onWindow = (e: KeyboardEvent) => seen.push([e.key, e.defaultPrevented]);
    window.addEventListener('keydown', onWindow);
    const { separator } = setup();
    for (const key of [
      'ArrowDown',
      'ArrowUp',
      'ArrowLeft',
      'ArrowRight',
      'Home',
      'End',
      'a',
      'Tab',
    ]) {
      fireEvent.keyDown(separator, { key });
    }
    window.removeEventListener('keydown', onWindow);
    expect(seen.map(([, prevented]) => prevented)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  it('write the position when a key moves it', () => {
    const { separator } = setup();
    fireEvent.keyDown(separator, { key: 'ArrowDown' });
    expect(stored()).toBe(0.57);
    fireEvent.keyDown(separator, { key: 'Home' });
    expect(stored()).toBe(0.25);
  });
});

describe('a drag', () => {
  it('follows the pointer, and is written once, where it ends', () => {
    const { separator } = setup();
    fireEvent.pointerDown(separator, { ...pointer, clientY: 340 });
    expect(stored()).toBeNull();
    fireEvent.pointerMove(separator, { ...pointer, clientY: 306 });
    expect(now()).toBe(50);
    fireEvent.pointerMove(separator, { ...pointer, clientY: 186 });
    expect(now()).toBe(30);
    expect(stored()).toBeNull();
    fireEvent.pointerUp(separator, { ...pointer, clientY: 186 });
    expect(stored()).toBeCloseTo(0.3, 5);
  });

  it('is held inside the limits', () => {
    const { separator } = setup();
    fireEvent.pointerDown(separator, { ...pointer, clientY: 340 });
    fireEvent.pointerMove(separator, { ...pointer, clientY: -900 });
    expect(now()).toBe(25);
    fireEvent.pointerMove(separator, { ...pointer, clientY: 9000 });
    expect(now()).toBe(75);
    fireEvent.pointerUp(separator, { ...pointer, clientY: 9000 });
    expect(stored()).toBe(0.75);
  });

  it('takes the divider’s own pointer, and nothing else', () => {
    const { separator } = setup();
    fireEvent.pointerMove(separator, { ...pointer, clientY: 100 });
    expect(now()).toBe(55);
    fireEvent.pointerDown(separator, { ...pointer, button: 2, clientY: 340 });
    fireEvent.pointerMove(separator, { ...pointer, clientY: 100 });
    expect(now()).toBe(55);
    fireEvent.pointerDown(separator, { ...pointer, clientY: 340 });
    fireEvent.pointerMove(separator, { ...pointer, pointerId: 9, clientY: 100 });
    expect(now()).toBe(55);
  });

  it('stops following when the pointer is released, and when it is cancelled', () => {
    const { separator } = setup();
    fireEvent.pointerDown(separator, { ...pointer, clientY: 340 });
    fireEvent.pointerMove(separator, { ...pointer, clientY: 306 });
    fireEvent.pointerCancel(separator, { ...pointer });
    fireEvent.pointerMove(separator, { ...pointer, clientY: 100 });
    expect(now()).toBe(50);
    expect(stored()).toBe(0.5);
  });

  it('gives the divider focus, so the keys can finish what the pointer began', () => {
    const { separator } = setup();
    fireEvent.pointerDown(separator, { ...pointer, clientY: 340 });
    expect(document.activeElement).toBe(separator);
  });
});

describe('remembering', () => {
  it('opens where it was left', () => {
    localStorage.setItem(SPLIT_STORAGE_KEY, '0.4');
    setup();
    expect(now()).toBe(40);
  });

  it('opens at 55 for a value that is not a position, and inside the limits for one out of range', () => {
    localStorage.setItem(SPLIT_STORAGE_KEY, '"x"');
    const a = setup();
    expect(now()).toBe(55);
    a.unmount();
    localStorage.setItem(SPLIT_STORAGE_KEY, '0.99');
    setup();
    expect(now()).toBe(75);
  });

  it('keeps what a key set across a remount', () => {
    const a = setup();
    fireEvent.keyDown(a.separator, { key: 'ArrowUp' });
    a.unmount();
    setup();
    expect(now()).toBe(53);
  });
});

describe('what it re-renders', () => {
  it('the divider only: the panes it was given are left alone while it moves', () => {
    let boardRenders = 0;
    let drawingRenders = 0;
    const Board = () => (boardRenders++, null);
    const Drawing = () => (drawingRenders++, null);
    const panes = { top: <Board />, bottom: <Drawing /> };
    const { separator } = setup(<SplitPane {...panes} />);
    expect([boardRenders, drawingRenders]).toEqual([1, 1]);
    fireEvent.keyDown(separator, { key: 'ArrowDown' });
    fireEvent.pointerDown(separator, { ...pointer, clientY: 340 });
    fireEvent.pointerMove(separator, { ...pointer, clientY: 306 });
    fireEvent.pointerUp(separator, { ...pointer, clientY: 306 });
    expect(now()).toBe(50);
    expect([boardRenders, drawingRenders]).toEqual([1, 1]);
  });
});
