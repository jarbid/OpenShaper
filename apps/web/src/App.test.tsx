import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { boardStore } from './store';
import { STORAGE_KEY } from './recent-boards';

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
    expect((await screen.findAllByText(/[\d.]+ liters/)).length).toBeGreaterThan(0);

    // The sample board was parsed into the store on mount (session hydration is
    // async — no stored session in this environment, so the sample is the fallback).
    expect(boardStore.getState().board).not.toBeNull();
  });

  it('reserves the same header height in all four quad panes when a point is selected', async () => {
    render(<App />);
    await screen.findAllByText(/[\d.]+ liters/);

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
    await screen.findAllByText(/[\d.]+ liters/); // sample board loaded + specs settled
    const before = boardStore.getState().board!;

    act(() => boardStore.getState().scaleBoard(1.1, 1, 1));

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
