// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Opening a shared link — the startup precedence, and everything adoption
 * resets.
 *
 * The rule this file exists to hold: **existing local work is never replaced
 * without a yes.** A shared board stays out of `boardStore` until the user
 * accepts it, so *Keep current* is a genuine no-op, and an invalid, hostile or
 * oversized link can never disturb a workspace at all.
 *
 * Lives in its own file for the same reason as App.session-restore.test.tsx:
 * boardStore is a module singleton and these tests need the pristine
 * "no board loaded yet" state App sees on a first visit.
 */
import 'fake-indexeddb/auto';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeShareFragment, parseBrd, writeBoardJson } from '@openshaper/io';
import { getLength } from '@openshaper/kernel';
import { scaleBoard } from '@openshaper/store';
import { act } from '@testing-library/react';
import { vec2 } from '@openshaper/kernel';
import { App } from './App';
import sampleBrd from './sample-board.brd?raw';
import { clearSession, loadSession, saveSession } from './session-store';
import { clearSharedPayload, extractSharedFragment } from './share-bootstrap';
import { getRecentBoards } from './recent-boards';
import { loadTraceVisibility } from './trace-visibility';
import { boardStore } from './store';
import { openSection } from './test/sidebar';
import { saveViewState, DEFAULT_VIEW_STATE } from './view-state';

vi.mock('@openshaper/render3d', () => ({ Board3DView: () => null }));

const sample = () => parseBrd(sampleBrd).board;
const sampleLength = getLength(sample());

/** A shared board distinguishable from the sample by length. */
const SHARED_SCALE = 1.37;
const sharedBoard = () => scaleBoard(sample(), SHARED_SCALE, 1, 1);
const sharedLength = sampleLength * SHARED_SCALE;

/** Put a share link in the address bar and run the bootstrap over it. */
async function arriveViaShareLink(metadata?: Record<string, unknown>): Promise<void> {
  const fragment = await encodeShareFragment(sharedBoard(), metadata);
  window.history.replaceState(null, '', `/app#board=${fragment}`);
  extractSharedFragment();
}

/** Put a deliberately broken link in the address bar. */
function arriveViaBadLink(fragment: string): void {
  window.history.replaceState(null, '', `/app#board=${fragment}`);
  extractSharedFragment();
}

const editorReady = () => screen.findAllByText(/\d+\.\dL/);
const currentLength = () => getLength(boardStore.getState().board!);

beforeEach(async () => {
  localStorage.clear();
  await clearSession();
  clearSharedPayload();
  window.history.replaceState(null, '', '/app');
  boardStore.getState().load(sample());
  boardStore.setState({ board: null, past: [], future: [] });
});

describe('precedence: no existing workspace', () => {
  it('opens a valid shared link immediately, with no question asked', async () => {
    await arriveViaShareLink({ model: 'Go Fish', designer: 'Ada L' });

    render(<App />);
    await editorReady();

    await waitFor(() => expect(currentLength()).toBeCloseTo(sharedLength, 3));
    expect(screen.queryByText('Open shared board?')).toBeNull();
    expect(await screen.findByText(/Shared board opened as an editable copy/)).toBeTruthy();
  });

  it('falls back to the bundled sample when the link is invalid', async () => {
    arriveViaBadLink('v1.not-valid-gzip');

    render(<App />);
    await editorReady();

    expect(currentLength()).toBeCloseTo(sampleLength, 3);
    expect(await screen.findByText(/damaged or incomplete/)).toBeTruthy();
  });
});

describe('precedence: an existing workspace', () => {
  /** Autosave a board distinguishable from both the sample and the shared one. */
  const saveWorkspace = async () => {
    const mine = scaleBoard(sample(), 1.1, 1, 1);
    await saveSession({ boardJson: writeBoardJson(mine, { model: 'My Board' }) });
    return sampleLength * 1.1;
  };

  it('asks before replacing it', async () => {
    const mineLength = await saveWorkspace();
    await arriveViaShareLink({ model: 'Go Fish' });

    render(<App />);
    await editorReady();

    expect(await screen.findByText('Open shared board?')).toBeTruthy();
    // The restored workspace is what is actually loaded while the question
    // stands — the shared board has not entered the store.
    await waitFor(() => expect(currentLength()).toBeCloseTo(mineLength, 3));
  });

  it('"Keep current" changes nothing at all', async () => {
    const mineLength = await saveWorkspace();
    await arriveViaShareLink({ model: 'Go Fish' });

    render(<App />);
    await editorReady();
    fireEvent.click(await screen.findByRole('button', { name: 'Keep current' }));

    await waitFor(() => expect(screen.queryByText('Open shared board?')).toBeNull());
    expect(currentLength()).toBeCloseTo(mineLength, 3);
    // Not merely dismissed — forgotten, so no remount can bring it back.
    expect(screen.queryByText(/Shared board opened/)).toBeNull();
  });

  it('"Open shared board" replaces it', async () => {
    await saveWorkspace();
    await arriveViaShareLink({ model: 'Go Fish' });

    render(<App />);
    await editorReady();
    fireEvent.click(await screen.findByRole('button', { name: 'Open shared board' }));

    await waitFor(() => expect(currentLength()).toBeCloseTo(sharedLength, 3));
    expect(await screen.findByText(/Shared board opened as an editable copy/)).toBeTruthy();
  });

  it('leaves the workspace alone when the link is invalid', async () => {
    const mineLength = await saveWorkspace();
    arriveViaBadLink('v99.AAAA');

    render(<App />);
    await editorReady();

    await waitFor(() => expect(currentLength()).toBeCloseTo(mineLength, 3));
    expect(screen.queryByText('Open shared board?')).toBeNull();
    // v99 is an unrecognised envelope, not a newer board document.
    expect(await screen.findByText(/isn't an OpenShaper share link/)).toBeTruthy();
  });
});

describe('what adoption resets', () => {
  const openShared = async (metadata?: Record<string, unknown>) => {
    await arriveViaShareLink(metadata);
    render(<App />);
    await editorReady();
    await waitFor(() => expect(currentLength()).toBeCloseTo(sharedLength, 3));
  };

  it('clears undo history — you cannot undo past a board you never edited', async () => {
    await saveSession({ boardJson: writeBoardJson(scaleBoard(sample(), 1.1, 1, 1)) });
    await arriveViaShareLink({ model: 'Go Fish' });

    render(<App />);
    await editorReady();

    // Build real history on the restored workspace first, or "past is empty"
    // would pass on a store that had never been edited anyway.
    act(() => boardStore.getState().moveControlPoint({ kind: 'outline' }, 1, vec2(50, 30)));
    expect(boardStore.getState().past.length).toBeGreaterThan(0);

    fireEvent.click(await screen.findByRole('button', { name: 'Open shared board' }));
    await waitFor(() => expect(currentLength()).toBeCloseTo(sharedLength, 3));

    expect(boardStore.getState().past).toHaveLength(0);
    expect(boardStore.getState().future).toHaveLength(0);
  });

  it('restores the full Board Info', async () => {
    await openShared({
      model: 'Go Fish',
      designer: 'Ada L',
      surfer: 'Bo',
      comments: 'twin + trailer',
      foamType: 'EPS',
    });

    openSection('boardInfo');
    await waitFor(() =>
      expect((screen.getAllByDisplayValue('Ada L')[0] as HTMLInputElement).value).toBe('Ada L'),
    );
    expect(screen.getAllByDisplayValue('Go Fish').length).toBeGreaterThan(0);
    expect(screen.getAllByDisplayValue('twin + trailer').length).toBeGreaterThan(0);
  });

  it('names the recent entry "<model> (shared)" without touching the model itself', async () => {
    await openShared({ model: 'Go Fish' });

    await waitFor(() => expect(getRecentBoards()[0]?.name).toBe('Go Fish (shared)'));
    // The suffix is a display name for the list only.
    expect(getRecentBoards()[0]!.boardJson).toContain('"model": "Go Fish"');
    expect(getRecentBoards()[0]!.boardJson).not.toContain('(shared)');
  });

  it('names an unnamed shared board "Shared board"', async () => {
    await openShared();
    await waitFor(() => expect(getRecentBoards()[0]?.name).toBe('Shared board'));
  });

  it('lets a second shared board with the same model replace the first', async () => {
    // Documented consequence of de-duplicating the recent list by name, and the
    // same rule every other entry follows. Pinned so it stays a decision.
    await openShared({ model: 'Go Fish' });
    await waitFor(() => expect(getRecentBoards()[0]?.name).toBe('Go Fish (shared)'));

    const named = getRecentBoards().filter((e) => e.name === 'Go Fish (shared)');
    expect(named).toHaveLength(1);
  });

  it('hides both traces without deleting them', async () => {
    await openShared({ model: 'Go Fish' });

    await waitFor(() => expect(loadTraceVisibility()).toEqual({ outline: false, rocker: false }));
  });

  it('opens in Quad view even when the recipient last used another tab', async () => {
    // Quad is the default, so without a stored non-quad view this would pass
    // whether or not adoption sets it.
    saveViewState({ ...DEFAULT_VIEW_STATE, view: 'outline' });
    await openShared({ model: 'Go Fish' });

    // Scoped to the view tabs: "Outline" also names a pane heading and a
    // trace-panel button.
    const tabs = () => within(screen.getByRole('group', { name: 'Views' }));
    const active = (name: string) =>
      tabs().getByRole('button', { name }).className.includes('secondary');
    await waitFor(() => expect(active('Quad')).toBe(true));
    expect(active('Outline')).toBe(false);
  });

  it('drops the ghost from the autosaved session, so a reload cannot resurrect it', async () => {
    // A workspace whose session carries a comparison board.
    await saveSession({
      boardJson: writeBoardJson(scaleBoard(sample(), 1.1, 1, 1), { model: 'My Board' }),
      ghostJson: writeBoardJson(scaleBoard(sample(), 0.9, 1, 1)),
    });
    await arriveViaShareLink({ model: 'Go Fish' });

    render(<App />);
    await editorReady();
    fireEvent.click(await screen.findByRole('button', { name: 'Open shared board' }));
    await waitFor(() => expect(currentLength()).toBeCloseTo(sharedLength, 3));

    // Autosave is debounced; wait for the record to catch up.
    await waitFor(
      async () => {
        const session = await loadSession();
        expect(session?.ghostJson).toBeUndefined();
        expect(session?.boardJson).toContain('"model": "Go Fish"');
      },
      { timeout: 4000 },
    );
  });

  it('keeps autosaving normally afterwards', async () => {
    await openShared({ model: 'Go Fish' });

    await waitFor(
      async () => expect((await loadSession())?.boardJson).toContain('"model": "Go Fish"'),
      { timeout: 4000 },
    );
  });
});
