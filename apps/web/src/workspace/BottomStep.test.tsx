// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The Bottom step's drawing against the real rails store: the slice and the plan from below, the station the
 * plan's ticks choose, and the cross-section editor for Edit curve in place of both.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lengthUnitByKey } from '../format';
import { activeStore, boardStore, railsStore } from '../store';
import { key, showRails } from '../test/rails-board';
import { resetBottomChoice, setBottomEditCurve } from './bottom-choice';
import { BottomStep } from './BottomStep';

const CM = lengthUnitByKey('cm');
const KEYS = [key(20, 0.5), key(100, 0.5), key(170, 0.4)];

function Harness({ start = 3 }: { start?: number }) {
  const [slice, setSlice] = useState(start);
  const editor = (control: ReactNode) => <div data-testid="editor">{control}</div>;
  return (
    <>
      <div data-testid="chosen">{slice}</div>
      <BottomStep units={CM} station={slice} onStation={setSlice} renderEditor={editor} />
    </>
  );
}

beforeEach(async () => {
  localStorage.clear();
  resetBottomChoice();
  await showRails({ plus: KEYS });
  activeStore.getState().select({ target: { kind: 'bottom' }, index: 0 } as never);
});
afterEach(() => {
  resetBottomChoice();
  activeStore.use(boardStore);
});

describe('the drawing', () => {
  it('is the slice and the plan from below, each in a card with a name', () => {
    render(<Harness />);
    expect(screen.getByRole('heading', { name: /Bottom: station 3/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Bottom seen from below' })).toBeTruthy();
    expect(screen.getByTestId('bottom-slice')).toBeTruthy();
    expect(screen.getByTestId('contour-plan')).toBeTruthy();
    expect(screen.queryByTestId('editor')).toBeNull();
    expect(screen.getByText(/The bottom is flat/)).toBeTruthy();
  });

  it('asks for a contour to be added where the board has none, and for a handle where it has one', () => {
    render(<Harness />);
    act(() => {
      railsStore.getState().addContour('single-concave');
    });
    expect(screen.getByText(/Drag the handle to set the depth/)).toBeTruthy();
    expect(screen.getByRole('slider', { name: 'Depth' })).toBeTruthy();
  });

  it('follows the station the plan’s ticks choose', () => {
    render(<Harness />);
    const lane = screen.getByRole('toolbar', { name: 'Stations along the board' });
    fireEvent.click(within(lane).getAllByRole('button')[3]!);
    expect(screen.getByTestId('chosen').textContent).toBe('4');
    expect(screen.getByRole('heading', { name: /Bottom: station 4/ })).toBeTruthy();
  });
});

describe('Edit curve', () => {
  it('shows the cross-section editor in place of the slice and the plan, with the control to go back', () => {
    render(<Harness />);
    act(() => setBottomEditCurve(true));
    expect(screen.getByTestId('editor')).toBeTruthy();
    expect(screen.queryByTestId('bottom-slice')).toBeNull();
    expect(screen.queryByTestId('contour-plan')).toBeNull();
    const control = within(screen.getByTestId('editor')).getByRole('button', {
      name: 'Edit curve',
    });
    expect(control.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(control);
    expect(screen.queryByTestId('editor')).toBeNull();
    expect(screen.getByTestId('bottom-slice')).toBeTruthy();
  });

  it('is on the slice’s header too, and clears the editor’s selection when the editor is not shown', () => {
    render(<Harness />);
    expect(activeStore.getState().selection).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit curve' }));
    expect(screen.getByTestId('editor')).toBeTruthy();
    act(() => activeStore.getState().select({ target: { kind: 'bottom' }, index: 0 } as never));
    fireEvent.click(
      within(screen.getByTestId('editor')).getByRole('button', { name: 'Edit curve' }),
    );
    expect(activeStore.getState().selection).toBeNull();
  });
});
