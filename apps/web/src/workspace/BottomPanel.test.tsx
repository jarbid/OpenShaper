// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The bottom panel against the real rails store: a board with no contour, Add contour (the four kinds), the
 * chosen contour's Depth (typed, stepped by a key, slid), its second dial, where it runs (From and To), the
 * on/off switch, Remove, and under More the other numbers, the law along the board and Edit curve. Each edit is
 * the store action with the arguments it should have, one undo step with its label, and a number the board holds
 * says so.
 */
import type { RailsBoard } from '@openshaper/board2';
import { MAX_CONTOURS, contourDials, contourExtent, contoursOf } from '@openshaper/store/rails';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lengthUnitByKey } from '../format';
import { activeStore, boardStore, railsStore } from '../store';
import { key, showRails } from '../test/rails-board';
import {
  getBottomEditCurve,
  getBottomStatus,
  getChosenContour,
  resetBottomChoice,
  setChosenContour,
} from './bottom-choice';
import { BottomPanel } from './BottomPanel';
import { NO_CONTOURS } from './contour-panel';

const CM = lengthUnitByKey('cm');
const MM = lengthUnitByKey('mm');
const KEYS = [key(20, 0.5), key(100, 0.5), key(170, 0.4)];

const doc = () => railsStore.getState().doc as RailsBoard;
const past = () => railsStore.getState().past;
const labels = () => past().map((p) => p.label);
const contours = () => contoursOf(doc());
const dials = (id: string) => contourDials(doc(), id)!;
const store = () => railsStore.getState();

const panel = () => screen.getByRole('region', { name: 'Bottom panel' });
const add = (name: string) =>
  fireEvent.click(
    within(within(panel()).getByRole('group', { name: 'Add a contour' })).getByRole('button', {
      name,
    }),
  );
const field = (name: string) => within(panel()).getByRole('textbox', { name }) as HTMLInputElement;
const slider = (name: string) => within(panel()).getByRole('slider', { name }) as HTMLInputElement;
const type = (name: string, value: string) => {
  fireEvent.change(field(name), { target: { value } });
  fireEvent.keyDown(field(name), { key: 'Enter' });
};
const openMore = () => fireEvent.click(within(panel()).getByRole('button', { name: /More/ }));

beforeEach(async () => {
  localStorage.clear();
  resetBottomChoice();
  await showRails({ plus: KEYS });
});
afterEach(() => {
  resetBottomChoice();
  activeStore.use(boardStore);
});

describe('a board with no contour', () => {
  it('says so in a sentence and offers the four kinds to add, in a shaper’s order', () => {
    render(<BottomPanel units={CM} slice={3} />);
    expect(within(panel()).getByTestId('no-contours').textContent).toBe(NO_CONTOURS);
    expect(within(panel()).queryByTestId('contour-list')).toBeNull();
    const group = within(panel()).getByRole('group', { name: 'Add a contour' });
    expect(
      within(group)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Single concave', 'Double concave', 'Vee', 'Channels']);
    expect(within(panel()).queryByRole('textbox', { name: 'Depth number' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Bottom' })).toBeTruthy();
  });
});

describe('adding a contour', () => {
  it('adds the kind at its own run and depth, chooses it, and shows its dials', () => {
    render(<BottomPanel units={CM} slice={3} />);
    add('Single concave');
    expect(contours().map((c) => c.name)).toEqual(['Single concave']);
    expect(labels()).toEqual(['Add Single concave']);
    expect(getChosenContour()).toBe('single-concave');
    expect(screen.getByRole('heading', { name: /Bottom.*Single concave/ })).toBeTruthy();
    expect(within(panel()).queryByTestId('no-contours')).toBeNull();
    const d = dials('single-concave');
    expect(field('Depth number').value).toBe(d.depth.value.toFixed(2));
    expect(field('Width number').value).toBe('70');
    expect(field('From number').value).toBe(d.from.value.toFixed(2));
    expect(field('To number').value).toBe(d.to.value.toFixed(2));
    // the row of the list says what it is
    expect(within(panel()).getByTestId('contour-list').textContent).toContain('0.3 cm deep');
  });

  it('gives each kind its own second dial: a concave’s Width, the channels’ Count, and a vee none', () => {
    render(<BottomPanel units={CM} slice={3} />);
    add('Vee');
    expect(within(panel()).queryByRole('textbox', { name: 'Width number' })).toBeNull();
    expect(within(panel()).queryByRole('textbox', { name: 'Count number' })).toBeNull();
    add('Channels');
    expect(field('Count number').value).toBe('2');
    add('Double concave');
    expect(field('Width number').value).toBe('30');
    expect(contours().map((c) => c.id)).toEqual(['vee', 'channels', 'double-concave']);
    // every kind that was added was chosen when it came
    expect(getChosenContour()).toBe('double-concave');
  });

  it('is one undo step, and undo takes it away again', () => {
    render(<BottomPanel units={CM} slice={3} />);
    const before = doc();
    add('Channels');
    act(() => store().undo());
    expect(doc()).toBe(before);
    expect(screen.getByTestId('no-contours')).toBeTruthy();
  });

  it('is not offered when the board holds the most contours, and the panel says why', () => {
    render(<BottomPanel units={CM} slice={3} />);
    act(() => {
      for (let i = 0; i < MAX_CONTOURS; i++) store().addContour('vee');
    });
    const group = within(panel()).getByRole('group', { name: 'Add a contour' });
    for (const b of within(group).getAllByRole('button'))
      expect((b as HTMLButtonElement).disabled).toBe(true);
    expect(within(panel()).getByText(/as many contours as the engine builds/)).toBeTruthy();
  });
});

describe('the list', () => {
  it('chooses a contour when its row is pressed, and shows its numbers', () => {
    render(<BottomPanel units={CM} slice={3} />);
    add('Vee');
    add('Channels');
    expect(getChosenContour()).toBe('channels');
    fireEvent.click(panel().querySelector('[data-contour="vee"]')!);
    expect(getChosenContour()).toBe('vee');
    expect(screen.getByRole('heading', { name: /Bottom.*Vee/ })).toBeTruthy();
    expect(field('Depth number').value).toBe(dials('vee').depth.value.toFixed(2));
    const pressed = within(panel()).getAllByRole('button', { pressed: true });
    expect(pressed.map((b) => b.getAttribute('data-contour'))).toEqual(['vee']);
  });

  it('shows the first contour when the one that was chosen is not there', () => {
    act(() => {
      store().addContour('vee');
      store().addContour('channels');
    });
    act(() => setChosenContour('gone'));
    render(<BottomPanel units={CM} slice={3} />);
    expect(screen.getByRole('heading', { name: /Bottom.*Vee/ })).toBeTruthy();
  });

  it('switches a contour off and on, each one undo step, keeping it in the list', () => {
    render(<BottomPanel units={CM} slice={3} />);
    add('Vee');
    fireEvent.click(within(panel()).getByRole('checkbox', { name: 'Vee on' }));
    expect(doc().features[0]!.enabled).toBe(false);
    expect(contours()).toHaveLength(1);
    expect(screen.getByText(/switched off: it is kept, and not built/i)).toBeTruthy();
    fireEvent.click(within(panel()).getByRole('checkbox', { name: 'Vee on' }));
    expect(doc().features[0]!.enabled).toBe(true);
    expect(labels()).toEqual(['Add Vee', 'Disable vee', 'Enable vee']);
  });

  it('removes a contour, chooses its neighbour, says so, and undo brings it back', () => {
    render(<BottomPanel units={CM} slice={3} />);
    add('Vee');
    add('Channels');
    fireEvent.click(within(panel()).getByRole('button', { name: 'Remove Channels' }));
    expect(contours().map((c) => c.id)).toEqual(['vee']);
    expect(getChosenContour()).toBe('vee');
    expect(getBottomStatus()).toBe('Removed Channels. Undo brings it back.');
    expect(within(panel()).getByRole('status').textContent).toContain('Removed Channels');
    act(() => store().undo());
    expect(contours().map((c) => c.id)).toEqual(['vee', 'channels']);
    fireEvent.click(within(panel()).getByRole('button', { name: 'Remove Vee' }));
    fireEvent.click(within(panel()).getByRole('button', { name: 'Remove Channels' }));
    expect(screen.getByTestId('no-contours')).toBeTruthy();
    expect(getChosenContour()).toBeNull();
  });
});

describe('the depth', () => {
  it('is typed in the display unit, one undo step with its label, and reads back what was set', () => {
    render(<BottomPanel units={CM} slice={3} />);
    add('Single concave');
    type('Depth number', '0.45');
    expect(dials('single-concave').depth.value).toBeCloseTo(0.45, 9);
    expect(labels()).toEqual(['Add Single concave', 'Set depth of single concave']);
    expect(field('Depth number').value).toBe('0.45');
    act(() => store().undo());
    expect(dials('single-concave').depth.value).toBeCloseTo(0.3, 9);
  });

  it('is typed in millimetres when the unit is millimetres', () => {
    render(<BottomPanel units={MM} slice={3} />);
    add('Vee');
    expect(field('Depth number').value).toBe('2.0');
    type('Depth number', '2.5');
    expect(dials('vee').depth.value).toBeCloseTo(0.25, 9);
    expect(within(panel()).getByTestId('contour-list').textContent).toContain('2.5 mm');
  });

  it('is stepped by the arrow keys, a held key one undo step', () => {
    render(<BottomPanel units={CM} slice={3} />);
    add('Single concave');
    const f = field('Depth number');
    const start = dials('single-concave').depth.value;
    fireEvent.keyDown(f, { key: 'ArrowUp' });
    fireEvent.keyDown(f, { key: 'ArrowUp' });
    fireEvent.keyDown(f, { key: 'ArrowUp', shiftKey: true });
    fireEvent.keyUp(f, { key: 'ArrowUp' });
    expect(dials('single-concave').depth.value).toBeCloseTo(start + 0.02 + 0.02 + 0.1, 9);
    expect(labels()).toEqual(['Add Single concave', 'Set depth of single concave']);
    fireEvent.keyDown(f, { key: 'ArrowDown' });
    fireEvent.keyUp(f, { key: 'ArrowDown' });
    expect(labels()).toHaveLength(3);
  });

  it('is slid, the whole drag one undo step, to the least and the most the board holds', () => {
    render(<BottomPanel units={CM} slice={3} />);
    add('Single concave');
    const s = slider('Depth');
    fireEvent.pointerDown(s);
    fireEvent.change(s, { target: { value: '200' } });
    expect(dials('single-concave').depth.value).toBeCloseTo(dials('single-concave').depth.max, 9);
    fireEvent.change(s, { target: { value: '0' } });
    expect(dials('single-concave').depth.value).toBe(0);
    fireEvent.change(s, { target: { value: '100' } });
    fireEvent.pointerUp(s);
    const d = dials('single-concave');
    expect(d.depth.value).toBeCloseTo((d.depth.min + d.depth.max) / 2, 9);
    expect(labels()).toEqual(['Add Single concave', 'Set depth of single concave']);
    expect(s.getAttribute('aria-valuetext')).toMatch(/cm$/);
  });

  it('is held at the most the board allows, and the panel says so', () => {
    render(<BottomPanel units={CM} slice={3} />);
    add('Single concave');
    type('Depth number', '99');
    const d = dials('single-concave');
    expect(d.depth.value).toBeCloseTo(d.depth.max, 9);
    expect(getBottomStatus()).toMatch(/^Held at the most this board allows here/);
    expect(within(panel()).getByRole('status').textContent).toMatch(/Held at the most/);
    type('Depth number', '0.2');
    expect(getBottomStatus()).toBe('');
  });

  it('keeps a number that is not one where it was', () => {
    render(<BottomPanel units={CM} slice={3} />);
    add('Vee');
    const before = doc();
    type('Depth number', 'abc');
    expect(doc()).toBe(before);
    expect(field('Depth number').value).toBe('0.20');
  });
});

describe('the second dial and where it runs', () => {
  it('sets a concave’s width as a percent, held to its range', () => {
    render(<BottomPanel units={CM} slice={3} />);
    add('Single concave');
    type('Width number', '50');
    const f = doc().features[0]!;
    expect(f.kind === 'concave' && f.width).toBeCloseTo(0.5, 9);
    expect(labels()).toContain('Set single concave');
    type('Width number', '400');
    expect(dials('single-concave').second!.value).toBe(1);
    expect(getBottomStatus()).toMatch(/Held at the most/);
  });

  it('sets the channels’ count with its slider, in whole channels', () => {
    render(<BottomPanel units={CM} slice={3} />);
    add('Channels');
    fireEvent.change(slider('Count'), { target: { value: '3' } });
    const f = doc().features[0]!;
    expect(f.kind === 'channels' && f.count).toBe(3);
  });

  it('sets where it starts and ends, from the tail, and holds an end a least span from the other', () => {
    render(<BottomPanel units={CM} slice={3} />);
    add('Vee');
    type('From number', '30');
    type('To number', '100');
    expect(contourExtent(doc().features[0]!)).toEqual({ from: 30, to: 100 });
    expect(labels()).toEqual(['Add Vee', 'Set extent of vee', 'Set extent of vee']);
    type('To number', '30.5');
    const { from, to } = contourExtent(doc().features[0]!);
    expect(to - from).toBeGreaterThanOrEqual(2 - 1e-9);
    expect(within(panel()).getByText(/Along the board, measured from the tail/)).toBeTruthy();
  });

  it('says when it runs out of the tail', () => {
    render(<BottomPanel units={CM} slice={3} />);
    add('Vee');
    expect(within(panel()).getByText(/and out of the tail/)).toBeTruthy();
    type('From number', '40');
    expect(within(panel()).queryByText(/and out of the tail/)).toBeNull();
  });
});

describe('More', () => {
  it('holds the other numbers of the chosen contour, each with a number and a slider', () => {
    render(<BottomPanel units={CM} slice={3} />);
    add('Channels');
    openMore();
    for (const name of ['Channel width', 'Spacing', 'Rail inset']) {
      expect(field(`${name} number`)).toBeTruthy();
      expect(slider(name)).toBeTruthy();
    }
    type('Rail inset number', '5');
    const f = doc().features[0]!;
    expect(f.kind === 'channels' && f.railInset).toBeCloseTo(5, 9);
    // a double concave has its centre there, a vee its stringer blend
    add('Double concave');
    expect(field('Centre number').value).toBe('40');
    add('Vee');
    type('Stringer blend number', '50');
    const vee = doc().features.find((q) => q.id === 'vee')!;
    expect(vee.kind === 'vee' && vee.stringerRadius).toBeCloseTo(0.5, 9);
  });

  it('lists the law along the board: the keys between the ends, to type, add and remove', () => {
    render(<BottomPanel units={CM} slice={3} />);
    add('Single concave');
    openMore();
    const keys = within(panel()).getByTestId('law-keys');
    expect(within(keys).getByRole('textbox', { name: 'Key 1 position' })).toBeTruthy();
    expect(within(keys).getByRole('textbox', { name: 'Key 2 depth' })).toBeTruthy();
    const f = doc().features[0]!;
    const middle = (f.depth.keys[1]!.s + f.depth.keys[2]!.s) / 2;
    fireEvent.change(within(keys).getByRole('textbox', { name: 'Key 1 position' }), {
      target: { value: String(middle - 5) },
    });
    fireEvent.keyDown(within(keys).getByRole('textbox', { name: 'Key 1 position' }), {
      key: 'Enter',
    });
    expect(doc().features[0]!.depth.keys[1]!.s).toBeCloseTo(middle - 5, 6);
    expect(labels().at(-1)).toBe('Move a key of single concave');
    fireEvent.click(within(keys).getByRole('button', { name: 'Remove key 1' }));
    expect(doc().features[0]!.depth.keys).toHaveLength(3);
    // a curve keeps its ends and one key between them
    expect(
      (within(keys).getByRole('button', { name: 'Remove key 1' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(within(keys).getByRole('button', { name: 'Add key' }));
    expect(doc().features[0]!.depth.keys).toHaveLength(4);
  });

  it('holds a key’s depth to what the board allows', () => {
    render(<BottomPanel units={CM} slice={3} />);
    add('Single concave');
    openMore();
    const keys = within(panel()).getByTestId('law-keys');
    fireEvent.change(within(keys).getByRole('textbox', { name: 'Key 1 depth' }), {
      target: { value: '500' },
    });
    fireEvent.keyDown(within(keys).getByRole('textbox', { name: 'Key 1 depth' }), { key: 'Enter' });
    const d = dials('single-concave');
    expect(d.depth.value).toBeLessThanOrEqual(d.depth.max + 1e-9);
  });

  it('has Edit curve, a button that is pressed while the drawing shows the bottom curve’s points', () => {
    render(<BottomPanel units={CM} slice={3} />);
    add('Vee');
    openMore();
    const button = within(panel()).getByRole('button', { name: 'Edit curve' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    expect(getBottomEditCurve()).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(within(panel()).getByText(/station 3/i)).toBeTruthy();
    fireEvent.click(button);
    expect(getBottomEditCurve()).toBe(false);
  });

  it('keeps Edit curve for a board with no contour too, and remembers that More was open', () => {
    const { unmount } = render(<BottomPanel units={CM} slice={3} />);
    openMore();
    expect(within(panel()).getByRole('button', { name: 'Edit curve' })).toBeTruthy();
    unmount();
    render(<BottomPanel units={CM} slice={3} />);
    expect(within(panel()).getByRole('button', { name: 'Edit curve' })).toBeTruthy();
  });
});
