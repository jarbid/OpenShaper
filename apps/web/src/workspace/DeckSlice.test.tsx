// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The deck slice against the real rails store: the section and the deck curve it draws, and the one handle, the crown:
 * dragged or stepped by a key it sets the crown as the panel's dial does (one undo step), off for a Flat deck and a
 * drawn one with the reason, and held at the most the station can hold.
 */
import type { RailsBoard } from '@openshaper/board2';
import { deckCrownRangeAt, deckShapeAt } from '@openshaper/store/rails';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lengthUnitByKey } from '../format';
import { activeStore, boardStore, railsStore } from '../store';
import { key, showRails } from '../test/rails-board';
import { getDeckStatus, resetDeckChoice, setDeckScope } from './deck-choice';
import { DeckSlice } from './DeckSlice';

const CM = lengthUnitByKey('cm');
const KEYS = [key(20, 0.5), key(100, 0.5), key(170, 0.4)];
const STATION = 2;
const SLICE = STATION + 1;
const pointer = { pointerId: 4, isPrimary: true, button: 0 };

const doc = () => railsStore.getState().doc as RailsBoard;
const past = () => railsStore.getState().past;
const handle = () => screen.getByRole('slider', { name: 'Crown' });
const crown = () => deckShapeAt(doc(), STATION)!.crown;
/** The handle's centre, px from the top of the drawing. */
const centre = () => Number.parseFloat(handle().style.top) + 8;

beforeEach(async () => {
  localStorage.clear();
  resetDeckChoice();
  await showRails({ plus: KEYS });
});
afterEach(() => {
  resetDeckChoice();
  activeStore.use(boardStore);
});

describe('what it draws', () => {
  it('is a section of the board with the deck named in its label', () => {
    railsStore
      .getState()
      .setDeckShape({ shape: 'domed', crown: 1.5 }, { station: STATION, all: true });
    render(<DeckSlice units={CM} slice={SLICE} />);
    const label = screen.getByRole('img').getAttribute('aria-label')!;
    expect(label).toContain('deck domed');
    expect(label).toContain('Crown 1.50 cm');
  });

  it('draws the deck curve on both sides of the stringer: solid to the band edge, dashed under the rail', () => {
    railsStore
      .getState()
      .setDeckShape({ shape: 'domed', crown: 1.5 }, { station: STATION, all: true });
    const { container } = render(<DeckSlice units={CM} slice={SLICE} />);
    const decks = container.querySelectorAll('svg g.stroke-primary');
    expect(decks).toHaveLength(2);
    decks.forEach((g) => {
      const [solid, hidden] = Array.from(g.querySelectorAll('path'));
      expect(solid!.getAttribute('d')).toMatch(/^M/);
      expect(solid!.getAttribute('stroke-dasharray')).toBeNull();
      expect(hidden!.getAttribute('stroke-dasharray')).toBe('3 3');
      expect(hidden!.getAttribute('d')).toMatch(/^M/);
    });
  });

  it('says there is nothing to draw at a station with no width', () => {
    const base = doc();
    const tip = { ...base, stations: base.stations.map((s, i) => (i === 0 ? { ...s, x: 0 } : s)) };
    act(() => railsStore.getState().loadDoc(tip as RailsBoard));
    render(<DeckSlice units={CM} slice={1} />);
    expect(screen.getByText(/Nothing to draw here/)).toBeTruthy();
  });

  it('draws a drawn curve with the handle off and the reason on it', () => {
    render(<DeckSlice units={CM} slice={SLICE} />);
    expect(handle().getAttribute('aria-disabled')).toBe('true');
    expect(handle().title).toContain('drawn by hand');
    expect(handle().tabIndex).toBe(-1);
  });
});

describe('the crown handle', () => {
  beforeEach(() => {
    railsStore
      .getState()
      .setDeckShape({ shape: 'domed', crown: 1.5 }, { station: STATION, all: true });
  });

  it('is a vertical slider in the display unit at the crown the deck has, and is on', () => {
    render(<DeckSlice units={CM} slice={SLICE} />);
    expect(handle().getAttribute('aria-orientation')).toBe('vertical');
    expect(handle().getAttribute('aria-disabled')).toBe('false');
    expect(handle().getAttribute('aria-valuetext')).toBe('1.50 cm');
    expect(Number(handle().getAttribute('aria-valuenow'))).toBeCloseTo(1.5, 9);
    const range = deckCrownRangeAt(doc(), STATION)!;
    expect(Number(handle().getAttribute('aria-valuemax'))).toBeCloseTo(range.max, 9);
    expect(handle().tabIndex).toBe(0);
  });

  it('follows the pointer: down is more crown, one undo step for the drag', () => {
    render(<DeckSlice units={CM} slice={SLICE} />);
    const steps = past().length;
    const from = centre();
    fireEvent.pointerDown(handle(), { ...pointer, clientX: 300, clientY: from });
    fireEvent.pointerMove(handle(), { ...pointer, clientX: 300, clientY: from + 12 });
    fireEvent.pointerMove(handle(), { ...pointer, clientX: 300, clientY: from + 24 });
    // the handle is under the pointer, which took it where it was
    expect(centre()).toBeCloseTo(from + 24, 1);
    expect(crown()).toBeGreaterThan(1.5);
    fireEvent.pointerUp(handle(), { ...pointer, clientX: 300, clientY: from + 24 });
    expect(past().length).toBe(steps + 1);
    expect(past()[past().length - 1]!.label).toBe('Deck crown');
    // back up the same way: the pointer alone decides, from where the drag began
    fireEvent.pointerDown(handle(), { ...pointer, clientX: 300, clientY: from + 24 });
    fireEvent.pointerMove(handle(), { ...pointer, clientX: 300, clientY: from });
    fireEvent.pointerUp(handle(), { ...pointer, clientX: 300, clientY: from });
    // the handle is drawn on the cubic, which is within a hundredth of a millimetre of the arc
    expect(crown()).toBeCloseTo(1.5, 5);
  });

  it('is held at the most the station can hold, and says so', () => {
    render(<DeckSlice units={CM} slice={SLICE} />);
    const range = deckCrownRangeAt(doc(), STATION)!;
    const from = centre();
    fireEvent.pointerDown(handle(), { ...pointer, clientY: from });
    fireEvent.pointerMove(handle(), { ...pointer, clientY: from + 5000 });
    fireEvent.pointerUp(handle(), { ...pointer, clientY: from + 5000 });
    expect(crown()).toBeCloseTo(range.max, 9);
    expect(getDeckStatus()).toMatch(/^Held at the most this station can hold/);
    // and the least, the other way
    fireEvent.pointerDown(handle(), { ...pointer, clientY: centre() });
    fireEvent.pointerMove(handle(), { ...pointer, clientY: -5000 });
    fireEvent.pointerUp(handle(), { ...pointer, clientY: -5000 });
    expect(crown()).toBeCloseTo(range.min, 9);
  });

  it('reaches the chosen station alone when the scope says so', () => {
    act(() => setDeckScope('station'));
    render(<DeckSlice units={CM} slice={SLICE} />);
    const before = doc();
    const from = centre();
    fireEvent.pointerDown(handle(), { ...pointer, clientY: from });
    fireEvent.pointerMove(handle(), { ...pointer, clientY: from + 20 });
    fireEvent.pointerUp(handle(), { ...pointer, clientY: from + 20 });
    expect(doc().stations[1]).toBe(before.stations[1]);
    expect(doc().stations[STATION]).not.toBe(before.stations[STATION]);
  });

  it('ignores another button and another pointer', () => {
    render(<DeckSlice units={CM} slice={SLICE} />);
    const was = doc();
    fireEvent.pointerDown(handle(), { ...pointer, button: 2, clientY: centre() });
    fireEvent.pointerMove(handle(), { ...pointer, clientY: centre() + 30 });
    expect(doc()).toBe(was);
    fireEvent.pointerDown(handle(), { ...pointer, clientY: centre() });
    fireEvent.pointerMove(handle(), { ...pointer, pointerId: 9, clientY: centre() + 30 });
    fireEvent.pointerUp(handle(), { ...pointer, clientY: centre() });
    expect(doc()).toBe(was);
  });

  it('is stepped by the keys the way the arrow points: Down is more crown, a held key one step', () => {
    render(<DeckSlice units={CM} slice={SLICE} />);
    const steps = past().length;
    fireEvent.keyDown(handle(), { key: 'ArrowDown' });
    fireEvent.keyDown(handle(), { key: 'ArrowDown' });
    expect(crown()).toBeCloseTo(1.7, 9);
    fireEvent.keyDown(handle(), { key: 'ArrowUp' });
    expect(crown()).toBeCloseTo(1.6, 9);
    fireEvent.keyDown(handle(), { key: 'ArrowRight' });
    expect(crown()).toBeCloseTo(1.7, 9);
    fireEvent.keyDown(handle(), { key: 'ArrowDown', shiftKey: true });
    expect(crown()).toBeCloseTo(2.7, 9);
    fireEvent.keyUp(handle(), { key: 'ArrowDown' });
    expect(past().length).toBe(steps + 1);
  });

  it('goes to the ends with Home and End', () => {
    render(<DeckSlice units={CM} slice={SLICE} />);
    const range = deckCrownRangeAt(doc(), STATION)!;
    fireEvent.keyDown(handle(), { key: 'End' });
    expect(crown()).toBeCloseTo(range.max, 9);
    fireEvent.keyDown(handle(), { key: 'Home' });
    expect(crown()).toBeCloseTo(range.min, 9);
  });

  it('keeps its keys from the editor’s own key handler, and leaves others to it', () => {
    render(<DeckSlice units={CM} slice={SLICE} />);
    const seen: string[] = [];
    const on = (e: KeyboardEvent) => seen.push(e.key);
    window.addEventListener('keydown', on);
    fireEvent.keyDown(handle(), { key: 'ArrowDown' });
    fireEvent.keyDown(handle(), { key: 'Home' });
    fireEvent.keyDown(handle(), { key: 'Delete' });
    window.removeEventListener('keydown', on);
    expect(seen).toEqual(['Delete']);
  });
});

describe('a deck that is Flat', () => {
  beforeEach(() => {
    railsStore.getState().setDeckShape({ shape: 'flat' }, { station: STATION, all: true });
  });

  it('shows the handle off, on the stringer’s height, and the reason on it', () => {
    render(<DeckSlice units={CM} slice={SLICE} />);
    expect(handle().getAttribute('aria-disabled')).toBe('true');
    expect(handle().title).toBe('A flat deck has no crown. Choose Domed to give it one.');
    expect(handle().getAttribute('aria-valuetext')).toBe('0.00 cm');
  });

  it('does nothing when it is dragged or stepped', () => {
    render(<DeckSlice units={CM} slice={SLICE} />);
    const was = doc();
    fireEvent.pointerDown(handle(), { ...pointer, clientY: centre() });
    fireEvent.pointerMove(handle(), { ...pointer, clientY: centre() + 30 });
    fireEvent.keyDown(handle(), { key: 'ArrowDown' });
    expect(doc()).toBe(was);
  });
});
