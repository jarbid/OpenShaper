// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The main-thread side of an NURBS export (docs/design/m3-exports.md, decision 1).
 *
 * An export is the one job allowed to take seconds, so it does not share the editing worker: each
 * export gets a worker of its own, which keeps edits (and their meshes) flowing meanwhile and makes
 * Cancel a `terminate()`: the worker is computing, it could not read a cancel message. The document
 * is cloned into the request, so the export is of the board as it was when asked.
 *
 * Without `Worker` (jsdom tests, prerender) the job runs on this thread through a dynamic import of
 * `workers/nurbs-core`, and cannot be cancelled once started.
 *
 * Nothing here imports board2: the worker (and the fallback's dynamic import) carries it.
 */
import type { BoardDoc, RailsBoard } from '@openshaper/board2';
import type {
  ExportedFile,
  ExportJob,
  ExportRequest,
  ExportResponse,
  ExportStage,
} from './workers/nurbs-protocol';

/** The export was cancelled before it finished. */
export class ExportCancelledError extends Error {
  constructor() {
    super('The export was cancelled.');
    this.name = 'ExportCancelledError';
  }
}

export type ExportAnswer =
  | { readonly ok: true; readonly files: readonly ExportedFile[]; readonly ms: number }
  | { readonly ok: false; readonly error: string };

/** What a worker looks like to an export; tests supply a fake. */
export interface ExportTransport {
  post(req: ExportRequest): void;
  terminate(): void;
}

export interface ExportHandlers {
  onMessage(res: ExportResponse): void;
  onError(message: string): void;
}

export type ExportTransportFactory = (handlers: ExportHandlers) => ExportTransport | null;

/** A worker per export. Returns null where there is no `Worker`. */
export const spawnExportWorker: ExportTransportFactory = (handlers) => {
  if (typeof Worker === 'undefined') return null;
  const worker = new Worker(new URL('./workers/nurbs-worker.ts', import.meta.url), {
    type: 'module',
  });
  worker.onmessage = (e: MessageEvent<ExportResponse>) => handlers.onMessage(e.data);
  worker.onerror = (e: ErrorEvent) => {
    e.preventDefault();
    handlers.onError(e.message || 'The NURBS worker failed to load.');
  };
  return { post: (req) => worker.postMessage(req), terminate: () => worker.terminate() };
};

/** A running export: its answer, and the way to stop it. */
export interface ExportRun {
  /** Resolves with the answer; rejects with {@link ExportCancelledError} after `cancel()`. */
  readonly result: Promise<ExportAnswer>;
  /** Stop the worker. No effect once the export has finished. */
  cancel(): void;
}

let nextId = 0;

export type ExportCoreLoader = () => Promise<
  Pick<typeof import('./workers/nurbs-core'), 'exportDocument'>
>;
const loadCore: ExportCoreLoader = () => import('./workers/nurbs-core');

export function startNurbsExport(
  doc: BoardDoc | RailsBoard,
  job: ExportJob,
  onStage?: (s: ExportStage, pass?: number) => void,
  spawn: ExportTransportFactory = spawnExportWorker,
  core: ExportCoreLoader = loadCore,
): ExportRun {
  const id = ++nextId;
  let settled = false;
  let transport: ExportTransport | null = null;
  let finish: (a: ExportAnswer) => void = () => {};
  let fail: (e: Error) => void = () => {};
  const result = new Promise<ExportAnswer>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  const settle = (f: () => void): void => {
    if (settled) return;
    settled = true;
    transport?.terminate();
    transport = null;
    f();
  };

  try {
    transport = spawn({
      onMessage(res) {
        if (res.id !== id || settled) return;
        if (res.kind === 'export-progress') onStage?.(res.stage, res.pass);
        else {
          settle(() =>
            finish(
              res.ok ? { ok: true, files: res.files, ms: res.ms } : { ok: false, error: res.error },
            ),
          );
        }
      },
      onError(message) {
        settle(() => fail(new Error(message)));
      },
    });
    if (transport) transport.post({ kind: 'export', id, doc, job });
  } catch (err) {
    settled = true;
    fail(err instanceof Error ? err : new Error(String(err)));
    return { result, cancel: () => {} };
  }

  if (!transport) {
    // No Worker: compute on this thread (the stages are reported, the job cannot be interrupted).
    core()
      .then((c) => {
        if (settled) return;
        const out = c.exportDocument(doc, job, onStage);
        settle(() => finish(out));
      })
      .catch((err: unknown) =>
        settle(() => fail(err instanceof Error ? err : new Error(String(err)))),
      );
  }

  return {
    result,
    cancel: () => settle(() => fail(new ExportCancelledError())),
  };
}
