// SPDX-License-Identifier: GPL-3.0-or-later
/** The panel slot: the rail panel for the Rails step, the deck panel for the Deck step, the bottom panel for the Bottom step, nothing for the others. */
import { render, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lengthUnitByKey } from '../format';
import { activeStore, boardStore } from '../store';
import { key, showRails } from '../test/rails-board';
import { resetBottomChoice } from './bottom-choice';
import { resetDeckChoice } from './deck-choice';
import { StepPanelSlot } from './StepPanelSlot';
import { resetWorkspaceStep, setWorkspaceStep } from './use-step';
import type { StepId } from './steps';

const CM = lengthUnitByKey('cm');

beforeEach(async () => {
  localStorage.clear();
  resetWorkspaceStep();
  resetDeckChoice();
  resetBottomChoice();
  await showRails({ plus: [key(20, 0.5), key(100, 0.5), key(170, 0.4)] });
});
afterEach(() => {
  resetWorkspaceStep();
  activeStore.use(boardStore);
});

describe('StepPanelSlot', () => {
  it('shows the deck panel for the Deck step, for the station it is given', () => {
    act(() => setWorkspaceStep('deck'));
    render(<StepPanelSlot units={CM} slice={3} />);
    expect(screen.getByRole('region', { name: 'Deck panel' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Rail panel' })).toBeNull();
    expect(screen.getByRole('heading', { name: /Station 3 of/ })).toBeTruthy();
  });

  it('shows the rail panel for the Rails step', () => {
    act(() => setWorkspaceStep('rails'));
    render(<StepPanelSlot units={CM} slice={3} />);
    expect(screen.getByRole('region', { name: 'Rail panel' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Deck panel' })).toBeNull();
  });

  it('shows the bottom panel for the Bottom step', () => {
    act(() => setWorkspaceStep('bottom'));
    render(<StepPanelSlot units={CM} slice={3} />);
    expect(screen.getByRole('region', { name: 'Bottom panel' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Deck panel' })).toBeNull();
  });

  it('shows the tail panel for the Tail step', () => {
    act(() => setWorkspaceStep('tail'));
    render(<StepPanelSlot units={CM} slice={3} />);
    expect(screen.getByRole('region', { name: 'Tail panel' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Rail panel' })).toBeNull();
  });

  it('shows nothing for a step that has no panel of its own', () => {
    for (const step of ['outline', 'rocker', 'fins'] as StepId[]) {
      act(() => setWorkspaceStep(step));
      const { container, unmount } = render(<StepPanelSlot units={CM} slice={3} />);
      expect(container.firstChild, step).toBeNull();
      unmount();
    }
  });

  it('follows the step when it changes', () => {
    act(() => setWorkspaceStep('outline'));
    const { container } = render(<StepPanelSlot units={CM} slice={3} />);
    expect(container.firstChild).toBeNull();
    act(() => setWorkspaceStep('deck'));
    expect(screen.getByRole('region', { name: 'Deck panel' })).toBeTruthy();
    act(() => setWorkspaceStep('rails'));
    expect(screen.getByRole('region', { name: 'Rail panel' })).toBeTruthy();
    act(() => setWorkspaceStep('bottom'));
    expect(screen.getByRole('region', { name: 'Bottom panel' })).toBeTruthy();
  });

  it('fills the width of a sheet for either panel', () => {
    act(() => setWorkspaceStep('deck'));
    const { rerender } = render(<StepPanelSlot units={CM} slice={3} fluid />);
    expect(screen.getByRole('region', { name: 'Deck panel' }).className).toContain('w-full');
    act(() => setWorkspaceStep('rails'));
    rerender(<StepPanelSlot units={CM} slice={3} fluid />);
    expect(screen.getByRole('region', { name: 'Rail panel' }).className).toContain('w-full');
  });
});
