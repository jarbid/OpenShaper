// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The station strip, given plain props: a button for each station named for its number and place in the
 * display unit; a click chooses, a drag moves (one gesture), a mouse offers a "+" off the ticks; the Add and
 * Remove buttons, and the keys. It has no board: every test hands it stations and watches what it asks for.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { lengthUnitByKey } from '../format';
import { xToPx, type Frame } from './rail-map';
import { StationStrip, type StationStripProps } from './StationStrip';

const CM = lengthUnitByKey('cm');
/** The strip has no layout in jsdom: 640 px wide, from the left of the page, over a board 180 cm long. */
const F: Frame = { width: 640, length: 180 };
const px = (x: number) => xToPx(x, F);
const pointer = { pointerId: 3, isPrimary: true, button: 0 };

const STATIONS = [{ x: 10 }, { x: 60 }, { x: 100 }, { x: 150 }];

function props(over: Partial<StationStripProps> = {}): StationStripProps {
  return {
    stations: STATIONS,
    chosen: 1,
    length: 180,
    units: CM,
    minStations: 2,
    onChoose: vi.fn(),
    onMove: vi.fn(),
    onAdd: vi.fn(),
    onRemove: vi.fn(),
    onGestureStart: vi.fn(),
    onGestureEnd: vi.fn(),
    ...over,
  };
}

const lane = () => screen.getByRole('toolbar', { name: 'Stations along the board' });
const ticks = () => within(lane()).getAllByRole('button', { name: /^Station / });
const tick = (n: number) => ticks()[n - 1]!;

describe('what it draws', () => {
  it('is a button for each station in board order, named for its number and its place', () => {
    render(<StationStrip {...props()} />);
    expect(ticks().map((b) => b.getAttribute('aria-label'))).toEqual([
      'Station 1 of 4, 10.00 cm from the tail',
      'Station 2 of 4, 60.00 cm from the tail',
      'Station 3 of 4, 100.00 cm from the tail',
      'Station 4 of 4, 150.00 cm from the tail',
    ]);
  });

  it('names the places in the display unit', () => {
    render(<StationStrip {...props({ units: lengthUnitByKey('mm') })} />);
    expect(tick(2).getAttribute('aria-label')).toBe('Station 2 of 4, 600.0 mm from the tail');
  });

  it('marks the chosen station, and has one tab stop: the chosen one', () => {
    render(<StationStrip {...props({ chosen: 2 })} />);
    expect(ticks().map((b) => b.getAttribute('aria-pressed'))).toEqual([
      'false',
      'false',
      'true',
      'false',
    ]);
    expect(ticks().filter((b) => b.tabIndex === 0)).toEqual([tick(3)]);
  });

  it('has its first tick for the tab stop when none is chosen, and says so', () => {
    render(<StationStrip {...props({ chosen: null })} />);
    expect(tick(1).tabIndex).toBe(0);
    expect(screen.getByText('No station is chosen.')).toBeTruthy();
  });

  it('says which station is chosen and where, and what the last action said', () => {
    render(<StationStrip {...props({ chosen: 2, status: 'There is no room here.' })} />);
    expect(screen.getByText('Station 3 of 4')).toBeTruthy();
    expect(screen.getByText(/100\.00 cm from the tail\./)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('There is no room here.');
  });

  it('draws the board’s length as a ruler in the display unit', () => {
    const { container } = render(<StationStrip {...props()} />);
    const labels = Array.from(container.querySelectorAll('svg text')).map((t) => t.textContent);
    expect(labels[0]).toBe('0 cm');
    expect(labels.length).toBeGreaterThan(2);
  });

  it('has the finger’s 44 px: a tall lane and a wide hit area on a coarse pointer', () => {
    render(<StationStrip {...props()} />);
    expect(lane().className).toContain('h-10');
    expect(lane().className).toContain('pointer-coarse:h-14');
    expect(tick(1).className).toContain('pointer-coarse:before:-inset-x-4');
  });

  it('numbers the ticks while they stand apart, and only the chosen one when they crowd', () => {
    const crowd = Array.from({ length: 40 }, (_, i) => ({ x: 20 + i * 3 }));
    render(<StationStrip {...props({ stations: crowd, chosen: 5 })} />);
    const numbered = ticks().filter((b) => /^\d+$/.test(b.textContent ?? ''));
    expect(numbered.map((b) => b.textContent)).toEqual(['6']);
  });
});

describe('choosing', () => {
  it('chooses a station by a click on its tick', () => {
    const p = props();
    render(<StationStrip {...p} />);
    fireEvent.click(tick(3));
    expect(p.onChoose).toHaveBeenCalledWith(2);
  });

  it('chooses the station nearest a click on the bare lane', () => {
    const p = props();
    render(<StationStrip {...p} />);
    fireEvent.click(lane(), { clientX: px(140) });
    expect(p.onChoose).toHaveBeenCalledWith(3);
    fireEvent.click(lane(), { clientX: px(20) });
    expect(p.onChoose).toHaveBeenLastCalledWith(0);
  });
});

describe('dragging a tick', () => {
  it('chooses the station on the press, then moves it with the pointer in one gesture', () => {
    const p = props();
    render(<StationStrip {...p} />);
    const t = tick(3);
    fireEvent.pointerDown(t, { ...pointer, clientX: px(100), clientY: 10 });
    expect(p.onChoose).toHaveBeenCalledWith(2);
    expect(p.onGestureStart).not.toHaveBeenCalled();
    fireEvent.pointerMove(t, { ...pointer, clientX: px(110), clientY: 10 });
    fireEvent.pointerMove(t, { ...pointer, clientX: px(120), clientY: 10 });
    expect(p.onGestureStart).toHaveBeenCalledTimes(1);
    const moves = (p.onMove as ReturnType<typeof vi.fn>).mock.calls;
    expect(moves.map((c) => c[0])).toEqual([2, 2]);
    expect(moves[0]![1]).toBeCloseTo(110, 6);
    expect(moves[1]![1]).toBeCloseTo(120, 6);
    fireEvent.pointerUp(t, { ...pointer, clientX: px(120), clientY: 10 });
    expect(p.onGestureEnd).toHaveBeenCalledTimes(1);
    // after the drag the pointer moves nothing
    fireEvent.pointerMove(t, { ...pointer, clientX: px(130), clientY: 10 });
    expect((p.onMove as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it('keeps the grab: a tick taken a little to the side does not jump to the pointer', () => {
    const p = props();
    render(<StationStrip {...p} />);
    const t = tick(2);
    fireEvent.pointerDown(t, { ...pointer, clientX: px(60) + 6, clientY: 10 });
    fireEvent.pointerMove(t, { ...pointer, clientX: px(80) + 6, clientY: 10 });
    expect((p.onMove as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toBeCloseTo(80, 6);
  });

  it('is a click, not a drag, below the slop: nothing moves', () => {
    const p = props();
    render(<StationStrip {...p} />);
    const t = tick(2);
    fireEvent.pointerDown(t, { ...pointer, clientX: px(60), clientY: 10 });
    fireEvent.pointerMove(t, { ...pointer, clientX: px(60) + 1, clientY: 10 });
    fireEvent.pointerUp(t, { ...pointer, clientX: px(60) + 1, clientY: 10 });
    expect(p.onMove).not.toHaveBeenCalled();
    expect(p.onGestureStart).not.toHaveBeenCalled();
    expect(p.onGestureEnd).not.toHaveBeenCalled();
  });

  it('ignores another button and another pointer', () => {
    const p = props();
    render(<StationStrip {...p} />);
    const t = tick(2);
    fireEvent.pointerDown(t, { ...pointer, button: 2, clientX: px(60), clientY: 10 });
    fireEvent.pointerMove(t, { ...pointer, clientX: px(90), clientY: 10 });
    expect(p.onMove).not.toHaveBeenCalled();
    fireEvent.pointerDown(t, { ...pointer, clientX: px(60), clientY: 10 });
    fireEvent.pointerMove(t, { ...pointer, pointerId: 9, clientX: px(90), clientY: 10 });
    expect(p.onMove).not.toHaveBeenCalled();
  });

  it('ends a gesture that is still open when the strip goes', () => {
    const p = props();
    const { unmount } = render(<StationStrip {...p} />);
    const t = tick(2);
    fireEvent.pointerDown(t, { ...pointer, clientX: px(60), clientY: 10 });
    fireEvent.pointerMove(t, { ...pointer, clientX: px(90), clientY: 10 });
    unmount();
    expect(p.onGestureEnd).toHaveBeenCalledTimes(1);
  });
});

describe('the "+"', () => {
  it('shows under a mouse off the ticks, and adds a station at that place', () => {
    const p = props();
    render(<StationStrip {...p} />);
    fireEvent.pointerMove(lane(), { pointerType: 'mouse', clientX: px(30), clientY: 10 });
    const plus = screen.getByRole('button', { name: 'Add a station here' });
    fireEvent.click(plus);
    expect((p.onAdd as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBeCloseTo(30, 6);
    expect(screen.queryByRole('button', { name: 'Add a station here' })).toBeNull();
  });

  it('is not offered on a tick, to a finger, or off the board', () => {
    render(<StationStrip {...props()} />);
    fireEvent.pointerMove(lane(), { pointerType: 'mouse', clientX: px(60), clientY: 10 });
    expect(screen.queryByRole('button', { name: 'Add a station here' })).toBeNull();
    fireEvent.pointerMove(lane(), { pointerType: 'touch', clientX: px(30), clientY: 10 });
    expect(screen.queryByRole('button', { name: 'Add a station here' })).toBeNull();
    fireEvent.pointerMove(lane(), { pointerType: 'mouse', clientX: px(0) - 5, clientY: 10 });
    expect(screen.queryByRole('button', { name: 'Add a station here' })).toBeNull();
  });

  it('goes when the pointer leaves', () => {
    render(<StationStrip {...props()} />);
    fireEvent.pointerMove(lane(), { pointerType: 'mouse', clientX: px(30), clientY: 10 });
    expect(screen.getByRole('button', { name: 'Add a station here' })).toBeTruthy();
    fireEvent.pointerLeave(lane());
    expect(screen.queryByRole('button', { name: 'Add a station here' })).toBeNull();
  });
});

describe('Add station and Remove station', () => {
  it('add a station midway between the chosen one and the next', () => {
    const p = props({ chosen: 1 });
    render(<StationStrip {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add station' }));
    expect(p.onAdd).toHaveBeenCalledWith(80);
  });

  it('add midway to the nose after the last station, and are off where there is no room', () => {
    const p = props({ chosen: 3 });
    const { rerender } = render(<StationStrip {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add station' }));
    expect(p.onAdd).toHaveBeenCalledWith(165);
    rerender(<StationStrip {...props({ chosen: 3, stations: [{ x: 10 }, { x: 180 }] })} />);
    expect(
      (screen.getByRole('button', { name: 'Add station' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    rerender(<StationStrip {...props({ chosen: null })} />);
    expect(
      (screen.getByRole('button', { name: 'Add station' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('remove the chosen station', () => {
    const p = props({ chosen: 2 });
    render(<StationStrip {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove station' }));
    expect(p.onRemove).toHaveBeenCalledWith(2);
  });

  it('do not remove below the least number of stations, and say why', () => {
    const p = props({ stations: [{ x: 10 }, { x: 60 }], chosen: 0 });
    render(<StationStrip {...p} />);
    const remove = screen.getByRole('button', { name: 'Remove station' }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    expect(remove.title).toBe('A board keeps at least 2 stations.');
    fireEvent.keyDown(tick(1), { key: 'Delete' });
    expect(p.onRemove).not.toHaveBeenCalled();
  });
});

describe('the keys', () => {
  it('move the choice along and back with the arrows, and to the ends with Home and End', () => {
    const p = props({ chosen: 1 });
    render(<StationStrip {...p} />);
    fireEvent.keyDown(tick(2), { key: 'ArrowRight' });
    expect(p.onChoose).toHaveBeenLastCalledWith(2);
    fireEvent.keyDown(tick(2), { key: 'ArrowLeft' });
    expect(p.onChoose).toHaveBeenLastCalledWith(0);
    fireEvent.keyDown(tick(2), { key: 'End' });
    expect(p.onChoose).toHaveBeenLastCalledWith(3);
    fireEvent.keyDown(tick(2), { key: 'Home' });
    expect(p.onChoose).toHaveBeenLastCalledWith(0);
  });

  it('move focus with the choice', () => {
    const p = props({ chosen: 1 });
    render(<StationStrip {...p} />);
    tick(2).focus();
    fireEvent.keyDown(tick(2), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tick(3));
  });

  it('choose with Enter and Space as a button does', () => {
    const p = props();
    render(<StationStrip {...p} />);
    fireEvent.click(tick(4));
    expect(p.onChoose).toHaveBeenLastCalledWith(3);
  });

  it('remove the chosen station with Delete or Backspace', () => {
    const p = props({ chosen: 2 });
    render(<StationStrip {...p} />);
    fireEvent.keyDown(tick(3), { key: 'Delete' });
    fireEvent.keyDown(tick(3), { key: 'Backspace' });
    expect(p.onRemove).toHaveBeenCalledTimes(2);
    expect(p.onRemove).toHaveBeenCalledWith(2);
  });

  it('move the chosen station half a centimetre with Shift and an arrow, in one gesture', () => {
    const p = props({ chosen: 1 });
    render(<StationStrip {...p} />);
    fireEvent.keyDown(tick(2), { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(tick(2), { key: 'ArrowRight', shiftKey: true });
    expect(p.onGestureStart).toHaveBeenCalledTimes(1);
    expect(p.onMove).toHaveBeenNthCalledWith(1, 1, 60.5);
    expect(p.onMove).toHaveBeenNthCalledWith(2, 1, 60.5);
    fireEvent.keyUp(tick(2), { key: 'ArrowRight' });
    expect(p.onGestureEnd).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(tick(2), { key: 'ArrowLeft', shiftKey: true, ctrlKey: true });
    expect(p.onMove).toHaveBeenLastCalledWith(1, 55);
  });

  it('do not reach the editor’s own key handler', () => {
    const p = props({ chosen: 2 });
    render(<StationStrip {...p} />);
    const seen = vi.fn();
    window.addEventListener('keydown', seen);
    fireEvent.keyDown(tick(3), { key: 'Delete' });
    fireEvent.keyDown(tick(3), { key: 'ArrowRight' });
    fireEvent.keyDown(tick(3), { key: 'ArrowRight', shiftKey: true });
    window.removeEventListener('keydown', seen);
    expect(seen).not.toHaveBeenCalled();
  });

  it('leave a key the strip does not use to the editor', () => {
    render(<StationStrip {...props()} />);
    const seen = vi.fn();
    window.addEventListener('keydown', seen);
    fireEvent.keyDown(tick(2), { key: '[' });
    window.removeEventListener('keydown', seen);
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
