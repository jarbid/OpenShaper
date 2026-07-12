/**
 * Silent session restore — on launch the app rehydrates the autosaved working
 * board from IndexedDB instead of the bundled sample, with the sample as the
 * fallback when nothing (or something broken) is stored.
 *
 * Lives in its own file: boardStore is a module singleton, and these tests
 * need the pristine "no board loaded yet" state that App sees on first visit.
 */
import 'fake-indexeddb/auto';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseBrd, writeBoardJson } from '@openshaper/io';
import { getLength } from '@openshaper/kernel';
import { scaleBoard } from '@openshaper/store';
import { App } from './App';
import sampleBrd from './sample-board.brd?raw';
import { clearSession, saveSession } from './session-store';
import { boardStore } from './store';

// The 3D pane lazy-loads three.js/fiber, which need WebGL — stub the whole package.
vi.mock('@openshaper/render3d', () => ({ Board3DView: () => null }));

const sampleLength = getLength(parseBrd(sampleBrd).board);

beforeEach(async () => {
  localStorage.clear();
  await clearSession();
  // Reset the singleton store to the pristine pre-first-visit state.
  boardStore.getState().load(parseBrd(sampleBrd).board);
  boardStore.setState({ board: null, past: [], future: [] });
});

describe('<App /> session restore', () => {
  it('restores the autosaved board instead of loading the sample', async () => {
    // Autosaved session: the sample board stretched 20% — distinguishable by length.
    const saved = scaleBoard(parseBrd(sampleBrd).board, 1.2, 1, 1);
    await saveSession({ boardJson: writeBoardJson(saved, { model: 'Autosaved' }) });

    render(<App />);
    await screen.findAllByText(/[\d.]+ liters/);

    const restored = boardStore.getState().board;
    expect(restored).not.toBeNull();
    expect(getLength(restored!)).toBeCloseTo(sampleLength * 1.2, 3);
  });

  it('falls back to the sample board when the stored session is corrupt', async () => {
    await saveSession({ boardJson: 'not json at all {{{' });

    render(<App />);
    await screen.findAllByText(/[\d.]+ liters/);

    const board = boardStore.getState().board;
    expect(board).not.toBeNull();
    expect(getLength(board!)).toBeCloseTo(sampleLength, 3);
  });

  it('falls back to the sample board when no session exists', async () => {
    render(<App />);
    await screen.findAllByText(/[\d.]+ liters/);

    const board = boardStore.getState().board;
    expect(board).not.toBeNull();
    expect(getLength(board!)).toBeCloseTo(sampleLength, 3);
  });
});
