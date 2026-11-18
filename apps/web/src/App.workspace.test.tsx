// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The workspace in the whole app: with the NURBS and rails switches on and a rails board open, the main area
 * is the design list over the board and the drawing, not the view tabs; with the rails engine off, or on a
 * phone, the tabs and the views are as they always were.
 *
 * Lives in its own file: the stores are module singletons and these tests need the pristine "no board loaded
 * yet" state `App` sees on a first visit.
 */
import 'fake-indexeddb/auto';
import type { RailsBoard } from '@openshaper/board2';
import { parseBrd } from '@openshaper/io';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { setPatchPick } from './patch-look';
import { resetRailsEngine } from './rails-engine';
import sampleBrd from './sample-board.brd?raw';
import { clearSession } from './session-store';
import { DEFAULT_SETTINGS, saveSettings } from './settings';
import { clearSharedPayload } from './share-bootstrap';
import { activeStore, boardStore, railsStore, sectionStore } from './store';
import { setTier } from './test/viewport';
import { resetSectionEngine } from './use-section-engine';
import { DEFAULT_VIEW_STATE, saveViewState } from './view-state';
import { resetWorkspaceStep } from './workspace/use-step';

vi.mock('@openshaper/render3d', () => ({
  Board3DView: () => null,
  isExactAnalysis: () => false,
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
  resetWorkspaceStep();
  act(() => setPatchPick(null));
  // jsdom has no object URLs
  URL.createObjectURL = vi.fn(() => 'blob:test');
  URL.revokeObjectURL = vi.fn();
});

const editorReady = () => screen.findAllByText(/\d+\.\dL/);

function openFile(text: string): void {
  const input = document.querySelector('input[type=file]') as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File([text], 'board.board', { type: 'application/json' })] },
  });
}

/** The app with both switches on and a rails board open. */
async function openRailsBoard() {
  saveSettings({ ...DEFAULT_SETTINGS, nurbsEngine: true, surfaceEngine: 'rails' });
  const view = render(<App />);
  await editorReady();
  openFile(railsFile);
  await waitFor(() => expect(activeStore.target).toBe(railsStore));
  await screen.findByRole('navigation', { name: 'Design steps' });
  return view;
}

const list = () => screen.getByRole('navigation', { name: 'Design steps' });
const entry = (name: string) => within(list()).getByRole('button', { name });
const views = () => screen.queryByRole('group', { name: 'Views' });
const press = (key: string) => fireEvent.keyDown(window, { key });
/** An entry's name: its text, or its label where the column is icons only. */
const nameOf = (b: HTMLElement) => b.getAttribute('aria-label') || b.textContent;
const current = () =>
  within(list())
    .getAllByRole('button')
    .filter((b) => b.getAttribute('aria-current') === 'step')
    .map(nameOf);
/** The sidebar, so a section header is not taken for the list entry of the same name. */
const sidebar = () => within(screen.getByRole('complementary', { name: 'Board panels' }));
const heading = (name: string) => screen.getByRole('heading', { name });
const tab = (name: string) => screen.getByRole('tab', { name });

describe('with the NURBS and rails engines on and a rails board open', () => {
  it('shows the workspace in place of the view tabs', async () => {
    await openRailsBoard();
    expect(views()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Quad' })).toBeNull();
    expect(heading('3D')).toBeTruthy();
    expect(heading('Outline')).toBeTruthy();
    expect(screen.getByRole('separator', { name: /board and the drawing/ })).toBeTruthy();
    // the toolbar keeps what is not a view tab
    expect(screen.getByLabelText('Display units')).toBeTruthy();
  });

  it('is the wide list with the sidebar beside the drawing on a desktop', async () => {
    setTier('desktop');
    await openRailsBoard();
    expect(list().className).toContain('w-[168px]');
    expect(within(list()).getByText('Rocker and foil')).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Board panels' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Board panels' })).toBeNull();
  });

  it('is the icon column with the sidebar in the sheet below lg', async () => {
    await openRailsBoard();
    expect(list().className).toContain('w-14');
    expect(within(list()).queryByText('Rocker and foil')).toBeNull();
    expect(within(list()).getByRole('button', { name: 'Rocker and foil' })).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Board panels' })).toBeTruthy();
  });

  it('starts on the outline, and chooses a step by a click', async () => {
    await openRailsBoard();
    expect(current()).toEqual(['Outline']);
    fireEvent.click(entry('Rocker and foil'));
    expect(current()).toEqual(['Rocker and foil']);
    expect(heading('Rocker and foil')).toBeTruthy();
    fireEvent.click(entry('Tail'));
    expect(heading('Outline: tail')).toBeTruthy();
  });

  it('chooses a step with the number keys 1 to 7, and does nothing with 8 or 0', async () => {
    await openRailsBoard();
    const labels = ['Outline', 'Rocker and foil', 'Deck', 'Bottom', 'Rails', 'Tail', 'Fins'];
    labels.forEach((label, i) => {
      press(String(i + 1));
      expect(current(), `key ${i + 1}`).toEqual([label]);
    });
    press('8');
    press('0');
    expect(current()).toEqual(['Fins']);
  });

  it('does not take the number keys for views: no key changes a view, and none brings the tabs back', async () => {
    await openRailsBoard();
    press('6'); // Split in the tabbed layout; Tail here
    expect(views()).toBeNull();
    expect(current()).toEqual(['Tail']);
    press('5'); // 3D in the tabbed layout; Rails here
    expect(heading('3D')).toBeTruthy();
    expect(current()).toEqual(['Rails']);
  });

  it('leaves the keys alone while a text field has focus', async () => {
    await openRailsBoard();
    const field = screen.getByLabelText('Display units');
    field.focus();
    fireEvent.keyDown(field, { key: '3' });
    // a select is not a text field: the key still reaches the workspace
    expect(current()).toEqual(['Deck']);
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: '4' });
    expect(current()).toEqual(['Deck']);
    input.remove();
  });

  it('remembers the step in its own key and not in the view state', async () => {
    await openRailsBoard();
    fireEvent.click(entry('Bottom'));
    expect(JSON.parse(localStorage.getItem('bs.workspaceStep')!)).toBe('bottom');
    // the view state holds what it always held: nothing about the step, the divider or the look default
    await new Promise((r) => setTimeout(r, 700));
    const keys = Object.keys(JSON.parse(localStorage.getItem('bs.viewState')!));
    for (const k of keys) {
      expect([
        'version',
        'view',
        'views2d',
        'camera3d',
        'view3d',
        'split',
        'sidebar',
        'railsCurve',
      ]).toContain(k);
    }
  });

  it('opens on the step the last visit ended on', async () => {
    localStorage.setItem('bs.workspaceStep', JSON.stringify('rails'));
    resetWorkspaceStep();
    await openRailsBoard();
    expect(current()).toEqual(['Rails']);
  });
});

describe('the drawing', () => {
  it('has no Deck | Bottom control: the step decides, and the saved choice is not written', async () => {
    saveViewState({ ...DEFAULT_VIEW_STATE, railsCurve: 'bottom' });
    await openRailsBoard();
    for (const step of ['Deck', 'Bottom', 'Rails']) {
      fireEvent.click(entry(step));
      expect(screen.queryByRole('group', { name: 'Curve to edit' }), step).toBeNull();
    }
    expect(heading('Cross-section: rails')).toBeTruthy();
    fireEvent.click(entry('Deck'));
    expect(heading('Cross-section: deck')).toBeTruthy();
    fireEvent.click(entry('Bottom'));
    expect(heading('Cross-section: bottom')).toBeTruthy();
    // the view state is saved after a pause; what it holds is still the person's choice
    await new Promise((r) => setTimeout(r, 700));
    expect(JSON.parse(localStorage.getItem('bs.viewState')!).railsCurve).toBe('bottom');
  });

  it('keeps the station controls of the cross-section pane: stepping, add and remove', async () => {
    await openRailsBoard();
    fireEvent.click(entry('Deck'));
    expect(screen.getByRole('button', { name: 'Next cross-section' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Previous cross-section' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add cross-section' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete cross-section' })).toBeTruthy();
  });

  it('shows the rail keys read-only under the Rails drawing, and under no other', async () => {
    await openRailsBoard();
    expect(screen.queryByRole('region', { name: 'Rail keys' })).toBeNull();
    fireEvent.click(entry('Rails'));
    const keys = screen.getByRole('region', { name: 'Rail keys' });
    expect(within(keys).getAllByRole('table').length).toBeGreaterThan(0);
    expect(within(keys).getAllByRole('row').length).toBeGreaterThan(2);
    fireEvent.click(entry('Deck'));
    expect(screen.queryByRole('region', { name: 'Rail keys' })).toBeNull();
  });

  it('draws the outline for Outline, Tail and Fins and the rocker for Rocker and foil', async () => {
    await openRailsBoard();
    for (const [step, title] of [
      ['Outline', 'Outline'],
      ['Rocker and foil', 'Rocker and foil'],
      ['Tail', 'Outline: tail'],
      ['Fins', 'Outline: fins'],
    ] as const) {
      fireEvent.click(entry(step));
      expect(heading(title), step).toBeTruthy();
    }
  });
});

describe('the sidebar follows the step', () => {
  it('shows the Shape tab with Board shape open for Tail', async () => {
    setTier('desktop');
    await openRailsBoard();
    fireEvent.click(entry('Tail'));
    expect(tab('Shape').getAttribute('aria-selected')).toBe('true');
    expect(
      sidebar().getByRole('button', { name: 'Board shape' }).getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('shows the Build tab with the fins open for Fins, and shuts them again for Outline', async () => {
    setTier('desktop');
    await openRailsBoard();
    fireEvent.click(entry('Fins'));
    expect(tab('Build').getAttribute('aria-selected')).toBe('true');
    expect(sidebar().getByRole('button', { name: 'Fins' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
    fireEvent.click(entry('Outline'));
    expect(sidebar().getByRole('button', { name: 'Fins' }).getAttribute('aria-expanded')).toBe(
      'false',
    );
  });

  it('shows the Shape tab with the bottom features open for Bottom', async () => {
    setTier('desktop');
    await openRailsBoard();
    fireEvent.click(entry('Bottom'));
    expect(tab('Shape').getAttribute('aria-selected')).toBe('true');
    expect(
      sidebar().getByRole('button', { name: 'Bottom features' }).getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('shows the tab of Specs, Build and Compare when they are chosen, and marks the list', async () => {
    setTier('desktop');
    await openRailsBoard();
    fireEvent.click(entry('Build'));
    expect(tab('Build').getAttribute('aria-selected')).toBe('true');
    expect(entry('Build').getAttribute('aria-current')).toBe('true');
    fireEvent.click(entry('Compare'));
    expect(tab('Reference').getAttribute('aria-selected')).toBe('true');
    expect(entry('Compare').getAttribute('aria-current')).toBe('true');
    fireEvent.click(entry('Specs'));
    expect(tab('Specs').getAttribute('aria-selected')).toBe('true');
    // the design step is still the step
    expect(current()).toEqual(['Outline']);
  });

  it('raises the sheet below lg when a panel entry is chosen, and not for a design step', async () => {
    await openRailsBoard();
    expect(screen.getByRole('button', { name: 'Show board panels' })).toBeTruthy();
    fireEvent.click(entry('Tail'));
    expect(screen.getByRole('button', { name: 'Show board panels' })).toBeTruthy();
    fireEvent.click(entry('Specs'));
    expect(screen.getByRole('button', { name: 'Hide board panels' })).toBeTruthy();
  });
});

describe('the Patches look', () => {
  const analysis = () => (screen.getByTitle(/^Surface analysis/) as HTMLSelectElement).value;

  it('is the board’s look the first time the workspace is entered with No analysis', async () => {
    await openRailsBoard();
    expect(analysis()).toBe('patches');
    expect(JSON.parse(localStorage.getItem('bs.workspacePatches')!)).toBe(true);
  });

  it('is never put back once it has been applied: a later choice of No analysis stands', async () => {
    localStorage.setItem('bs.workspacePatches', 'true');
    await openRailsBoard();
    expect(analysis()).toBe('none');
  });

  it('leaves a look that was chosen before the first entry, and still counts as the first entry', async () => {
    saveViewState({
      ...DEFAULT_VIEW_STATE,
      view3d: { ...DEFAULT_VIEW_STATE.view3d!, analysis: 'zebra' },
    } as typeof DEFAULT_VIEW_STATE);
    await openRailsBoard();
    expect(analysis()).toBe('zebra');
    expect(JSON.parse(localStorage.getItem('bs.workspacePatches')!)).toBe(true);
  });

  it('lets a person choose another look, which stays', async () => {
    await openRailsBoard();
    fireEvent.change(screen.getByTitle(/^Surface analysis/), { target: { value: 'slope' } });
    expect(analysis()).toBe('slope');
    fireEvent.click(entry('Deck'));
    expect(analysis()).toBe('slope');
  });
});

describe('a tap on the board', () => {
  it('chooses the step the patch belongs to', async () => {
    await openRailsBoard();
    act(() => setPatchPick({ patch: 'bottom', side: 'plus', x: 40, y: 3 }));
    expect(current()).toEqual(['Bottom']);
    act(() => setPatchPick({ patch: 'rail', side: 'minus', x: 40, y: -9, zone: 0 }));
    expect(current()).toEqual(['Rails']);
    act(() => setPatchPick({ patch: 'tailEdge', side: 'plus', x: 2, y: 3 }));
    expect(current()).toEqual(['Tail']);
    act(() => setPatchPick({ patch: 'deck', side: 'plus', x: 60, y: 3 }));
    expect(current()).toEqual(['Deck']);
  });

  it('chooses Tail for a corner in the tail half and Outline for one in the nose half', async () => {
    await openRailsBoard();
    const length = activeStore.getState().board!.outline.knots.at(-1)!.end.x;
    act(() => setPatchPick({ patch: 'corner', side: 'plus', x: length * 0.1, y: 3 }));
    expect(current()).toEqual(['Tail']);
    act(() => setPatchPick({ patch: 'corner', side: 'plus', x: length * 0.9, y: 1 }));
    expect(current()).toEqual(['Outline']);
  });

  it('changes no step for a tap on nothing', async () => {
    await openRailsBoard();
    act(() => setPatchPick({ patch: 'deck', side: 'plus', x: 60, y: 3 }));
    act(() => setPatchPick(null));
    expect(current()).toEqual(['Deck']);
  });
});

describe('with the rails engine off', () => {
  it('shows the view tabs and no design list, and the number keys choose views', async () => {
    saveSettings({ ...DEFAULT_SETTINGS, nurbsEngine: true, surfaceEngine: 'sections' });
    setTier('desktop');
    render(<App />);
    await editorReady();
    expect(
      within(screen.getByRole('group', { name: 'Views' }))
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Quad', 'Outline', 'Rocker', 'Cross-section', '3D', 'Split']);
    expect(screen.queryByRole('navigation', { name: 'Design steps' })).toBeNull();
    expect(screen.queryByRole('separator', { name: /board and the drawing/ })).toBeNull();
    press('3');
    expect(heading('Rocker (deck + bottom)')).toBeTruthy();
    press('7'); // a design step key: not a view key
    expect(heading('Rocker (deck + bottom)')).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Design steps' })).toBeNull();
  });

  it('shows the classic layout with the engines off altogether', async () => {
    render(<App />);
    await editorReady();
    expect(screen.getByRole('group', { name: 'Views' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Design steps' })).toBeNull();
  });
});

describe('on a phone', () => {
  it('keeps the view tabs, the views and the sheet for a rails board', async () => {
    setTier('phone');
    saveSettings({ ...DEFAULT_SETTINGS, nurbsEngine: true, surfaceEngine: 'rails' });
    render(<App />);
    await editorReady();
    openFile(railsFile);
    await waitFor(() => expect(activeStore.target).toBe(railsStore));
    expect(screen.getByRole('group', { name: 'Views' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Design steps' })).toBeNull();
    press('3');
    expect(heading('Rocker (deck + bottom)')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Board panels' })).toBeTruthy();
  });

  it('gets the workspace back, on the step it had, when the window grows', async () => {
    await openRailsBoard();
    fireEvent.click(entry('Rails'));
    act(() => setTier('phone'));
    expect(screen.queryByRole('navigation', { name: 'Design steps' })).toBeNull();
    expect(screen.getByRole('group', { name: 'Views' })).toBeTruthy();
    act(() => setTier('tablet'));
    expect(views()).toBeNull();
    expect(current()).toEqual(['Rails']);
  });
});
