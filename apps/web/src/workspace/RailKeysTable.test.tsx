// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The Rails step's footer: per side, the rail keys' x and seven numbers, in the display unit where
 * the number is a length, and nothing at all for a board that has no rail keys.
 */
import type { RailsBoard } from '@openshaper/board2';
import { act, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lengthUnitByKey } from '../format';
import { activeStore, boardStore, railsStore } from '../store';
import { RAIL_KEY_COLUMNS, RailKeysTable } from './RailKeysTable';

const key = (x: number, over: Partial<RailsBoard['rails']['plus'][number]['rail']> = {}) => ({
  x,
  rail: {
    band: 1.5,
    hardness: 0.5,
    tuck: 2.25,
    tuckShape: 0.4,
    bottomEdge: 12.34,
    deckEdge: 0,
    apex: 0.6,
    ...over,
  },
});

const doc = (rails: RailsBoard['rails']) => ({ model: 'rails', rails }) as unknown as RailsBoard;

const show = (rails: RailsBoard['rails'] | null) =>
  act(() => {
    railsStore.setState({ doc: rails ? doc(rails) : null });
    activeStore.use(rails ? railsStore : boardStore);
  });

beforeEach(() => show(null));
afterEach(() => show(null));

const mm = lengthUnitByKey('mm');

const cells = (table: HTMLElement) =>
  within(table)
    .getAllByRole('row')
    .map((r) => Array.from(r.querySelectorAll('th, td')).map((c) => c.textContent));

describe('the table', () => {
  it('is not there for a board with no rail keys', () => {
    show(null);
    const { container } = render(<RailKeysTable units={mm} />);
    expect(container.firstChild).toBeNull();
  });

  it('has one table for both sides of a mirror board, a row to a key', () => {
    show({ plus: [key(0), key(60.5), key(121)] });
    render(<RailKeysTable units={mm} />);
    expect(screen.getByRole('region', { name: 'Rail keys' })).toBeTruthy();
    const tables = screen.getAllByRole('table');
    expect(tables.map((t) => t.getAttribute('aria-label'))).toEqual(['Both rails']);
    expect(within(tables[0]!).getAllByRole('row')).toHaveLength(4);
  });

  it('has the x and the seven numbers, in the order of the rail recipe', () => {
    expect(RAIL_KEY_COLUMNS.map((c) => c.id)).toEqual([
      'x',
      'band',
      'shoulder',
      'tuck',
      'tuckShape',
      'bottomEdge',
      'deckEdge',
      'apex',
    ]);
  });

  it('shows the lengths in the display unit and the other numbers as they are', () => {
    show({ plus: [key(12.34)] });
    render(<RailKeysTable units={mm} />);
    expect(cells(screen.getByRole('table'))).toEqual([
      [
        'x (mm)',
        'Band (mm)',
        'Shoulder',
        'Tuck (mm)',
        'Tuck shape',
        'Bottom edge (°)',
        'Deck edge (°)',
        'Apex',
      ],
      ['123.4', '15.0', '0.50', '22.5', '0.40', '12.3', '0.0', '0.60'],
    ]);
  });

  it('follows the display unit, and leaves the dimensionless numbers alone', () => {
    show({ plus: [key(12.7)] });
    const inches = render(<RailKeysTable units={lengthUnitByKey('in')} />);
    expect(cells(screen.getByRole('table'))[1]).toEqual([
      '5.000',
      '0.591',
      '0.50',
      '0.886',
      '0.40',
      '12.3',
      '0.0',
      '0.60',
    ]);
    expect(cells(screen.getByRole('table'))[0]![0]).toBe('x (in)');
    inches.unmount();
    render(<RailKeysTable units={lengthUnitByKey('cm')} />);
    expect(cells(screen.getByRole('table'))[1]!.slice(0, 4)).toEqual([
      '12.70',
      '1.50',
      '0.50',
      '2.25',
    ]);
    expect(cells(screen.getByRole('table'))[0]![0]).toBe('x (cm)');
  });

  it('has a table for each side of an asymmetric board, upper then lower', () => {
    show({ plus: [key(0), key(100)], minus: [key(0, { band: 3 }), key(50), key(100)] });
    render(<RailKeysTable units={mm} />);
    const tables = screen.getAllByRole('table');
    expect(tables.map((t) => t.getAttribute('aria-label'))).toEqual(['Upper rail', 'Lower rail']);
    expect(within(tables[0]!).getAllByRole('row')).toHaveLength(3);
    expect(within(tables[1]!).getAllByRole('row')).toHaveLength(4);
    expect(cells(tables[1]!)[1]![1]).toBe('30.0');
  });

  it('follows an edit to the rail keys', () => {
    show({ plus: [key(0)] });
    render(<RailKeysTable units={mm} />);
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(2);
    show({ plus: [key(0), key(80)] });
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(3);
  });

  it('is read-only: no input, no button', () => {
    show({ plus: [key(0), key(100)] });
    const { container } = render(<RailKeysTable units={mm} />);
    expect(container.querySelector('input, button, select, textarea')).toBeNull();
  });
});
