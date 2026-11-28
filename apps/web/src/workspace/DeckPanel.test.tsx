// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The deck panel against the real rails store: the shape by name, the crown dial (typed, dragged, stepped by a key),
 * why the dial is off, the scope and Edit curve under More. Each edit is the store action with the arguments it
 * should have, one undo step with its label; choosing a shape replaces a drawn curve with no question, and undo
 * brings it back.
 */
import type { RailsBoard } from '@openshaper/board2';
import {
  CROWN_MIN,
  DEFAULT_WALL_FALL_SHARE,
  bandAt,
  bandEdge,
  deckCrownRangeAt,
  domeFall,
  deckShapeAt,
  stationSplines,
} from '@openshaper/store/rails';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lengthUnitByKey } from '../format';
import { activeStore, boardStore, railsStore } from '../store';
import { drawDecksAsSlabs, key, showRails } from '../test/rails-board';
import { getDeckEditCurve, getDeckScope, getDeckStatus, resetDeckChoice } from './deck-choice';
import { DeckPanel } from './DeckPanel';

const CM = lengthUnitByKey('cm');
const MM = lengthUnitByKey('mm');
const KEYS = [key(20, 0.5), key(100, 0.5), key(170, 0.4)];

const doc = () => railsStore.getState().doc as RailsBoard;
const past = () => railsStore.getState().past;
const labels = () => past().map((p) => p.label);
/** A station with width and thickness, from the middle of the board. */
const STATION = 2;
const SLICE = STATION + 1;

const panel = () => screen.getByRole('region', { name: 'Deck panel' });
const field = () =>
  within(panel()).getByRole('textbox', { name: 'Crown number' }) as HTMLInputElement;
const slider = () => within(panel()).getByRole('slider', { name: 'Crown' }) as HTMLInputElement;
const shapeMenu = () =>
  within(panel()).getByRole('combobox', { name: 'Deck shape' }) as HTMLSelectElement;
const reading = (index = STATION) => deckShapeAt(doc(), index)!;
const typeCrown = (value: string) => {
  fireEvent.change(field(), { target: { value } });
  fireEvent.keyDown(field(), { key: 'Enter' });
};
const openMore = () => fireEvent.click(within(panel()).getByRole('button', { name: /More/ }));

beforeEach(async () => {
  localStorage.clear();
  resetDeckChoice();
  await showRails({ plus: KEYS });
});
afterEach(() => {
  resetDeckChoice();
  activeStore.use(boardStore);
});

describe('what it shows', () => {
  it('names the station in its heading, and shows nothing at an end slice', () => {
    const { rerender } = render(<DeckPanel units={CM} slice={SLICE} />);
    expect(screen.getByRole('heading', { name: /Deck.*Station 3 of \d+/ })).toBeTruthy();
    rerender(<DeckPanel units={CM} slice={0} />);
    expect(screen.queryByRole('region', { name: 'Deck panel' })).toBeNull();
  });

  it('reads a board as it is shipped as Domed: a close dome, with the dial on at the crown the curve has', () => {
    render(<DeckPanel units={CM} slice={SLICE} />);
    expect(shapeMenu().value).toBe('domed');
    expect(slider().disabled).toBe(false);
    expect(Number.parseFloat(field().value)).toBeCloseTo(reading().crown, 2);
  });

  it('reads a drawn deck as Custom: the name is shown, it is not a choice, the dial is off and says why', () => {
    drawDecksAsSlabs();
    render(<DeckPanel units={CM} slice={SLICE} />);
    expect(shapeMenu().value).toBe('custom');
    const options = within(shapeMenu()).getAllByRole('option') as HTMLOptionElement[];
    expect(options.map((o) => [o.textContent, o.disabled])).toEqual([
      ['Flat', false],
      ['Domed', false],
      ['Custom', true],
    ]);
    expect(panel().textContent).toContain('drawn point by point');
    expect(slider().disabled).toBe(true);
    expect(panel().textContent).toContain('This curve is drawn by hand');
    // it still reads the crown it has, but not as a field to type in
    expect(within(panel()).queryByRole('textbox', { name: 'Crown number' })).toBeNull();
    expect(panel().textContent).toMatch(/\d\.\d\d cm/);
  });

  it('says where the crown is measured', () => {
    render(<DeckPanel units={CM} slice={SLICE} />);
    expect(panel().textContent).toMatch(
      /Measured where the rail starts to roll over the deck, \d+\.\d\d cm from the stringer/,
    );
  });

  it('fills the width it is given for a sheet', () => {
    render(<DeckPanel units={CM} slice={SLICE} fluid />);
    expect(panel().className).toContain('w-full');
  });
});

describe('choosing a shape', () => {
  it('replaces the drawn curves with Domed, one step, and says so; undo brings them back exactly', () => {
    drawDecksAsSlabs();
    render(<DeckPanel units={CM} slice={SLICE} />);
    const was = doc();
    fireEvent.change(shapeMenu(), { target: { value: 'domed' } });
    expect(labels()).toEqual(['Domed deck']);
    expect(shapeMenu().value).toBe('domed');
    for (let i = 0; i < doc().stations.length; i++) {
      const r = deckShapeAt(doc(), i);
      // a station too thin to hold a crown stays level
      if (r) expect(r.shape).toBe(deckCrownRangeAt(doc(), i) === null ? 'flat' : 'domed');
    }
    expect(getDeckStatus()).toMatch(
      /^Replaced the drawn curves with Domed\. Undo brings them back\./,
    );
    act(() => railsStore.getState().undo());
    expect(doc()).toBe(was);
    expect(shapeMenu().value).toBe('custom');
  });

  it('keeps the crown each station has when a drawn curve becomes Domed', () => {
    drawDecksAsSlabs();
    const before = [0, 1, 2, 3].map((i) => deckShapeAt(doc(), i)?.crown);
    render(<DeckPanel units={CM} slice={SLICE} />);
    fireEvent.change(shapeMenu(), { target: { value: 'domed' } });
    [0, 1, 2, 3].forEach((i) => {
      const r = deckShapeAt(doc(), i);
      // a station whose drawn curve had less crown than the least a dome has is given a dome of its own
      if (r && before[i] !== undefined && before[i]! >= CROWN_MIN)
        expect(r.crown).toBeCloseTo(before[i]!, 9);
    });
  });

  it('makes a Flat deck, turns the dial off and says why', () => {
    render(<DeckPanel units={CM} slice={SLICE} />);
    fireEvent.change(shapeMenu(), { target: { value: 'flat' } });
    expect(labels()).toEqual(['Flat deck']);
    expect(reading().shape).toBe('flat');
    expect(slider().disabled).toBe(true);
    expect(panel().textContent).toContain('A flat deck has no crown. Choose Domed to give it one.');
  });

  it('gives a flat deck the typical crown for its thickness when it is made Domed', () => {
    render(<DeckPanel units={CM} slice={SLICE} />);
    fireEvent.change(shapeMenu(), { target: { value: 'flat' } });
    fireEvent.change(shapeMenu(), { target: { value: 'domed' } });
    const e = stationSplines(doc(), 'plus')[STATION]!;
    const edge = bandEdge(e.w, bandAt(doc(), 'plus', doc().stations[STATION]!.x));
    const range = deckCrownRangeAt(doc(), STATION)!;
    // a new dome falls the default share of the thickness at the wall, which is a crown at the band edge
    expect(reading().crown).toBeCloseTo(
      Math.min(range.max, domeFall(DEFAULT_WALL_FALL_SHARE * e.T, e.w, edge)),
      9,
    );
    expect(slider().disabled).toBe(false);
    expect(field()).toBeTruthy();
  });

  it('does not record a step for the shape it already is', () => {
    render(<DeckPanel units={CM} slice={SLICE} />);
    fireEvent.change(shapeMenu(), { target: { value: 'flat' } });
    fireEvent.change(shapeMenu(), { target: { value: 'flat' } });
    expect(labels()).toEqual(['Flat deck']);
  });

  it('reaches this station alone when the scope says so, and the others keep their curves', () => {
    render(<DeckPanel units={CM} slice={SLICE} />);
    openMore();
    fireEvent.click(within(panel()).getByRole('radio', { name: 'This station' }));
    expect(getDeckScope()).toBe('station');
    const was = doc();
    fireEvent.change(shapeMenu(), { target: { value: 'flat' } });
    expect(reading().shape).toBe('flat');
    doc().stations.forEach((st, i) => {
      if (i !== STATION) expect(st).toBe(was.stations[i]);
    });
  });
});

describe('the crown dial', () => {
  beforeEach(() => {
    railsStore
      .getState()
      .setDeckShape({ shape: 'domed', crown: 1.5 }, { station: STATION, all: true });
  });

  it('types a crown in the display unit: this station’s number, one step named Deck crown', () => {
    render(<DeckPanel units={CM} slice={SLICE} />);
    typeCrown('1.8');
    expect(reading().crown).toBeCloseTo(1.8, 9);
    expect(labels()).toEqual(['Deck crown', 'Deck crown']);
    expect(field().value).toBe('1.80');
  });

  it('takes millimetres when the display unit is millimetres', () => {
    render(<DeckPanel units={MM} slice={SLICE} />);
    typeCrown('18');
    expect(reading().crown).toBeCloseTo(1.8, 9);
  });

  it('gives every other station the same share of its thickness at the wall when it reaches all stations', () => {
    render(<DeckPanel units={CM} slice={SLICE} />);
    typeCrown('1.8');
    const entries = stationSplines(doc(), 'plus');
    const share = reading().wallFall! / entries[STATION]!.T;
    [1, 3].forEach((i) => {
      const range = deckCrownRangeAt(doc(), i);
      if (!range) return;
      const e = entries[i]!;
      const wanted = domeFall(
        share * e.T,
        e.w,
        bandEdge(e.w, bandAt(doc(), 'plus', doc().stations[i]!.x)),
      );
      expect(reading(i).crown).toBeCloseTo(Math.min(range.max, Math.max(range.min, wanted)), 9);
    });
  });

  it('changes only this station when the scope is this station', () => {
    render(<DeckPanel units={CM} slice={SLICE} />);
    openMore();
    fireEvent.click(within(panel()).getByRole('radio', { name: 'This station' }));
    const before = doc();
    typeCrown('2');
    expect(reading().crown).toBeCloseTo(2, 9);
    expect(doc().stations[1]).toBe(before.stations[1]);
    expect(doc().stations[3]).toBe(before.stations[3]);
  });

  it('holds a crown the station cannot hold at the most it can, and says so', () => {
    render(<DeckPanel units={CM} slice={SLICE} />);
    typeCrown('999');
    const range = deckCrownRangeAt(doc(), STATION)!;
    expect(reading().crown).toBeCloseTo(range.max, 9);
    expect(getDeckStatus()).toMatch(/^Held at the most this station can hold, \d+\.\d\d cm\./);
    // and the field shows what it is now
    expect(Number(field().value)).toBeCloseTo(range.max, 2);
  });

  it('puts the number back for text that is not one', () => {
    render(<DeckPanel units={CM} slice={SLICE} />);
    const was = doc();
    typeCrown('abc');
    expect(doc()).toBe(was);
    expect(field().value).toBe('1.50');
  });

  it('steps by a millimetre with the arrow keys, ten with Shift, a held key one undo step', () => {
    render(<DeckPanel units={CM} slice={SLICE} />);
    const steps = past().length;
    fireEvent.keyDown(field(), { key: 'ArrowUp' });
    fireEvent.keyDown(field(), { key: 'ArrowUp' });
    expect(reading().crown).toBeCloseTo(1.7, 9);
    fireEvent.keyDown(field(), { key: 'ArrowDown', shiftKey: true });
    expect(reading().crown).toBeCloseTo(0.7, 9);
    fireEvent.keyUp(field(), { key: 'ArrowDown' });
    expect(past().length).toBe(steps + 1);
  });

  it('moves with the slider, one step for a drag, from the range the station has', () => {
    render(<DeckPanel units={CM} slice={SLICE} />);
    const steps = past().length;
    const range = deckCrownRangeAt(doc(), STATION)!;
    fireEvent.pointerDown(slider());
    fireEvent.change(slider(), { target: { value: '100' } });
    fireEvent.change(slider(), { target: { value: '200' } });
    fireEvent.pointerUp(slider());
    expect(reading().crown).toBeCloseTo(range.max, 9);
    expect(past().length).toBe(steps + 1);
    fireEvent.change(slider(), { target: { value: '0' } });
    expect(reading().crown).toBeCloseTo(range.min, 9);
  });

  it('leaves the keys of its slider to the slider, and the editor’s key handler none of them', () => {
    render(<DeckPanel units={CM} slice={SLICE} />);
    const seen: string[] = [];
    const on = (e: KeyboardEvent) => seen.push(e.key);
    window.addEventListener('keydown', on);
    fireEvent.keyDown(slider(), { key: 'ArrowRight' });
    fireEvent.keyUp(slider(), { key: 'ArrowRight' });
    window.removeEventListener('keydown', on);
    expect(seen).toEqual([]);
  });

  it('is undone to the exact board it was made from', () => {
    render(<DeckPanel units={CM} slice={SLICE} />);
    const was = doc();
    typeCrown('2');
    act(() => railsStore.getState().undo());
    expect(doc()).toBe(was);
  });
});

describe('More', () => {
  it('opens on every station, and remembers that it was left open', () => {
    const { unmount } = render(<DeckPanel units={CM} slice={SLICE} />);
    expect(within(panel()).queryByRole('radio', { name: 'All stations' })).toBeNull();
    openMore();
    expect(
      (within(panel()).getByRole('radio', { name: 'All stations' }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(panel().textContent).toContain('usually one shape from tail to nose');
    unmount();
    render(<DeckPanel units={CM} slice={SLICE} />);
    expect(within(panel()).getByRole('radio', { name: 'All stations' })).toBeTruthy();
  });

  it('shows the curve’s own points with Edit curve, and a drawn curve has them always', () => {
    railsStore.getState().setDeckShape({ shape: 'domed' }, { station: STATION, all: true });
    render(<DeckPanel units={CM} slice={SLICE} />);
    openMore();
    const button = within(panel()).getByRole('button', { name: 'Edit curve' }) as HTMLButtonElement;
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    expect(getDeckEditCurve()).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button);
    expect(getDeckEditCurve()).toBe(false);
  });

  it('has Edit curve pressed and off while the deck is Custom, with the reason', () => {
    drawDecksAsSlabs();
    render(<DeckPanel units={CM} slice={SLICE} />);
    openMore();
    const button = within(panel()).getByRole('button', { name: 'Edit curve' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.title).toContain('always shown with its points');
  });
});

describe('a deck that is edited as a curve', () => {
  it('reads Custom after a point is moved, and the panel says so', () => {
    railsStore
      .getState()
      .setDeckShape({ shape: 'domed', crown: 1.5 }, { station: STATION, all: false });
    render(<DeckPanel units={CM} slice={SLICE} />);
    expect(shapeMenu().value).toBe('domed');
    const knots = railsStore.getState().board!.stationCurves[STATION]!.deck.knots;
    const end = knots[knots.length - 1]!.end;
    act(() =>
      railsStore
        .getState()
        .moveControlPoint({ kind: 'stationDeck', index: STATION }, knots.length - 1, {
          x: end.x,
          y: end.y - 2,
        }),
    );
    expect(shapeMenu().value).toBe('custom');
    expect(panel().textContent).toContain('drawn point by point');
    expect(slider().disabled).toBe(true);
  });
});

describe('a station with no deck to shape', () => {
  it('says so and offers no dial', () => {
    const base = railsStore.getState().doc as RailsBoard;
    // a station on the very tip of the tail: the board has no width there
    const tip = {
      ...base,
      stations: base.stations.map((s, i) => (i === 0 ? { ...s, x: 0 } : s)),
    } as RailsBoard;
    act(() => railsStore.getState().loadDoc(tip));
    expect(stationSplines(tip, 'plus')[0]!.w).toBe(0);
    render(<DeckPanel units={CM} slice={1} />);
    expect(panel().textContent).toContain('no deck to shape here');
    expect(within(panel()).queryByRole('slider')).toBeNull();
    expect(within(panel()).queryByRole('combobox')).toBeNull();
  });
});
