// SPDX-License-Identifier: GPL-3.0-or-later
/** What the Bottom step has chosen: the contour, Edit curve, the status line; forgotten when another board is loaded. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { railsStore } from '../store';
import { sampleRailsBoard } from '../test/rails-board';
import {
  getBottomEditCurve,
  getBottomStatus,
  getChosenContour,
  resetBottomChoice,
  resolveContour,
  setBottomEditCurve,
  setBottomStatus,
  setChosenContour,
} from './bottom-choice';

beforeEach(() => resetBottomChoice());
afterEach(() => {
  vi.useRealTimers();
  resetBottomChoice();
});

describe('the choice', () => {
  it('starts with nothing chosen and remembers what is set', () => {
    expect([getChosenContour(), getBottomEditCurve(), getBottomStatus()]).toEqual([
      null,
      false,
      '',
    ]);
    setChosenContour('vee');
    setBottomEditCurve(true);
    setBottomStatus('Held.');
    expect([getChosenContour(), getBottomEditCurve(), getBottomStatus()]).toEqual([
      'vee',
      true,
      'Held.',
    ]);
  });

  it('lets a status line go after a few seconds', () => {
    vi.useFakeTimers();
    setBottomStatus('Held.');
    expect(getBottomStatus()).toBe('Held.');
    vi.advanceTimersByTime(7000);
    expect(getBottomStatus()).toBe('');
  });

  it('is forgotten when another board is loaded', async () => {
    railsStore.getState().loadDoc(await sampleRailsBoard());
    setChosenContour('vee');
    setBottomEditCurve(true);
    railsStore.getState().loadDoc(await sampleRailsBoard());
    expect([getChosenContour(), getBottomEditCurve()]).toEqual([null, false]);
  });
});

describe('the contour that is chosen in fact', () => {
  it('is the one named when the board has it, else the first, else none', () => {
    expect(resolveContour(['a', 'b'], 'b')).toBe('b');
    expect(resolveContour(['a', 'b'], 'gone')).toBe('a');
    expect(resolveContour(['a', 'b'], null)).toBe('a');
    expect(resolveContour([], 'a')).toBeNull();
  });
});
