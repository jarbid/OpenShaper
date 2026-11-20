// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The Deck step's drawing against the real rails store: the slice and the strip for a deck that is Flat or Domed,
 * the cross-section editor for Edit curve and for a drawn deck, and the strip's actions as store edits: choose,
 * drag (one step), add (a new station, chosen), remove (never below the least), each with its label.
 */
import type { RailsBoard } from '@openshaper/board2';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lengthUnitByKey } from '../format';
import { activeStore, boardStore, railsStore } from '../store';
import { key, showRails } from '../test/rails-board';
import { resetDeckChoice, setDeckEditCurve } from './deck-choice';
import { DeckStep } from './DeckStep';
import { xToPx, type Frame } from './rail-map';

const CM = lengthUnitByKey('cm');
const KEYS = [key(20, 0.5), key(100, 0.5), key(170, 0.4)];
const pointer = { pointerId: 5, isPrimary: true, button: 0 };

const doc = () => railsStore.getState().doc as RailsBoard;
const past = () => railsStore.getState().past;
const labels = () => past().map((p) => p.label);
const lane = () => screen.getByRole('toolbar', { name: 'Stations along the board' });
const tick = (n: number) => within(lane()).getAllByRole('button', { name: /^Station / })[n - 1]!;

/** The strip has no layout in jsdom: 640 px wide over the board. */
const frame = (): Frame => ({
  width: 640,
  length: doc().outline.plus.knots[doc().outline.plus.knots.length - 1]!.p[0],
});
const px = (x: number) => xToPx(x, frame());

/** The step with the shell's choice of station held here, and an editor that is a marker with its control. */
function Harness({ start = 3, onStation }: { start?: number; onStation?: (s: number) => void }) {
  const [slice, setSlice] = useState(start);
  const editor = (control: ReactNode) => <div data-testid="editor">{control}</div>;
  return (
    <>
      <div data-testid="chosen">{slice}</div>
      <DeckStep
        units={CM}
        station={slice}
        onStation={(s) => {
          onStation?.(s);
          setSlice(s);
        }}
        renderEditor={editor}
      />
    </>
  );
}
const chosen = () => Number(screen.getByTestId('chosen').textContent);

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
  it('is the cross-section editor, with the control for Edit curve, while the deck is a drawn curve', () => {
    render(<Harness />);
    expect(screen.getByTestId('editor')).toBeTruthy();
    expect(screen.queryByTestId('deck-slice')).toBeNull();
    const control = within(screen.getByTestId('editor')).getByRole('button', {
      name: 'Edit curve',
    });
    expect((control as HTMLButtonElement).disabled).toBe(true);
    // the strip is under it either way
    expect(screen.getByTestId('station-strip')).toBeTruthy();
  });

  it('is the slice with one handle while the deck is Domed, and the strip', () => {
    railsStore.getState().setDeckShape({ shape: 'domed', crown: 1.5 }, { station: 2, all: true });
    render(<Harness />);
    expect(screen.getByTestId('deck-slice')).toBeTruthy();
    expect(screen.queryByTestId('editor')).toBeNull();
    expect(screen.getByRole('slider', { name: 'Crown' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Deck: station 3' })).toBeTruthy();
    expect(screen.getByText('Drag the handle up and down to set the crown.')).toBeTruthy();
  });

  it('says what a flat deck is, and offers Edit curve', () => {
    railsStore.getState().setDeckShape({ shape: 'flat' }, { station: 2, all: true });
    render(<Harness />);
    expect(screen.getByText(/Flat: level from the stringer to the rail/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit curve' })).toBeTruthy();
  });

  it('switches to the editor for Edit curve, and back, whatever the shape', () => {
    railsStore.getState().setDeckShape({ shape: 'domed', crown: 1.5 }, { station: 2, all: true });
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit curve' }));
    expect(screen.getByTestId('editor')).toBeTruthy();
    expect(screen.queryByTestId('deck-slice')).toBeNull();
    const control = within(screen.getByTestId('editor')).getByRole('button', {
      name: 'Edit curve',
    });
    expect(control.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(control);
    expect(screen.getByTestId('deck-slice')).toBeTruthy();
  });

  it('goes to the editor by itself when the deck becomes Custom, and the shape’s handle comes back with a shape', () => {
    railsStore.getState().setDeckShape({ shape: 'domed', crown: 1.5 }, { station: 2, all: false });
    render(<Harness />);
    expect(screen.getByTestId('deck-slice')).toBeTruthy();
    const knots = railsStore.getState().board!.stationCurves[2]!.deck.knots;
    const end = knots[knots.length - 1]!.end;
    act(() =>
      railsStore.getState().moveControlPoint({ kind: 'stationDeck', index: 2 }, knots.length - 1, {
        x: end.x,
        y: end.y - 0.1,
      }),
    );
    expect(screen.getByTestId('editor')).toBeTruthy();
    act(() => railsStore.getState().setDeckShape({ shape: 'domed' }, { station: 2, all: false }));
    expect(screen.getByTestId('deck-slice')).toBeTruthy();
  });

  it('clears a point selected in the editor when the shape’s handle takes over, so Delete cannot reach it', () => {
    railsStore.getState().setDeckShape({ shape: 'domed', crown: 1.5 }, { station: 2, all: true });
    render(<Harness />);
    act(() => setDeckEditCurve(true));
    act(() =>
      activeStore.getState().select({ target: { kind: 'stationDeck', index: 2 }, index: 1 }),
    );
    expect(activeStore.getState().selection).not.toBeNull();
    act(() => setDeckEditCurve(false));
    expect(activeStore.getState().selection).toBeNull();
  });

  it('draws nothing with no rails board', () => {
    activeStore.use(boardStore);
    act(() => railsStore.setState({ doc: null }));
    const { container } = render(<Harness />);
    expect(container.querySelector('[data-testid="station-strip"]')).toBeNull();
  });
});

describe('the strip’s actions', () => {
  it('chooses a station by its tick, and by the station nearest a click on the lane', () => {
    render(<Harness start={1} />);
    fireEvent.click(tick(3));
    expect(chosen()).toBe(3);
    const x = doc().stations[3]!.x;
    fireEvent.click(lane(), { clientX: px(x) + 15 });
    expect(chosen()).toBe(4);
  });

  it('moves a station with a drag: held between its neighbours, one undo step named for it', () => {
    render(<Harness start={3} />);
    const was = doc();
    const t = tick(3);
    const x0 = was.stations[2]!.x;
    const x1 = was.stations[3]!.x;
    fireEvent.pointerDown(t, { ...pointer, clientX: px(x0), clientY: 10 });
    fireEvent.pointerMove(t, { ...pointer, clientX: px(x0) + 12, clientY: 10 });
    fireEvent.pointerMove(t, { ...pointer, clientX: px(x1 + 40), clientY: 10 });
    fireEvent.pointerUp(t, { ...pointer, clientX: px(x1 + 40), clientY: 10 });
    const moved = doc().stations[2]!.x;
    expect(moved).toBeGreaterThan(x0);
    // never past the station beside it
    expect(moved).toBeLessThan(x1);
    expect(doc().stations).toHaveLength(was.stations.length);
    expect(labels()).toEqual(['Move cross-section']);
    expect(chosen()).toBe(3);
    act(() => railsStore.getState().undo());
    expect(doc()).toBe(was);
  });

  it('moves a station by a key, one step for a held key', () => {
    render(<Harness start={3} />);
    const x0 = doc().stations[2]!.x;
    fireEvent.keyDown(tick(3), { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(tick(3), { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyUp(tick(3), { key: 'ArrowRight' });
    expect(doc().stations[2]!.x).toBeCloseTo(x0 + 1, 9);
    expect(labels()).toEqual(['Move cross-section']);
  });

  it('adds a station after the chosen one and chooses it, one step, with curves that follow its neighbours', () => {
    render(<Harness start={3} />);
    const n = doc().stations.length;
    const a = doc().stations[2]!.x;
    const b = doc().stations[3]!.x;
    fireEvent.click(screen.getByRole('button', { name: 'Add station' }));
    expect(doc().stations).toHaveLength(n + 1);
    expect(doc().stations[3]!.x).toBeCloseTo((a + b) / 2, 9);
    expect(chosen()).toBe(4);
    expect(labels()).toEqual(['Add station']);
    expect(screen.getByRole('status').textContent).toBe('Added station 4.');
    act(() => railsStore.getState().undo());
    expect(doc().stations).toHaveLength(n);
  });

  it('adds a station where the pointer is, with the "+" off the ticks', () => {
    render(<Harness start={3} />);
    const n = doc().stations.length;
    const x = (doc().stations[2]!.x + doc().stations[3]!.x) / 2;
    fireEvent.pointerMove(lane(), { pointerType: 'mouse', clientX: px(x), clientY: 10 });
    fireEvent.click(screen.getByRole('button', { name: 'Add a station here' }));
    expect(doc().stations).toHaveLength(n + 1);
    expect(chosen()).toBe(4);
  });

  it('says there is no room for a station that cannot be added, and adds none', () => {
    render(<Harness start={1} />);
    const last = doc().stations.length;
    // the last station as far along as it can go: a station after it would be on the nose
    act(() => railsStore.getState().moveCrossSection(last, 1e6));
    fireEvent.click(tick(last));
    const n = doc().stations.length;
    const steps = past().length;
    fireEvent.click(screen.getByRole('button', { name: 'Add station' }));
    expect(doc().stations).toHaveLength(n);
    expect(past().length).toBe(steps);
    expect(screen.getByRole('status').textContent).toBe('There is no room for a station here.');
    expect(chosen()).toBe(last);
  });

  it('removes the chosen station, one step, and chooses the one that took its place', () => {
    render(<Harness start={3} />);
    const n = doc().stations.length;
    const was = doc();
    fireEvent.click(screen.getByRole('button', { name: 'Remove station' }));
    expect(doc().stations).toHaveLength(n - 1);
    expect(labels()).toEqual(['Delete cross-section']);
    expect(chosen()).toBe(3);
    expect(screen.getByRole('status').textContent).toBe('Removed station 3.');
    act(() => railsStore.getState().undo());
    expect(doc()).toBe(was);
  });

  it('removes with Delete, and the last station’s removal chooses the new last', () => {
    render(<Harness start={1} />);
    const n = doc().stations.length;
    fireEvent.click(tick(n));
    expect(chosen()).toBe(n);
    fireEvent.keyDown(tick(n), { key: 'Delete' });
    expect(doc().stations).toHaveLength(n - 1);
    expect(chosen()).toBe(n - 1);
  });

  it('keeps the least number of stations: nothing is removed below it, and the button says why', () => {
    render(<Harness start={1} />);
    // take it down to two
    while (doc().stations.length > 2) act(() => railsStore.getState().deleteCrossSection(1));
    const was = doc();
    const remove = screen.getByRole('button', { name: 'Remove station' }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    expect(remove.title).toBe('A board keeps at least 2 stations.');
    fireEvent.keyDown(tick(1), { key: 'Delete' });
    expect(doc()).toBe(was);
  });

  it('keeps the strip’s moves out of the editor’s own key handling', () => {
    render(<Harness start={3} />);
    const seen: string[] = [];
    const on = (e: KeyboardEvent) => seen.push(e.key);
    window.addEventListener('keydown', on);
    fireEvent.keyDown(tick(3), { key: 'ArrowRight' });
    fireEvent.keyDown(tick(4), { key: 'Delete' });
    window.removeEventListener('keydown', on);
    expect(seen).toEqual([]);
  });
});
