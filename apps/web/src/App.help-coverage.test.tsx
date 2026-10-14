// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The find-it test: every menu command has help, and the help reaches the user.
 *
 * Same spirit as `docs/coverage.test.ts`: it asserts against what the app itself
 * renders, not a list someone has to remember to update. Add an item to the File,
 * Edit, View, Board, Export or Help menu without a `help-text.ts` entry and this
 * fails, naming the item — so a new command cannot ship that the palette can only
 * find by its exact label, with nothing to say about what it does.
 *
 * The menus are read off the rendered menubar, with the conditional items brought
 * out: a recent board on file (Open recent and Clear recent), and a ghost loaded
 * (Clear ghost replaces Open ghost).
 *
 * Its limit is the registry's: it proves a sentence exists, not that it is right.
 */
import { parseBrd } from '@openshaper/io';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { DOCS_ROUTES } from './docs/registry';
import { commandHelp } from './help-text';
import { recordRecentBoard } from './recent-boards';
import sampleBrd from './sample-board.brd?raw';
import { loadSettings } from './settings';
import { setTier } from './test/viewport';

vi.mock('@openshaper/render3d', () => ({ Board3DView: () => null }));

// Only the file reading is stubbed: the ghost goes through the app's real import path.
vi.mock('./file-io', async (importActual) => ({
  ...(await importActual<typeof import('./file-io')>()),
  openBoardFile: vi.fn(),
}));
const fileIo = await import('./file-io');

const MENUS = ['File', 'Edit', 'View', 'Board', 'Export', 'Help'] as const;

interface RenderedItem {
  menu: string;
  label: string;
  /** The menu's `label` row the item sits under, if any. */
  group?: string;
}

/** Every action and checkbox row of one menubar menu, in order, with its group. */
function readMenu(menu: string): RenderedItem[] {
  fireEvent.click(screen.getByRole('menuitem', { name: menu }));
  const panel = screen.getByRole('menu');
  const items: RenderedItem[] = [];
  let group: string | undefined;
  for (const row of Array.from(panel.children)) {
    const role = row.getAttribute('role');
    if (role === 'presentation') group = row.textContent ?? undefined;
    if (role !== 'menuitem' && role !== 'menuitemcheckbox') continue;
    // The label span, not the row: the row's text also holds the shortcut.
    const label = row.querySelector('.flex-1')!.textContent!;
    items.push({ menu, label, group });
  }
  fireEvent.click(screen.getByRole('menuitem', { name: menu }));
  return items;
}

const readMenus = () => MENUS.flatMap(readMenu);

const ready = () => screen.findAllByText(/\d+\.\dL/);

const openGhost = async () => {
  // The board, trace and ghost pickers, in that order.
  const ghostInput = document.querySelectorAll('input[type="file"]')[2] as HTMLInputElement;
  await act(async () => {
    fireEvent.change(ghostInput, { target: { files: [new File(['x'], 'ghost.brd')] } });
  });
};

beforeEach(() => {
  localStorage.clear();
  setTier('desktop');
  vi.mocked(fileIo.openBoardFile).mockResolvedValue({
    board: parseBrd(sampleBrd).board,
    meta: {},
    warnings: [],
  });
});

describe('every menu command can be found and explained', () => {
  it('has a help entry with a description and a docs route', async () => {
    recordRecentBoard('A board from last week', '{}');
    render(<App />);
    await ready();

    const before = readMenus();
    await openGhost();
    await waitFor(() => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Board' }));
      expect(screen.getByRole('menuitem', { name: 'Clear ghost' })).toBeTruthy();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Board' }));
    });
    const items = [...before, ...readMenus()];

    // The conditional items really were brought out, so they were really checked.
    const labels = new Set(items.map((i) => `${i.menu}/${i.label}`));
    for (const id of [
      'File/A board from last week',
      'File/Clear recent',
      'Board/Open ghost…',
      'Board/Clear ghost',
      'File/Longboard',
      'View/in',
    ]) {
      expect(labels, id).toContain(id);
    }

    const routes = new Set<string>(DOCS_ROUTES);
    const missing = items
      .filter(({ menu, label, group }) => {
        const help = commandHelp(menu, label, group);
        return !help || !help.description.trim() || !routes.has(help.route);
      })
      .map(({ menu, label }) => `"${menu} ▸ ${label}"`)
      // An item seen in both passes over the menus is one item.
      .filter((id, i, all) => all.indexOf(id) === i);
    expect(
      missing,
      `Menu items without help: ${missing.join(', ')}. ` +
        `Add an entry to src/help-text.ts: one sentence on what it does, and its /docs route.`,
    ).toEqual([]);
  });
});

describe('the help in the app', () => {
  const palette = () => {
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    return screen.getByPlaceholderText(/command/i);
  };

  it('finds commands in the palette by their synonyms', async () => {
    render(<App />);
    await ready();

    const input = palette();
    const top = (query: string) => {
      fireEvent.change(input, { target: { value: query } });
      const list = within(screen.getByRole('dialog', { name: 'Command palette' }));
      return list.getAllByRole('option')[0]!.getAttribute('aria-label');
    };
    expect(top('scale')).toBe('Board: Resize…');
    expect(top('litres')).toBe('View: Volume distribution');
    expect(top('tuck')).toBe('View: Apex height');
    expect(top('starter')).toBe('File: Shortboard');
    expect(top('zebra')).toBe('View: Curvature comb');
    // The description is under the name.
    fireEvent.change(input, { target: { value: 'scale' } });
    const resize = screen.getByRole('option', { name: 'Board: Resize…' });
    expect(within(resize).getByText(/new length, width and thickness/)).toBeTruthy();
  });

  it('describes toolbar buttons until Show tips is turned off', async () => {
    // The Settings dialog links to the privacy page, so it needs a router around it.
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    await ready();
    const share = screen.getByRole('button', { name: 'Share board' });
    const described = () => screen.queryByText(/Makes a link that opens a copy/);

    // Focus shows a tooltip at once; the label always, the description while tips are on.
    fireEvent.focus(share);
    expect(screen.getByText('Share this board as a link')).toBeTruthy();
    expect(described()).toBeTruthy();
    fireEvent.blur(share);

    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Settings…' }));
    const showTips = screen.getByLabelText('Show tips') as HTMLInputElement;
    expect(showTips.checked).toBe(true);
    fireEvent.click(showTips);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(loadSettings().showTips).toBe(false);

    fireEvent.focus(share);
    expect(screen.getByText('Share this board as a link')).toBeTruthy();
    expect(described()).toBeNull();
  });

  it('puts a docs link on the sidebar section headers', async () => {
    render(<App />);
    await ready();

    fireEvent.click(screen.getByRole('tab', { name: 'Shape' }));
    const resizeHelp = screen.getByRole('link', { name: 'Learn more about Resize' });
    expect(resizeHelp.getAttribute('href')).toBe('/docs/specs#resize');
    // Beside the header button, not inside it.
    expect(screen.getByRole('button', { name: 'Resize' }).contains(resizeHelp)).toBe(false);

    // Specs is a tab of one tool with no section header: the link sits on the tab's.
    fireEvent.click(screen.getByRole('tab', { name: 'Specs' }));
    expect(screen.getByRole('link', { name: 'Learn more about Specs' }).getAttribute('href')).toBe(
      '/docs/specs#readout',
    );
  });
});
