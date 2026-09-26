import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { boardStore } from './store';
import { STORAGE_KEY } from './recent-boards';
import { openSection } from './test/sidebar';
import { VIEW_TOGGLE_HINT } from './view-toolkit';

// The 3D pane lazy-loads three.js/fiber, which need WebGL — stub the whole package.
vi.mock('@openshaper/render3d', () => ({ Board3DView: () => null }));

describe('<App /> smoke', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('mounts the shell, loads the sample board, and shows the editor chrome', async () => {
    render(<App />);

    // Menubar + view tabs are up.
    expect(screen.getByText('File')).toBeTruthy();
    expect(screen.getByText('Board')).toBeTruthy();
    expect(screen.getAllByText('Outline').length).toBeGreaterThan(0); // tab + pane title

    // The spec sidebar rendered values for the settled board (volume is always litres).
    expect((await screen.findAllByText(/\d+\.\dL/)).length).toBeGreaterThan(0);

    // The sample board was parsed into the store on mount (session hydration is
    // async — no stored session in this environment, so the sample is the fallback).
    expect(boardStore.getState().board).not.toBeNull();
  });

  it('reserves the same header height in all four quad panes when a point is selected', async () => {
    render(<App />);
    await screen.findAllByText(/\d+\.\dL/);

    const paneHeaders = () => [
      screen.getByRole('heading', { name: 'Outline' }).parentElement!,
      screen.getByRole('heading', { name: /Cross-section/ }).parentElement!,
      screen.getByRole('heading', { name: 'Rocker (deck + bottom)' }).parentElement!,
      screen.getByRole('heading', { name: '3D' }).parentElement!,
    ];
    const before = paneHeaders().map((header) => header.className);

    expect(before.every((className) => className.includes('min-h-14'))).toBe(true);

    act(() => boardStore.getState().select({ target: { kind: 'outline' }, index: 1 }));

    expect(screen.getAllByRole('spinbutton')).toHaveLength(2);
    expect(paneHeaders().map((header) => header.className)).toEqual(before);
  });

  it.each([
    ['Outline', 'Rocker (deck + bottom)'],
    [/Cross-section/, 'Outline'],
    ['Rocker (deck + bottom)', 'Outline'],
    ['3D', 'Outline'],
  ])(
    'toggles the %s pane between quad and maximized on title double-click',
    async (title, otherTitle) => {
      render(<App />);
      await screen.findAllByText(/\d+\.\dL/);

      const heading = screen.getByRole('heading', { name: title });
      fireEvent.doubleClick(heading);

      const maximizedHeading = screen.getByRole('heading', { name: title });
      expect(screen.queryByRole('heading', { name: otherTitle })).toBeNull();

      fireEvent.doubleClick(maximizedHeading);

      expect(screen.getByRole('heading', { name: title })).toBeTruthy();
      expect(screen.getByRole('heading', { name: otherTitle })).toBeTruthy();
    },
  );

  it('advertises the double-click toggle on the titles that carry it', async () => {
    render(<App />);
    await screen.findAllByText(/\d+\.\dL/);

    // The hint is the whole affordance — a double-click has no visible control of
    // its own — and `select-none` keeps the switch from leaving the title
    // highlighted behind the view it just opened.
    for (const name of ['Outline', '3D']) {
      const heading = screen.getByRole('heading', { name });
      expect(heading.getAttribute('title')).toBe(VIEW_TOGGLE_HINT);
      expect(heading.className).toContain('select-none');
      expect(heading.className).toContain('cursor-pointer');
    }
    // A title with no handler stays a plain heading: the sidebar panels are not views.
    expect(screen.getByRole('heading', { name: 'Specs' }).getAttribute('title')).toBeNull();
  });

  it('does not maximize a quad pane when a title-bar control is double-clicked', async () => {
    render(<App />);
    await screen.findAllByText(/\d+\.\dL/);

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Stringer' }));

    expect(screen.getByRole('heading', { name: 'Outline' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '3D' })).toBeTruthy();
  });

  it('uses the File-menu palette for the Display units selector and its options', () => {
    render(<App />);

    const units = screen.getByTitle('Display units');
    expect(units.className).toContain('bg-card');
    expect(units.className).toContain('text-card-foreground');
    expect(units.className).toContain('[&>option]:bg-card');
    expect(units.className).toContain('[&>option]:text-card-foreground');
    expect(units.className).not.toContain('bg-transparent');
  });

  it('Ctrl+K opens the command palette over the menu actions', async () => {
    render(<App />);

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = await screen.findByPlaceholderText(/command/i);

    // Palette entries come from the real menus.
    fireEvent.change(input, { target: { value: 'spec sheet' } });
    expect(screen.getByText(/Export: Spec sheet/)).toBeTruthy();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByPlaceholderText(/command/i)).toBeNull();
  });

  it('history panel lists labelled steps and jumps back on click', async () => {
    render(<App />);
    await screen.findAllByText(/\d+\.\dL/); // sample board loaded + specs settled
    const before = boardStore.getState().board!;

    act(() => boardStore.getState().scaleBoard(1.1, 1, 1));

    // History is a reference section: it starts collapsed, and a collapsed section's
    // body is unmounted, so the steps are reached the way a user reaches them.
    openSection('history');
    const step = await screen.findByRole('button', { name: /Resize board/ });
    fireEvent.click(step);

    expect(boardStore.getState().board).toBe(before);
    expect(boardStore.getState().future).toHaveLength(1);
  });

  it('File menu shows a pre-seeded recent entry under "Open recent"', async () => {
    // Pre-seed localStorage so the App reads it on mount.
    const entry = {
      name: 'My Test Board',
      savedAt: new Date().toISOString(),
      boardJson: '{}',
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify([entry]));

    render(<App />);

    // Open the File menu.
    const fileBtn = screen.getByRole('menuitem', { name: 'File' });
    fireEvent.click(fileBtn);

    // The "Open recent" label and the board name should be visible.
    expect(screen.getByText('Open recent')).toBeTruthy();
    expect(screen.getByText('My Test Board')).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Clear recent' })).toBeTruthy();
  });
});
