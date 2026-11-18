// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clampSplit,
  readSplit,
  SPLIT_DEFAULT,
  SPLIT_MAX,
  SPLIT_MIN,
  SPLIT_STORAGE_KEY,
  splitAfterKey,
  splitAtPointer,
  splitPercent,
  writeSplit,
} from './split';

beforeEach(() => localStorage.clear());

describe('the limits', () => {
  it('are 25 % and 75 %, and the board starts at 55 %', () => {
    expect(SPLIT_MIN).toBe(0.25);
    expect(SPLIT_MAX).toBe(0.75);
    expect(SPLIT_DEFAULT).toBe(0.55);
  });

  it('hold a position between them, and read what is not a number as the default', () => {
    expect(clampSplit(0.1)).toBe(0.25);
    expect(clampSplit(0.9)).toBe(0.75);
    expect(clampSplit(0.4)).toBe(0.4);
    expect(clampSplit(NaN)).toBe(0.55);
    expect(clampSplit(Infinity)).toBe(0.55);
  });

  it('show as a whole percent', () => {
    expect(splitPercent(0.55)).toBe(55);
    expect(splitPercent(0.5437)).toBe(54);
    expect(splitPercent(0.7501)).toBe(75);
  });
});

describe('the keys', () => {
  it('move it 2 % a press: Up and Left up, Down and Right down', () => {
    expect(splitAfterKey('ArrowDown', 0.55)).toBe(0.57);
    expect(splitAfterKey('ArrowRight', 0.55)).toBe(0.57);
    expect(splitAfterKey('ArrowUp', 0.55)).toBe(0.53);
    expect(splitAfterKey('ArrowLeft', 0.55)).toBe(0.53);
  });

  it('move it by what is shown, so a press is 2 % on screen after a drag as well', () => {
    expect(splitPercent(splitAfterKey('ArrowDown', 0.5437)!)).toBe(56);
    expect(splitPercent(splitAfterKey('ArrowUp', 0.5437)!)).toBe(52);
  });

  it('hold at the limits', () => {
    expect(splitAfterKey('ArrowUp', 0.26)).toBe(0.25);
    expect(splitAfterKey('ArrowUp', 0.25)).toBe(0.25);
    expect(splitAfterKey('ArrowDown', 0.74)).toBe(0.75);
    expect(splitAfterKey('ArrowDown', 0.75)).toBe(0.75);
  });

  it('snap to the limits on Home and End', () => {
    expect(splitAfterKey('Home', 0.6)).toBe(0.25);
    expect(splitAfterKey('End', 0.6)).toBe(0.75);
  });

  it('take twenty presses from the default to the bottom limit without drifting', () => {
    let f = SPLIT_DEFAULT;
    for (let i = 0; i < 20; i++) f = splitAfterKey('ArrowDown', f)!;
    expect(f).toBe(0.75);
    for (let i = 0; i < 25; i++) f = splitAfterKey('ArrowUp', f)!;
    expect(f).toBe(0.25);
  });

  it('leave every other key alone', () => {
    for (const k of ['Enter', ' ', 'Tab', 'Escape', 'a', '3', 'PageDown']) {
      expect(splitAfterKey(k, 0.55), k).toBeNull();
    }
  });
});

describe('the pointer', () => {
  it('puts the middle of the divider at the pointer, in a column with the divider taken out', () => {
    // column 612 tall, divider 12: 600 to share; the pointer at its middle is half way
    expect(splitAtPointer(306, 0, 612, 12)).toBe(0.5);
    expect(splitAtPointer(100 + 6 + 300, 100, 612, 12)).toBe(0.5);
  });

  it('holds it between the limits however far the pointer goes', () => {
    expect(splitAtPointer(-500, 0, 612, 12)).toBe(0.25);
    expect(splitAtPointer(5000, 0, 612, 12)).toBe(0.75);
  });

  it('keeps the default for a column with no room', () => {
    expect(splitAtPointer(10, 0, 12, 12)).toBe(0.55);
    expect(splitAtPointer(10, 0, 0, 12)).toBe(0.55);
  });
});

describe('storage', () => {
  it('has the default when nothing is stored', () => {
    expect(readSplit()).toBe(0.55);
  });

  it('remembers a position under its own key', () => {
    writeSplit(0.4);
    expect(JSON.parse(localStorage.getItem(SPLIT_STORAGE_KEY)!)).toBe(0.4);
    expect(readSplit()).toBe(0.4);
  });

  it('brings a stored position that is out of range back in, and ignores what is not a number', () => {
    localStorage.setItem(SPLIT_STORAGE_KEY, '0.95');
    expect(readSplit()).toBe(0.75);
    localStorage.setItem(SPLIT_STORAGE_KEY, '0.01');
    expect(readSplit()).toBe(0.25);
    for (const raw of ['"wide"', 'null', '{', '[0.4]', 'true']) {
      localStorage.setItem(SPLIT_STORAGE_KEY, raw);
      expect(readSplit(), raw).toBe(0.55);
    }
  });

  it('never stores a position outside the limits', () => {
    writeSplit(3);
    expect(JSON.parse(localStorage.getItem(SPLIT_STORAGE_KEY)!)).toBe(0.75);
  });

  it('survives storage that refuses', () => {
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    expect(() => writeSplit(0.4)).not.toThrow();
    write.mockRestore();
  });
});
