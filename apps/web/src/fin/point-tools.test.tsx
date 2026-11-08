// SPDX-License-Identifier: GPL-3.0-or-later
import { defaultFinDesign } from '@openshaper/kernel';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PointTools } from './PointTools';
import { finStore } from './fin-store';

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

describe('PointTools', () => {
  it('works on a slice’s own points, past the base foil’s count', () => {
    // Owner testing: the tools read the base foil (3 points), so a slice's later points
    // greyed them out; Delete still worked.
    act(() => {
      finStore.getState().load(defaultFinDesign('side', 'right'));
      finStore.getState().addSlice(0.93); // made the active foil
      finStore.getState().applyNaca('0008'); // a foil of many points
    });
    const outside = () => finStore.getState().design!.slices[0]!.section.outside;
    const n = outside().knots.length;
    expect(n).toBeGreaterThan(finStore.getState().design!.section.outside.knots.length);
    act(() => finStore.getState().select({ curve: 'outside', index: n - 2, kind: 'end' }));
    render(<PointTools store={finStore} />);
    expect(button('Add a point').disabled).toBe(false);
    expect(button('Delete the selected point').disabled).toBe(false);
    fireEvent.click(button('Delete the selected point'));
    expect(outside().knots).toHaveLength(n - 1);
  }, 20_000);

  it('acts on a point picked in any view', () => {
    // Owner testing: a point picked in a small pane greyed out the large pane's tools.
    act(() => {
      finStore.getState().load(defaultFinDesign('side', 'right'));
      finStore.getState().select({ curve: 'taper', index: 1, kind: 'end' });
    });
    const n = finStore.getState().design!.taper.knots.length;
    render(<PointTools store={finStore} />);
    fireEvent.click(button('Add a point'));
    expect(finStore.getState().design!.taper.knots).toHaveLength(n + 1);
  });
});
