// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The NURBS viewer's worker: converts a classic board to a board2 document, builds
 * and tessellates it, off the main thread (a conversion takes 12 to 22 s). Requests
 * are processed in arrival order; "cancellation" is supersession: the main thread
 * drops stale answers by id, and terminates this worker when a newer board makes a
 * running conversion pointless (`nurbs-client.ts`).
 *
 * Instantiated lazily by the client with `new Worker(new URL(...), { type: 'module' })`,
 * so a user who never turns the experimental engine on never downloads it.
 */
import { convertAndMesh, remesh } from './nurbs-core';
import { meshTransferables, type NurbsRequest, type NurbsResponse } from './nurbs-protocol';

// Local minimal worker-scope type, as in specs-worker.ts: the app's tsconfig loads the
// DOM lib, which types `self` as Window.
interface WorkerScope {
  onmessage: ((e: MessageEvent<NurbsRequest>) => void) | null;
  postMessage(message: NurbsResponse, transfer?: Transferable[]): void;
}
const ctx = self as unknown as WorkerScope;

ctx.onmessage = (e) => {
  const req = e.data;
  const progress = (stage: 'converting' | 'building' | 'meshing' | 'deviation') =>
    ctx.postMessage({ kind: 'progress', id: req.id, stage });
  const out =
    req.kind === 'convert'
      ? convertAndMesh(req.modelId, req.board, req.faceSize, progress)
      : remesh(req.modelId, req.docJson, req.board, req.faceSize, progress);
  if (out.ok) {
    ctx.postMessage(
      { kind: 'done', id: req.id, modelId: req.modelId, ...out },
      meshTransferables(out.mesh),
    );
  } else {
    ctx.postMessage({
      kind: 'done',
      id: req.id,
      ok: false,
      error: out.error,
      issues: out.issues,
    });
  }
};
