// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The NURBS engine's worker: builds and meshes the section store's document (no converter in the
 * loop), converts a classic board to a document (once, when the engine switches on or a file is
 * opened with it on), and meshes a classic board or a test board for the viewer, off the main
 * thread (milliseconds per job, one job per edit).
 * Requests are processed in arrival order, and the client posts one at a time;
 * "cancellation" is supersession: the main thread drops stale answers by id
 * (`nurbs-client.ts`).
 *
 * Instantiated lazily by the client with `new Worker(new URL(...), { type: 'module' })`,
 * so a user who never turns the experimental engine on never downloads it.
 */
import {
  convertAndMesh,
  exportDocument,
  convertToDoc,
  meshDocument,
  measureDocument,
  meshTestBoard,
  probeDocument,
} from './nurbs-core';
import {
  exportTransferables,
  meshTransferables,
  type ExportRequest,
  type ExportResponse,
  type NurbsRequest,
  type NurbsResponse,
} from './nurbs-protocol';

// Local minimal worker-scope type, as in specs-worker.ts: the app's tsconfig loads the
// DOM lib, which types `self` as Window.
interface WorkerScope {
  onmessage: ((e: MessageEvent<NurbsRequest | ExportRequest>) => void) | null;
  postMessage(message: NurbsResponse | ExportResponse, transfer?: Transferable[]): void;
}
const ctx = self as unknown as WorkerScope;

ctx.onmessage = (e) => {
  const req = e.data;
  if (req.kind === 'export') {
    // An export has its own worker (nurbs-export-client.ts), so it never delays an edit's mesh and a
    // cancel is a terminate. Progress is posted between its stages.
    const out = exportDocument(req.doc, req.job, (stage, pass) =>
      ctx.postMessage({
        kind: 'export-progress',
        id: req.id,
        stage,
        ...(pass === undefined ? {} : { pass }),
      }),
    );
    if (out.ok) {
      ctx.postMessage(
        { kind: 'exported', id: req.id, ok: true, files: out.files, ms: out.ms },
        exportTransferables(out.files),
      );
    } else {
      ctx.postMessage({ kind: 'exported', id: req.id, ok: false, error: out.error });
    }
    return;
  }
  if (req.kind === 'convert') {
    const out = convertToDoc(req.board);
    ctx.postMessage({ kind: 'converted', id: req.id, ...out });
    return;
  }
  if (req.kind === 'measure') {
    const out = measureDocument(req.doc, req.engine);
    ctx.postMessage({ kind: 'measured', id: req.id, ...out });
    return;
  }
  if (req.kind === 'probe') {
    const out = probeDocument(req.doc, req.probes, req.engine);
    ctx.postMessage(
      out.ok
        ? { kind: 'probed', id: req.id, ok: true, probes: out.probes }
        : { kind: 'probed', id: req.id, ok: false, error: out.error },
    );
    return;
  }
  // No progress messages: a job is milliseconds, and one is posted per pointer move.
  const out =
    req.kind === 'classic'
      ? convertAndMesh(req.board, req.options)
      : req.kind === 'doc'
        ? meshDocument(req.doc, req.reference, req.options, undefined, req.probes)
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
