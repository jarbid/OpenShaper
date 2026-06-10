import type { BezierBoard } from '@openshaper/kernel';
import { selectSpecs, type BoardSpecs } from '@openshaper/store';
import { useEffect, useRef, useState } from 'react';
import type { SpecsRequest, SpecsResponse } from './workers/specs-protocol';

// jsdom tests and the vite-react-ssg prerender pass have no Worker; compute
// synchronously there (selectSpecs memoizes by board identity, so it's cheap
// to call again). Constant for the session, so the hook order is stable.
const HAS_WORKER = typeof Worker !== 'undefined';

/**
 * Derived board specs computed in the specs worker instead of on the main
 * thread (see docs/design/specs-worker.md). Returns the last completed result,
 * so during recompute the previous specs stay on screen (no flicker); stale
 * responses (superseded by a newer board) are dropped by id.
 */
export function useSpecsWorker(board: BezierBoard | null): BoardSpecs | null {
  const workerRef = useRef<Worker | null>(null);
  const idRef = useRef(0);
  const [specs, setSpecs] = useState<BoardSpecs | null>(null);

  useEffect(() => {
    if (!HAS_WORKER) return;
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
    if (!HAS_WORKER) {
      setSpecs(selectSpecs(board));
      return;
    }
    const request: SpecsRequest = { id: ++idRef.current, board };
    workerRef.current?.postMessage(request);
  }, [board]);

  return specs;
}
