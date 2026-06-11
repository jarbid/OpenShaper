import { parseBrd } from '@openshaper/io';
import { getCrossSectionAreaAt, getLength, type BezierBoard } from '@openshaper/kernel';
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
    expect(result.current?.specs).toEqual(selectSpecs(board));
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

  it('returns null distribution when wantDistribution is false', async () => {
    const { result } = renderHook(() => useSpecsWorker(board, { wantDistribution: false }));

    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current?.distribution).toBeUndefined();
  });

  it('returns distribution matching synchronous getCrossSectionAreaAt sampling when wantDistribution is true', async () => {
    const intervals = 40;
    const { result } = renderHook(() =>
      useSpecsWorker(board, { wantDistribution: true, distributionIntervals: intervals }),
    );

    await waitFor(() => expect(result.current?.distribution).toBeDefined());

    const dist = result.current!.distribution!;
    expect(dist).toHaveLength(intervals + 1);

    // Compute the expected distribution synchronously — SAME logic as the worker.
    // Assert equality to the synchronous path, not to hardcoded numbers, so this
    // test remains valid if the kernel integration resolution changes (order-independence
    // constraint from the coordinator prompt).
    const len = getLength(board);
    const N = intervals;
    const expected = Array.from({ length: N + 1 }, (_, i) => {
      const x = (i / N) * len;
      return { x, value: getCrossSectionAreaAt(board, x, 10) };
    });

    for (let i = 0; i <= N; i++) {
      expect(dist[i]!.x).toBeCloseTo(expected[i]!.x, 10);
      expect(dist[i]!.value).toBeCloseTo(expected[i]!.value, 10);
    }
  });

  it('uses default 40 intervals when distributionIntervals is omitted', async () => {
    const { result } = renderHook(() => useSpecsWorker(board, { wantDistribution: true }));

    await waitFor(() => expect(result.current?.distribution).toBeDefined());
    // Default N=40 → 41 samples
    expect(result.current!.distribution).toHaveLength(41);
  });

  it('specs.area matches the value returned by selectSpecs (weight estimate dependency)', async () => {
    const { result } = renderHook(() => useSpecsWorker(board));

    await waitFor(() => expect(result.current).not.toBeNull());
    // specs.area is the planshape area used by estimateWeight — it must equal
    // what selectSpecs computes, so callers can drop their own getArea() call.
    expect(result.current!.specs.area).toBe(selectSpecs(board).area);
  });
});
