/**
 * P9: when the specs worker dies (fails to load, or throws outside its message
 * handler) the readouts fall back to computing on the main thread instead of
 * staying on "Loading…" for the rest of the session.
 *
 * Separate file: `HAS_WORKER` is read when the module loads, so the Worker stub
 * has to be installed before the hook is imported.
 */
import { parseBrd } from '@openshaper/io';
import { selectSpecs } from '@openshaper/store';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import sampleBrd from './sample-board.brd?raw';

vi.mock('./analytics', () => ({ captureError: vi.fn() }));

/** A worker that never answers; tests fire its onerror by hand. */
class DeadWorker {
  static last: DeadWorker | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;
  constructor() {
    DeadWorker.last = this;
  }
  postMessage() {}
  terminate() {
    this.terminated = true;
  }
}

const { board } = parseBrd(sampleBrd);

beforeAll(() => {
  vi.stubGlobal('Worker', DeadWorker);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useSpecsWorker — the worker crashes (P9)', () => {
  it('computes on the main thread once the worker errors', async () => {
    const { useSpecsWorker } = await import('./use-specs-worker');
    const { result } = renderHook(() => useSpecsWorker(board));
    expect(result.current).toBeNull(); // waiting on a worker that will never answer

    const worker = DeadWorker.last!;
    act(() => worker.onerror!(new ErrorEvent('error', { message: 'boom' })));

    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current?.specs).toEqual(selectSpecs(board));
    expect(worker.terminated).toBe(true);
  });
});
