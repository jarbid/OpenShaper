// SPDX-License-Identifier: GPL-3.0-or-later
/** What the Deck step has chosen besides the station: defaults, changes, the status line, and being forgotten on a new board. */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { railsStore } from '../store';
import { sampleRailsBoard } from '../test/rails-board';
import {
  STATUS_MS,
  getDeckEditCurve,
  getDeckScope,
  getDeckStatus,
  resetDeckChoice,
  setDeckEditCurve,
  setDeckScope,
  setDeckStatus,
  useDeckEditCurve,
  useDeckScope,
  useDeckStatus,
} from './deck-choice';

beforeEach(() => resetDeckChoice());
afterEach(() => {
  vi.useRealTimers();
  resetDeckChoice();
});

describe('the Deck step’s choices', () => {
  it('start with every station reached, the shape’s handle shown and nothing said', () => {
    expect(getDeckScope()).toBe('all');
    expect(getDeckEditCurve()).toBe(false);
    expect(getDeckStatus()).toBe('');
  });

  it('change, and the hooks follow', () => {
    const scope = renderHook(() => useDeckScope());
    const edit = renderHook(() => useDeckEditCurve());
    act(() => setDeckScope('station'));
    act(() => setDeckEditCurve(true));
    expect(scope.result.current).toBe('station');
    expect(edit.result.current).toBe(true);
    act(() => resetDeckChoice());
    expect(scope.result.current).toBe('all');
    expect(edit.result.current).toBe(false);
  });

  it('say a thing for a few seconds', () => {
    vi.useFakeTimers();
    const status = renderHook(() => useDeckStatus());
    act(() => setDeckStatus('Held at the most this station can hold, 4.00 cm.'));
    expect(status.result.current).toBe('Held at the most this station can hold, 4.00 cm.');
    act(() => {
      vi.advanceTimersByTime(STATUS_MS + 1);
    });
    expect(status.result.current).toBe('');
  });

  it('keep a status that is said again, and say nothing for an empty one', () => {
    vi.useFakeTimers();
    act(() => setDeckStatus('a'));
    act(() => {
      vi.advanceTimersByTime(STATUS_MS - 10);
    });
    act(() => setDeckStatus('a'));
    act(() => {
      vi.advanceTimersByTime(STATUS_MS - 10);
    });
    expect(getDeckStatus()).toBe('a');
    act(() => setDeckStatus(''));
    expect(getDeckStatus()).toBe('');
  });

  it('are forgotten when another board is loaded, and not by an edit', async () => {
    const doc = await sampleRailsBoard();
    railsStore.getState().loadDoc(doc);
    act(() => setDeckScope('station'));
    act(() => setDeckEditCurve(true));
    railsStore.getState().setDeckShape({ shape: 'flat' }, { station: 1, all: false });
    expect(getDeckScope()).toBe('station');
    railsStore.getState().loadDoc(doc);
    expect(getDeckScope()).toBe('all');
    expect(getDeckEditCurve()).toBe(false);
  });
});
