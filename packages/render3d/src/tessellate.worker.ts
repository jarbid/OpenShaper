/**
 * Off-main-thread board tessellation and surface analysis. The kernel mesh build
 * walks every station interpolating a cross-section — heavy at fine target-face
 * sizes — the curvature analysis fits the whole hull, and the deviation from a ghost
 * measures every vertex against the ghost's section, so all three run in a worker to
 * keep editing responsive (project principle #4: the UI never blocks).
 *
 * The protocol lives in `worker-protocol.ts`, where it can be tested; this is only
 * the shell that receives and replies.
 */
import { handleWorkerRequest, type WorkerRequest } from './worker-protocol';

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { reply, transfer } = handleWorkerRequest(e.data);
  (self as unknown as Worker).postMessage(reply, transfer);
};
