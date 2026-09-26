// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The sidebar as a tab strip over an accordion: that the tool list is permanently
 * readable whatever is open, what a shut section still tells you, pinning a second
 * panel, and the desktop fold.
 *
 * Rendered through `<App />` rather than in isolation because the behaviour under test
 * is the wiring — the shell owns `SidebarState`, decides per-view relevance and feeds
 * both mounts — and a hand-built props object would assert none of that.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { SIDEBAR_TABS } from './sidebar-sections';
import { openSection, openTabFor } from './test/sidebar';
import { setTier } from './test/viewport';

vi.mock('@openshaper/render3d', () => ({ Board3DView: () => null }));

const header = (name: string) => screen.getByRole('button', { name });
const isOpen = (name: string) => header(name).getAttribute('aria-expanded') === 'true';
const panels = () => screen.getByRole('complementary', { name: 'Board panels' });
const tab = (name: string) => screen.getByRole('tab', { name });
const activeTab = () =>
  SIDEBAR_TABS.find((t) => tab(t.title).getAttribute('aria-selected') === 'true')?.id;
const view = (name: string) => screen.getByRole('button', { name });

beforeEach(() => {
  localStorage.clear();
  setTier('desktop');
});

/** The sample board plus settled specs — every test needs the readout populated. */
const ready = () => screen.findAllByText(/\d+\.\dL/);

describe('the tab strip', () => {
  it('names all four tool groups at once, whatever is open', async () => {
    render(<App />);
    await ready();

    // The whole point of the strip: this list cannot be displaced by the panel below
    // it, which is what happened when Specs' nineteen rows pushed everything off.
    for (const t of SIDEBAR_TABS) expect(tab(t.title)).toBeTruthy();
    expect(activeTab()).toBe('specs');
  });

  it('spells captions out in full for assistive tech, not the strip abbreviation', () => {
    render(<App />);
    // "REF" is a 64px rendering constraint, not what the tab is called.
    expect(screen.getByRole('tab', { name: 'Reference' })).toBeTruthy();
  });

  it('swaps the panel and takes the old tab’s tools out of the DOM', async () => {
    render(<App />);
    await ready();

    fireEvent.click(tab('Build'));
    expect(activeTab()).toBe('build');
    expect(header('Fins')).toBeTruthy();
    // Shape's tools are gone, not merely hidden — a hidden subtree keeps its store
    // subscriptions and re-renders on every drag of a control point.
    expect(screen.queryByRole('button', { name: 'Analysis' })).toBeNull();
  });

  it('keeps the accordion inside a tab as the user left it', async () => {
    render(<App />);
    await ready();

    openSection('weight');
    expect(isOpen('Weight estimate')).toBe(true);
    fireEvent.click(tab('Shape'));
    fireEvent.click(tab('Build'));
    expect(isOpen('Weight estimate')).toBe(true);
  });
});

describe('a shut section', () => {
  it('is unmounted rather than hidden', async () => {
    render(<App />);
    await ready();

    openTabFor('boardInfo');
    expect(isOpen('Board info')).toBe(false);
    expect(screen.queryByPlaceholderText('Comments…')).toBeNull();

    fireEvent.click(header('Board info'));
    expect(screen.getByPlaceholderText('Comments…')).toBeTruthy();
  });

  it('is still worth reading, via its summary', async () => {
    render(<App />);
    await ready();

    openTabFor('weight');
    expect(isOpen('Weight estimate')).toBe(false);
    expect(within(panels()).getByText(/\d+(\.\d+)? kg/)).toBeTruthy();
  });

  it('does not let that summary bleed into the section name', async () => {
    render(<App />);
    await ready();

    // Without an explicit label the accessible name drifts with the board —
    // "Weight estimate2.44 kg (5.4 lb)", which no test could query.
    openTabFor('weight');
    expect(header('Weight estimate')).toBeTruthy();
  });
});

describe('the spec readout', () => {
  it('opens on Overall alone, so nineteen rows do not fill the sidebar', async () => {
    render(<App />);
    await ready();

    expect(isOpen('Overall')).toBe(true);
    expect(isOpen('Nose')).toBe(false);
    expect(isOpen('Center')).toBe(false);
    expect(isOpen('Tail')).toBe(false);
  });

  it('renders bare — one tool in a tab needs no header of its own', async () => {
    render(<App />);
    await ready();

    // The Specs tab holds only Specs, so a "Specs" section header would be a click
    // that reveals nothing and an accordion nested in an accordion.
    expect(screen.queryByRole('button', { name: 'Specs' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Specs' })).toBeTruthy();
  });

  it('keeps a band readable while shut', async () => {
    render(<App />);
    await ready();

    // Nose shut still answers the question it is usually opened for.
    expect(within(header('Nose')).getByText(/rocker/)).toBeTruthy();
  });

  it('expands a band on demand', async () => {
    render(<App />);
    await ready();

    fireEvent.click(header('Nose'));
    expect(isOpen('Nose')).toBe(true);
    expect(within(panels()).getByText('Width @ 12"')).toBeTruthy();
  });

  it('gives the master toggle the bands, since that is what is on screen here', async () => {
    render(<App />);
    await ready();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse all sections' }));
    for (const band of ['Nose', 'Center', 'Tail', 'Overall']) {
      expect(isOpen(band), band).toBe(false);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Expand all sections' }));
    for (const band of ['Nose', 'Center', 'Tail', 'Overall']) {
      expect(isOpen(band), band).toBe(true);
    }
  });
});

describe('the master collapse toggle', () => {
  it('shuts the active tab’s sections in one click', async () => {
    render(<App />);
    await ready();

    fireEvent.click(tab('Shape'));
    openSection('resize');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all sections' }));
    for (const s of ['Resize', 'Control point', 'Analysis']) {
      expect(isOpen(s), s).toBe(false);
    }
  });

  it('leaves another tab’s sections alone — you cannot mean what you cannot see', async () => {
    render(<App />);
    await ready();

    openSection('fins'); // Build
    fireEvent.click(tab('Shape'));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all sections' }));
    fireEvent.click(tab('Build'));
    expect(isOpen('Fins')).toBe(true);
  });

  it('survives a view change, which is what stops it reading as broken', async () => {
    render(<App />);
    await ready();

    fireEvent.click(tab('Shape'));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all sections' }));
    fireEvent.click(view('Outline'));
    for (const s of ['Resize', 'Control point', 'Analysis']) {
      expect(isOpen(s), s).toBe(false);
    }
  });
});

describe('pinning', () => {
  it('keeps a pinned panel on screen while you work in another tab', async () => {
    render(<App />);
    await ready();

    fireEvent.click(screen.getByRole('button', { name: 'Pin Specs open' }));
    fireEvent.click(tab('Shape'));

    // Both panels render: the readout above, the tools being used below.
    expect(screen.getByRole('region', { name: 'Specs' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Shape' })).toBeTruthy();
    expect(header('Analysis')).toBeTruthy();
  });

  it('drops the pinned panel when unpinned', async () => {
    render(<App />);
    await ready();

    fireEvent.click(screen.getByRole('button', { name: 'Pin Specs open' }));
    fireEvent.click(tab('Shape'));
    fireEvent.click(screen.getByRole('button', { name: 'Unpin Specs' }));
    expect(screen.queryByRole('region', { name: 'Specs' })).toBeNull();
  });

  it('shows one panel when the pinned tab is the one being worked in', async () => {
    render(<App />);
    await ready();

    // Allowed on purpose: pinning the tab you are in should not have to move you.
    fireEvent.click(screen.getByRole('button', { name: 'Pin Specs open' }));
    expect(screen.getAllByRole('region', { name: 'Specs' })).toHaveLength(1);
  });

  it('caps at one pin, so a third panel cannot squeeze the other two', async () => {
    render(<App />);
    await ready();

    fireEvent.click(screen.getByRole('button', { name: 'Pin Specs open' }));
    fireEvent.click(tab('Build'));
    fireEvent.click(screen.getByRole('button', { name: 'Pin Build open' }));
    fireEvent.click(tab('Shape'));

    expect(screen.queryByRole('region', { name: 'Specs' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Build' })).toBeTruthy();
  });

  it('marks a pinned tab in the strip when it is not the active one', async () => {
    render(<App />);
    await ready();

    fireEvent.click(screen.getByRole('button', { name: 'Pin Specs open' }));
    fireEvent.click(tab('Shape'));
    // The strip would otherwise claim Specs is not on screen when it plainly is.
    expect(tab('Specs').querySelector('.bg-primary')).toBeTruthy();
  });
});

describe('per-view relevance', () => {
  it('opens the trace controls in a view that can hold a trace', async () => {
    render(<App />);
    await ready();

    fireEvent.click(view('Outline'));
    openTabFor('trace');
    expect(isOpen('Trace image')).toBe(true);
  });

  it('shuts them again where there is nothing to trace over', async () => {
    render(<App />);
    await ready();

    fireEvent.click(view('Outline'));
    fireEvent.click(view('3D'));
    openTabFor('trace');
    expect(isOpen('Trace image')).toBe(false);
  });

  it('never moves the user to another tab', async () => {
    render(<App />);
    await ready();

    // The panel jumping tabs because you glanced at the outline would be the worst
    // kind of surprise: the tab is the user's navigation, not the app's.
    fireEvent.click(tab('Build'));
    fireEvent.click(view('Outline'));
    expect(activeTab()).toBe('build');
    fireEvent.click(view('3D'));
    expect(activeTab()).toBe('build');
  });

  it('defers to a section the user opened by hand', async () => {
    render(<App />);
    await ready();

    openSection('weight'); // never auto-relevant
    fireEvent.click(view('Outline'));
    fireEvent.click(view('3D'));
    openTabFor('weight');
    expect(isOpen('Weight estimate')).toBe(true);
  });
});

describe('the desktop fold', () => {
  it('keeps the readout on the strip from every tab, not just from Specs', async () => {
    render(<App />);
    await ready();

    // Resizing happens in Shape and the result is a Specs number. Without the strip
    // carrying it, you would edit in one tab and change tabs to see what you did.
    fireEvent.click(tab('Shape'));
    expect(within(panels()).getByText(/\d+\.\dL/)).toBeTruthy();
  });

  it('leaves the strip and the dims, and takes the panel away', async () => {
    render(<App />);
    await ready();

    fireEvent.click(screen.getByRole('button', { name: 'Hide board panels' }));

    expect(screen.queryByRole('region', { name: 'Specs' })).toBeNull();
    // Issue #37 wanted the space back, not the readout.
    expect(within(panels()).getByText(/\d+\.\dL/)).toBeTruthy();
    for (const t of SIDEBAR_TABS) expect(tab(t.title)).toBeTruthy();
  });

  it('unfolds when a tool is reached for, rather than only via a chevron', async () => {
    render(<App />);
    await ready();

    fireEvent.click(screen.getByRole('button', { name: 'Hide board panels' }));
    fireEvent.click(tab('Build'));

    expect(screen.getByRole('region', { name: 'Build' })).toBeTruthy();
    expect(activeTab()).toBe('build');
  });

  it('comes back with the sections exactly as they were', async () => {
    render(<App />);
    await ready();

    openSection('boardInfo');
    fireEvent.click(screen.getByRole('button', { name: 'Hide board panels' }));
    fireEvent.click(tab('Build'));
    expect(isOpen('Board info')).toBe(true);
  });

  it('is not offered in the bottom sheet, whose snap points already are the fold', async () => {
    setTier('tablet');
    render(<App />);
    await ready();

    expect(screen.queryByRole('button', { name: 'Hide board panels' })).toBeNull();
    // The tabs are still there — they are the point at every tier.
    for (const t of SIDEBAR_TABS) expect(tab(t.title)).toBeTruthy();
  });

  it('lays the tabs out as a row in the sheet, where height is the scarce axis', async () => {
    setTier('phone');
    render(<App />);
    await ready();

    expect(
      screen.getByRole('tablist', { name: 'Sidebar tools' }).getAttribute('aria-orientation'),
    ).toBe('horizontal');
  });
});

describe('the support link', () => {
  it('rides the strip, so it survives the fold', async () => {
    render(<App />);
    await ready();

    fireEvent.click(screen.getByRole('button', { name: 'Hide board panels' }));
    expect(screen.getByRole('link', { name: 'Buy me a coffee' })).toBeTruthy();
  });

  it('follows the sidebar into the bottom sheet', async () => {
    setTier('phone');
    render(<App />);
    await ready();

    expect(within(panels()).getByRole('link', { name: /coffee/i })).toBeTruthy();
  });
});
