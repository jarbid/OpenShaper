// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The menu button on its own: roles, the arrow keys, what closes it and where focus goes, and that a key
 * handled in the menu does not go on to the window (Escape clears a chosen patch there, the arrows nudge
 * the selected point, the digits choose steps).
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MenuButton, MenuGroup, MenuItemRow, MenuSeparator } from './menu-button';

const blockedRow = { reason: 'Because of the board', short: 'no board' };

function Harness({ onSelect }: { onSelect: (name: string) => void }) {
  return (
    <>
      <button type="button">before</button>
      <MenuButton
        label="Test"
        trigger={<span>Test</span>}
        tip="A tip"
        initialFocus="chosen"
        data={{ 'data-x': '1' }}
      >
        <MenuGroup label="Choices">
          <MenuItemRow role="menuitemradio" checked onSelect={() => onSelect('alpha')}>
            Alpha
          </MenuItemRow>
          <MenuItemRow role="menuitemradio" hint="The second" onSelect={() => onSelect('beta')}>
            Beta
          </MenuItemRow>
          <MenuItemRow role="menuitemradio" blocked={blockedRow} onSelect={() => onSelect('gamma')}>
            Gamma
          </MenuItemRow>
        </MenuGroup>
        <MenuSeparator />
        <MenuItemRow role="menuitemcheckbox" keepOpen onSelect={() => onSelect('delta')}>
          Delta
        </MenuItemRow>
      </MenuButton>
      <button type="button">after</button>
    </>
  );
}

const trigger = () => screen.getByRole('button', { name: /^Test/ });
const menu = () => screen.queryByRole('menu', { name: 'Test' });
const ROW_ROLES = ['menuitemradio', 'menuitemcheckbox', 'menuitem'] as const;
const row = (name: string | RegExp): HTMLElement => {
  for (const role of ROW_ROLES) {
    const found = screen.queryAllByRole(role, { name });
    if (found.length === 1) return found[0]!;
  }
  throw new Error(`no single row named ${String(name)}`);
};
const open = () => fireEvent.click(trigger());
const focused = () => document.activeElement;

afterEach(() => vi.restoreAllMocks());

describe('MenuButton', () => {
  it('is a closed menu button, with the attributes it was given', () => {
    render(<Harness onSelect={vi.fn()} />);
    expect(trigger().getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(trigger().getAttribute('data-x')).toBe('1');
    expect(trigger().getAttribute('title')).toBe('A tip');
    expect(menu()).toBeNull();
  });

  it('opens on a click, names its menu, and puts focus on the chosen row', () => {
    render(<Harness onSelect={vi.fn()} />);
    open();
    const panel = menu()!;
    expect(panel).toBeTruthy();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(trigger().getAttribute('aria-controls')).toBe(panel.id);
    expect(focused()).toBe(row('Alpha'));
  });

  it('puts focus on the first row by default, even when another is the chosen one', () => {
    render(
      <MenuButton label="Plain" trigger={<span>Plain</span>}>
        <MenuItemRow role="menuitemcheckbox" onSelect={vi.fn()}>
          One
        </MenuItemRow>
        <MenuItemRow role="menuitemcheckbox" checked onSelect={vi.fn()}>
          Two
        </MenuItemRow>
      </MenuButton>,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Plain/ }));
    expect(focused()).toBe(row('One'));
  });

  it('has the roles of a menu: groups with names, radios and checkboxes with their state', () => {
    render(<Harness onSelect={vi.fn()} />);
    open();
    const group = screen.getByRole('group', { name: 'Choices' });
    expect(
      within(group)
        .getAllByRole('menuitemradio')
        .map((r) => r.textContent),
    ).toEqual(['Alpha', 'Beta', 'Gamma (no board)']);
    expect(row('Alpha').getAttribute('aria-checked')).toBe('true');
    expect(row('Beta').getAttribute('aria-checked')).toBe('false');
    expect(
      screen.getByRole('menuitemcheckbox', { name: 'Delta' }).getAttribute('aria-checked'),
    ).toBe('false');
    expect(screen.getByRole('separator')).toBeTruthy();
  });

  it('moves with the arrows, Home and End, round the ends, and lands on a row that cannot be chosen', () => {
    render(<Harness onSelect={vi.fn()} />);
    open();
    const key = (k: string) => fireEvent.keyDown(focused()!, { key: k });
    key('ArrowDown');
    expect(focused()).toBe(row('Beta'));
    key('ArrowDown');
    expect(focused()).toBe(row(/^Gamma/));
    key('ArrowDown');
    expect(focused()).toBe(row('Delta'));
    key('ArrowDown');
    expect(focused()).toBe(row('Alpha'));
    key('ArrowUp');
    expect(focused()).toBe(row('Delta'));
    key('Home');
    expect(focused()).toBe(row('Alpha'));
    key('End');
    expect(focused()).toBe(row('Delta'));
  });

  it('lists a row that cannot be chosen with its reason, and does nothing when it is chosen', () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    open();
    const gamma = row(/^Gamma/);
    expect(gamma.getAttribute('aria-disabled')).toBe('true');
    expect(gamma.getAttribute('title')).toBe('Because of the board');
    expect(gamma.hasAttribute('disabled')).toBe(false);
    fireEvent.click(gamma);
    expect(onSelect).not.toHaveBeenCalled();
    expect(menu()).toBeTruthy();
  });

  it('chooses a row, closes, and gives focus back to its button; a switch leaves the menu open', () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    open();
    fireEvent.click(row('Delta'));
    expect(onSelect).toHaveBeenLastCalledWith('delta');
    expect(menu()).toBeTruthy();
    fireEvent.click(row('Beta'));
    expect(onSelect).toHaveBeenLastCalledWith('beta');
    expect(menu()).toBeNull();
    expect(focused()).toBe(trigger());
  });

  it('closes on Escape and returns focus, and the key goes no further', () => {
    const onWindowKey = vi.fn();
    window.addEventListener('keydown', onWindowKey);
    render(<Harness onSelect={vi.fn()} />);
    open();
    const notPrevented = fireEvent.keyDown(focused()!, { key: 'Escape' });
    expect(notPrevented).toBe(false);
    expect(menu()).toBeNull();
    expect(focused()).toBe(trigger());
    expect(onWindowKey).not.toHaveBeenCalled();
    window.removeEventListener('keydown', onWindowKey);
  });

  it('keeps every plain key inside the menu, and lets a key with Ctrl held go to the app', () => {
    const onWindowKey = vi.fn();
    window.addEventListener('keydown', onWindowKey);
    render(<Harness onSelect={vi.fn()} />);
    open();
    for (const key of ['3', 'Delete', 'l', 'ArrowDown', 'ArrowUp', 'Home', 'End']) {
      fireEvent.keyDown(focused()!, { key });
    }
    expect(onWindowKey).not.toHaveBeenCalled();
    fireEvent.keyDown(focused()!, { key: 'z', ctrlKey: true });
    expect(onWindowKey).toHaveBeenCalledTimes(1);
    window.removeEventListener('keydown', onWindowKey);
  });

  it('closes on Tab, with focus on its button so the key carries on from there, and does not stop the key', () => {
    render(<Harness onSelect={vi.fn()} />);
    open();
    const notPrevented = fireEvent.keyDown(focused()!, { key: 'Tab' });
    expect(notPrevented).toBe(true);
    expect(menu()).toBeNull();
    expect(focused()).toBe(trigger());
  });

  it('closes on a press outside and gives focus back to its button when the press took it nowhere', async () => {
    render(<Harness onSelect={vi.fn()} />);
    open();
    fireEvent.pointerDown(document.body);
    expect(menu()).toBeNull();
    await waitFor(() => expect(focused()).toBe(trigger()));
  });

  it('leaves focus where a press outside put it', async () => {
    render(<Harness onSelect={vi.fn()} />);
    open();
    const after = screen.getByRole('button', { name: 'after' });
    fireEvent.pointerDown(after);
    after.focus();
    expect(menu()).toBeNull();
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(focused()).toBe(after);
  });

  it('is closed by a click on its button, not closed and opened again by the press before it', () => {
    render(<Harness onSelect={vi.fn()} />);
    open();
    fireEvent.pointerDown(trigger());
    expect(menu()).toBeTruthy();
    fireEvent.click(trigger());
    expect(menu()).toBeNull();
    expect(focused()).toBe(trigger());
  });

  it('opens from its button with the arrow keys: Down on the chosen row, Up on the last', () => {
    render(<Harness onSelect={vi.fn()} />);
    const down = fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
    expect(down).toBe(false);
    expect(menu()).toBeTruthy();
    expect(focused()).toBe(row('Alpha'));
    fireEvent.keyDown(focused()!, { key: 'Escape' });
    fireEvent.keyDown(trigger(), { key: 'ArrowUp' });
    expect(focused()).toBe(row('Delta'));
  });

  it('lines up with the left edge of its button, or with its right edge when asked, inside the window', () => {
    const rect = (left: number, width: number) =>
      ({ left, right: left + width, top: 20, bottom: 50, width, height: 30 }) as DOMRect;
    const widthOfPanel = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(200);
    const at = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(() => rect(600, 100));
    const placed = (align?: 'start' | 'end') => {
      const { unmount } = render(
        <MenuButton label="Placed" trigger={<span>Placed</span>} align={align}>
          <MenuItemRow role="menuitem" onSelect={vi.fn()}>
            One
          </MenuItemRow>
        </MenuButton>,
      );
      fireEvent.click(screen.getByRole('button', { name: /^Placed/ }));
      const style = screen.getByRole('menu', { name: 'Placed' }).style;
      const left = style.left;
      unmount();
      return left;
    };
    expect(placed()).toBe('600px');
    expect(placed('start')).toBe('600px');
    // the panel's right edge on the button's right edge: 700 - 200
    expect(placed('end')).toBe('500px');
    // a button near the left of the window: the panel stays inside it
    at.mockImplementation(() => rect(10, 100));
    expect(placed('end')).toBe('8px');
    // and near the right: it stays inside that edge
    at.mockImplementation(() => rect(window.innerWidth - 20, 20));
    expect(placed('start')).toBe(`${window.innerWidth - 200 - 8}px`);
    widthOfPanel.mockRestore();
    at.mockRestore();
  });

  it('closes when the window is resized', () => {
    render(<Harness onSelect={vi.fn()} />);
    open();
    fireEvent(window, new Event('resize'));
    expect(menu()).toBeNull();
  });

  it('is taken out of the page with the component', () => {
    const { unmount } = render(<Harness onSelect={vi.fn()} />);
    open();
    unmount();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});
