// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A conversion's answer that arrives after another document was opened must not land. When the conversion
 * is made from the section store's document, opening a rails board whole (`openRailsBoard`, a restored
 * session's `attachRailsBoard`) does not change that document, so "was the source edited meanwhile?" says
 * no; the answer is for the previous load all the same. The client is a fake whose answers the test
 * releases, and the answer is released before React has re-rendered for the new load, as a worker message
 * that was already queued would be.
 */
import type { BoardDoc, RailsBoard } from '@openshaper/board2';
import { parseBrd } from '@openshaper/io';
import { act, renderHook } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openRailsBoard, resetRailsEngine, useRailsEngine } from './rails-engine';
import sampleBrd from './sample-board.brd?raw';
import { boardStore, railsStore, sectionStore } from './store';
import swallowDoc from './templates/swallow-shortboard.board?raw';

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

type Core = typeof import('./workers/nurbs-core');
let core: Core;
let sections: BoardDoc;
let arrived: RailsBoard;
beforeAll(async () => {
  core = await import('./workers/nurbs-core');
  const d = core.docFromJson(JSON.parse(swallowDoc));
  if (!d.ok) throw new Error(d.error);
  sections = d.doc;
  const made = core.toRails({ doc: sections });
  if (!made.ok) throw new Error(made.error);
  arrived = made.board;
}, 60_000);

beforeEach(() => {
  fake.asked.length = 0;
  fake.release.length = 0;
  resetRailsEngine();
  railsStore.setState({ doc: null, board: null, slices: null });
  boardStore.getState().load(parseBrd(sampleBrd).board);
  sectionStore.getState().loadDoc(sections);
});

describe('an answer for the previous load', () => {
  it('does not replace a rails board opened while it was in the worker', async () => {
    const { result } = renderHook(() => useRailsEngine(true, { ready: true, converting: false }));
    await vi.waitFor(() => expect(fake.asked.length).toBe(1));
    expect(fake.asked[0]).toBe(sectionStore.getState().doc);

    // The stale answer is queued first, then the rails board is opened, in the same task.
    const stale = { ...arrived, meta: { name: 'stale' } } as RailsBoard;
    fake.release[0]!(stale);
    openRailsBoard(arrived);
    await act(async () => {});

    expect(railsStore.getState().doc).toBe(arrived);
    expect(result.current.ready).toBe(true);
  });
});
