// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A rails board through the switch, the autosave, a share link and a restore, in the paths that lose or
 * misreport it. Tests marked `it.skip` describe behaviour `App.tsx` does not have yet; each says what
 * change makes it pass.
 *
 * Lives in its own file: the stores are module singletons and these tests need the pristine
 * "no board loaded yet" state `App` sees on a first visit.
 */
import 'fake-indexeddb/auto';
import type { RailsBoard } from '@openshaper/board2';
import { encodeShareText, parseBrd, writeBoardJson } from '@openshaper/io';
import { vec2 } from '@openshaper/kernel';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { resetRailsEngine } from './rails-engine';
import { getRecentBoards } from './recent-boards';
import sampleBrd from './sample-board.brd?raw';
import { clearSession, loadSession, saveSession } from './session-store';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './settings';
import { clearSharedPayload, extractSharedFragment } from './share-bootstrap';
import { activeStore, boardStore, railsStore, sectionStore } from './store';
import swallowDoc from './templates/swallow-shortboard.board?raw';
import { resetSectionEngine } from './use-section-engine';

vi.mock('@openshaper/render3d', () => ({
  Board3DView: () => null,
  isExactAnalysis: () => false,
  sameHull: (a: unknown, b: unknown) => a === b,
}));

type Core = typeof import('./workers/nurbs-core');
let core: Core;
let railsDoc: RailsBoard;
let railsFile: string;

beforeAll(async () => {
  core = await import('./workers/nurbs-core');
  const sections = core.docFromJson(JSON.parse(swallowDoc));
  if (!sections.ok) throw new Error(sections.error);
  const made = core.toRails({ doc: sections.doc });
  if (!made.ok) throw new Error(made.error);
  railsDoc = made.board;
  railsFile = core.railsToText(railsDoc);
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

function openFile(text: string, name = 'board.board'): void {
  const input = document.querySelector('input[type=file]') as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File([text], name, { type: 'application/json' })] },
  });
}

/** Save as the shortcut does, and the text it wrote (the newest entry of Open recent). */
function saveText(): string {
  fireEvent.keyDown(window, { key: 's', ctrlKey: true });
  return getRecentBoards()[0]!.boardJson;
}

/** Turn "Rails engine (experimental)" on or off through Settings. */
function setRailsSwitch(on: boolean): void {
  fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Settings…' }));
  const box = screen.getByLabelText('Rails engine (experimental)') as HTMLInputElement;
  if (box.checked !== on) fireEvent.click(box);
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
}

/** An outline point moved, a deck point moved, and the last undone: two steps, one of them kept. */
function editRails(): RailsBoard {
  const s = railsStore.getState();
  const outline = s.board!.outline.knots;
  const k = Math.floor(outline.length / 2);
  act(() => {
    s.moveControlPoint({ kind: 'outline' }, k, vec2(outline[k]!.end.x, outline[k]!.end.y + 1));
  });
  const kept = railsStore.getState().doc!;
  const deck = railsStore.getState().board!.deck.knots;
  const d = Math.floor(deck.length / 2);
  act(() => {
    railsStore
      .getState()
      .moveControlPoint({ kind: 'deck' }, d, vec2(deck[d]!.end.x, deck[d]!.end.y + 0.5));
  });
  act(() => railsStore.getState().undo());
  expect(railsStore.getState().doc).toBe(kept);
  return kept;
}

const sessionAfterFlush = async () => {
  window.dispatchEvent(new Event('pagehide'));
  // the text may wait for the file code; give the write a moment
  await new Promise((r) => setTimeout(r, 50));
  return loadSession();
};

describe('the rails switch turned off after rails edits', () => {
  it('shows and saves the section document; turning it on again brings the rails board back with its history', async () => {
    saveSettings({ ...DEFAULT_SETTINGS, nurbsEngine: true, surfaceEngine: 'rails' });
    // the Settings dialog links to the docs
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    await editorReady();
    openFile(railsFile);
    await waitFor(() => expect(activeStore.target).toBe(railsStore));
    const edited = editRails();
    const depth = railsStore.getState().past.length;

    setRailsSwitch(false);
    await waitFor(() => expect(activeStore.target).toBe(sectionStore));
    // The section document shown is made from the classic projection of the board as it was opened:
    // the rails edits are not in it.
    const saved = JSON.parse(saveText()) as { model?: string; version?: number };
    expect(saved.model).not.toBe('rails');

    setRailsSwitch(true);
    await waitFor(() => expect(activeStore.target).toBe(railsStore));
    expect(railsStore.getState().doc).toBe(edited);
    expect(railsStore.getState().past.length).toBe(depth);
  }, 60_000);

  // Unskip when the session keeps the rails board while the switch is off: `persistSession` in `App.tsx`
  // writes the rails store's board whenever it holds the open document (`useRailsCurrent`), in a slot
  // of its own (`railsJson` in `session-store.ts`), and the restore picks it by the setting.
  it.skip('the autosave still holds the rails edits, so closing the tab does not lose them', async () => {
    saveSettings({ ...DEFAULT_SETTINGS, nurbsEngine: true, surfaceEngine: 'rails' });
    // the Settings dialog links to the docs
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    await editorReady();
    openFile(railsFile);
    await waitFor(() => expect(activeStore.target).toBe(railsStore));
    const edited = editRails();
    setRailsSwitch(false);
    await waitFor(() => expect(activeStore.target).toBe(sectionStore));
    const session = await sessionAfterFlush();
    const stored = session as { railsJson?: string; sectionsJson?: string } | undefined;
    expect(stored?.railsJson ?? stored?.sectionsJson).toBe(core.railsToText(edited));
  }, 60_000);
});

describe('a rails board that arrives by share link with the engines off', () => {
  // Unskip when the rails notice survives the shared-board notice: `openRails` in `App.tsx` passes the
  // rails line on to `presentSharedBoard` (one toast naming both), instead of a second `showToast` that
  // replaces the first in the single toast slot.
  it.skip('says the engines were turned on', async () => {
    const fragment = await encodeShareText(railsFile);
    window.history.replaceState(null, '', `/app#board=${fragment}`);
    extractSharedFragment();
    render(<App />);
    await editorReady();
    await waitFor(() => expect(activeStore.target).toBe(railsStore));
    expect(await screen.findByText(/rails engines are now on/)).toBeTruthy();
  }, 30_000);

  // Unskip when a rails board that arrives turns the engines on for this visit only: `railsArrived` in
  // `App.tsx` sets a session override (as `?engine=nurbs` does, `nurbs-flag.ts`) instead of calling
  // `handleSaveSettings`.
  it.skip('does not change the saved settings', async () => {
    const fragment = await encodeShareText(railsFile);
    window.history.replaceState(null, '', `/app#board=${fragment}`);
    extractSharedFragment();
    render(<App />);
    await editorReady();
    await waitFor(() => expect(activeStore.target).toBe(railsStore));
    expect(loadSettings()).toMatchObject({ nurbsEngine: false, surfaceEngine: 'sections' });
  }, 30_000);
});

describe('a restored session whose rails board will not read', () => {
  const sessionWith = (sectionsJson: string) =>
    saveSession({ boardJson: writeBoardJson(parseBrd(sampleBrd).board), sectionsJson });

  it('a newer version: the classic board opens, the text is kept unchanged in the session', async () => {
    const newer = railsFile.replace(/"version": \d+/, '"version": 99');
    await sessionWith(newer);
    render(<App />);
    await editorReady();
    expect(railsStore.getState().doc).toBeNull();
    expect(activeStore.target).toBe(boardStore);
    const session = await sessionAfterFlush();
    expect(session?.sectionsJson).toBe(newer);
  }, 30_000);

  // Unskip when a held rails text survives the engines: in `use-section-engine.ts` a held text that
  // `isRailsText` recognises is kept (as an `unavailable` one is) instead of `held = null` and a
  // conversion of the classic board, and `useRailsEngine` does not convert over it either; the restore
  // in `App.tsx` says that the saved rails board could not be read.
  it.skip('a newer version with the engines on: the session still holds the text after the engines run', async () => {
    saveSettings({ ...DEFAULT_SETTINGS, nurbsEngine: true, surfaceEngine: 'rails' });
    const newer = railsFile.replace(/"version": \d+/, '"version": 99');
    await sessionWith(newer);
    render(<App />);
    await editorReady();
    // give the engines time to convert the classic board, as they do now
    await new Promise((r) => setTimeout(r, 3000));
    const session = await sessionAfterFlush();
    expect(session?.sectionsJson).toBe(newer);
  }, 30_000);

  it.skip('a newer version, engines off, the held prompt accepted: the session still holds the text', async () => {
    const newer = railsFile.replace(/"version": \d+/, '"version": 99');
    await sessionWith(newer);
    render(<App />);
    await editorReady();
    fireEvent.click(await screen.findByText(/Turn the NURBS engine on to keep editing it/));
    await new Promise((r) => setTimeout(r, 3000));
    const session = await sessionAfterFlush();
    expect(session?.sectionsJson).toBe(newer);
  }, 30_000);
});
