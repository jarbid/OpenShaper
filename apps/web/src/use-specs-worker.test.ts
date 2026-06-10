import { parseBrd } from '@openshaper/io';
import type { BezierBoard } from '@openshaper/kernel';
import { selectSpecs } from '@openshaper/store';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import sampleBrd from './sample-board.brd?raw';
import { useSpecsWorker } from './use-specs-worker';

const { board } = parseBrd(sampleBrd);

describe('useSpecsWorker — no-Worker fallback (jsdom, SSG)', () => {
  it('falls back to synchronous selectSpecs when Worker is unavailable', async () => {
    expect(typeof Worker).toBe('undefined'); // the premise of this suite

    const { result } = renderHook(() => useSpecsWorker(board));

    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current).toEqual(selectSpecs(board));
  });

  it('clears specs when the board goes null', async () => {
    const { result, rerender } = renderHook(
      ({ b }: { b: BezierBoard | null }) => useSpecsWorker(b),
      {
        initialProps: { b: board as BezierBoard | null },
      },
    );
    await waitFor(() => expect(result.current).not.toBeNull());

    rerender({ b: null });

    expect(result.current).toBeNull();
  });
});
