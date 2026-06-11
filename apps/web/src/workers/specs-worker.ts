import { getCrossSectionAreaAt, getLength } from '@openshaper/kernel';
import { selectSpecs } from '@openshaper/store';
import type { DistributionSample, SpecsRequest, SpecsResponse } from './specs-protocol';

/**
 * Dedicated worker that runs the integration-heavy selectSpecs off the main
 * thread (see docs/design/specs-worker.md). Requests are processed in arrival
 * order; "cancellation" is supersession — the main thread bumps the request id
 * and drops any response whose id is no longer current. Instantiated by the
 * useSpecsWorker hook.
 *
 * Step 4: also computes the cross-sectional-area distribution (volume-distribution
 * overlay) when the request includes wantDistribution: true.
 */

// Local minimal worker-scope type: the app's tsconfig loads the DOM lib, which
// types `self` as Window (postMessage there needs a targetOrigin).
interface WorkerScope {
  onmessage: ((e: MessageEvent<SpecsRequest>) => void) | null;
  postMessage(message: SpecsResponse): void;
}
const ctx = self as unknown as WorkerScope;

/** Compute the distribution array — same sampling logic as the App.tsx useMemo it replaces. */
function computeDistribution(
  board: SpecsRequest['board'],
  intervals: number,
): DistributionSample[] {
  const len = getLength(board);
  const N = intervals;
  return Array.from({ length: N + 1 }, (_, i) => {
    const x = (i / N) * len;
    return { x, value: getCrossSectionAreaAt(board, x, 10) };
  });
}

ctx.onmessage = (e) => {
  const { id, board, wantDistribution = false, distributionIntervals = 40 } = e.data;
  try {
    const specs = selectSpecs(board);
    const distribution = wantDistribution
      ? computeDistribution(board, distributionIntervals)
      : undefined;
    ctx.postMessage({ id, ok: true, specs, distribution });
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: (err as Error).message });
  }
};
