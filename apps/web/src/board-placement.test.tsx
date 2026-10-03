/**
 * P22: fins and 3D guides are placed from the board the hull was meshed from.
 * The placement only moves to a new board once that board's mesh exists, so an
 * overlay built from it can never run ahead of the hull during a drag.
 */
import { parseBrd } from '@openshaper/io';
import { scaleBoard } from '@openshaper/store';
import { useBoardOffset } from '@openshaper/render3d';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import sampleBrd from './sample-board.brd?raw';

const { board: first } = parseBrd(sampleBrd);
const second = scaleBoard(first, 1.1, 1, 1);

describe('useBoardOffset placement (P22)', () => {
  it('names the meshed board, and keeps the old one until the new mesh lands', async () => {
    const { result, rerender } = renderHook(({ b }) => useBoardOffset(b, 2), {
      initialProps: { b: first },
    });
    await waitFor(() => expect(result.current?.board).toBe(first));

    rerender({ b: second });
    // Same render as the new board: its mesh is not in yet, so nothing moves.
    expect(result.current?.board).toBe(first);

    await waitFor(() => expect(result.current?.board).toBe(second));
    expect(result.current!.offset).toHaveLength(3);
  });
});
