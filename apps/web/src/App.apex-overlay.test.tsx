// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The rail apex line (Phase 0, item 0.6) as the app wires it: View ▸ Apex line and
 * the sidebar's Analysis checkbox draw its height in the rocker pane only, and the
 * 3D controls' Apex button turns on the guide on the hull.
 *
 * Rendered through `<App />` with the panes stubbed: what is under test is which pane
 * gets the line and which toggle sends it there, not how either pane draws it.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { getRockerAtPos, getThicknessAtPos } from '@openshaper/kernel';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { boardStore } from './store';
import { openSection } from './test/sidebar';

vi.mock('@openshaper/render3d', () => ({
  Board3DView: (props: { showApex?: boolean }) => (
    <div data-testid="board-3d" data-show-apex={props.showApex ? 'yes' : 'no'} />
  ),
}));

vi.mock('@openshaper/render2d', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openshaper/render2d')>();
  return {
    ...actual,
    SplineEditor: (props: React.ComponentProps<typeof actual.SplineEditor>) => (
      <div
        data-testid={`editor-${props.targets[0]?.kind ?? 'unknown'}`}
        data-apex={JSON.stringify(props.overlays?.apexHeight ?? null)}
      />
    ),
  };
});

beforeEach(() => {
  localStorage.clear();
});

/** The apex points a pane was handed, or null. Rocker = deck, outline, cross-section. */
const apexOn = (kind: 'deck' | 'outline' | 'crossSection') =>
  JSON.parse(screen.getAllByTestId(`editor-${kind}`)[0]!.getAttribute('data-apex')!) as
    | { x: number; z: number }[]
    | null;

const ready = () => screen.findAllByText(/\d+\.\dL/);

const toggleFromViewMenu = () => {
  fireEvent.click(screen.getByRole('menuitem', { name: 'View' }));
  fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Apex line' }));
};

describe('apex height overlay', () => {
  it('is off until View ▸ Apex line turns it on, then draws in the rocker pane only', async () => {
    render(<App />);
    await ready();
    expect(apexOn('deck')).toBeNull();

    toggleFromViewMenu();
    const item = screen.getByRole('menuitemcheckbox', { name: 'Apex line' });
    expect(item.getAttribute('aria-checked')).toBe('true');
    await waitFor(() => expect(apexOn('deck')).not.toBeNull());

    const pts = apexOn('deck')!;
    expect(pts.length).toBeGreaterThan(100);
    // Heights in board space: every point between the bottom and the deck at its x.
    const board = boardStore.getState().board!;
    for (const p of pts) {
      const rocker = getRockerAtPos(board, p.x);
      expect(p.z).toBeGreaterThan(rocker);
      expect(p.z).toBeLessThan(rocker + getThicknessAtPos(board, p.x));
    }
    expect(apexOn('outline')).toBeNull();
    expect(apexOn('crossSection')).toBeNull();

    // And off again.
    fireEvent.click(item);
    await waitFor(() => expect(apexOn('deck')).toBeNull());
  });

  it('turns on from the sidebar’s Analysis section too', async () => {
    render(<App />);
    await ready();
    openSection('analysis');

    fireEvent.click(screen.getByRole('checkbox', { name: /apex line/i }));
    await waitFor(() => expect(apexOn('deck')?.length).toBeGreaterThan(100));
  });
});

describe('apex guide in 3D', () => {
  it('is toggled by the Apex button beside Stringer and Sections', async () => {
    render(<App />);
    await ready();
    const view = screen.getByTestId('board-3d');
    expect(view.getAttribute('data-show-apex')).toBe('no');

    const apex = screen.getAllByRole('button', { name: 'Apex' })[0]!;
    // Grouped with the other guide toggles.
    const controls = apex.parentElement!;
    expect(within(controls).getByRole('button', { name: 'Stringer' })).toBeTruthy();
    expect(within(controls).getByRole('button', { name: 'Sections' })).toBeTruthy();

    fireEvent.click(apex);
    expect(screen.getByTestId('board-3d').getAttribute('data-show-apex')).toBe('yes');
  });
});
