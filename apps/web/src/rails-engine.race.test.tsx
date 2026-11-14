// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * An edit made while a conversion is in the worker: the answer is for the older source and is thrown away;
 * the conversion is made again from the edited one, so the board that lands includes the edit. The client
 * is a fake whose answers the test releases one by one.
 */
import type { RailsBoard } from '@openshaper/board2';
import { parseBrd } from '@openshaper/io';
import { vec2 } from '@openshaper/kernel';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRailsEngine, useRailsEngine } from './rails-engine';
import sampleBrd from './sample-board.brd?raw';
import { boardStore, railsStore } from './store';

const fake = vi.hoisted(() => ({
  asked: [] as unknown[],
  release: [] as ((b: unknown) => void)[],
}));
vi.mock('./nurbs-client', () => ({
  SupersededError: class SupersededError extends Error {},
  createNurbsClient: () => ({
    toRails: (source: unknown) => {
      fake.asked.push(source);
      return new Promise((resolve) =>
        fake.release.push((board) => resolve({ ok: true, board, conversion: null, issues: [] })),
      );
    },
    dispose: () => {},
  }),
}));

beforeEach(() => {
  fake.asked.length = 0;
  fake.release.length = 0;
  resetRailsEngine();
  railsStore.setState({ doc: null, board: null, slices: null });
  boardStore.getState().load(parseBrd(sampleBrd).board);
});

describe('a conversion whose source was edited meanwhile', () => {
  it('is thrown away and made again from the edited board', async () => {
    const { result } = renderHook(() => useRailsEngine(true, { ready: false, converting: false }));
    await waitFor(() => expect(fake.asked.length).toBe(1));
    const first = boardStore.getState().board;
    const nose = first!.outline.knots.length - 1;
    const end = first!.outline.knots[nose]!.end;
    act(() => {
      boardStore.getState().moveControlPoint({ kind: 'outline' }, nose, vec2(end.x + 3, end.y));
    });
    const loadDoc = vi.spyOn(railsStore.getState(), 'loadDoc');
    // the first answer arrives for the old board: not used
    await act(async () =>
      fake.release[0]!({ model: 'rails', tag: 'old' } as unknown as RailsBoard),
    );
    await waitFor(() => expect(fake.asked.length).toBe(2));
    expect(loadDoc).not.toHaveBeenCalled();
    expect(result.current.ready).toBe(false);
    expect((fake.asked[1] as { outline: unknown }).outline).toBe(
      boardStore.getState().board!.outline,
    );
    // the second is for the edited board: it lands
    const made = (await import('./workers/nurbs-core')).toRails({
      classic: parseBrd(sampleBrd).board,
    });
    if (!made.ok) throw new Error(made.error);
    const next = made.board;
    await act(async () => fake.release[1]!(next));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(railsStore.getState().doc).toBe(next);
  });
});
