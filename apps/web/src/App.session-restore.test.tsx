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
import { loadSettings, saveSettings } from './settings';
import { boardStore, sectionStore } from './store';
import swallowDoc from './templates/swallow-shortboard.board?raw';
import { currentSections, resetSectionEngine } from './use-section-engine';

// The 3D pane lazy-loads three.js/fiber, which need WebGL — stub the whole package.
vi.mock('@openshaper/render3d', () => ({
  Board3DView: () => null,
  isExactAnalysis: () => false,
}));

const sampleLength = getLength(parseBrd(sampleBrd).board);

beforeEach(async () => {
  localStorage.clear();
  await clearSession();
  // Reset the singleton store to the pristine pre-first-visit state.
  boardStore.getState().load(parseBrd(sampleBrd).board);
  boardStore.setState({ board: null, past: [], future: [] });
  resetSectionEngine();
  sectionStore.setState({ doc: null, board: null });
});

describe('<App /> session restore', () => {
  it('restores the autosaved board instead of loading the sample', async () => {
    // Autosaved session: the sample board stretched 20% — distinguishable by length.
    const saved = scaleBoard(parseBrd(sampleBrd).board, 1.2, 1, 1);
    await saveSession({ boardJson: writeBoardJson(saved, { model: 'Autosaved' }) });

    render(<App />);
    await screen.findAllByText(/\d+\.\dL/);

    const restored = boardStore.getState().board;
    expect(restored).not.toBeNull();
    expect(getLength(restored!)).toBeCloseTo(sampleLength * 1.2, 3);
  });

  it('falls back to the sample board when the stored session is corrupt', async () => {
    await saveSession({ boardJson: 'not json at all {{{' });

    render(<App />);
    await screen.findAllByText(/\d+\.\dL/);

    const board = boardStore.getState().board;
    expect(board).not.toBeNull();
    expect(getLength(board!)).toBeCloseTo(sampleLength, 3);
  });

  it('falls back to the sample board when no session exists', async () => {
    render(<App />);
    await screen.findAllByText(/\d+\.\dL/);

    const board = boardStore.getState().board;
    expect(board).not.toBeNull();
    expect(getLength(board!)).toBeCloseTo(sampleLength, 3);
  });

  describe('with a NURBS document in the session', () => {
    const classic = () => writeBoardJson(parseBrd(sampleBrd).board, { model: 'Classic one' });

    it('restores both documents with the engine on, and does not convert over the document', async () => {
      saveSettings({ ...loadSettings(), nurbsEngine: true });
      await saveSession({ boardJson: classic(), sectionsJson: swallowDoc });

      render(<App />);
      await screen.findAllByText(/\d+\.\dL/, {}, { timeout: 30_000 });

      // the classic board is the one that was opened, the section store the document that was edited
      expect(getLength(boardStore.getState().board!)).toBeCloseTo(sampleLength, 3);
      await vi.waitFor(() => expect(sectionStore.getState().doc).not.toBeNull(), {
        timeout: 30_000,
      });
      const doc = sectionStore.getState().doc!;
      expect(doc.meta.name).toBe('Swallow shortboard');
      expect(doc.tail.kind).toBe('notched');
      expect(currentSections()).toEqual({ doc });
    }, 60_000);

    it('holds the document with the engine off, ready to be written back and to be revived', async () => {
      await saveSession({ boardJson: classic(), sectionsJson: swallowDoc });

      render(<App />);
      await screen.findAllByText(/\d+\.\dL/);

      expect(sectionStore.getState().doc).toBeNull();
      expect(currentSections()).toEqual({ text: swallowDoc });
    });
  });
});
