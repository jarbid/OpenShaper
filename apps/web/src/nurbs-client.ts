// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The main-thread side of the NURBS worker (docs/design/board2.md, "V1 viewer"): the
 * same protocol as `use-specs-worker.ts`, as a plain object so it can be tested
 * without React or a real Worker.
 *
 * - **Monotonic ids; stale answers dropped.** Every request takes the next id and
 *   becomes the only job that matters: its predecessor's promise rejects with
 *   {@link SupersededError}, and any answer that is not for the current id is
 *   ignored.
 * - **Superseded conversions are terminated.** A conversion runs 12 to 22 s and the
 *   worker is single-threaded, so a stale one left running would delay the next by
 *   that long. The worker is terminated and the next request starts a fresh one. A
 *   superseded re-mesh (a few seconds) is left to finish and its answer dropped.
 * - **Synchronous fallback.** Without `Worker` (jsdom tests) the compute runs on the
 *   calling thread through a dynamic import of `workers/nurbs-core`.
 * - **Errors surfaced.** A conversion that fails resolves with `ok: false` and the
 *   converter's issues; a crashed or unloadable worker rejects.
 *
 * Nothing here imports board2 or geom: the worker (and the fallback's dynamic import)
 * is what carries them, so this module stays small.
 */
import type { BezierBoard } from '@openshaper/kernel';
import type {
  NurbsIssue,
  NurbsMeshData,
  NurbsRequest,
  NurbsResponse,
  NurbsStage,
  NurbsSummary,
  NurbsTimings,
} from './workers/nurbs-protocol';

/** A request replaced by a newer one before it answered. */
export class SupersededError extends Error {
  constructor() {
    super('superseded by a newer NURBS request');
    this.name = 'SupersededError';
  }
}

/** The answer to a job. A failed conversion is an answer, not an exception. */
export type NurbsAnswer =
  | {
      readonly ok: true;
      readonly modelId: number;
      readonly docJson: string;
      readonly issues: readonly NurbsIssue[];
      readonly summary: NurbsSummary | null;
      readonly timings: NurbsTimings;
      readonly mesh: NurbsMeshData;
    }
  | { readonly ok: false; readonly error: string; readonly issues: readonly NurbsIssue[] };

/** What a worker looks like to the client; tests supply a fake. */
export interface NurbsTransport {
  post(req: NurbsRequest): void;
  terminate(): void;
}

export interface TransportHandlers {
  onMessage(res: NurbsResponse): void;
  /** The worker failed to load or threw outside its handler. */
  onError(message: string): void;
}

export type TransportFactory = (handlers: TransportHandlers) => NurbsTransport | null;

/** The real worker. Returns null where there is no `Worker` (tests, prerender). */
export const spawnNurbsWorker: TransportFactory = (handlers) => {
  if (typeof Worker === 'undefined') return null;
  const worker = new Worker(new URL('./workers/nurbs-worker.ts', import.meta.url), {
    type: 'module',
  });
  worker.onmessage = (e: MessageEvent<NurbsResponse>) => handlers.onMessage(e.data);
  worker.onerror = (e: ErrorEvent) => {
    e.preventDefault();
    handlers.onError(e.message || 'The NURBS worker failed to load.');
  };
  return { post: (req) => worker.postMessage(req), terminate: () => worker.terminate() };
};

export interface NurbsClient {
  /** Convert `board`, build and mesh it at `faceSize` (cm). */
  convert(
    modelId: number,
    board: BezierBoard,
    faceSize: number,
    onStage?: (s: NurbsStage) => void,
  ): Promise<NurbsAnswer>;
  /** Mesh an already converted board at another `faceSize`. */
  mesh(
    modelId: number,
    docJson: string,
    board: BezierBoard,
    faceSize: number,
    onStage?: (s: NurbsStage) => void,
  ): Promise<NurbsAnswer>;
  /** Drop the job in flight (its promise rejects with {@link SupersededError}). */
  cancel(): void;
  /** Cancel and release the worker. */
  dispose(): void;
}

interface Pending {
  readonly id: number;
  readonly kind: NurbsRequest['kind'];
  readonly onStage?: (s: NurbsStage) => void;
  resolve(answer: NurbsAnswer): void;
  reject(err: Error): void;
}

/** The compute module, loaded on demand for the synchronous fallback. */
export type CoreLoader = () => Promise<
  Pick<typeof import('./workers/nurbs-core'), 'convertAndMesh' | 'remesh'>
>;

const loadCore: CoreLoader = () => import('./workers/nurbs-core');

export function createNurbsClient(
  spawn: TransportFactory = spawnNurbsWorker,
  core: CoreLoader = loadCore,
): NurbsClient {
  let nextId = 0;
  let pending: Pending | null = null;
  let transport: NurbsTransport | null = null;
  // Set once a spawn returned null: from then on every job runs on this thread.
  let synchronous = false;

  const stop = (): void => {
    transport?.terminate();
    transport = null;
  };

  /** Settle the current job's promise with an error and forget it. */
  const abandon = (err: Error): void => {
    const p = pending;
    pending = null;
    p?.reject(err);
  };

  /** Replace the job in flight: its caller learns, and a running conversion is killed. */
  const supersede = (): void => {
    const p = pending;
    if (!p) return;
    abandon(new SupersededError());
    if (p.kind === 'convert') stop();
  };

  const handlers: TransportHandlers = {
    onMessage(res) {
      const p = pending;
      if (!p || res.id !== p.id) return; // superseded mid-flight: drop
      if (res.kind === 'progress') {
        p.onStage?.(res.stage);
        return;
      }
      pending = null;
      if (res.ok) {
        p.resolve({
          ok: true,
          modelId: res.modelId,
          docJson: res.docJson,
          issues: res.issues,
          summary: res.summary,
          timings: res.timings,
          mesh: res.mesh,
        });
      } else {
        p.resolve({ ok: false, error: res.error, issues: res.issues });
      }
    },
    onError(message) {
      stop();
      abandon(new Error(message));
    },
  };

  const ensureTransport = (): NurbsTransport | null => {
    if (synchronous) return null;
    if (transport) return transport;
    transport = spawn(handlers);
    if (!transport) synchronous = true;
    return transport;
  };

  const runSynchronously = async (req: NurbsRequest, p: Pending): Promise<void> => {
    const compute = await core();
    // A newer request took over while the module loaded: nobody wants this one.
    if (pending !== p) return;
    const progress = (s: NurbsStage) => p.onStage?.(s);
    const out =
      req.kind === 'convert'
        ? compute.convertAndMesh(req.modelId, req.board, req.faceSize, progress)
        : compute.remesh(req.modelId, req.docJson, req.board, req.faceSize, progress);
    if (pending !== p) return; // superseded during the (blocking) compute: drop
    pending = null;
    p.resolve(out.ok ? { ...out, modelId: req.modelId } : out);
  };

  const submit = (
    build: (id: number) => NurbsRequest,
    onStage?: (s: NurbsStage) => void,
  ): Promise<NurbsAnswer> => {
    supersede();
    const id = ++nextId;
    const req = build(id);
    return new Promise<NurbsAnswer>((resolve, reject) => {
      const p: Pending = { id, kind: req.kind, onStage, resolve, reject };
      pending = p;
      let t: NurbsTransport | null;
      try {
        t = ensureTransport();
      } catch (err) {
        // The worker could not even be constructed (blocked, offline, CSP).
        stop();
        abandon(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (t) {
        try {
          t.post(req);
        } catch (err) {
          stop();
          abandon(err instanceof Error ? err : new Error(String(err)));
        }
      } else {
        runSynchronously(req, p).catch((err: unknown) => {
          if (pending === p) abandon(err instanceof Error ? err : new Error(String(err)));
        });
      }
    });
  };

  return {
    convert: (modelId, board, faceSize, onStage) =>
      submit((id) => ({ kind: 'convert', id, modelId, board, faceSize }), onStage),
    mesh: (modelId, docJson, board, faceSize, onStage) =>
      submit((id) => ({ kind: 'mesh', id, modelId, docJson, board, faceSize }), onStage),
    cancel: supersede,
    dispose() {
      abandon(new SupersededError());
      stop();
    },
  };
}
