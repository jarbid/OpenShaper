// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Board ▸ Resize…: the menu (and so palette) command that finds the Resize tool.
 *
 * Resize lives in a Shape-tab section that no view opens on its own, so a shaper
 * asking how to scale a finished design had to be told where it was. The command has
 * to land the cursor in the first field from wherever the sidebar happens to be —
 * folded on the desktop, closed or peeking in the bottom sheet — and from the command
 * palette as well as the menubar.
 *
 * Rendered through `<App />`: the behaviour is the wiring between the menus, the
 * shell's sidebar and sheet state, and the section that owns the field.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { boardStore } from './store';
import { setTier } from './test/viewport';

vi.mock('@openshaper/render3d', () => ({ Board3DView: () => null }));

/** The sample board plus settled specs, so the Resize placeholders are populated. */
const ready = () => screen.findAllByText(/\d+\.\dL/);

const tab = (name: string) => screen.getByRole('tab', { name });
const resizeHeader = () => screen.getByRole('button', { name: 'Resize' });
const sheet = () => screen.queryByRole('dialog', { name: 'Board panels' });
/** The dimming backdrop, which the sheet renders only at its `full` snap. */
const fullSheetBackdrop = () => document.body.querySelector('div.fixed.inset-0[aria-hidden]');
/** The first Resize field, found where it should be: inside the Shape panel. */
const lengthField = () =>
  within(screen.getByRole('region', { name: 'Shape' })).getByRole('textbox', { name: 'Length' });

/** What every route to the command must end in. */
function expectResizeReady() {
  expect(tab('Shape').getAttribute('aria-selected')).toBe('true');
  expect(resizeHeader().getAttribute('aria-expanded')).toBe('true');
  expect(document.activeElement).toBe(lengthField());
}

/**
 * Run the command from the palette, opened from `opener`.
 *
 * The opener is focused first, as the click or keypress that opens the palette would
 * leave it. A dialog owes its opener focus back when it closes; with a real opener in
 * place, the field has to keep focus against that hand-back rather than against
 * nothing.
 */
function runFromPalette(opener: HTMLElement, open: () => void) {
  opener.focus();
  expect(document.activeElement).toBe(opener);
  open();
  const input = screen.getByPlaceholderText(/command/i);
  fireEvent.change(input, { target: { value: 'resize' } });
  expect(screen.getByRole('option', { name: 'Board: Resize…' })).toBeTruthy();
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(screen.queryByPlaceholderText(/command/i)).toBeNull();
}

beforeEach(() => {
  localStorage.clear();
});

describe('Board ▸ Resize… on the desktop', () => {
  beforeEach(() => setTier('desktop'));

  it('is in the Board menu', async () => {
    render(<App />);
    await ready();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Board' }));
    expect(screen.getByRole('menuitem', { name: 'Resize…' })).toBeTruthy();
  });

  it('unfolds the sidebar onto Shape with Resize open and its first field focused', async () => {
    render(<App />);
    await ready();

    // The worst starting point: panel folded away, on another tab, Resize shut.
    fireEvent.click(screen.getByRole('button', { name: 'Hide board panels' }));
    expect(screen.queryByRole('region', { name: 'Shape' })).toBeNull();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Board' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Resize…' }));

    expectResizeReady();
    // The menu closed behind it rather than staying over the field.
    expect(screen.queryByRole('menuitem', { name: 'Resize…' })).toBeNull();
  });

  it('keeps Resize open across a view change, since the user asked for it', async () => {
    render(<App />);
    await ready();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Board' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Resize…' }));
    // Resize is relevant to no view, so an untouched section would shut here.
    fireEvent.click(screen.getByRole('button', { name: 'Outline' }));
    expect(resizeHeader().getAttribute('aria-expanded')).toBe('true');
  });

  it('is found by the command palette under "resize", and focus survives it closing', async () => {
    render(<App />);
    await ready();

    // Ctrl+K pressed while a toolbar button has focus.
    runFromPalette(screen.getByRole('button', { name: 'Share board' }), () =>
      fireEvent.keyDown(window, { key: 'k', ctrlKey: true }),
    );
    expectResizeReady();
  });
});

/**
 * Each route is the one that tier actually offers: a portrait phone (below `sm`) has
 * only the menu button, which opens the palette; a landscape phone is wide enough for
 * the menubar.
 */
describe('Board ▸ Resize… in the bottom sheet', () => {
  const menuButton = () => screen.getByRole('button', { name: 'Menu and commands' });
  const openPalette = () => fireEvent.click(menuButton());

  /**
   * jsdom has no layout, so these pin the calls that place the form rather than the
   * pixels: a field focused while the sheet is still growing is centred in the tiny
   * body, a scroll offset that hides the tab strip and the Resize header once it has
   * grown. The focus must not scroll; the form is scrolled in once the sheet settles.
   */
  describe('scrolling the form in', () => {
    const scrollIntoView = vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>();
    let settle: () => void = () => {};
    beforeEach(() => {
      scrollIntoView.mockClear();
      Element.prototype.scrollIntoView = scrollIntoView;
      // The sheet's height transition, still running when the effect looks.
      Element.prototype.getAnimations = function (this: Element) {
        if (this.getAttribute('role') !== 'dialog') return [];
        const finished = new Promise<void>((resolve) => (settle = resolve));
        return [{ finished } as unknown as Animation];
      };
    });
    afterEach(() => {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
      delete (Element.prototype as Partial<Element>).getAnimations;
    });

    it('focuses without scrolling, then scrolls the form in once the sheet has grown', async () => {
      setTier('phone');
      render(<App />);
      await ready();
      const focus = vi.spyOn(HTMLElement.prototype, 'focus');

      runFromPalette(menuButton(), openPalette);

      expectResizeReady();
      const fieldFocus = focus.mock.contexts.indexOf(lengthField());
      expect(focus.mock.calls[fieldFocus]).toEqual([{ preventScroll: true }]);
      expect(scrollIntoView, 'not while the sheet is still growing').not.toHaveBeenCalled();

      settle();
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' }));
      // The whole form, Apply included, not just the field.
      const form = scrollIntoView.mock.contexts[0] as Element;
      expect(form.contains(lengthField())).toBe(true);
      expect(form.contains(screen.getByRole('button', { name: 'Apply' }))).toBe(true);
      focus.mockRestore();
    });
  });

  it('opens a closed sheet on a landscape phone', async () => {
    setTier('phoneLandscape');
    render(<App />);
    // No readout to wait on: with the sheet closed it is nowhere on screen.
    await waitFor(() => expect(boardStore.getState().board).not.toBeNull());
    expect(sheet(), 'a landscape phone starts with the sheet out of the way').toBeNull();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Board' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Resize…' }));

    expect(sheet()).not.toBeNull();
    // All the way up: half of a landscape phone leaves Apply below the support bar.
    expect(fullSheetBackdrop(), 'the sheet goes to full').not.toBeNull();
    await ready();
    expectResizeReady();
    expect(within(sheet()!).getByRole('textbox', { name: 'Length' })).toBe(lengthField());
  });

  it('raises a peeking sheet on a portrait phone, from the palette', async () => {
    setTier('phone');
    render(<App />);
    await ready();
    // At peek the panels button offers to show the panels.
    expect(screen.getByRole('button', { name: 'Show board panels' })).toBeTruthy();

    runFromPalette(menuButton(), openPalette);

    expect(screen.getByRole('button', { name: 'Hide board panels' })).toBeTruthy();
    expectResizeReady();
  });

  it('works from the menubar on a tablet too', async () => {
    setTier('tablet');
    render(<App />);
    await ready();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Board' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Resize…' }));

    expect(screen.getByRole('button', { name: 'Hide board panels' })).toBeTruthy();
    // A tall viewport stops at half, where the canvas stays usable.
    expect(fullSheetBackdrop()).toBeNull();
    expectResizeReady();
  });
});
