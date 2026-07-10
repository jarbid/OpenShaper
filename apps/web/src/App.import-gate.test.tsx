/**
 * Integration test: App-level data-loss import gate.
 *
 * Verifies that when `openBoardFile` resolves with a `dropped` warning:
 *   1. The `ImportWarningsDialog` is shown (not the board — load not yet called).
 *   2. Clicking Cancel dismisses the dialog; `boardStore.load` is NOT called.
 *   3. Clicking "Import anyway" calls `boardStore.load` with the new board.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { parseBrd } from '@openshaper/io';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { boardStore } from './store';
import sampleBrd from './sample-board.brd?raw';

// The 3D pane lazy-loads three.js/fiber, which need WebGL — stub the whole package.
vi.mock('@openshaper/render3d', () => ({ Board3DView: () => null }));

// Keep decideImport real; only make openBoardFile controllable.
vi.mock('./file-io', async (importActual) => {
  const actual = await importActual<typeof import('./file-io')>();
  return {
    ...actual,
    openBoardFile: vi.fn(),
  };
});

// Import after vi.mock so we get the mocked version.
const fileIo = await import('./file-io');
const mockedOpenBoardFile = vi.mocked(fileIo.openBoardFile);

const { board: sampleBoard } = parseBrd(sampleBrd);

describe('App import gate (dropped warning)', () => {
  beforeEach(() => {
    // Reset the store between tests so each test starts clean.
    act(() => boardStore.getState().load(sampleBoard));
    vi.clearAllMocks();
  });

  it('shows the ImportWarningsDialog and does NOT load when there is a dropped warning', async () => {
    // Arrange: mock returns a board + a dropped warning.
    mockedOpenBoardFile.mockResolvedValueOnce({
      board: sampleBoard,
      meta: {},
      warnings: [{ severity: 'dropped', message: 'removed a flat section at 113.9 cm' }],
    });

    const loadSpy = vi.spyOn(boardStore.getState(), 'load');

    render(<App />);

    // Trigger file open via the hidden <input type="file">.
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toBeTruthy();

    await act(async () => {
      fireEvent.change(fileInput, {
        target: { files: [new File(['x'], 'test-board.s3dx')] },
      });
    });

    // The dialog should appear.
    expect(await screen.findByText(/Import will change/)).toBeTruthy();
    expect(screen.getByText(/removed a flat section/)).toBeTruthy();

    // `load` must NOT have been called yet for the new board.
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it('Cancel dismisses the dialog without loading', async () => {
    mockedOpenBoardFile.mockResolvedValueOnce({
      board: sampleBoard,
      meta: {},
      warnings: [{ severity: 'dropped', message: 'removed a flat section at 113.9 cm' }],
    });

    const loadSpy = vi.spyOn(boardStore.getState(), 'load');

    render(<App />);

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(fileInput, {
        target: { files: [new File(['x'], 'test-board.s3dx')] },
      });
    });

    // Dialog is visible.
    const cancelBtn = await screen.findByRole('button', { name: /cancel/i });

    fireEvent.click(cancelBtn);

    // Dialog must be gone.
    expect(screen.queryByText(/Import will change/)).toBeNull();

    // load must still not have been called.
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it('"Import anyway" calls boardStore.load', async () => {
    mockedOpenBoardFile.mockResolvedValueOnce({
      board: sampleBoard,
      meta: {},
      warnings: [{ severity: 'dropped', message: 'removed a flat section at 113.9 cm' }],
    });

    const loadSpy = vi.spyOn(boardStore.getState(), 'load');

    render(<App />);

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(fileInput, {
        target: { files: [new File(['x'], 'test-board.s3dx')] },
      });
    });

    const importBtn = await screen.findByRole('button', { name: /import anyway/i });

    act(() => {
      fireEvent.click(importBtn);
    });

    // Dialog must be gone and load called exactly once.
    expect(screen.queryByText(/Import will change/)).toBeNull();
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(loadSpy).toHaveBeenCalledWith(sampleBoard);
  });
});
