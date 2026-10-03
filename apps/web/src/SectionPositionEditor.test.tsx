/**
 * P14: the slice-position field shows the unit's own precision (3 places in inches)
 * instead of a fixed 2, with 2 as the floor so mm still shows sub-millimetre positions.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LENGTH_UNITS } from './format';
import { SectionPositionEditor } from './SectionPositionEditor';

const byKey = (k: string) => LENGTH_UNITS.find((u) => u.key === k)!;
const field = () => screen.getByLabelText('Selected slice position') as HTMLInputElement;

describe('<SectionPositionEditor /> precision (P14)', () => {
  it.each([
    ['mm', '1500.00'],
    ['cm', '150.00'],
    ['in', '59.055'],
  ])('shows %s to the unit precision', (key, shown) => {
    render(<SectionPositionEditor valueCm={150} units={byKey(key)} onCommit={() => {}} />);
    expect(field().value).toBe(shown);
  });

  it('steps keep the unit precision', () => {
    const onCommit = vi.fn();
    render(<SectionPositionEditor valueCm={150} units={byKey('mm')} onCommit={onCommit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Increase slice position' }));
    expect(field().value).toBe('1510.00');
    expect(onCommit).toHaveBeenCalledWith(151);
  });
});
