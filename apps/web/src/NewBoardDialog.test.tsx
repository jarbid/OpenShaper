// SPDX-License-Identifier: GPL-3.0-or-later
import type { RailsBoard } from '@openshaper/board2';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { measureRails } from './board-sizing';
import { BOARD_TYPES } from './board-types';
import { lengthUnitByKey } from './format';
import NewBoardDialog from './NewBoardDialog';
import * as newBoard from './new-board';

// The real pipeline (the template, the conversion, the scaling) with a hook for the one test of a failure.
vi.mock('./new-board', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./new-board')>();
  return { ...actual, makeBoardOfType: vi.fn(actual.makeBoardOfType) };
});

const MM = lengthUnitByKey('mm');
const FTIN = lengthUnitByKey('ftin');

function open(units = MM) {
  const onOpen = vi.fn<(board: RailsBoard, name: string) => void>();
  const onClose = vi.fn();
  const view = render(<NewBoardDialog units={units} onOpen={onOpen} onClose={onClose} />);
  return { onOpen, onClose, ...view };
}

const radio = (name: string) => screen.getByRole('radio', { name });
const field = (name: string) => screen.getByRole('textbox', { name }) as HTMLInputElement;
const arrow = (el: HTMLElement, key: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(el, { key, ...init });
/** Type `text` into a field and leave it, as a person does. */
const typeInto = (name: string, text: string) => {
  fireEvent.change(field(name), { target: { value: text } });
  fireEvent.blur(field(name));
};

beforeEach(() => {
  vi.mocked(newBoard.makeBoardOfType).mockClear();
});

describe('the New board dialog', () => {
  it('is a dialog with a radio group of the five kinds, none chosen, and the first in reach', () => {
    open();
    const dialog = screen.getByRole('dialog', { name: 'New board' });
    const group = within(dialog).getByRole('radiogroup', { name: 'Kind of board' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-labelledby') && r.textContent)).toHaveLength(5);
    expect(BOARD_TYPES.map((t) => radio(t.name).getAttribute('aria-checked'))).toEqual(
      BOARD_TYPES.map(() => 'false'),
    );
    // one stop in the Tab order, on the first card, which has the focus
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    expect(document.activeElement).toBe(radios[0]);
    // nothing to size yet, and nothing to create
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(
      (screen.getByRole('button', { name: 'Create board' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('shows each card with its description and the size it is drawn at, in the app’s units', () => {
    const { unmount } = open(MM);
    expect(radio('Shortboard').getAttribute('aria-describedby')).toBeTruthy();
    const card = radio('Shortboard');
    expect(card.textContent).toContain(BOARD_TYPES[0]!.description);
    expect(card.textContent).toContain('1879.6 mm × 469.9 mm × 59.6 mm');
    unmount();
    open(FTIN);
    expect(radio('Longboard').textContent).toContain('9\'0" × 22 3/4" × 2 15/16"');
    // the picture of the plan is not read out
    expect(radio('Fish shortboard').querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('asks for the size once a kind is chosen, filled with the size it is drawn at', () => {
    open(MM);
    fireEvent.click(radio('Funboard'));
    expect(radio('Funboard').getAttribute('aria-checked')).toBe('true');
    expect(radio('Shortboard').getAttribute('aria-checked')).toBe('false');
    const size = screen.getByRole('group', { name: 'Size of the Funboard' });
    expect(
      within(size)
        .getAllByRole('textbox')
        .map((f) => f.getAttribute('id')),
    ).toHaveLength(3);
    expect(field('Length').value).toBe('2286.0');
    expect(field('Width').value).toBe('546.1');
    expect(field('Thickness').value).toBe('69.8');
    // the range of each, in the same units, under it
    expect(screen.getByText('1981.2 mm to 2590.8 mm')).toBeTruthy();
    expect(screen.getByText('508.0 mm to 596.9 mm')).toBeTruthy();
    expect(screen.getByText('60.3 mm to 79.4 mm')).toBeTruthy();
    expect(screen.getAllByText('mm', { selector: 'span' })).toHaveLength(3);
    expect(
      (screen.getByRole('button', { name: 'Create board' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('shows the lengths in feet and inches’ unit as inches, and reads feet and inches typed in any unit', () => {
    open(FTIN);
    fireEvent.click(radio('Shortboard'));
    expect(field('Length').value).toBe('74.000');
    expect(field('Width').value).toBe('18.500');
    expect(screen.getByText('5\'0" to 7\' 2"')).toBeTruthy();
    typeInto('Length', '6\'8"');
    expect(field('Length').value).toBe('80.000');
  });

  describe('the cards, as a radio group', () => {
    it('are moved through, and chosen, by the arrow keys, Home and End', () => {
      open();
      const names = BOARD_TYPES.map((t) => t.name);
      const checked = () => names.filter((n) => radio(n).getAttribute('aria-checked') === 'true');
      arrow(radio('Shortboard'), 'ArrowRight');
      expect(checked()).toEqual(['Funboard']);
      expect(document.activeElement).toBe(radio('Funboard'));
      arrow(radio('Funboard'), 'ArrowDown');
      expect(checked()).toEqual(['Longboard']);
      arrow(radio('Longboard'), 'ArrowLeft');
      arrow(radio('Funboard'), 'ArrowUp');
      expect(checked()).toEqual(['Shortboard']);
      // it wraps round
      arrow(radio('Shortboard'), 'ArrowLeft');
      expect(checked()).toEqual(['Fish shortboard']);
      expect(document.activeElement).toBe(radio('Fish shortboard'));
      arrow(radio('Fish shortboard'), 'ArrowRight');
      expect(checked()).toEqual(['Shortboard']);
      arrow(radio('Shortboard'), 'End');
      expect(checked()).toEqual(['Fish shortboard']);
      arrow(radio('Fish shortboard'), 'Home');
      expect(checked()).toEqual(['Shortboard']);
      // the chosen card is the one Tab reaches
      arrow(radio('Shortboard'), 'ArrowRight');
      expect(BOARD_TYPES.map((t) => radio(t.name).tabIndex)).toEqual([-1, 0, -1, -1, -1]);
    });

    it('are chosen by Enter, which goes on to the length, and by a click, which stays', () => {
      open();
      arrow(radio('Longboard'), 'Enter');
      expect(radio('Longboard').getAttribute('aria-checked')).toBe('true');
      expect(document.activeElement).toBe(field('Length'));
      // a click focuses the card it is on, and the focus stays there
      radio('Fish shortboard').focus();
      fireEvent.click(radio('Fish shortboard'));
      expect(radio('Fish shortboard').getAttribute('aria-checked')).toBe('true');
      expect(document.activeElement).toBe(radio('Fish shortboard'));
    });

    it('start the size over when another kind is chosen, and keep it when the same one is chosen again', () => {
      open();
      fireEvent.click(radio('Shortboard'));
      typeInto('Length', '1800');
      expect(field('Length').value).toBe('1800.0');
      fireEvent.click(radio('Shortboard'));
      expect(field('Length').value).toBe('1800.0');
      fireEvent.click(radio('Longboard'));
      expect(field('Length').value).toBe('2743.2');
    });
  });

  describe('the size fields', () => {
    it('hold a number past an end of the range to that end, and show it, never refusing one', () => {
      open();
      fireEvent.click(radio('Shortboard'));
      typeInto('Length', '99999');
      expect(field('Length').value).toBe('2184.4');
      typeInto('Length', '10');
      expect(field('Length').value).toBe('1524.0');
      typeInto('Width', '-4');
      expect(field('Width').value).toBe('431.8');
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('put the number back for text that is no number', () => {
      open();
      fireEvent.click(radio('Shortboard'));
      typeInto('Width', 'wide');
      expect(field('Width').value).toBe('469.9');
      fireEvent.change(field('Width'), { target: { value: '' } });
      fireEvent.blur(field('Width'));
      expect(field('Width').value).toBe('469.9');
    });

    it('keep what is typed until it is committed', () => {
      open();
      fireEvent.click(radio('Shortboard'));
      fireEvent.change(field('Length'), { target: { value: '19' } });
      expect(field('Length').value).toBe('19');
      fireEvent.change(field('Length'), { target: { value: '' } });
      expect(field('Length').value).toBe('');
    });

    it('are nudged by the up and down arrow keys, ten times as much with Shift, and stop at the ends', () => {
      open();
      fireEvent.click(radio('Shortboard'));
      const length = field('Length');
      arrow(length, 'ArrowUp');
      expect(length.value).toBe('1889.6');
      arrow(length, 'ArrowUp', { shiftKey: true });
      expect(length.value).toBe('1989.6');
      arrow(length, 'ArrowDown');
      expect(length.value).toBe('1979.6');
      for (let i = 0; i < 30; i++) arrow(length, 'ArrowUp', { shiftKey: true });
      expect(length.value).toBe('2184.4');
      const thickness = field('Thickness');
      arrow(thickness, 'ArrowUp');
      expect(thickness.value).toBe('60.6');
      arrow(field('Width'), 'ArrowUp');
      expect(field('Width').value).toBe('474.9');
    });

    it('nudge in the shown unit: an inch, an eighth and a sixteenth of one', () => {
      open(FTIN);
      fireEvent.click(radio('Shortboard'));
      arrow(field('Length'), 'ArrowUp');
      arrow(field('Width'), 'ArrowUp');
      arrow(field('Thickness'), 'ArrowUp');
      expect(field('Length').value).toBe('75.000');
      expect(field('Width').value).toBe('18.625');
      expect(field('Thickness').value).toBe('2.411');
    });

    it('show the numbers again in a unit that is chosen while the dialog is open', () => {
      const onOpen = vi.fn();
      const view = render(<NewBoardDialog units={MM} onOpen={onOpen} onClose={vi.fn()} />);
      fireEvent.click(radio('Longboard'));
      expect(field('Length').value).toBe('2743.2');
      view.rerender(
        <NewBoardDialog units={lengthUnitByKey('cm')} onOpen={onOpen} onClose={vi.fn()} />,
      );
      expect(field('Length').value).toBe('274.32');
    });
  });

  describe('making the board', () => {
    it('opens the board at the size typed, to 0.1 mm, when Create board is pressed', async () => {
      const { onOpen } = open(MM);
      fireEvent.click(radio('Swallow shortboard'));
      typeInto('Length', '1800');
      typeInto('Width', '480');
      fireEvent.click(screen.getByRole('button', { name: 'Create board' }));
      expect(screen.getByRole('status').textContent).toMatch(/Making the board/);
      await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1), { timeout: 20_000 });
      const [board, name] = onOpen.mock.calls[0]!;
      expect(name).toBe('Swallow shortboard');
      const size = measureRails(board);
      expect(size.length).toBeCloseTo(180, 2);
      expect(size.width).toBeCloseTo(48, 2);
      // the thickness was not touched: the template's own
      expect(size.thickness).toBeCloseTo(BOARD_TYPES[3]!.drawn.thickness, 3);
      expect(board.meta.name).toBe('Swallow shortboard');
    }, 30_000);

    it('opens the template itself, as it is, when no size was changed', async () => {
      const { onOpen } = open(MM);
      fireEvent.click(radio('Fish shortboard'));
      fireEvent.click(screen.getByRole('button', { name: 'Create board' }));
      await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1), { timeout: 20_000 });
      const board = onOpen.mock.calls[0]![0];
      const drawn = BOARD_TYPES[4]!.drawn;
      const size = measureRails(board);
      expect(size.length).toBeCloseTo(drawn.length, 3);
      expect(size.thickness).toBeCloseTo(drawn.thickness, 3);
    }, 30_000);

    it('creates on Enter in a field, with the value typed there held to the range', async () => {
      const { onOpen } = open(MM);
      fireEvent.click(radio('Shortboard'));
      fireEvent.change(field('Length'), { target: { value: '30000' } });
      arrow(field('Length'), 'Enter');
      await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1), { timeout: 20_000 });
      expect(measureRails(onOpen.mock.calls[0]![0]).length).toBeCloseTo(218.44, 2);
    }, 30_000);

    it('changes nothing in the fields while the board is being made', async () => {
      let answer: (board: RailsBoard) => void = () => {};
      vi.mocked(newBoard.makeBoardOfType).mockImplementationOnce(
        () => new Promise<RailsBoard>((resolve) => (answer = resolve)),
      );
      const { onOpen } = open(MM);
      fireEvent.click(radio('Shortboard'));
      fireEvent.click(screen.getByRole('button', { name: 'Create board' }));
      const length = field('Length');
      expect(length.readOnly).toBe(true);
      arrow(length, 'ArrowUp');
      arrow(length, 'Enter');
      expect(length.value).toBe('1879.6');
      expect(vi.mocked(newBoard.makeBoardOfType)).toHaveBeenCalledTimes(1);
      answer({} as RailsBoard);
      await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
    });

    it('ignores a second press while the board is being made, and keeps the focus where it was', async () => {
      const { onOpen } = open(MM);
      fireEvent.click(radio('Funboard'));
      const create = screen.getByRole('button', { name: 'Create board' });
      create.focus();
      fireEvent.click(create);
      fireEvent.click(create);
      expect(create.getAttribute('aria-busy')).toBe('true');
      expect(document.activeElement).toBe(create);
      await waitFor(() => expect(onOpen).toHaveBeenCalled(), { timeout: 20_000 });
      expect(onOpen).toHaveBeenCalledTimes(1);
    }, 30_000);

    it('opens nothing when the dialog is closed first', async () => {
      // the engine answers only after the dialog has gone
      let answer: (board: RailsBoard) => void = () => {};
      vi.mocked(newBoard.makeBoardOfType).mockImplementationOnce(
        () => new Promise<RailsBoard>((resolve) => (answer = resolve)),
      );
      const { onOpen, unmount } = open(MM);
      fireEvent.click(radio('Longboard'));
      fireEvent.click(screen.getByRole('button', { name: 'Create board' }));
      unmount();
      answer({} as RailsBoard);
      await new Promise((r) => setTimeout(r, 0));
      expect(onOpen).not.toHaveBeenCalled();
    });

    it('says why, and stays open, when the board cannot be made', async () => {
      vi.mocked(newBoard.makeBoardOfType).mockRejectedValueOnce(new Error('the engine said no'));
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { onOpen, onClose } = open(MM);
      fireEvent.click(radio('Shortboard'));
      fireEvent.click(screen.getByRole('button', { name: 'Create board' }));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toBe('Could not make the Shortboard: the engine said no');
      expect(onOpen).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      // and it can be tried again
      expect(
        (screen.getByRole('button', { name: 'Create board' }) as HTMLButtonElement).disabled,
      ).toBe(false);
      spy.mockRestore();
    });
  });

  describe('leaving', () => {
    it('closes on Escape, from a card and from a field', () => {
      const { onClose } = open();
      arrow(radio('Shortboard'), 'Escape');
      expect(onClose).toHaveBeenCalledTimes(1);
      fireEvent.click(radio('Shortboard'));
      arrow(field('Length'), 'Escape');
      expect(onClose).toHaveBeenCalledTimes(2);
    });

    it('closes from the close button and from Cancel, and makes nothing', () => {
      const { onClose, onOpen } = open();
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(onClose).toHaveBeenCalledTimes(2);
      expect(onOpen).not.toHaveBeenCalled();
    });

    it('gives the focus back to what opened it', () => {
      const opener = document.createElement('button');
      document.body.append(opener);
      opener.focus();
      const { unmount } = open();
      expect(document.activeElement).not.toBe(opener);
      unmount();
      expect(document.activeElement).toBe(opener);
      opener.remove();
    });

    it('keeps Tab inside the dialog', () => {
      open();
      fireEvent.click(radio('Shortboard'));
      const stops = [
        radio('Shortboard'),
        field('Length'),
        field('Width'),
        field('Thickness'),
        screen.getByRole('button', { name: 'Close' }),
        screen.getByRole('button', { name: 'Cancel' }),
        screen.getByRole('button', { name: 'Create board' }),
      ];
      const last = stops[stops.length - 1]!;
      last.focus();
      fireEvent.keyDown(last, { key: 'Tab' });
      expect(document.activeElement?.closest('[role="dialog"]')).not.toBeNull();
    });
  });
});
