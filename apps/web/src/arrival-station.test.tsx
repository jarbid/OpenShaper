// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The station a board opens on when it arrives (`arrival-station.ts`): the one nearest the middle for a rails
 * board that is shown for the first time and for a shared board, and the station the shell had for anything else.
 */
import type { RailsBoard } from '@openshaper/board2';
import { parseBrd } from '@openshaper/io';
import { getLength } from '@openshaper/kernel';
import { act, renderHook } from '@testing-library/react';
import { useState, useSyncExternalStore } from 'react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { arrivalStation, useArrivalStation, type Arrival } from './arrival-station';
import { openRailsBoard, resetRailsEngine } from './rails-engine';
import sampleBrd from './sample-board.brd?raw';
import { nearestMidpointSection } from './section-index';
import { activeStore, boardStore, railsStore } from './store';
import swallowDoc from './templates/swallow-shortboard.board?raw';

type Core = typeof import('./workers/nurbs-core');
let swallow: RailsBoard;
let sampleRails: RailsBoard;
const sample = parseBrd(sampleBrd).board;

/** The rails board a template converts to: its projection has the stations the editors choose among. */
beforeAll(async () => {
  const core: Core = await import('./workers/nurbs-core');
  const sections = core.docFromJson(JSON.parse(swallowDoc));
  if (!sections.ok) throw new Error(sections.error);
  const a = core.toRails({ doc: sections.doc });
  if (!a.ok) throw new Error(a.error);
  swallow = a.board;
  const b = core.toRails({ classic: sample });
  if (!b.ok) throw new Error(b.error);
  sampleRails = b.board as RailsBoard;
}, 60_000);

beforeEach(() => {
  resetRailsEngine();
  railsStore.setState({ doc: null, board: null, slices: null });
  activeStore.use(boardStore);
  boardStore.getState().load(sample);
});

const none: Arrival = { rails: null, shared: 0 };

describe('arrivalStation', () => {
  it('is the station nearest the middle of a converted template, not the first', () => {
    railsStore.getState().loadDoc(swallow);
    const board = railsStore.getState().board!;
    const index = arrivalStation({ rails: 1, shared: 0 }, none, board);
    expect(index).not.toBeNull();
    expect(index).toBeGreaterThan(1);
    // the nearest to the middle, by looking at them all
    const mid = getLength(board) / 2;
    const distance = (i: number) => Math.abs(board.crossSections[i]!.position - mid);
    for (let i = 1; i <= board.crossSections.length - 2; i += 1) {
      expect(distance(index!)).toBeLessThanOrEqual(distance(i));
    }
    expect(index).toBe(nearestMidpointSection(board));
  });

  it('leaves the station alone for a rails board that was already chosen for', () => {
    railsStore.getState().loadDoc(swallow);
    const board = railsStore.getState().board!;
    expect(arrivalStation({ rails: 4, shared: 0 }, { rails: 4, shared: 0 }, board)).toBeNull();
  });

  it('leaves the station alone when no rails board is shown and no shared board was presented', () => {
    expect(arrivalStation(none, none, boardStore.getState().board)).toBeNull();
    // a rails board shown earlier is not an arrival now that the classic board is
    expect(arrivalStation(none, { rails: 3, shared: 0 }, boardStore.getState().board)).toBeNull();
  });

  it('chooses for a shared board of any kind', () => {
    const board = boardStore.getState().board!;
    expect(arrivalStation({ rails: null, shared: 1 }, none, board)).toBe(
      nearestMidpointSection(board),
    );
  });

  it('chooses nothing without a board', () => {
    expect(arrivalStation({ rails: 1, shared: 1 }, none, null)).toBeNull();
  });
});

/** The shell's side: the board the editors show and the station it holds, with the hook between them. */
function harness(shared = 0) {
  return renderHook(
    ({ shared }: { shared: number }) => {
      const board = useSyncExternalStore(activeStore.subscribe, () => activeStore.getState().board);
      const [station, setStation] = useState(1);
      useArrivalStation(board, setStation, shared);
      return { station, setStation, board };
    },
    { initialProps: { shared } },
  );
}

describe('useArrivalStation', () => {
  it('leaves a classic board on the station the shell had', () => {
    const { result } = harness();
    expect(result.current.station).toBe(1);
    act(() => result.current.setStation(3));
    act(() => boardStore.getState().load(sample));
    expect(result.current.station).toBe(3);
  });

  it('opens a rails board on its middle station, as soon as it is the board shown', () => {
    const { result } = harness();
    act(() => {
      openRailsBoard(swallow);
      activeStore.use(railsStore);
    });
    const board = railsStore.getState().board!;
    expect(result.current.board).toBe(board);
    expect(result.current.station).toBe(nearestMidpointSection(board));
    expect(result.current.station).toBeGreaterThan(1);
  });

  it('chooses again for each board that arrives, and not for the same one shown again', () => {
    const { result } = harness();
    act(() => {
      openRailsBoard(swallow);
      activeStore.use(railsStore);
    });
    act(() => result.current.setStation(2));

    // the engine turned off and on again: the same board, the person's station
    act(() => activeStore.use(boardStore));
    act(() => activeStore.use(railsStore));
    expect(result.current.station).toBe(2);

    // another board: its own middle
    act(() => openRailsBoard(sampleRails));
    expect(result.current.station).toBe(nearestMidpointSection(railsStore.getState().board!));
    act(() => result.current.setStation(1));

    // a classic board with the engine off: nothing
    act(() => {
      activeStore.use(boardStore);
      boardStore.getState().load(sample);
    });
    expect(result.current.station).toBe(1);
  });

  it('waits for the rails board to be the board shown: the classic board has other stations', () => {
    const { result } = harness();
    act(() => openRailsBoard(swallow));
    // the rails store holds the board, but the switch still shows the classic one
    expect(result.current.station).toBe(1);
    act(() => activeStore.use(railsStore));
    expect(result.current.station).toBe(nearestMidpointSection(railsStore.getState().board!));
  });

  it('opens a shared board on its middle station, whatever kind it is', () => {
    const { result, rerender } = harness();
    act(() => result.current.setStation(1));
    rerender({ shared: 1 });
    const board = boardStore.getState().board!;
    expect(result.current.station).toBe(nearestMidpointSection(board));
    expect(result.current.station).toBeGreaterThan(1);
    // moved by the person, then left alone until the next shared board
    act(() => result.current.setStation(1));
    rerender({ shared: 1 });
    expect(result.current.station).toBe(1);
  });
});
