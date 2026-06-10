import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { boardStore } from './store';

// The 3D pane lazy-loads three.js/fiber, which need WebGL — stub the whole package.
vi.mock('@openshaper/render3d', () => ({ Board3DView: () => null }));

describe('<App /> smoke', () => {
  it('mounts the shell, loads the sample board, and shows the editor chrome', async () => {
    render(<App />);

    // Menubar + view tabs are up.
    expect(screen.getByText('File')).toBeTruthy();
    expect(screen.getByText('Board')).toBeTruthy();
    expect(screen.getAllByText('Outline').length).toBeGreaterThan(0); // tab + pane title

    // The sample board was parsed into the store on mount.
    expect(boardStore.getState().board).not.toBeNull();

    // The spec sidebar rendered values for the settled board (volume is always litres).
    expect((await screen.findAllByText(/[\d.]+ liters/)).length).toBeGreaterThan(0);
  });
});
