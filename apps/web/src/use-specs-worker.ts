import type { BezierBoard } from '@openshaper/kernel';
import type { BoardSpecs } from '@openshaper/store';
import { useEffect, useRef, useState } from 'react';
import type { SpecsRequest, SpecsResponse } from './workers/specs-protocol';

/**
 * Derived board specs computed in the specs worker instead of on the main
 * thread (see docs/design/specs-worker.md). Returns the last completed result,
 * so during recompute the previous specs stay on screen (no flicker); stale
 * responses (superseded by a newer board) are dropped by id.
 *
 * NOT YET WIRED: App still calls selectSpecs(settledBoard) synchronously.
 * Swapping is `const specs = useSpecsWorker(settledBoard)` — plus a sync
 * fallback for environments without Worker (jsdom tests, SSG prerender).
 */
export function useSpecsWorker(board: BezierBoard | null): BoardSpecs | null {
  const workerRef = useRef<Worker | null>(null);
  const idRef = useRef(0);
  const [specs, setSpecs] = useState<BoardSpecs | null>(null);

  useEffect(() => {
    const worker = new Worker(new URL('./workers/specs-worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (e: MessageEvent<SpecsResponse>) => {
      if (e.data.id !== idRef.current) return; // superseded mid-flight — drop
      if (e.data.ok) setSpecs(e.data.specs);
      else console.error('specs worker failed', e.data.error);
    };
    workerRef.current = worker;
    return () => {
      workerRef.current = null;
      worker.terminate();
    };
  }, []);

  useEffect(() => {
    if (!board) {
      idRef.current++; // invalidate any in-flight result
      setSpecs(null);
      return;
    }
    const request: SpecsRequest = { id: ++idRef.current, board };
    workerRef.current?.postMessage(request);
  }, [board]);

  return specs;
}
