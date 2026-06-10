import { parseBrd } from '@openshaper/io';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import sampleBrd from './sample-board.brd?raw';
import { boardStore } from './store';
import { useSettledBoard } from './use-settled-board';

const { board: sample } = parseBrd(sampleBrd);

describe('useSettledBoard', () => {
  beforeEach(() => {
    act(() => boardStore.getState().load(sample));
  });

  it('is the live board when not editing', () => {
    const { result } = renderHook(() => useSettledBoard());
    expect(result.current).toBe(boardStore.getState().board);
  });

  it('freezes during a drag and snaps to the final board on release', () => {
    const { result } = renderHook(() => useSettledBoard());
    const settled = result.current;

    act(() => {
      boardStore.getState().beginEdit();
      boardStore.getState().scaleBoard(1.1, 1, 1);
    });
    // The live board moved, but the settled board stays frozen mid-drag…
    expect(boardStore.getState().board).not.toBe(settled);
    expect(result.current).toBe(settled);

    // …and snaps to the live board the moment the drag ends.
    act(() => boardStore.getState().endEdit());
    expect(result.current).toBe(boardStore.getState().board);
    expect(result.current).not.toBe(settled);
  });

  it('tracks committed (non-drag) edits immediately', () => {
    const { result } = renderHook(() => useSettledBoard());
    const before = result.current;
    act(() => boardStore.getState().scaleBoard(1, 1.05, 1));
    expect(result.current).not.toBe(before);
    expect(result.current).toBe(boardStore.getState().board);
  });
});
