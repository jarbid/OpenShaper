// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The tail panel against the real rails store: the shape by name with a thumbnail, the two dials (typed, dragged, stepped by
 * a key), why a dial is off, the sides where they differ, and each corner's radius under More. Each edit is the store action
 * with the arguments it should have, one undo step with its label; choosing a shape replaces a drawn tail with no question,
 * and undo brings it back.
 */
import type { RailsBoard } from '@openshaper/board2';
import {
  applyTailShape,
  tailCorners,
  tailShapeAt,
  tailShapeOf,
  tailWidthRange,
  type TailShapeId,
} from '@openshaper/store/rails';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lengthUnitByKey } from '../format';
import { activeStore, boardStore, railsStore } from '../store';
import { key, sampleRailsBoard, showRails } from '../test/rails-board';
import { TailPanel } from './TailPanel';
import {
  getChosenCorner,
  getTailStatus,
  resetTailChoice,
  setChosenCorner,
  setTailSide,
} from './tail-choice';

const CM = lengthUnitByKey('cm');
const MM = lengthUnitByKey('mm');
const KEYS = [key(20, 0.5), key(100, 0.5), key(170, 0.4)];

const doc = () => railsStore.getState().doc as RailsBoard;
const labels = () => railsStore.getState().past.map((p) => p.label);

const panel = () => screen.getByRole('region', { name: 'Tail panel' });
const shapeButton = (id: TailShapeId) =>
  within(panel()).getByRole('button', { name: new RegExp(`^${id}$`, 'i') }) as HTMLButtonElement;
const choose = (id: TailShapeId) => fireEvent.click(shapeButton(id));
const widthField = () =>
  within(panel()).getByRole('textbox', { name: 'Tail width number' }) as HTMLInputElement;
const widthSlider = () =>
  within(panel()).getByRole('slider', { name: 'Tail width' }) as HTMLInputElement;
const notchSlider = () =>
  within(panel()).getByRole('slider', { name: 'Notch depth' }) as HTMLInputElement;
const typeInto = (field: HTMLInputElement, value: string) => {
  fireEvent.change(field, { target: { value } });
  fireEvent.keyDown(field, { key: 'Enter' });
};
const openMore = () => fireEvent.click(within(panel()).getByRole('button', { name: /More/ }));

/** Put `shape` on the board being edited, as the document the panel opens on. */
async function showShape(shape: TailShapeId): Promise<void> {
  const base = await showRails({ plus: KEYS });
  railsStore.getState().loadDoc(applyTailShape(base, { shape }));
}

beforeEach(async () => {
  localStorage.clear();
  resetTailChoice();
  await showRails({ plus: KEYS });
});
afterEach(() => {
  resetTailChoice();
  activeStore.use(boardStore);
});

describe('what it shows', () => {
  it('names the tail in its heading and offers the six shapes, none chosen for a tail drawn by hand', () => {
    render(<TailPanel units={CM} />);
    expect(tailShapeAt(doc()).shape).toBe('custom');
    expect(screen.getByRole('heading', { name: /Tail.*Custom/ })).toBeTruthy();
    const buttons = within(panel()).getAllByRole('button', {
      name: /^(squash|round|pin|diamond|swallow|fish)$/i,
    });
    expect(buttons.map((b) => b.textContent)).toEqual([
      'Squash',
      'Round',
      'Pin',
      'Diamond',
      'Swallow',
      'Fish',
    ]);
    expect(buttons.every((b) => b.getAttribute('aria-pressed') === 'false')).toBe(true);
    expect(panel().textContent).toContain('drawn, or moved since a shape was chosen');
  });

  it('turns both dials off for a drawn tail and says why', () => {
    render(<TailPanel units={CM} />);
    expect(widthSlider().disabled).toBe(true);
    expect(notchSlider().disabled).toBe(true);
    expect(panel().textContent).toContain(
      'This tail is drawn by hand, and a width would replace it.',
    );
    expect(panel().textContent).toContain('a notch would replace it');
  });

  it('shows the shape the tail is, with its width and, for a notch, its depth', async () => {
    await showShape('swallow');
    render(<TailPanel units={CM} />);
    expect(shapeButton('swallow').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('tail-shape-name').textContent).toBe('Swallow');
    const r = tailShapeOf(doc());
    expect(widthField().value).toBe(r.width!.toFixed(2));
    expect(notchSlider().disabled).toBe(false);
    expect(within(panel()).getByRole('textbox', { name: 'Notch depth number' })).toBeTruthy();
  });
});

describe('choosing a shape', () => {
  it('replaces a drawn tail with no question, one undo step named for the shape, and undo brings it back', () => {
    render(<TailPanel units={CM} />);
    const was = doc();
    choose('squash');
    expect(tailShapeOf(doc()).shape).toBe('squash');
    expect(labels()).toEqual(['Squash tail']);
    expect(getTailStatus()).toBe('Replaced the tail’s points with Squash. Undo brings them back.');
    expect(shapeButton('squash').getAttribute('aria-pressed')).toBe('true');
    act(() => railsStore.getState().undo());
    expect(doc()).toBe(was);
    expect(screen.getByRole('heading', { name: /Tail.*Custom/ })).toBeTruthy();
  });

  it('does not record a step for the shape it already is', () => {
    render(<TailPanel units={CM} />);
    choose('round');
    choose('round');
    expect(labels()).toEqual(['Round tail']);
  });

  it.each(['squash', 'round', 'pin', 'diamond'] as const)(
    '%s has no notch: the dial is off and says what to choose',
    (id) => {
      render(<TailPanel units={CM} />);
      choose(id);
      expect(notchSlider().disabled).toBe(true);
      expect(widthSlider().disabled).toBe(false);
      expect(panel().textContent).toContain(
        `A ${id} tail has no notch. Choose Swallow or Fish to cut one.`,
      );
    },
  );

  it.each(['swallow', 'fish'] as const)(
    '%s turns the notch dial on, and a notch off again for a standard tail',
    (id) => {
      render(<TailPanel units={CM} />);
      choose(id);
      expect(tailShapeOf(doc()).shape).toBe(id);
      expect(notchSlider().disabled).toBe(false);
      choose('squash');
      expect(notchSlider().disabled).toBe(true);
    },
  );
});

describe('the width dial', () => {
  beforeEach(async () => {
    await showShape('squash');
  });

  it('types a width in the display unit: one step named Set tail width', () => {
    render(<TailPanel units={CM} />);
    typeInto(widthField(), '15');
    expect(tailShapeOf(doc()).width).toBeCloseTo(15, 9);
    expect(labels()).toEqual(['Set tail width']);
    expect(widthField().value).toBe('15.00');
  });

  it('takes millimetres when the display unit is millimetres', () => {
    render(<TailPanel units={MM} />);
    typeInto(widthField(), '150');
    expect(tailShapeOf(doc()).width).toBeCloseTo(15, 9);
  });

  it('holds a width the tail cannot have at the nearest it can, and says so', () => {
    render(<TailPanel units={CM} />);
    typeInto(widthField(), '999');
    const range = tailWidthRange(doc(), 'squash');
    expect(tailShapeOf(doc()).width).toBeCloseTo(range.max, 9);
    expect(getTailStatus()).toMatch(/^Width held at the most this tail can have, \d+\.\d\d cm\./);
    expect(widthField().value).toBe(range.max.toFixed(2));
    typeInto(widthField(), '0.1');
    expect(getTailStatus()).toMatch(/^Width held at the least this tail can have/);
  });

  it('is one undo step for a drag of the slider', () => {
    render(<TailPanel units={CM} />);
    const slider = widthSlider();
    fireEvent.pointerDown(slider);
    for (const v of ['20', '60', '120', '90']) fireEvent.change(slider, { target: { value: v } });
    fireEvent.pointerUp(slider);
    expect(labels()).toEqual(['Set tail width']);
    const range = tailWidthRange(doc(), 'squash');
    expect(tailShapeOf(doc()).width).toBeCloseTo(
      range.min + (90 / 200) * (range.max - range.min),
      9,
    );
  });

  it('steps by a millimetre with the arrow keys and by a centimetre with Shift, a held key being one step', () => {
    render(<TailPanel units={CM} />);
    const before = tailShapeOf(doc()).width!;
    fireEvent.keyDown(widthField(), { key: 'ArrowUp' });
    fireEvent.keyDown(widthField(), { key: 'ArrowUp' });
    fireEvent.keyUp(widthField(), { key: 'ArrowUp' });
    expect(tailShapeOf(doc()).width!).toBeCloseTo(before + 0.2, 9);
    fireEvent.keyDown(widthField(), { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyUp(widthField(), { key: 'ArrowDown' });
    expect(tailShapeOf(doc()).width!).toBeCloseTo(before - 0.8, 9);
    expect(labels()).toEqual(['Set tail width', 'Set tail width']);
  });
});

describe('the notch depth dial', () => {
  beforeEach(async () => {
    await showShape('fish');
  });

  it('types a depth: one step named Set notch depth, and the width stays', () => {
    render(<TailPanel units={CM} />);
    const width = tailShapeOf(doc()).width!;
    typeInto(
      within(panel()).getByRole('textbox', { name: 'Notch depth number' }) as HTMLInputElement,
      '9',
    );
    expect(tailShapeOf(doc()).notch).toBeCloseTo(9, 9);
    expect(tailShapeOf(doc()).width).toBeCloseTo(width, 9);
    expect(labels()).toEqual(['Set notch depth']);
  });

  it('holds a depth at the most a board can have, 30% of its length', () => {
    render(<TailPanel units={CM} />);
    typeInto(
      within(panel()).getByRole('textbox', { name: 'Notch depth number' }) as HTMLInputElement,
      '9999',
    );
    expect(tailShapeOf(doc()).notch).toBeCloseTo(0.3 * doc().outline.plus.knots.at(-1)!.p[0], 9);
    expect(getTailStatus()).toMatch(/^Notch depth held at the most/);
  });
});

describe('the sides', () => {
  it('names no side on a board whose sides cannot differ', async () => {
    await showShape('squash');
    render(<TailPanel units={CM} />);
    expect(within(panel()).queryByRole('radio', { name: 'Left' })).toBeNull();
  });

  it('offers Both, Left and Right where the two sides differ, and an edit reaches the side chosen', async () => {
    const base = await sampleRailsBoard();
    const asym = applyTailShape(
      applyTailShape(
        {
          ...base,
          symmetry: 'asymmetric',
          outline: { plus: base.outline.plus, minus: base.outline.plus },
          corners: { ...base.corners, minus: base.corners.plus },
          rails: { plus: KEYS, minus: KEYS },
          stations: base.stations.map((s) => ({ ...s, minus: s.plus })),
        },
        { shape: 'squash' },
      ),
      { shape: 'squash', width: 20 },
      'minus',
    );
    activeStore.use(railsStore);
    railsStore.getState().loadDoc(asym);
    expect(tailShapeAt(doc()).sidesDiffer).toBe(true);
    render(<TailPanel units={CM} />);
    expect(within(panel()).getByRole('radio', { name: 'Both' })).toBeTruthy();
    act(() => setTailSide('plus'));
    const before = tailShapeOf(doc(), 'minus').width;
    typeInto(widthField(), '14');
    expect(tailShapeOf(doc(), 'plus').width).toBeCloseTo(14, 9);
    expect(tailShapeOf(doc(), 'minus').width).toBe(before);
    act(() => setTailSide('both'));
    typeInto(widthField(), '15');
    expect(tailShapeAt(doc())).toMatchObject({ shape: 'squash', sidesDiffer: false });
  });
});

describe('each corner’s radius under More', () => {
  beforeEach(async () => {
    await showShape('swallow');
  });

  it('lists the corners from the tail, named by where they are, each a number and a slider', () => {
    render(<TailPanel units={CM} />);
    openMore();
    const list = within(panel()).getByRole('list', { name: 'Corners of the tail' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => within(r).getByRole('button').textContent)).toEqual([
      expect.stringMatching(/^Tail tip0\.60 cm$/),
      expect.stringMatching(/^Notch crotch0\.20 cm$/),
    ]);
    expect(within(list).getByRole('slider', { name: 'Radius of the tail tip' })).toBeTruthy();
    expect(
      within(list).getByRole('textbox', { name: 'Radius of the notch crotch number' }),
    ).toBeTruthy();
  });

  it('sets a radius typed in the display unit, one step named Set corner radius, held to its range', () => {
    render(<TailPanel units={CM} />);
    openMore();
    const field = within(panel()).getByRole('textbox', {
      name: 'Radius of the tail tip number',
    }) as HTMLInputElement;
    typeInto(field, '1.2');
    expect(doc().corners.plus[0]).toBeCloseTo(1.2, 9);
    expect(labels().at(-1)).toBe('Set corner radius');
    typeInto(field, '0.01');
    expect(doc().corners.plus[0]).toBe(0.5);
    expect(getTailStatus()).toMatch(/^Radius held at the least this tail can have, 0\.50 cm\./);
    typeInto(
      within(panel()).getByRole('textbox', {
        name: 'Radius of the notch crotch number',
      }) as HTMLInputElement,
      '1',
    );
    expect(doc().corners.tail).toBeCloseTo(1, 9);
  });

  it('marks the chosen corner, chooses one by its name, and opens the list for a corner chosen elsewhere', () => {
    render(<TailPanel units={CM} />);
    expect(within(panel()).queryByRole('list', { name: 'Corners of the tail' })).toBeNull();
    act(() => setChosenCorner({ side: 'plus', index: 0 }));
    const list = within(panel()).getByRole('list', { name: 'Corners of the tail' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows[0]!.getAttribute('aria-current')).toBe('true');
    expect(rows[1]!.getAttribute('aria-current')).toBeNull();
    fireEvent.click(within(rows[1]!).getByRole('button', { name: /Notch crotch/ }));
    expect(getChosenCorner()).toEqual({ side: 'tail', index: 0 });
    expect(rows[1]!.getAttribute('aria-current')).toBe('true');
  });

  it('says there is no corner where the tail is smooth', async () => {
    await showShape('round');
    render(<TailPanel units={CM} />);
    openMore();
    expect(tailCorners(doc())).toHaveLength(0);
    expect(panel().textContent).toContain('This tail has no corner to round');
  });

  it('forgets the chosen corner when another board is loaded', () => {
    act(() => setChosenCorner({ side: 'plus', index: 0 }));
    act(() => railsStore.getState().loadDoc(doc()));
    expect(getChosenCorner()).toBeNull();
  });
});
