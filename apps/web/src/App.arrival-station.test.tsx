// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The station a board opens on, whichever way it arrives (`arrival-station.ts`): with the rails engine on,
 * the one nearest the middle of the board, not the tail's first station the shell had. The classic layout
 * with a classic board keeps what it had.
 *
 * The station is read from the controls of the cross-section pane ("3/5"), which the workspace shows under
 * its Deck step. Every test first moves the station to the tail's first, so that a board which only kept
 * the station it was given would show it.
 *
 * Lives in its own file: the stores are module singletons and these tests need the pristine "no board
 * loaded yet" state `App` sees on a first visit.
 */
import 'fake-indexeddb/auto';
import type { RailsBoard } from '@openshaper/board2';
import {
  encodeShareFragment,
  encodeShareText,
  parseBrd,
  readBoardJson,
  writeBoardJson,
} from '@openshaper/io';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { resetRailsEngine } from './rails-engine';
import { recordRecentBoard } from './recent-boards';
import sampleBrd from './sample-board.brd?raw';
import { nearestMidpointSection } from './section-index';
import { clearSession, saveSession } from './session-store';
import { DEFAULT_SETTINGS, saveSettings } from './settings';
import { clearSharedPayload, extractSharedFragment } from './share-bootstrap';
import { activeStore, boardStore, railsStore, sectionStore } from './store';
import { resetSectionEngine } from './use-section-engine';

vi.mock('@openshaper/render3d', () => ({
  Board3DView: () => null,
  isExactAnalysis: () => false,
  sameHull: (a: unknown, b: unknown) => a === b,
}));

type Core = typeof import('./workers/nurbs-core');
let railsFile: string;

beforeAll(async () => {
  const core: Core = await import('./workers/nurbs-core');
  const made = core.toRails({ classic: parseBrd(sampleBrd).board });
  if (!made.ok) throw new Error(made.error);
  railsFile = core.railsToText(made.board as RailsBoard);
}, 60_000);

beforeEach(async () => {
  localStorage.clear();
  await clearSession();
  clearSharedPayload();
  window.history.replaceState(null, '', '/app');
  boardStore.getState().load(parseBrd(sampleBrd).board);
  boardStore.setState({ board: null, past: [], future: [] });
  resetSectionEngine();
  resetRailsEngine();
  sectionStore.setState({ doc: null, board: null });
  railsStore.setState({ doc: null, board: null, slices: null });
  activeStore.use(boardStore);
  URL.createObjectURL = vi.fn(() => 'blob:test');
  URL.revokeObjectURL = vi.fn();
});

const editorReady = () => screen.findAllByText(/\d+\.\dL/);
const enginesOn = () =>
  saveSettings({ ...DEFAULT_SETTINGS, nurbsEngine: true, surfaceEngine: 'rails' });

function openFile(text: string, name = 'board.board'): void {
  const input = document.querySelector('input[type=file]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File([text], name)] } });
}

const fileButton = () => screen.getByRole('menuitem', { name: 'File' });
const fileItem = (name: string) => {
  fireEvent.click(fileButton());
  fireEvent.click(screen.getByRole('menuitem', { name }));
};

/** The station strip of the workspace's Deck step, when it is showing. */
const strip = () => screen.queryByRole('toolbar', { name: 'Stations along the board' });

/**
 * The station that is chosen, and how many there are: the Deck step's strip says "Station 3 of 5" and the
 * classic layout's cross-section controls "3/5".
 */
function station(): { at: number; of: number } {
  const region = screen.queryByRole('region', { name: 'Stations' });
  if (region !== null) {
    const found = /Station (\d+) of (\d+)/.exec(region.textContent ?? '')!;
    return { at: Number(found[1]), of: Number(found[2]) };
  }
  const [at, of] = screen
    .getByText(/^\d+\/\d+$/)
    .textContent!.split('/')
    .map(Number);
  return { at: at!, of: of! };
}
/** The next station, by the strip's own tick or the classic controls' button. */
function next(): void {
  const lane = strip();
  if (lane !== null) {
    fireEvent.click(within(lane).getAllByRole('button', { name: /^Station \d/ })[station().at]!);
  } else {
    fireEvent.click(screen.getByRole('button', { name: 'Next cross-section' }));
  }
}
/** The tail's first station, by the strip's first tick or the classic controls' button. */
function moveToFirst(): void {
  const lane = strip();
  if (lane !== null) {
    fireEvent.click(within(lane).getAllByRole('button', { name: /^Station \d/ })[0]!);
  } else {
    const previous = screen.getByRole('button', { name: 'Previous cross-section' });
    while (!(previous as HTMLButtonElement).disabled) fireEvent.click(previous);
  }
  expect(station().at).toBe(1);
}
/** The workspace is showing, open on the Deck step, which has the station strip. */
async function onDeckStep(): Promise<void> {
  await waitFor(() => expect(activeStore.target).toBe(railsStore), { timeout: 30_000 });
  const list = await screen.findByRole('navigation', { name: 'Design steps' });
  fireEvent.click(within(list).getByRole('button', { name: 'Deck' }));
}
/** The middle station of the rails board that is open, which is not the first. */
const middle = (): number => {
  const board = railsStore.getState().board!;
  const index = nearestMidpointSection(board);
  expect(index).toBeGreaterThan(1);
  return index;
};
const expectMiddle = (): void =>
  expect(station()).toEqual({
    at: middle(),
    of: railsStore.getState().board!.crossSections.length - 2,
  });

/** The app with both engines on and the sample board converted into the rails board, on the first station. */
async function appOnFirstStation(): Promise<void> {
  enginesOn();
  render(<App />);
  await editorReady();
  await onDeckStep();
  moveToFirst();
}

describe('a rails board that arrives opens on the station nearest its middle', () => {
  it('a file', async () => {
    await appOnFirstStation();
    openFile(railsFile);
    await waitFor(() => expectMiddle());
  }, 60_000);

  it('a file, with the engines off: it turns them on and opens on its middle', async () => {
    render(<App />);
    await editorReady();
    expect(activeStore.target).toBe(boardStore);
    openFile(railsFile);
    await onDeckStep();
    await waitFor(() => expectMiddle());
  }, 60_000);

  it('a template, converted into the rails board a moment after the classic board loads', async () => {
    await appOnFirstStation();
    fileItem('Funboard');
    await waitFor(() => expectMiddle(), { timeout: 30_000 });
  }, 60_000);

  it('a board made in the New board gallery', async () => {
    await appOnFirstStation();
    fileItem('New board…');
    const dialog = await screen.findByRole('dialog', { name: 'New board' }, { timeout: 20_000 });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Swallow shortboard' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create board' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New board' })).toBeNull(), {
      timeout: 20_000,
    });
    await waitFor(() => expectMiddle());
  }, 60_000);

  it('a recent board', async () => {
    enginesOn();
    recordRecentBoard('My rails board', railsFile);
    render(<App />);
    await editorReady();
    await onDeckStep();
    moveToFirst();
    fireEvent.click(fileButton());
    fireEvent.click(screen.getByText('My rails board'));
    await waitFor(() => expectMiddle());
  }, 60_000);

  it('a restored session', async () => {
    enginesOn();
    await saveSession({
      boardJson: writeBoardJson(parseBrd(sampleBrd).board),
      sectionsJson: railsFile,
    });
    render(<App />);
    await editorReady();
    await onDeckStep();
    await waitFor(() => expectMiddle());
  }, 60_000);

  it('a share link', async () => {
    // the engines are off: the link turns them on, and the board opens on its middle all the same
    window.history.replaceState(null, '', `/app#board=${await encodeShareText(railsFile)}`);
    extractSharedFragment();
    render(<App />);
    await editorReady();
    await onDeckStep();
    await waitFor(() => expectMiddle());
  }, 60_000);

  it('a classic board already open, when both engines are turned on in Settings', async () => {
    // the classic board is open, with the person on the station they chose there
    // (the Settings dialog links to the docs)
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    await editorReady();
    expect(activeStore.target).toBe(boardStore);
    fireEvent.click(screen.getByRole('button', { name: 'Next cross-section' }));
    expect(station().at).toBe(2);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Settings…' }));
    for (const label of ['Engine: NURBS (experimental)', 'Rails engine (experimental)']) {
      const box = screen.getByLabelText(label) as HTMLInputElement;
      if (!box.checked) fireEvent.click(box);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await onDeckStep();
    await waitFor(() => expectMiddle());
  }, 60_000);

  it('keeps the station the person chose when the engine is turned off and on again for the same board', async () => {
    await appOnFirstStation();
    next();
    expect(station().at).toBe(2);
    // off and on again: the same board, so the same station
    act(() => activeStore.use(boardStore));
    act(() => activeStore.use(railsStore));
    await onDeckStep();
    expect(station().at).toBe(2);
  }, 60_000);
});

describe('the classic layout with a classic board', () => {
  it('keeps the station it had when a board is opened', async () => {
    render(<App />);
    await editorReady();
    // the sample opens on the first station; the person steps to the third
    expect(station().at).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Next cross-section' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next cross-section' }));
    expect(station().at).toBe(3);
    openFile(sampleBrd, 'sample.brd');
    await waitFor(() => expect(boardStore.getState().past).toHaveLength(0));
    expect(station().at).toBe(3);
    expect(activeStore.target).toBe(boardStore);
  }, 30_000);

  it('still opens a shared board on its middle station', async () => {
    const board = readBoardJson(writeBoardJson(parseBrd(sampleBrd).board)).board;
    window.history.replaceState(null, '', `/app#board=${await encodeShareFragment(board)}`);
    extractSharedFragment();
    render(<App />);
    await editorReady();
    expect(activeStore.target).toBe(boardStore);
    expect(station().at).toBe(nearestMidpointSection(boardStore.getState().board!));
    expect(station().at).toBeGreaterThan(1);
  }, 30_000);
});
