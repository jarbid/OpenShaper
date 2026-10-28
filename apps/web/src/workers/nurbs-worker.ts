// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The NURBS viewer's worker: converts a classic board to a board2 document, builds
 * and meshes it, off the main thread (milliseconds per job, one job per edit).
 * Requests are processed in arrival order, and the client posts one at a time;
 * "cancellation" is supersession: the main thread drops stale answers by id
 * (`nurbs-client.ts`).
 *
 * Instantiated lazily by the client with `new Worker(new URL(...), { type: 'module' })`,
 * so a user who never turns the experimental engine on never downloads it.
 */
import { convertAndMesh, meshTestBoard } from './nurbs-core';
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
  // No progress messages: a job is milliseconds, and one is posted per pointer move.
  const out =
    req.kind === 'classic'
      ? convertAndMesh(req.board, req.options)
      : meshTestBoard(req.name, req.options);
  if (out.ok) {
    ctx.postMessage({ kind: 'done', id: req.id, ...out }, meshTransferables(out.mesh));
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
