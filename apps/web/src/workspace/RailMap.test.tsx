// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The rail map against the real rails store: what it draws for a board's zones and blends, how a
 * click, a key and a drag choose and edit them (each edit one undo step), and the "+" that adds one.
 */
import type { RailsBoard } from '@openshaper/board2';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lengthUnitByKey } from '../format';
import { resetMyRails, setMyRails } from '../my-rails';
import {
  getRailChoice,
  getRailPlace,
  resetRailChoice,
  setRailChoice,
  setRailSides,
} from '../rail-choice';
import { zonesOfKeys } from '../rail-zones';
import { activeStore, boardStore, railsStore } from '../store';
import { key, rail, SAMPLE_LENGTH, showRails } from '../test/rails-board';
import { xToPx, type Frame } from './rail-map';
import { RailMap } from './RailMap';
import { RailsStep } from './RailsStep';
import { setRailStatus } from './rail-actions';

const CM = lengthUnitByKey('cm');
/** The strip has no layout in jsdom: it is 640 px wide, from the left of the page. */
const F: Frame = { width: 640, length: SAMPLE_LENGTH };
const px = (x: number) => xToPx(x, F);

/** A zone 20-60, a blend, a tick at 100, a blend, a zone 140-180. */
const KEYS = [key(20, 0.5), key(60, 0.5), key(100, 0.3), key(140, 0.4), key(180, 0.4)];

const pointer = { pointerId: 3, isPrimary: true, button: 0 };
const rails = () => (railsStore.getState().doc as RailsBoard).rails;
const past = () => railsStore.getState().past;
const toolbar = () => screen.getByRole('toolbar', { name: 'Rail zones and blends' });
const stops = () =>
  within(toolbar()).getAllByRole('button', { name: /^(Left |Right )?(Zone|Blend) / });
const stopNames = () => stops().map((b) => b.getAttribute('aria-label'));
const handle = (name: string) => screen.getByRole('slider', { name });

beforeEach(async () => {
  localStorage.clear();
  resetMyRails();
  await showRails({ plus: KEYS });
});
afterEach(() => {
  resetRailChoice();
  activeStore.use(boardStore);
});

describe('what it draws', () => {
  it('is a button for each zone and blend in board order, named for its rail and its places', () => {
    render(<RailMap units={CM} />);
    expect(stopNames()).toEqual([
      'Zone 1: Round, from 20.00 cm to 60.00 cm',
      'Blend 1: zone 1 to zone 2, from 60.00 cm to 100.00 cm',
      'Zone 2: Custom, at 100.00 cm',
      'Blend 2: zone 2 to zone 3, from 100.00 cm to 140.00 cm',
      'Zone 3: Custom, from 140.00 cm to 180.00 cm',
    ]);
  });

  it('has one lane while the sides are one list, and the toolbar has one tab stop', () => {
    render(<RailMap units={CM} />);
    expect(screen.getByRole('group', { name: 'Rail' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Left rail' })).toBeNull();
    expect(stops().filter((b) => b.tabIndex === 0)).toHaveLength(1);
  });

  it('names a zone by one of my rails when its numbers match', () => {
    setMyRails([{ name: 'Surf', rail: rail(0.3) }]);
    render(<RailMap units={CM} />);
    expect(stopNames()[2]).toBe('Zone 2: Surf, at 100.00 cm');
  });

  it('has a place along the board as a slider in the display unit, in the middle to begin with', () => {
    render(<RailMap units={CM} />);
    const ruler = screen.getByRole('slider', { name: 'Place along the board' });
    expect(ruler.getAttribute('aria-valuetext')).toBe('93.98 cm');
    expect(ruler.getAttribute('aria-valuemax')).toBe(String(SAMPLE_LENGTH));
  });

  it('has a handle at each end of a zone of length and one on a zone of no length', () => {
    render(<RailMap units={CM} />);
    const sliders = screen
      .getAllByRole('slider')
      .map((s) => s.getAttribute('aria-label'))
      .filter((n) => n !== 'Place along the board');
    expect(sliders).toEqual([
      'Start of zone 1',
      'End of zone 1',
      'Start of zone 2',
      'Start of zone 3',
      'End of zone 3',
    ]);
    const end = handle('End of zone 1');
    expect(end.getAttribute('aria-valuetext')).toBe('60.00 cm');
    expect(end.getAttribute('aria-valuenow')).toBe('60');
  });

  it('draws nothing when no rails board is being edited', () => {
    activeStore.use(boardStore);
    const { container } = render(<RailMap units={CM} />);
    expect(container.firstChild).toBeNull();
  });

  it('draws two lanes, Left over Right, when the sides differ, each its own zones', async () => {
    await showRails({ plus: KEYS, minus: [key(30, 0.5), key(150, 0.3)] });
    render(<RailMap units={CM} />);
    expect(screen.getByRole('group', { name: 'Left rail' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Right rail' })).toBeTruthy();
    const names = stopNames();
    expect(names.filter((n) => n!.startsWith('Left '))).toHaveLength(5);
    expect(names.filter((n) => n!.startsWith('Right '))).toEqual([
      'Right Zone 1: Round, at 30.00 cm',
      'Right Blend 1: zone 1 to zone 2, from 30.00 cm to 150.00 cm',
      'Right Zone 2: Custom, at 150.00 cm',
    ]);
  });

  it('draws two lanes while one side is being edited alone, though the sides are the same', async () => {
    await showRails({ plus: KEYS, minus: KEYS });
    render(<RailMap units={CM} />);
    expect(screen.queryByRole('group', { name: 'Left rail' })).toBeNull();
    act(() => setRailSides('plus'));
    expect(screen.getByRole('group', { name: 'Left rail' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Right rail' })).toBeTruthy();
  });
});

describe('choosing', () => {
  it('chooses a zone by a click and puts the cursor where it landed, held inside the zone', () => {
    render(<RailMap units={CM} />);
    fireEvent.click(stops()[0]!, { clientX: px(30), detail: 1 });
    expect(getRailChoice()).toEqual({ side: 'plus', zone: 0 });
    expect(getRailPlace()).toBeCloseTo(30, 6);
    expect(stops()[0]!.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(stops()[0]!, { clientX: px(5), detail: 1 });
    expect(getRailPlace()).toBe(20);
  });

  it('chooses a blend by a click, and the middle of a zone by a key', () => {
    render(<RailMap units={CM} />);
    fireEvent.click(stops()[1]!, { clientX: px(70), detail: 1 });
    expect(getRailChoice()).toEqual({ side: 'plus', blend: 0 });
    expect(getRailPlace()).toBeCloseTo(70, 6);
    fireEvent.click(stops()[4]!, { detail: 0 });
    expect(getRailChoice()).toEqual({ side: 'plus', zone: 2 });
    expect(getRailPlace()).toBe(160);
  });

  it('chooses the end zone from the stretch the rail is held flat across', () => {
    render(<RailMap units={CM} />);
    const lead = document.querySelector<HTMLElement>('[data-hold=lead]')!;
    fireEvent.click(lead, { clientX: px(10) });
    expect(getRailChoice()).toEqual({ side: 'plus', zone: 0 });
    expect(getRailPlace()).toBe(20);
  });

  it('moves the place alone from the ruler, and keeps the choice', () => {
    render(<RailMap units={CM} />);
    fireEvent.click(stops()[0]!, { clientX: px(30), detail: 1 });
    const ruler = screen.getByRole('slider', { name: 'Place along the board' });
    fireEvent.pointerDown(ruler, { ...pointer, clientX: px(150) });
    expect(getRailPlace()).toBeCloseTo(150, 6);
    expect(getRailChoice()).toEqual({ side: 'plus', zone: 0 });
    // and follows the pointer while it is held down
    fireEvent.pointerMove(ruler, { ...pointer, clientX: px(120) });
    expect(getRailPlace()).toBeCloseTo(120, 6);
    fireEvent.pointerUp(ruler, { ...pointer, clientX: px(120) });
    fireEvent.pointerMove(ruler, { ...pointer, clientX: px(60) });
    expect(getRailPlace()).toBeCloseTo(120, 6);
  });

  it('moves the place with the arrow keys, by half a centimetre and by five with Shift', () => {
    act(() => setRailChoice(null, 100));
    render(<RailMap units={CM} />);
    const ruler = screen.getByRole('slider', { name: 'Place along the board' });
    fireEvent.keyDown(ruler, { key: 'ArrowRight' });
    expect(getRailPlace()).toBe(100.5);
    fireEvent.keyDown(ruler, { key: 'ArrowLeft', shiftKey: true });
    expect(getRailPlace()).toBe(95.5);
    fireEvent.keyDown(ruler, { key: 'End' });
    expect(getRailPlace()).toBe(SAMPLE_LENGTH);
    fireEvent.keyDown(ruler, { key: 'Home' });
    expect(getRailPlace()).toBe(0);
  });

  it('moves the choice along the strip with the arrow keys, taking focus with it', () => {
    render(<RailMap units={CM} />);
    const first = stops()[0]!;
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(getRailChoice()).toEqual({ side: 'plus', blend: 0 });
    expect(document.activeElement).toBe(stops()[1]);
    fireEvent.keyDown(stops()[1]!, { key: 'ArrowRight' });
    expect(getRailChoice()).toEqual({ side: 'plus', zone: 1 });
    fireEvent.keyDown(stops()[2]!, { key: 'End' });
    expect(getRailChoice()).toEqual({ side: 'plus', zone: 2 });
    fireEvent.keyDown(stops()[4]!, { key: 'Home' });
    expect(getRailChoice()).toEqual({ side: 'plus', zone: 0 });
    // the tab stop is the chosen one
    expect(stops().filter((b) => b.tabIndex === 0)).toEqual([stops()[0]]);
  });

  it('moves between the lanes with Up and Down', async () => {
    await showRails({ plus: KEYS, minus: [key(30, 0.5), key(150, 0.3)] });
    render(<RailMap units={CM} />);
    const top = stops().find((b) => b.dataset.lane === 'plus')!;
    top.focus();
    fireEvent.keyDown(top, { key: 'ArrowDown' });
    expect(getRailChoice()?.side).toBe('minus');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(getRailChoice()?.side).toBe('plus');
  });
});

describe('dragging a zone’s end', () => {
  it('moves it with the pointer, as one undo step, and the strip follows at once', () => {
    render(<RailMap units={CM} />);
    const end = handle('End of zone 1');
    fireEvent.pointerDown(end, { ...pointer, clientX: px(60), clientY: 10 });
    expect(getRailChoice()).toEqual({ side: 'plus', zone: 0 });
    for (const x of [62, 65, 70, 75]) {
      fireEvent.pointerMove(end, { ...pointer, clientX: px(x), clientY: 10 });
      expect(rails().plus[1]!.x).toBeCloseTo(x, 6);
      // the block reads its new end in the same render
      expect(stopNames()[0]).toContain(`to ${x.toFixed(2)} cm`);
    }
    fireEvent.pointerUp(end, { ...pointer, clientX: px(75), clientY: 10 });
    expect(past()).toHaveLength(1);
    expect(past()[0]!.label).toBe('Move rail zone');
    expect(railsStore.getState().editing).toBe(false);
    act(() => railsStore.getState().undo());
    expect(rails().plus[1]!.x).toBe(60);
  });

  it('stops at the gap when held past the next zone', () => {
    render(<RailMap units={CM} />);
    const end = handle('End of zone 1');
    fireEvent.pointerDown(end, { ...pointer, clientX: px(60), clientY: 10 });
    fireEvent.pointerMove(end, { ...pointer, clientX: px(150), clientY: 10 });
    fireEvent.pointerUp(end, { ...pointer, clientX: px(150), clientY: 10 });
    expect(rails().plus[1]!.x).toBe(99);
  });

  it('is not a drag, and makes no undo step, until the pointer has moved a little', () => {
    render(<RailMap units={CM} />);
    const end = handle('End of zone 1');
    fireEvent.pointerDown(end, { ...pointer, clientX: px(60), clientY: 10 });
    fireEvent.pointerMove(end, { ...pointer, clientX: px(60) + 1, clientY: 10 });
    fireEvent.pointerUp(end, { ...pointer, clientX: px(60) + 1, clientY: 10 });
    expect(past()).toHaveLength(0);
    expect(getRailChoice()).toEqual({ side: 'plus', zone: 0 });
  });

  it('ignores the pointer of another finger, and a button that is not the main one', () => {
    render(<RailMap units={CM} />);
    const end = handle('End of zone 1');
    fireEvent.pointerDown(end, { ...pointer, button: 2, clientX: px(60), clientY: 10 });
    fireEvent.pointerMove(end, { ...pointer, clientX: px(80), clientY: 10 });
    expect(past()).toHaveLength(0);
    fireEvent.pointerDown(end, { ...pointer, clientX: px(60), clientY: 10 });
    fireEvent.pointerMove(end, { ...pointer, pointerId: 9, clientX: px(80), clientY: 10 });
    expect(rails().plus[1]!.x).toBe(60);
    fireEvent.pointerUp(end, { ...pointer, clientX: px(60), clientY: 10 });
  });

  it('moves a zone of no length by its handle, and draws it out with the grip it shows when chosen', () => {
    render(<RailMap units={CM} />);
    // not chosen: no grip
    expect(screen.queryByRole('slider', { name: 'Draw out zone 2' })).toBeNull();
    const start = handle('Start of zone 2');
    fireEvent.pointerDown(start, { ...pointer, clientX: px(100), clientY: 10 });
    fireEvent.pointerMove(start, { ...pointer, clientX: px(90), clientY: 10 });
    fireEvent.pointerUp(start, { ...pointer, clientX: px(90), clientY: 10 });
    // it was moved, still a tick
    expect(rails().plus[2]!.x).toBeCloseTo(90, 6);
    expect(zonesOfKeys(rails().plus).zones[1]).toMatchObject({ from: rails().plus[2]!.x });
    expect(zonesOfKeys(rails().plus).zones[1]!.to).toBe(zonesOfKeys(rails().plus).zones[1]!.from);
    // chosen by that drag, so the grip is there; drawn out to 120
    const grip = handle('Draw out zone 2');
    fireEvent.pointerDown(grip, { ...pointer, clientX: px(90) + 16, clientY: 10 });
    fireEvent.pointerMove(grip, { ...pointer, clientX: px(120) + 16, clientY: 10 });
    fireEvent.pointerUp(grip, { ...pointer, clientX: px(120) + 16, clientY: 10 });
    const zone = zonesOfKeys(rails().plus).zones[1]!;
    expect(zone.from).toBeCloseTo(90, 6);
    expect(zone.to).toBeCloseTo(120, 6);
    // the grip became the zone's end handle, the same element, and its release ended the drag
    expect(handle('End of zone 2')).toBe(grip);
    expect(railsStore.getState().editing).toBe(false);
    expect(past()).toHaveLength(2);
  });

  it('ends a drag that is still open when the map goes', () => {
    const view = render(<RailMap units={CM} />);
    const end = handle('End of zone 1');
    fireEvent.pointerDown(end, { ...pointer, clientX: px(60), clientY: 10 });
    fireEvent.pointerMove(end, { ...pointer, clientX: px(70), clientY: 10 });
    expect(railsStore.getState().editing).toBe(true);
    view.unmount();
    expect(railsStore.getState().editing).toBe(false);
    expect(past()).toHaveLength(1);
  });

  it('drags in the lane it is in: the right side alone on a board whose sides differ', async () => {
    await showRails({ plus: KEYS, minus: [key(30, 0.5), key(150, 0.3)] });
    const before = rails();
    render(<RailMap units={CM} />);
    const end = handle('Right Start of zone 2');
    fireEvent.pointerDown(end, { ...pointer, clientX: px(150), clientY: 60 });
    fireEvent.pointerMove(end, { ...pointer, clientX: px(120), clientY: 60 });
    fireEvent.pointerUp(end, { ...pointer, clientX: px(120), clientY: 60 });
    expect(rails().plus).toBe(before.plus);
    expect(rails().minus![1]!.x).toBeCloseTo(120, 6);
    expect(getRailChoice()).toEqual({ side: 'minus', zone: 1 });
  });

  it('keeps the chosen zone while a dial-like drag changes how many zones there are, and settles after', () => {
    render(<RailMap units={CM} />);
    fireEvent.click(stops()[4]!, { detail: 0 });
    railsStore.getState().beginEdit();
    // the rails of zone 3 become zone 2's for a moment: two zones, the choice held
    railsStore.getState().setZoneRail('both', 2, rails().plus[2]!.rail);
    expect(getRailChoice()).toEqual({ side: 'plus', zone: 2 });
    railsStore.getState().endEdit();
    expect(getRailChoice()).toEqual({ side: 'plus', zone: 1 });
  });
});

describe('the keyboard on a handle', () => {
  it('nudges a zone’s end half a centimetre, or five with Shift, one undo step for a burst of keys', () => {
    render(<RailMap units={CM} />);
    const end = handle('End of zone 1');
    fireEvent.keyDown(end, { key: 'ArrowRight' });
    fireEvent.keyDown(end, { key: 'ArrowRight' });
    fireEvent.keyDown(end, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyUp(end, { key: 'ArrowRight' });
    expect(rails().plus[1]!.x).toBeCloseTo(60 + 0.5 + 0.5 + 5, 9);
    expect(past()).toHaveLength(1);
    fireEvent.keyDown(end, { key: 'ArrowLeft' });
    fireEvent.keyUp(end, { key: 'ArrowLeft' });
    expect(rails().plus[1]!.x).toBeCloseTo(60 + 5.5, 9);
    expect(past()).toHaveLength(2);
    expect(past().map((p) => p.label)).toEqual(['Move rail zone', 'Move rail zone']);
  });

  it('ends the edit when the handle loses focus mid-burst', () => {
    render(<RailMap units={CM} />);
    const end = handle('End of zone 1');
    fireEvent.keyDown(end, { key: 'ArrowRight' });
    expect(railsStore.getState().editing).toBe(true);
    fireEvent.blur(end);
    expect(railsStore.getState().editing).toBe(false);
  });

  it('keeps the arrow keys and Delete from reaching the editor’s own handler', () => {
    const seen = vi.fn();
    window.addEventListener('keydown', seen);
    render(<RailMap units={CM} />);
    const end = handle('End of zone 1');
    fireEvent.keyDown(end, { key: 'ArrowRight' });
    fireEvent.keyUp(end, { key: 'ArrowRight' });
    fireEvent.keyDown(stops()[0]!, { key: 'ArrowRight' });
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Place along the board' }), {
      key: 'ArrowRight',
    });
    fireEvent.keyDown(stops()[2]!, { key: 'Delete' });
    expect(seen).not.toHaveBeenCalled();
    window.removeEventListener('keydown', seen);
  });

  it('lets a key it does not use through', () => {
    const seen = vi.fn();
    window.addEventListener('keydown', seen);
    render(<RailMap units={CM} />);
    fireEvent.keyDown(stops()[0]!, { key: 'z', ctrlKey: true });
    expect(seen).toHaveBeenCalled();
    window.removeEventListener('keydown', seen);
  });
});

describe('adding a zone', () => {
  afterEach(() => setRailStatus(''));
  const lane = () => screen.getByRole('group', { name: 'Rail' });
  const point = (x: number) =>
    fireEvent.pointerMove(lane(), { pointerType: 'mouse', clientX: px(x), clientY: 20 });

  it('offers a "+" under the pointer in a blend, and a click adds a zone there and chooses it', () => {
    render(<RailMap units={CM} />);
    expect(screen.queryByRole('button', { name: 'Add a zone here' })).toBeNull();
    point(80);
    fireEvent.click(screen.getByRole('button', { name: 'Add a zone here' }));
    expect(zonesOfKeys(rails().plus).zones).toHaveLength(4);
    expect(zonesOfKeys(rails().plus).zones[1]!.from).toBeCloseTo(80, 6);
    expect(getRailChoice()).toEqual({ side: 'plus', zone: 1 });
    expect(past().map((p) => p.label)).toEqual(['Add rail zone']);
    // the "+" is gone with the click
    expect(screen.queryByRole('button', { name: 'Add a zone here' })).toBeNull();
  });

  it('splits the zone under the pointer: the part after it is the new zone and keeps the rail’s name', () => {
    render(<RailMap units={CM} />);
    point(40);
    fireEvent.click(screen.getByRole('button', { name: 'Add a zone here' }));
    const zones = zonesOfKeys(rails().plus).zones;
    expect(zones).toHaveLength(4);
    expect(zones[0]!.to).toBeLessThan(40);
    expect(zones[1]!.from).toBeGreaterThan(40);
    expect(zones[1]!.to).toBe(60);
    expect(getRailChoice()).toEqual({ side: 'plus', zone: 1 });
    // the board has not changed shape: both parts are still Round
    expect(stopNames()[0]).toContain('Round');
    expect(stopNames()[2]).toContain('Round');
    expect(stopNames()[2]).toContain('Zone 2: Round');
  });

  it('offers no "+" on a handle or on a zone of no length', () => {
    render(<RailMap units={CM} />);
    point(100);
    expect(screen.queryByRole('button', { name: 'Add a zone here' })).toBeNull();
    point(60);
    expect(screen.queryByRole('button', { name: 'Add a zone here' })).toBeNull();
    // and not for a touch, which has nothing to point with
    fireEvent.pointerMove(lane(), { pointerType: 'touch', clientX: px(80), clientY: 20 });
    expect(screen.queryByRole('button', { name: 'Add a zone here' })).toBeNull();
  });

  it('adds a zone at the cursor from the Add zone button, and says when it cannot', () => {
    render(<RailsStep units={CM} />);
    act(() => setRailChoice(null, 80));
    fireEvent.click(screen.getByRole('button', { name: 'Add zone' }));
    expect(zonesOfKeys(rails().plus).zones).toHaveLength(4);
    act(() => resetRailChoice());
    act(() => setRailChoice(null, 100));
    fireEvent.click(screen.getByRole('button', { name: 'Add zone' }));
    expect(screen.getByRole('status').textContent).toMatch(/no room for a zone/);
    expect(zonesOfKeys(rails().plus).zones).toHaveLength(4);
  });

  it('adds a zone at the cursor with Enter on the ruler', () => {
    render(<RailMap units={CM} />);
    act(() => setRailChoice(null, 120));
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Place along the board' }), {
      key: 'Enter',
    });
    expect(zonesOfKeys(rails().plus).zones).toHaveLength(4);
  });
});

describe('removing a zone', () => {
  it('goes with Delete on the chosen zone, one undo step, and the others are as they were', () => {
    render(<RailMap units={CM} />);
    fireEvent.click(stops()[2]!, { detail: 0 });
    fireEvent.keyDown(stops()[2]!, { key: 'Delete' });
    expect(zonesOfKeys(rails().plus).zones).toHaveLength(2);
    expect(past().map((p) => p.label)).toEqual(['Remove rail zone']);
    // the cursor is now in the blend between the two that are left: nothing is chosen
    expect(getRailChoice()).toBeNull();
  });

  it('never takes the last zone', async () => {
    await showRails({ plus: [key(50, 0.5)] });
    render(<RailMap units={CM} />);
    fireEvent.click(stops()[0]!, { detail: 0 });
    fireEvent.keyDown(stops()[0]!, { key: 'Delete' });
    expect(zonesOfKeys(rails().plus).zones).toHaveLength(1);
    expect(past()).toHaveLength(0);
  });

  it('does nothing for a blend', () => {
    render(<RailMap units={CM} />);
    fireEvent.click(stops()[1]!, { detail: 0 });
    fireEvent.keyDown(stops()[1]!, { key: 'Delete' });
    expect(zonesOfKeys(rails().plus).zones).toHaveLength(3);
  });
});

describe('Tidy rails', () => {
  afterEach(() => setRailStatus(''));

  it('joins zones whose rails are within the tolerance, one undo step, and says how many', async () => {
    await showRails({
      plus: [key(20, 0.5), key(60, 0.505), key(100, 0.3), key(140, 0.4), key(180, 0.4)],
    });
    render(<RailsStep units={CM} />);
    // four zones (the last two keys are one) and three blends
    expect(stopNames()).toHaveLength(7);
    fireEvent.click(screen.getByRole('button', { name: 'Tidy rails' }));
    expect(screen.getByRole('status').textContent).toBe('Joined 1 zone.');
    expect(zonesOfKeys(rails().plus).zones).toHaveLength(3);
    expect(past().map((p) => p.label)).toEqual(['Tidy rails']);
  });

  it('says so when there is nothing to join, and records no step', () => {
    render(<RailsStep units={CM} />);
    fireEvent.click(screen.getByRole('button', { name: 'Tidy rails' }));
    expect(screen.getByRole('status').textContent).toBe(
      'Nothing to join: neighbouring zones already differ.',
    );
    expect(past()).toHaveLength(0);
  });
});
