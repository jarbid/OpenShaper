// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { measureRails } from './board-sizing';
import { BOARD_TYPES, type BoardType } from './board-types';
import { makeBoardOfType } from './new-board';
import { NURBS_TEMPLATES } from './templates';

describe('makeBoardOfType', () => {
  it('makes the rails board of the template at the size asked, to 0.1 mm', async () => {
    const type = BOARD_TYPES[1]!;
    const board = await makeBoardOfType(type, { length: 240, width: 55, thickness: 7 });
    expect(board.model).toBe('rails');
    expect(board.meta.name).toBe('Funboard');
    const size = measureRails(board);
    expect(Math.abs(size.length - 240)).toBeLessThan(0.01);
    expect(Math.abs(size.width - 55)).toBeLessThan(0.01);
    expect(Math.abs(size.thickness - 7)).toBeLessThan(0.01);
  });

  it('makes the template itself at the size it is drawn at', async () => {
    const type = BOARD_TYPES[2]!;
    const board = await makeBoardOfType(type, type.drawn);
    const size = measureRails(board);
    expect(Math.abs(size.length - type.drawn.length)).toBeLessThan(1e-3);
    expect(Math.abs(size.thickness - type.drawn.thickness)).toBeLessThan(1e-3);
  });

  it('says so when the template cannot be loaded', async () => {
    const template = NURBS_TEMPLATES.find((t) => t.name === 'Fish shortboard')!;
    const load = vi.spyOn(template, 'load').mockRejectedValueOnce(new Error('Failed to fetch'));
    await expect(makeBoardOfType(BOARD_TYPES[4]!, BOARD_TYPES[4]!.drawn)).rejects.toThrow(
      'The Fish shortboard template could not be loaded (offline, or the app was just updated).',
    );
    load.mockRestore();
  });

  it('refuses a kind that has no template', async () => {
    const stray: BoardType = { ...BOARD_TYPES[0]!, name: 'Gun' };
    await expect(makeBoardOfType(stray, stray.drawn)).rejects.toThrow('There is no Gun template.');
  });
});
