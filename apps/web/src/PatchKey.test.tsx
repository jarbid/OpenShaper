// SPDX-License-Identifier: GPL-3.0-or-later
import { MAX_ZONES, PATCH_COLORS, RAIL_NO_ZONES_COLOR } from '@openshaper/render3d/patches';
import { zonesAt } from './test/zones-at';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PATCH_KEY_STORAGE, PatchKey } from './PatchKey';

/** `#rrggbb` as the `rgb(r, g, b)` a style reads back as. */
const rgb = (hex: string): string => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

const zones = zonesAt({ plus: [10, 50, 90] });

const items = () => within(screen.getByRole('list')).getAllByRole('listitem');
const swatch = (li: HTMLElement) => li.querySelector<HTMLElement>('[aria-hidden]')!;

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('the key to the Patches look', () => {
  it('has a swatch and a name for each part: deck, bottom, each zone along the board, tail edge, corner', () => {
    render(<PatchKey zones={zones} />);
    expect(items().map((li) => li.textContent)).toEqual([
      'Deck',
      'Bottom',
      'Rail zone 1',
      'Rail zone 2',
      'Rail zone 3',
      'Tail edge',
      'Corner',
    ]);
  });

  it('paints each swatch in the colour of the palette module and of the zones the view paints', () => {
    render(<PatchKey zones={zones} />);
    const colors = items().map((li) => swatch(li).style.backgroundColor);
    expect(colors).toEqual([
      rgb(PATCH_COLORS.deck),
      rgb(PATCH_COLORS.bottom),
      ...zones.plus.map((z) => rgb(z.color)),
      rgb(PATCH_COLORS.tailEdge),
      rgb(PATCH_COLORS.corner),
    ]);
  });

  it('names a board with no zones plainly, in the colour its rail has', () => {
    render(<PatchKey zones={zonesAt(null)} />);
    expect(items().map((li) => li.textContent)).toEqual([
      'Deck',
      'Bottom',
      'Rail',
      'Tail edge',
      'Corner',
    ]);
    expect(swatch(items()[2]!).style.backgroundColor).toBe(rgb(RAIL_NO_ZONES_COLOR));
  });

  it('lists no more zones than the view paints', () => {
    const many = zonesAt({
      plus: Array.from({ length: MAX_ZONES + 4 }, (_, i) => i * 3),
    });
    render(<PatchKey zones={many} />);
    expect(items().filter((li) => li.textContent?.startsWith('Rail'))).toHaveLength(MAX_ZONES);
  });

  it('is a labelled disclosure that starts open, and folds to its button with one click', () => {
    render(<PatchKey zones={zones} />);
    const button = screen.getByRole('button', { name: 'Hide the key to the patches' });
    expect(button.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(button);
    expect(screen.queryByRole('list')).toBeNull();
    const again = screen.getByRole('button', { name: 'Show the key to the patches' });
    expect(again.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(again);
    expect(items()).toHaveLength(7);
  });

  it('remembers whether it is open, across a remount', () => {
    const first = render(<PatchKey zones={zones} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide the key to the patches' }));
    expect(localStorage.getItem(PATCH_KEY_STORAGE)).toBe('false');
    first.unmount();
    render(<PatchKey zones={zones} />);
    expect(screen.queryByRole('list')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show the key to the patches' }));
    expect(localStorage.getItem(PATCH_KEY_STORAGE)).toBe('true');
  });

  it('is open when nothing usable is stored, and still works when storage refuses', () => {
    localStorage.setItem(PATCH_KEY_STORAGE, '"maybe"');
    const a = render(<PatchKey zones={zones} />);
    expect(items()).toHaveLength(7);
    a.unmount();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    render(<PatchKey zones={zones} />);
    expect(items()).toHaveLength(7);
    fireEvent.click(screen.getByRole('button', { name: 'Hide the key to the patches' }));
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('sits along the bottom edge, clear of the view cube, and takes the pointer only where it is drawn', () => {
    render(<PatchKey zones={zones} />);
    const frame = screen.getByTestId('patch-key');
    const cls = frame.className.split(/\s+/);
    expect(cls).toContain('bottom-2');
    expect(cls).toContain('left-2');
    // a right inset of 7rem (112 px) leaves the view cube's corner square alone
    expect(cls).toContain('right-28');
    expect(cls).toContain('pointer-events-none');
    expect(frame.firstElementChild?.className).toContain('pointer-events-auto');
    // it wraps in a narrow pane
    expect(screen.getByRole('list').className).toContain('flex-wrap');
  });
});
