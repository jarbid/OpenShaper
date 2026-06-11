import { getCrossSectionAreaAt, getLength, type BezierBoard } from '@openshaper/kernel';
import { selectSpecs, type BoardSpecs } from '@openshaper/store';
import { useEffect, useRef, useState } from 'react';
import type { DistributionSample, SpecsRequest, SpecsResponse } from './workers/specs-protocol';

// jsdom tests and the vite-react-ssg prerender pass have no Worker; compute
// synchronously there (selectSpecs memoizes by board identity, so it's cheap
// to call again). Constant for the session, so the hook order is stable.
const HAS_WORKER = typeof Worker !== 'undefined';

/** Options controlling what the worker computes alongside the core specs. */
export interface SpecsWorkerOptions {
  /**
   * When true, compute the cross-sectional-area distribution (volume-distribution
   * overlay). The hook re-issues a new request whenever this flag changes.
   */
  wantDistribution?: boolean;
  /**
   * Number of equal-spaced intervals along the board. Produces
   * (distributionIntervals + 1) samples. Defaults to 40.
   */
  distributionIntervals?: number;
}

/** Result returned by useSpecsWorker — null while the first result is pending. */
export interface SpecsWorkerResult {
  specs: BoardSpecs;
  /** Present when wantDistribution was true in the matching request. */
  distribution?: DistributionSample[];
}

/**
 * Derived board specs (and optionally the cross-sectional-area distribution)
 * computed in the specs worker instead of on the main thread (see
 * docs/design/specs-worker.md). Returns the last completed result, so during
 * recompute the previous values stay on screen (no flicker); stale responses
 * (superseded by a newer board or option change) are dropped by id.
 */
export function useSpecsWorker(
  board: BezierBoard | null,
  options: SpecsWorkerOptions = {},
): SpecsWorkerResult | null {
  const { wantDistribution = false, distributionIntervals = 40 } = options;

  const workerRef = useRef<Worker | null>(null);
  const idRef = useRef(0);
  const [result, setResult] = useState<SpecsWorkerResult | null>(null);

  useEffect(() => {
    if (!HAS_WORKER) return;
    const worker = new Worker(new URL('./workers/specs-worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (e: MessageEvent<SpecsResponse>) => {
      if (e.data.id !== idRef.current) return; // superseded mid-flight — drop
      if (e.data.ok) {
        setResult({ specs: e.data.specs, distribution: e.data.distribution });
      } else {
        console.error('specs worker failed', e.data.error);
      }
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
      setResult(null);
      return;
    }
    if (!HAS_WORKER) {
      // Synchronous fallback: same logic as the worker so tests exercise the same path.
      const specs = selectSpecs(board);
      let distribution: DistributionSample[] | undefined;
      if (wantDistribution) {
        const len = getLength(board);
        const N = distributionIntervals;
        distribution = Array.from({ length: N + 1 }, (_, i) => {
          const x = (i / N) * len;
          return { x, value: getCrossSectionAreaAt(board, x, 10) };
        });
      }
      setResult({ specs, distribution });
      return;
    }
    const request: SpecsRequest = {
      id: ++idRef.current,
      board,
      wantDistribution,
      distributionIntervals,
    };
    workerRef.current?.postMessage(request);
  }, [board, wantDistribution, distributionIntervals]);

  return result;
}
