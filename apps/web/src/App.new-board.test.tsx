// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * File > New board… (NewBoardDialog.tsx): with the NURBS and rails engines on, the File menu opens the gallery
 * above the five named boards, and a board made there arrives as a template does: it replaces the open one as
 * the rails document, with an empty undo history, at the size asked for. With the engines off the File menu is
 * what it was.
 *
 * Lives in its own file: the stores are module singletons and these tests need the pristine "no board loaded
 * yet" state `App` sees on a first visit.
 */
import 'fake-indexeddb/auto';
import { parseBrd } from '@openshaper/io';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { track } from './analytics';
import { measureRails } from './board-sizing';
import { resetRailsEngine } from './rails-engine';
import { getRecentBoards } from './recent-boards';
import sampleBrd from './sample-board.brd?raw';
import { clearSession } from './session-store';
import { DEFAULT_SETTINGS, saveSettings } from './settings';
import { clearSharedPayload } from './share-bootstrap';
import { activeStore, boardStore, railsStore, sectionStore } from './store';
import { resetSectionEngine } from './use-section-engine';

vi.mock('@openshaper/render3d', () => ({
  Board3DView: () => null,
  isExactAnalysis: () => false,
}));
vi.mock('./analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./analytics')>()),
  track: vi.fn(),
}));

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
  vi.mocked(track).mockClear();
  URL.createObjectURL = vi.fn(() => 'blob:test');
  URL.revokeObjectURL = vi.fn();
});

const editorReady = () => screen.findAllByText(/\d+\.\dL/);
const engines = (on: boolean) =>
  saveSettings({
    ...DEFAULT_SETTINGS,
    nurbsEngine: on,
    surfaceEngine: on ? 'rails' : 'sections',
  });

/** The File menu button, and the names of what the menu lists, in order. */
const fileButton = () => screen.getByRole('menuitem', { name: 'File' });
function fileItems(): string[] {
  fireEvent.click(fileButton());
  const menu = screen.getByRole('menu');
  const names = within(menu)
    .getAllByRole('menuitem')
    .map((i) => i.querySelector('.flex-1')?.textContent ?? '');
  fireEvent.click(fileButton());
  return names;
}

describe('the File menu', () => {
  it('lists New board… above the five named boards, with both engines on', async () => {
    engines(true);
    render(<App />);
    await editorReady();
    expect(fileItems().slice(0, 7)).toEqual([
      'New board…',
      'Shortboard',
      'Funboard',
      'Longboard',
      'Swallow shortboard',
      'Fish shortboard',
      'Open…',
    ]);
  });

  it('is what it was with the engines off: the three classic boards, no gallery', async () => {
    engines(false);
    render(<App />);
    await editorReady();
    expect(fileItems().slice(0, 4)).toEqual(['Shortboard', 'Funboard', 'Longboard', 'Open…']);
    expect(fileItems()).not.toContain('New board…');
  });

  it('has no gallery with only the NURBS engine on', async () => {
    saveSettings({ ...DEFAULT_SETTINGS, nurbsEngine: true, surfaceEngine: 'sections' });
    render(<App />);
    await editorReady();
    expect(fileItems()).not.toContain('New board…');
    expect(fileItems()).toContain('Fish shortboard');
  });
});

describe('the gallery', () => {
  async function openGallery() {
    fireEvent.click(fileButton());
    fireEvent.click(screen.getByRole('menuitem', { name: 'New board…' }));
    return screen.findByRole('dialog', { name: 'New board' }, { timeout: 20_000 });
  }

  it('makes a board at the size asked for, as the document, in place of the one that is open', async () => {
    engines(true);
    render(<App />);
    await editorReady();

    // a rails board with an edit to undo
    fireEvent.click(fileButton());
    fireEvent.click(screen.getByRole('menuitem', { name: 'Funboard' }));
    await waitFor(() => expect(railsStore.getState().doc).not.toBeNull(), { timeout: 30_000 });
    act(() => railsStore.getState().scaleBoard(1.1, 1, 1));
    expect(railsStore.getState().past).toHaveLength(1);
    const before = railsStore.getState().doc!;
    vi.mocked(track).mockClear();

    const dialog = await openGallery();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Swallow shortboard' }));
    const typeInto = (name: string, text: string) => {
      const input = within(dialog).getByRole('textbox', { name });
      fireEvent.change(input, { target: { value: text } });
      fireEvent.blur(input);
    };
    typeInto('Length', '1750');
    typeInto('Width', '470');
    typeInto('Thickness', '60');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create board' }));

    // the dialog closes and the board is open
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New board' })).toBeNull(), {
      timeout: 30_000,
    });
    const doc = railsStore.getState().doc!;
    expect(doc).not.toBe(before);
    expect(doc.meta.name).toBe('Swallow shortboard');
    const size = measureRails(doc);
    expect(size.length).toBeCloseTo(175, 2);
    expect(size.width).toBeCloseTo(47, 2);
    expect(size.thickness).toBeCloseTo(6, 2);
    // an empty undo history, and the classic store (the old views, the specs) holds the board too
    expect(railsStore.getState().past).toHaveLength(0);
    expect(railsStore.getState().future).toHaveLength(0);
    expect(boardStore.getState().past).toHaveLength(0);
    expect(activeStore.target).toBe(railsStore);
    // it arrived as a template does: its name is in the recent boards, and the arrival was counted once
    // by the template's name alone, with nothing about its size
    await waitFor(() => expect(getRecentBoards()[0]?.name).toBe('Swallow shortboard'));
    expect(vi.mocked(track).mock.calls.filter(([e]) => e === 'template_loaded')).toEqual([
      ['template_loaded', { template: 'Swallow shortboard' }],
    ]);
  }, 90_000);

  it('opens the template itself when the size is not changed', async () => {
    engines(true);
    render(<App />);
    await editorReady();
    const dialog = await openGallery();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Longboard' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create board' }));
    await waitFor(() => expect(railsStore.getState().doc?.meta.name).toBe('Longboard'), {
      timeout: 30_000,
    });
    const size = measureRails(railsStore.getState().doc!);
    expect(size.length).toBeCloseTo(274.32, 3);
    expect(size.thickness).toBeCloseTo(7.5594, 3);
  }, 60_000);

  it('closes on Escape and hands the focus back to the File menu button', async () => {
    engines(true);
    render(<App />);
    await editorReady();
    // the sample board, made the rails document
    await waitFor(() => expect(railsStore.getState().doc).not.toBeNull(), { timeout: 30_000 });
    const before = railsStore.getState().doc;
    const dialog = await openGallery();
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement ?? window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New board' })).toBeNull());
    expect(document.activeElement).toBe(fileButton());
    // nothing was opened
    expect(railsStore.getState().doc).toBe(before);
  }, 60_000);
});
