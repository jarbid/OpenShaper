// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The rail panel against the real rails store: the zone's rail by name, the sides, the three dials, More, the
 * footer; a blend's two ends; and what it says with nothing chosen. Each edit is the store action with the
 * arguments it should have, one undo step with its label.
 */
import type { RailsBoard } from '@openshaper/board2';
import { BUILT_IN_RAILS, DIAL_RANGES, railZones } from '@openshaper/store/rails';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lengthUnitByKey } from '../format';
import { getMyRails, resetMyRails, setMyRails } from '../my-rails';
import { chooseRail } from '../patch-look';
import {
  getRailChoice,
  getRailSides,
  resetRailChoice,
  setRailChoice,
  setRailSides,
} from '../rail-choice';
import { activeStore, boardStore, railsStore } from '../store';
import { key, rail, showRails } from '../test/rails-board';
import { RailPanel, RailPanelSlot } from './RailPanel';
import { setRailStatus } from './rail-actions';
import { resetWorkspaceStep, setWorkspaceStep } from './use-step';

const CM = lengthUnitByKey('cm');
const MM = lengthUnitByKey('mm');
/** Zone 1: 20-60 (Round); a tick at 100 (apex 0.3, Custom); zone 3: 140-180 (apex 0.4, Custom). */
const KEYS = [key(20, 0.5), key(60, 0.5), key(100, 0.3), key(140, 0.4), key(180, 0.4)];

const rails = () => (railsStore.getState().doc as RailsBoard).rails;
const past = () => railsStore.getState().past;
const labels = () => past().map((p) => p.label);
const zonesOf = (keys = rails().plus) => railZones(keys).zones;
const choose = (zone: number, place = 100) => act(() => chooseRail({ side: 'plus', zone }, place));

const panel = () => screen.getByRole('region', { name: 'Rail panel' });
const dial = (name: string) => within(panel()).getByRole('slider', { name });
const field = (name: string) => within(panel()).getByRole('textbox', { name }) as HTMLInputElement;
const typeInto = (name: string, value: string) => {
  const input = field(name);
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
};
const menu = () => within(panel()).getByRole('combobox', { name: 'Rail' }) as HTMLSelectElement;

beforeEach(async () => {
  localStorage.clear();
  resetMyRails();
  resetWorkspaceStep();
  await showRails({ plus: KEYS });
});
afterEach(() => {
  resetRailChoice();
  setRailStatus('');
  activeStore.use(boardStore);
});

describe('with nothing chosen', () => {
  it('says how to choose and lists the board’s zones with their names and places', () => {
    render(<RailPanel units={CM} />);
    expect(panel().textContent).toContain(
      'Tap a rail zone on the board or the strip to choose it. Tap + to add one.',
    );
    const rows = within(panel())
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(rows).toEqual([
      'Zone 1: Round20.00 cm to 60.00 cm',
      'Zone 2: Customat 100.00 cm',
      'Zone 3: Custom140.00 cm to 180.00 cm',
    ]);
  });

  it('chooses a zone from its row', () => {
    render(<RailPanel units={CM} />);
    fireEvent.click(within(panel()).getAllByRole('button', { name: /^Zone 3/ })[0]!);
    expect(getRailChoice()).toEqual({ side: 'plus', zone: 2 });
    expect(screen.getByRole('heading', { name: /Zone 3/ })).toBeTruthy();
  });

  it('lists each side when the board has two', async () => {
    await showRails({ plus: KEYS, minus: [key(30, 0.5)] });
    render(<RailPanel units={CM} />);
    expect(within(panel()).getByRole('list', { name: 'Left zones' })).toBeTruthy();
    expect(within(panel()).getByRole('list', { name: 'Right zones' })).toBeTruthy();
  });

  it('draws nothing without a rails board', () => {
    activeStore.use(boardStore);
    expect(render(<RailPanel units={CM} />).container.firstChild).toBeNull();
  });
});

describe('the Rail menu', () => {
  it('lists the built-in rails, then my rails, with Custom shown only when the numbers match none', () => {
    setMyRails([{ name: 'Surf', rail: rail(0.3, { band: 3 }) }]);
    render(<RailPanel units={CM} />);
    choose(0, 40);
    const groups = Array.from(menu().querySelectorAll('optgroup')).map((g) => [
      g.label,
      Array.from(g.querySelectorAll('option')).map((o) => o.textContent),
    ]);
    expect(groups).toEqual([
      ['Built-in rails', BUILT_IN_RAILS.map((b) => b.name)],
      ['My rails', ['Surf']],
    ]);
    // zone 1 is Round: no Custom entry, Round selected, and its summary is under the menu
    expect(menu().selectedOptions[0]!.textContent).toBe('Round');
    expect(panel().textContent).toContain(BUILT_IN_RAILS.find((b) => b.id === 'round')!.summary);
    expect(Array.from(menu().options).some((o) => o.value === 'custom')).toBe(false);
    // zone 3 matches none: Custom, like the nearest name
    choose(2, 160);
    expect(menu().selectedOptions[0]!.textContent).toBe('Custom (like Round)');
    expect(panel().textContent).toContain(
      'These numbers match no named rail. The closest is Round.',
    );
  });

  it('gives each built-in rail its summary as a hover hint', () => {
    render(<RailPanel units={CM} />);
    choose(0, 40);
    for (const b of BUILT_IN_RAILS) {
      const option = Array.from(menu().options).find((o) => o.textContent === b.name)!;
      expect(option.title).toBe(b.summary);
    }
  });

  it('sets the zone’s rail to the one chosen, on both sides, as one undo step', () => {
    render(<RailPanel units={CM} />);
    choose(0, 40);
    fireEvent.change(menu(), { target: { value: 'b:tucked' } });
    const tucked = BUILT_IN_RAILS.find((b) => b.id === 'tucked')!.rail;
    expect(rails().plus[0]!.rail).toEqual(tucked);
    expect(rails().plus[1]!.rail).toEqual(tucked);
    expect(rails().plus[2]!.rail).toEqual(KEYS[2]!.rail);
    expect(labels()).toEqual(['Edit rail']);
    expect(menu().selectedOptions[0]!.textContent).toBe('Tucked');
  });

  it('sets one of my rails the same way', () => {
    const mine = rail(0.3, { band: 3 });
    setMyRails([{ name: 'Surf', rail: mine }]);
    render(<RailPanel units={CM} />);
    choose(0, 40);
    fireEvent.change(menu(), { target: { value: 'm:Surf' } });
    expect(rails().plus[0]!.rail).toEqual(mine);
    expect(menu().selectedOptions[0]!.textContent).toBe('Surf');
    expect(panel().textContent).toContain('One of your own rails.');
  });

  it('does not set a zone that took the rail of its neighbour to something else: it is one zone with it', () => {
    render(<RailPanel units={CM} />);
    choose(1, 100);
    // the tick takes zone 1's rail: they are one zone, and the choice follows the place
    fireEvent.change(menu(), { target: { value: 'b:round' } });
    expect(zonesOf()).toHaveLength(2);
    expect(getRailChoice()).toEqual({ side: 'plus', zone: 0 });
  });
});

describe('the sides', () => {
  it('start as Both sides, as a radio group of three', () => {
    render(<RailPanel units={CM} />);
    choose(0, 40);
    const group = within(panel()).getByRole('group', { name: 'Sides' });
    const radios = within(group).getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((r) => [r.value, r.checked])).toEqual([
      ['both', true],
      ['plus', false],
      ['minus', false],
    ]);
    expect(within(group).getByRole('radio', { name: 'Left' })).toBeTruthy();
    expect(within(group).getByRole('radio', { name: 'Both sides' })).toBeTruthy();
  });

  it('unlock the sides when Left or Right is chosen on a board whose sides are one, then edit that side alone', () => {
    render(<RailPanel units={CM} />);
    choose(0, 40);
    fireEvent.click(screen.getByRole('radio', { name: 'Right' }));
    expect(labels()).toEqual(['Unlock rail sides']);
    expect(rails().minus).toBeDefined();
    expect(getRailSides()).toBe('minus');
    expect(getRailChoice()).toEqual({ side: 'minus', zone: 0 });
    // an edit now reaches the right side only
    const plus = rails().plus;
    fireEvent.change(menu(), { target: { value: 'b:boxy' } });
    expect(rails().plus).toBe(plus);
    expect(rails().minus![0]!.rail).toEqual(BUILT_IN_RAILS.find((b) => b.id === 'boxy')!.rail);
    expect(labels()).toEqual(['Unlock rail sides', 'Edit rail']);
  });

  it('edit the left side alone with Left, and a dial reaches only that side', () => {
    render(<RailPanel units={CM} />);
    choose(0, 40);
    fireEvent.click(screen.getByRole('radio', { name: 'Left' }));
    const minus = rails().minus;
    fireEvent.change(dial('Apex'), { target: { value: '100' } });
    expect(rails().minus).toBe(minus);
    expect(rails().plus[0]!.rail.apex).toBe(DIAL_RANGES.apex[1]);
  });

  it('lock two sides that are the same again with Both, which makes the board’s rail one list', () => {
    render(<RailPanel units={CM} />);
    choose(0, 40);
    fireEvent.click(screen.getByRole('radio', { name: 'Left' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Both sides' }));
    expect(rails().minus).toBeUndefined();
    expect(getRailSides()).toBe('both');
    expect(labels()).toEqual(['Unlock rail sides', 'Link rail sides']);
  });

  it('say so when the sides differ, and make both like Left or like Right', async () => {
    await showRails({ plus: KEYS, minus: [key(30, 0.2), key(150, 0.2)] });
    render(<RailPanel units={CM} />);
    choose(0, 40);
    expect(panel().textContent).toContain('The two sides have different rails.');
    fireEvent.click(screen.getByRole('button', { name: 'Make both sides like Right' }));
    expect(rails().minus).toBeUndefined();
    expect(rails().plus.map((k) => k.x)).toEqual([30, 150]);
    expect(labels()).toEqual(['Link rail sides']);
    // undone, the sides are as they were, and Left is the other way
    act(() => railsStore.getState().undo());
    fireEvent.click(screen.getByRole('button', { name: 'Make both sides like Left' }));
    expect(rails().plus.map((k) => k.x)).toEqual(KEYS.map((k) => k.x));
  });

  it('keep Both when the sides differ and the shaper chooses Both: edits reach the zone on each side', async () => {
    await showRails({ plus: KEYS, minus: [key(20, 0.2), key(60, 0.2), key(150, 0.1)] });
    render(<RailPanel units={CM} />);
    choose(0, 40);
    fireEvent.change(dial('Apex'), { target: { value: '100' } });
    expect(rails().plus[0]!.rail.apex).toBe(DIAL_RANGES.apex[1]);
    expect(rails().minus![0]!.rail.apex).toBe(DIAL_RANGES.apex[1]);
    // only the apex moved: the other numbers of each side are their own
    expect(rails().minus![2]!.rail).toEqual(key(150, 0.1).rail);
  });
});

describe('the dials', () => {
  it('are Apex, Tuck and Edge, each a slider with a number, its range ends in words', () => {
    render(<RailPanel units={CM} />);
    choose(0, 40);
    const group = within(panel()).getByRole('group', { name: 'Dials' });
    for (const name of ['Apex', 'Tuck', 'Edge']) {
      expect(within(group).getByRole('slider', { name })).toBeTruthy();
      expect(within(group).getByRole('textbox', { name: `${name} number` })).toBeTruthy();
    }
    const text = group.textContent!;
    expect(text).toContain('40/60');
    expect(text).toContain('80/20');
    expect(text).toContain('none');
    expect(text).toContain('deep');
    expect(text).toContain('hard');
  });

  it('read the rail’s numbers: apex as the dial says it, tuck in the display unit, edge in degrees', () => {
    render(<RailPanel units={MM} />);
    choose(0, 40);
    expect(dial('Apex').getAttribute('aria-valuetext')).toBe('50/50');
    expect(dial('Tuck').getAttribute('aria-valuetext')).toBe('14.0 mm');
    expect(dial('Edge').getAttribute('aria-valuetext')).toBe('0°');
    expect(field('Apex number').value).toBe('50');
    expect(field('Tuck number').value).toBe('14.0');
    expect(field('Edge number').value).toBe('0');
    // the slider is where the number is along the dial's range
    expect((dial('Apex') as HTMLInputElement).value).toBe('25');
  });

  it('set the rail’s number from the slider, held to the dial’s range', () => {
    render(<RailPanel units={CM} />);
    choose(0, 40);
    fireEvent.change(dial('Apex'), { target: { value: '100' } });
    expect(rails().plus[0]!.rail.apex).toBeCloseTo(DIAL_RANGES.apex[1], 12);
    fireEvent.change(dial('Tuck'), { target: { value: '100' } });
    expect(rails().plus[0]!.rail.tuck).toBeCloseTo(DIAL_RANGES.tuck[1], 12);
    fireEvent.change(dial('Edge'), { target: { value: '50' } });
    expect(rails().plus[0]!.rail.bottomEdge).toBeCloseTo(30, 12);
    // both keys of the zone, and nothing else about the rail
    expect(rails().plus[1]!.rail).toEqual(rails().plus[0]!.rail);
    expect(rails().plus[0]!.rail.band).toBe(2);
  });

  it('make a drag one undo step, and a held key one', () => {
    render(<RailPanel units={CM} />);
    choose(0, 40);
    const slider = dial('Apex');
    fireEvent.pointerDown(slider, { pointerId: 1, isPrimary: true });
    for (const v of ['30', '40', '50', '60']) fireEvent.change(slider, { target: { value: v } });
    fireEvent.pointerUp(slider, { pointerId: 1 });
    expect(labels()).toEqual(['Edit rail']);
    expect(railsStore.getState().editing).toBe(false);
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    fireEvent.change(slider, { target: { value: '61' } });
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    fireEvent.change(slider, { target: { value: '62' } });
    fireEvent.keyUp(slider, { key: 'ArrowRight' });
    expect(labels()).toEqual(['Edit rail', 'Edit rail']);
    act(() => railsStore.getState().undo());
    expect(rails().plus[0]!.rail.apex).toBeCloseTo(
      DIAL_RANGES.apex[0] + 0.6 * (DIAL_RANGES.apex[1] - DIAL_RANGES.apex[0]),
      9,
    );
  });

  it('set the number typed in the field, in the display unit, when it is entered', () => {
    render(<RailPanel units={MM} />);
    choose(0, 40);
    typeInto('Tuck number', '25');
    expect(rails().plus[0]!.rail.tuck).toBeCloseTo(2.5, 9);
    typeInto('Edge number', '12.5');
    expect(rails().plus[0]!.rail.bottomEdge).toBe(12.5);
    typeInto('Apex number', '30');
    expect(rails().plus[0]!.rail.apex).toBeCloseTo(0.3, 9);
    typeInto('Apex number', '80/20');
    expect(rails().plus[0]!.rail.apex).toBeCloseTo(0.2, 9);
    expect(labels()).toEqual(['Edit rail', 'Edit rail', 'Edit rail', 'Edit rail']);
  });

  it('hold a typed number to the dial’s range, and show what it came to', () => {
    render(<RailPanel units={MM} />);
    choose(0, 40);
    typeInto('Edge number', '85');
    expect(rails().plus[0]!.rail.bottomEdge).toBe(DIAL_RANGES.edge[1]);
    expect(field('Edge number').value).toBe('60');
    typeInto('Tuck number', '900');
    expect(rails().plus[0]!.rail.tuck).toBe(DIAL_RANGES.tuck[1]);
  });

  it('put the number back for text that is not one, and for Escape', () => {
    render(<RailPanel units={MM} />);
    choose(0, 40);
    typeInto('Edge number', 'steep');
    expect(field('Edge number').value).toBe('0');
    fireEvent.change(field('Edge number'), { target: { value: '33' } });
    fireEvent.keyDown(field('Edge number'), { key: 'Escape' });
    expect(field('Edge number').value).toBe('0');
    expect(past()).toHaveLength(0);
  });

  it('step the number with the arrow keys, by more with Shift, a held key one undo step', () => {
    render(<RailPanel units={MM} />);
    choose(0, 40);
    const edge = field('Edge number');
    fireEvent.keyDown(edge, { key: 'ArrowUp' });
    fireEvent.keyDown(edge, { key: 'ArrowUp' });
    fireEvent.keyDown(edge, { key: 'ArrowUp', shiftKey: true });
    fireEvent.keyUp(edge, { key: 'ArrowUp' });
    expect(rails().plus[0]!.rail.bottomEdge).toBe(7);
    expect(labels()).toEqual(['Edit rail']);
    fireEvent.keyDown(edge, { key: 'ArrowDown' });
    fireEvent.keyUp(edge, { key: 'ArrowDown' });
    expect(rails().plus[0]!.rail.bottomEdge).toBe(6);
    const tuck = field('Tuck number');
    fireEvent.keyDown(tuck, { key: 'ArrowDown' });
    fireEvent.keyUp(tuck, { key: 'ArrowDown' });
    // half a millimetre in millimetres
    expect(rails().plus[0]!.rail.tuck).toBeCloseTo(1.4 - 0.05, 9);
  });

  it('show a number past a dial’s end, and keep it until the dial is moved', () => {
    // an apex of 0.76 is past the 40/60 end of the dial
    return showRails({ plus: [key(20, 0.76), key(60, 0.76), key(100, 0.3)] }).then(() => {
      render(<RailPanel units={CM} />);
      choose(0, 40);
      expect(field('Apex number').value).toBe('76');
      expect((dial('Apex') as HTMLInputElement).value).toBe('0');
      expect(panel().textContent).toContain('Past the end of the dial.');
      // touching the field without changing it, and moving another dial, leave it
      fireEvent.focus(field('Apex number'));
      fireEvent.blur(field('Apex number'));
      fireEvent.change(dial('Edge'), { target: { value: '10' } });
      expect(rails().plus[0]!.rail.apex).toBe(0.76);
      // moving the dial takes it
      fireEvent.change(dial('Apex'), { target: { value: '5' } });
      expect(rails().plus[0]!.rail.apex).toBeLessThan(0.6);
      expect(panel().textContent).not.toContain('Past the end of the dial.');
    });
  });

  it('keep their keys from the editor’s own key handler', () => {
    const seen: string[] = [];
    const on = (e: KeyboardEvent) => seen.push(e.key);
    window.addEventListener('keydown', on);
    render(<RailPanel units={CM} />);
    choose(0, 40);
    fireEvent.keyDown(dial('Apex'), { key: 'ArrowRight' });
    fireEvent.keyDown(field('Edge number'), { key: 'ArrowUp' });
    expect(seen).toEqual([]);
    window.removeEventListener('keydown', on);
  });
});

describe('More', () => {
  it('is shut to begin with, opens, and stays as it was left', () => {
    const first = render(<RailPanel units={CM} />);
    choose(0, 40);
    expect(within(panel()).queryByRole('textbox', { name: 'Band width' })).toBeNull();
    fireEvent.click(within(panel()).getByRole('button', { name: /More/ }));
    expect(within(panel()).getByRole('textbox', { name: 'Band width' })).toBeTruthy();
    expect(localStorage.getItem('bs.railPanelMore')).toBe('true');
    first.unmount();
    render(<RailPanel units={CM} />);
    expect(within(panel()).getByRole('textbox', { name: 'Band width' })).toBeTruthy();
  });

  it('has band width, hardness, tuck shape, the deck-side edge and the zone’s start and end', () => {
    localStorage.setItem('bs.railPanelMore', 'true');
    render(<RailPanel units={MM} />);
    choose(0, 40);
    expect(
      ['Band width', 'Hardness', 'Tuck shape', 'Deck-side edge', 'Starts at', 'Ends at'].map(
        (n) => field(n).value,
      ),
    ).toEqual(['20.0', '0.5', '0.45', '0', '200.0', '600.0']);
  });

  it('sets each number with the store’s action for it', () => {
    localStorage.setItem('bs.railPanelMore', 'true');
    render(<RailPanel units={MM} />);
    choose(0, 40);
    typeInto('Band width', '30');
    typeInto('Hardness', '0.7');
    typeInto('Tuck shape', '0.6');
    typeInto('Deck-side edge', '12');
    const r = rails().plus[0]!.rail;
    expect([r.band, r.hardness, r.tuckShape, r.deckEdge]).toEqual([3, 0.7, 0.6, 12]);
    expect(labels()).toEqual(['Edit rail', 'Edit rail', 'Edit rail', 'Edit rail']);
  });

  it('places the zone by number: where it starts and where it ends', () => {
    localStorage.setItem('bs.railPanelMore', 'true');
    render(<RailPanel units={MM} />);
    choose(0, 40);
    typeInto('Starts at', '300');
    typeInto('Ends at', '700');
    expect(zonesOf()[0]).toMatchObject({ from: 30, to: 70 });
    expect(labels()).toEqual(['Move rail zone', 'Move rail zone']);
    // a zone of no length is drawn out by its end
    choose(1, 100);
    expect(field('Starts at').value).toBe('1000.0');
    typeInto('Ends at', '1200');
    expect(zonesOf()[1]).toMatchObject({ from: 100, to: 120 });
  });
});

describe('the foot of the panel', () => {
  it('saves the zone’s rail as one of my rails, under a name asked for, kept in the browser', () => {
    render(<RailPanel units={CM} />);
    choose(2, 160);
    fireEvent.click(screen.getByRole('button', { name: 'Save as my rail' }));
    const form = screen.getByRole('form', { name: 'Save as my rail' });
    fireEvent.change(within(form).getByRole('textbox', { name: 'Name for the rail' }), {
      target: { value: '  Point   break  ' },
    });
    fireEvent.submit(form);
    expect(getMyRails()).toEqual([{ name: 'Point break', rail: KEYS[3]!.rail }]);
    expect(JSON.parse(localStorage.getItem('bs.myRails')!)[0].name).toBe('Point break');
    // it names the zone now, and is in the menu
    expect(menu().selectedOptions[0]!.textContent).toBe('Point break');
    expect(panel().textContent).toContain('Saved as “Point break”');
    expect(screen.queryByRole('form', { name: 'Save as my rail' })).toBeNull();
  });

  it('refuses a built-in name, an empty one and one already used, and says why', () => {
    setMyRails([{ name: 'Surf', rail: rail(0.1) }]);
    render(<RailPanel units={CM} />);
    choose(2, 160);
    fireEvent.click(screen.getByRole('button', { name: 'Save as my rail' }));
    const form = screen.getByRole('form', { name: 'Save as my rail' });
    const input = within(form).getByRole('textbox', { name: 'Name for the rail' });
    for (const [name, reason] of [
      ['', 'Give the rail a name.'],
      ['tucked', 'built-in rail'],
      ['surf', 'already have a rail'],
    ] as const) {
      fireEvent.change(input, { target: { value: name } });
      fireEvent.submit(form);
      expect(within(form).getByRole('alert').textContent).toContain(reason);
    }
    expect(getMyRails()).toHaveLength(1);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('form', { name: 'Save as my rail' })).toBeNull();
  });

  it('renames and removes a rail of mine from under the menu', () => {
    setMyRails([{ name: 'Surf', rail: KEYS[3]!.rail }]);
    render(<RailPanel units={CM} />);
    choose(2, 160);
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const form = screen.getByRole('form', { name: 'Rename the rail' });
    fireEvent.change(within(form).getByRole('textbox', { name: 'Name for the rail' }), {
      target: { value: 'Surf 2' },
    });
    fireEvent.submit(form);
    expect(getMyRails().map((r) => r.name)).toEqual(['Surf 2']);
    expect(menu().selectedOptions[0]!.textContent).toBe('Surf 2');
    fireEvent.click(screen.getByRole('button', { name: 'Remove from my rails' }));
    expect(getMyRails()).toEqual([]);
    // the zone keeps its numbers, and is Custom again
    expect(menu().selectedOptions[0]!.textContent).toMatch(/^Custom/);
  });

  it('tidies the rails and says how many zones it joined', async () => {
    await showRails({
      plus: [key(20, 0.5), key(60, 0.505), key(100, 0.3), key(140, 0.4), key(180, 0.4)],
    });
    render(<RailPanel units={CM} />);
    choose(0, 20);
    fireEvent.click(within(panel()).getByRole('button', { name: 'Tidy rails' }));
    expect(panel().textContent).toContain('Joined 1 zone.');
    expect(labels()).toEqual(['Tidy rails']);
  });

  it('deletes the zone, and not the last one', async () => {
    render(<RailPanel units={CM} />);
    choose(1, 100);
    fireEvent.click(within(panel()).getByRole('button', { name: 'Delete zone' }));
    expect(zonesOf()).toHaveLength(2);
    expect(labels()).toEqual(['Remove rail zone']);
    await showRails({ plus: [key(50, 0.5)] });
    choose(0, 50);
    expect(
      (within(panel()).getByRole('button', { name: 'Delete zone' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe('a blend', () => {
  it('shows the zones at its two ends, each with an Edit button, and its length in the display unit', () => {
    render(<RailPanel units={CM} />);
    act(() => chooseRail({ side: 'plus', blend: 0 }, 80));
    expect(screen.getByRole('heading', { name: /Blend 1/ })).toBeTruthy();
    const text = panel().textContent!;
    expect(text).toContain('Before: zone 1, Round');
    expect(text).toContain('After: zone 2, Custom');
    expect(text).toContain('Length 40.00 cm, from 60.00 cm to 100.00 cm.');
    // nothing to edit in it
    expect(within(panel()).queryByRole('slider')).toBeNull();
    fireEvent.click(within(panel()).getByRole('button', { name: 'Edit zone 2' }));
    expect(getRailChoice()).toEqual({ side: 'plus', zone: 1 });
  });
});

describe('the panel slot', () => {
  it('shows the panel for the Rails step and nothing for any other', () => {
    act(() => setWorkspaceStep('outline'));
    const { rerender } = render(<RailPanelSlot units={CM} />);
    expect(screen.queryByRole('region', { name: 'Rail panel' })).toBeNull();
    act(() => setWorkspaceStep('rails'));
    rerender(<RailPanelSlot units={CM} />);
    expect(screen.getByRole('region', { name: 'Rail panel' })).toBeTruthy();
  });

  it('fills the width of the sheet when it is given one', () => {
    act(() => setWorkspaceStep('rails'));
    render(<RailPanelSlot units={CM} fluid />);
    expect(screen.getByRole('region', { name: 'Rail panel' }).className).toContain('w-full');
  });
});

describe('the choice', () => {
  it('follows a choice made elsewhere, and the sides setting', () => {
    render(<RailPanel units={CM} />);
    act(() => setRailChoice({ side: 'plus', zone: 0 }, 40));
    expect(screen.getByRole('heading', { name: /Zone 1/ })).toBeTruthy();
    act(() => setRailSides('both'));
    act(() => setRailChoice(null));
    expect(panel().textContent).toContain('Tap a rail zone');
  });
});
