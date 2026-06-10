import { selectSpecs } from '@openshaper/store';
import type { SpecsRequest, SpecsResponse } from './specs-protocol';

/**
 * Dedicated worker that runs the integration-heavy selectSpecs off the main
 * thread (see docs/design/specs-worker.md). Requests are processed in arrival
 * order; "cancellation" is supersession — the main thread bumps the request id
 * and drops any response whose id is no longer current. Instantiated by the
 * useSpecsWorker hook.
 */

// Local minimal worker-scope type: the app's tsconfig loads the DOM lib, which
// types `self` as Window (postMessage there needs a targetOrigin).
interface WorkerScope {
  onmessage: ((e: MessageEvent<SpecsRequest>) => void) | null;
  postMessage(message: SpecsResponse): void;
}
const ctx = self as unknown as WorkerScope;

ctx.onmessage = (e) => {
  const { id, board } = e.data;
  try {
    ctx.postMessage({ id, ok: true, specs: selectSpecs(board) });
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: (err as Error).message });
  }
};
