// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Rails boards in files, sessions and share links (rails-engine.ts, rails-files.ts): a saved rails board
 * opens whole and turns the engines on with one line saying so; Save writes it back, edits included; the
 * autosave stores it and a restored session brings it back; a share link carries it both ways; a sections
 * file opened with the rails switch on arrives converted.
 *
 * Lives in its own file: the stores are module singletons and these tests need the pristine
 * "no board loaded yet" state `App` sees on a first visit.
 */
import 'fake-indexeddb/auto';
import type { RailsBoard } from '@openshaper/board2';
import { decodeShareFile, encodeShareText, parseBrd } from '@openshaper/io';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { resetRailsEngine } from './rails-engine';
import { getRecentBoards } from './recent-boards';
import sampleBrd from './sample-board.brd?raw';
import { clearSession, loadSession, saveSession } from './session-store';
import { ShareDialog } from './ShareDialog';
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from './settings';
import { clearSharedPayload, extractSharedFragment } from './share-bootstrap';
import { activeStore, boardStore, railsStore, sectionStore } from './store';
import swallowDoc from './templates/swallow-shortboard.board?raw';
import { resetSectionEngine } from './use-section-engine';

vi.mock('@openshaper/render3d', () => ({
  Board3DView: () => null,
  isExactAnalysis: () => false,
}));

type Core = typeof import('./workers/nurbs-core');
let core: Core;
/** A rails board and its saved text (the swallow template, converted). */
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
  // jsdom has no object URLs; the download itself is not what is under test (its text is in Recent).
  URL.createObjectURL = vi.fn(() => 'blob:test');
  URL.revokeObjectURL = vi.fn();
});

const editorReady = () => screen.findAllByText(/\d+\.\dL/);

/** Pick a file in the editor's Open input. */
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

const railsTextOf = (doc: RailsBoard): string => core.railsToText(doc);

describe('a rails board opened', () => {
  it('turns the NURBS and rails engines on, says so, and is the document the editors edit', async () => {
    render(<App />);
    await editorReady();
    expect(loadSettings().surfaceEngine).toBe('sections');

    openFile(railsFile);
    await waitFor(() => expect(railsStore.getState().doc).not.toBeNull());
    expect(railsTextOf(railsStore.getState().doc!)).toBe(railsFile);
    expect(
      await screen.findByText(/rails board, so the NURBS and rails engines are now on/),
    ).toBeTruthy();
    expect(loadSettings()).toMatchObject({ nurbsEngine: true, surfaceEngine: 'rails' });
    await waitFor(() => expect(activeStore.target).toBe(railsStore));
    // no section document was made for it
    expect(sectionStore.getState().doc).toBeNull();
  });

  it('says nothing when the engines were on already', async () => {
    saveSettings({ ...DEFAULT_SETTINGS, nurbsEngine: true, surfaceEngine: 'rails' });
    render(<App />);
    await editorReady();
    openFile(railsFile);
    await waitFor(() => expect(railsStore.getState().doc).not.toBeNull());
    await waitFor(() => expect(activeStore.target).toBe(railsStore));
    expect(screen.queryByText(/rails board, so the NURBS/)).toBeNull();
  }, 30_000);
});

describe('save and reopen', () => {
  it('Save writes the rails board’s text, and reopening it gives the same board', async () => {
    render(<App />);
    await editorReady();
    openFile(railsFile);
    await waitFor(() => expect(activeStore.target).toBe(railsStore));
    // an edit: a station added
    act(() => {
      railsStore.getState().addCrossSection(80);
    });
    const edited = railsStore.getState().doc!;
    expect(edited.stations.length).toBe(railsDoc.stations.length + 1);

    const saved = saveText();
    expect(JSON.parse(saved)).toMatchObject({ model: 'rails' });
    expect(saved).toContain('"name": "Swallow shortboard"');

    // reopen: the same board
    act(() => {
      railsStore.getState().loadDoc(railsDoc);
    });
    openFile(saved);
    await waitFor(() => expect(railsTextOf(railsStore.getState().doc!)).toBe(saved));
    expect(saveText()).toBe(saved);
  }, 30_000);

  it('Open recent reads it back', async () => {
    render(<App />);
    await editorReady();
    openFile(railsFile);
    await waitFor(() => expect(activeStore.target).toBe(railsStore));
    act(() => {
      railsStore.getState().addCrossSection(80);
    });
    const saved = saveText();
    act(() => {
      railsStore.getState().loadDoc(railsDoc);
    });
    // the Recent entry is the board file's text: a menu pick opens it through the same reader
    const { readBoardText } = await import('@openshaper/io');
    const file = readBoardText(saved);
    expect(file.kind).toBe('sections');
  });
});

describe('a session', () => {
  it('stores the rails board while the rails store is edited, and restores it', async () => {
    saveSettings({ ...DEFAULT_SETTINGS, nurbsEngine: true, surfaceEngine: 'rails' });
    const first = render(<App />);
    await editorReady();
    openFile(railsFile);
    await waitFor(() => expect(activeStore.target).toBe(railsStore));
    act(() => {
      railsStore.getState().addCrossSection(80);
    });
    const edited = railsStore.getState().doc!;
    // the autosave is debounced and flushed when the page is hidden
    await waitFor(() => expect(core).toBeDefined());
    window.dispatchEvent(new Event('pagehide'));
    await waitFor(async () => {
      const session = await loadSession();
      expect(session?.sectionsJson).toBeDefined();
      expect(JSON.parse(session!.sectionsJson!)).toMatchObject({ model: 'rails' });
    });
    const session = (await loadSession())!;
    expect(session.sectionsJson).toBe(railsTextOf(edited));
    first.unmount();

    // another visit
    sectionStore.setState({ doc: null, board: null });
    railsStore.setState({ doc: null, board: null, slices: null });
    resetRailsEngine();
    resetSectionEngine();
    activeStore.use(boardStore);
    boardStore.getState().load(parseBrd(sampleBrd).board);
    boardStore.setState({ board: null, past: [], future: [] });
    render(<App />);
    await editorReady();
    await waitFor(() => expect(railsStore.getState().doc).not.toBeNull());
    expect(railsTextOf(railsStore.getState().doc!)).toBe(session.sectionsJson);
    await waitFor(() => expect(activeStore.target).toBe(railsStore));
  }, 40_000);

  it('a session restored with the engines off turns them on, and says so', async () => {
    await saveSession({
      boardJson: (await import('@openshaper/io')).writeBoardJson(parseBrd(sampleBrd).board),
      sectionsJson: railsFile,
    });
    render(<App />);
    await editorReady();
    await waitFor(() => expect(railsStore.getState().doc).not.toBeNull());
    expect(railsTextOf(railsStore.getState().doc!)).toBe(railsFile);
    expect(
      await screen.findByText(/rails board, so the NURBS and rails engines are now on/),
    ).toBeTruthy();
    expect(loadSettings()).toMatchObject({ nurbsEngine: true, surfaceEngine: 'rails' });
  }, 30_000);
});

describe('a share link', () => {
  it('opens a rails board straight into the rails store', async () => {
    const fragment = await encodeShareText(railsFile);
    window.history.replaceState(null, '', `/app#board=${fragment}`);
    extractSharedFragment();
    render(<App />);
    await editorReady();
    await waitFor(() => expect(railsStore.getState().doc).not.toBeNull());
    expect(railsTextOf(railsStore.getState().doc!)).toBe(railsFile);
    expect(loadSettings().surfaceEngine).toBe('rails');
  }, 30_000);

  it('the Share dialog makes a link that carries the rails board', async () => {
    const copied = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: copied },
      configurable: true,
      writable: true,
    });
    render(
      <ShareDialog
        board={parseBrd(sampleBrd).board}
        sections={railsDoc}
        meta={{ model: 'Swallow shortboard' }}
        setMeta={() => {}}
        onCopied={() => {}}
        onDownloadBoard={() => {}}
        onClose={() => {}}
      />,
    );
    await screen.findByText(/Link size:/);
    fireEvent.click(screen.getByRole('button', { name: /copy link/i }));
    await waitFor(() => expect(copied).toHaveBeenCalled());
    const url = copied.mock.calls[0]![0] as string;
    const file = await decodeShareFile(url.slice(url.indexOf('#board=') + '#board='.length));
    expect(file.kind).toBe('sections');
    if (file.kind === 'sections') expect(file.json).toEqual(JSON.parse(railsTextOf(railsDoc)));
  }, 30_000);
});

describe('a sections file with the rails switch on', () => {
  it('arrives converted into the rails store', async () => {
    saveSettings({ ...DEFAULT_SETTINGS, nurbsEngine: true, surfaceEngine: 'rails' });
    render(<App />);
    await editorReady();
    await waitFor(() => expect(activeStore.target).toBe(railsStore));
    const first = railsStore.getState().doc!;
    openFile(swallowDoc, 'swallow.board');
    await waitFor(() => expect(railsStore.getState().doc).not.toBe(first));
    await waitFor(() => expect(activeStore.target).toBe(railsStore));
    const doc = railsStore.getState().doc!;
    expect(doc.model).toBe('rails');
    expect(doc.meta.name).toBe('Swallow shortboard');
    // the sections document it was made from is still in the section store
    expect(sectionStore.getState().doc!.meta.name).toBe('Swallow shortboard');
  }, 40_000);
});
