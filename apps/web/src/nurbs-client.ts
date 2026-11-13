// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The main-thread side of the NURBS worker (docs/design/m1-model.md §3): the same
 * protocol as `use-specs-worker.ts`, as a plain object so it can be tested without
 * React or a real Worker.
 *
 * - **Monotonic ids; stale answers dropped.** Every request takes the next id and
 *   becomes the only job that matters: its predecessor's promise rejects with
 *   {@link SupersededError}, and any answer that is not for the current id is
 *   ignored.
 * - **Newest wins, one job at a time.** A job takes milliseconds, and an edit sends
 *   one per pointer move. The worker is given one request at a time; while it runs,
 *   only the newest later request is kept (it replaces any earlier waiting one) and
 *   is posted when the worker answers. So the worker never queues a backlog of jobs
 *   nobody wants, and it is never terminated for being slow.
 * - **Synchronous fallback.** Without `Worker` (jsdom tests) the compute runs on the
 *   calling thread through a dynamic import of `workers/nurbs-core`.
 * - **Errors surfaced.** A refused board resolves with `ok: false` and the converter's
 *   issues; a crashed or unloadable worker rejects.
 *
 * Nothing here imports board2 or geom: the worker (and the fallback's dynamic import)
 * is what carries them, so this module stays small.
 */
import type { BoardDoc, RailsBoard } from '@openshaper/board2';
import type { BezierBoard } from '@openshaper/kernel';
import type {
  ConvertedDoc,
  JobOptions,
  MeshMeasure,
  NurbsConversion,
  NurbsEngine,
  NurbsIssue,
  NurbsMeshData,
  NurbsRequest,
  NurbsResponse,
  NurbsStage,
  NurbsSummary,
  NurbsTimings,
  SectionProbe,
  TestBoardName,
} from './workers/nurbs-protocol';

/** A request replaced by a newer one before it answered. */
export class SupersededError extends Error {
  constructor() {
    super('superseded by a newer NURBS request');
    this.name = 'SupersededError';
  }
}

/** The answer to a job. A refused board is an answer, not an exception. */
export type NurbsAnswer =
  | {
      readonly ok: true;
      readonly issues: readonly NurbsIssue[];
      readonly summary: NurbsSummary;
      readonly timings: NurbsTimings;
      readonly mesh: NurbsMeshData;
      /** The as-built sections a `doc` job was asked for. */
      readonly probes: readonly SectionProbe[];
    }
  | { readonly ok: false; readonly error: string; readonly issues: readonly NurbsIssue[] };

/** The answer to a probe job: the sections, or why the document would not build. */
export type ProbeAnswer =
  | { readonly ok: true; readonly probes: readonly SectionProbe[] }
  | { readonly ok: false; readonly error: string };

/** The answer to a conversion: the document, or the reasons the board was refused. */
export type ConvertAnswer =
  | ({ readonly ok: true } & ConvertedDoc)
  | { readonly ok: false; readonly error: string; readonly issues: readonly NurbsIssue[] };

/** The answer to a rails conversion: the board, or the reasons the source was refused. */
export type ToRailsAnswer =
  | {
      readonly ok: true;
      readonly board: RailsBoard;
      /** The classic-to-sections report, when the source was a classic board. */
      readonly conversion: NurbsConversion | null;
      readonly issues: readonly NurbsIssue[];
    }
  | { readonly ok: false; readonly error: string; readonly issues: readonly NurbsIssue[] };

/** The answer to a measure job: the mesh's numbers, or why the document would not build. */
export type MeasureAnswer =
  | ({ readonly ok: true } & MeshMeasure)
  | { readonly ok: false; readonly error: string };

type Answer = NurbsAnswer | ConvertAnswer | ToRailsAnswer | ProbeAnswer | MeasureAnswer;

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
  /** Convert the live classic `board`, build and mesh it. */
  classic(
    board: BezierBoard,
    options: JobOptions,
    onStage?: (s: NurbsStage) => void,
  ): Promise<NurbsAnswer>;
  /** Build and mesh one of board2's test boards. */
  test(
    name: TestBoardName,
    options: JobOptions,
    onStage?: (s: NurbsStage) => void,
  ): Promise<NurbsAnswer>;
  /**
   * Build and mesh the section store's document: no converter in the loop. `reference` is the classic
   * board "Deviation from classic" measures against (null when that mode is not shown).
   */
  doc(
    doc: BoardDoc | RailsBoard,
    reference: BezierBoard | null,
    options: JobOptions,
    onStage?: (s: NurbsStage) => void,
    probes?: readonly number[],
  ): Promise<NurbsAnswer>;
  /** The as-built sections of an unchanged document at `probes` (no mesh): the scrub preview. */
  probe(
    doc: BoardDoc | RailsBoard,
    probes: readonly number[],
    engine?: NurbsEngine,
  ): Promise<ProbeAnswer>;
  /** Convert a classic board to a section document. A refusal is an answer, not an exception. */
  convert(board: BezierBoard): Promise<ConvertAnswer>;
  /**
   * Make a rails board from a classic board (through the classic conversion) or from a section document,
   * once. A refusal at either step is an answer, not an exception.
   */
  toRails(source: BezierBoard | BoardDoc): Promise<ToRailsAnswer>;
  /** Volume, areas and the centroid of a document's mesh (the sidebar's specs). No surface comes back. */
  measure(doc: BoardDoc | RailsBoard, engine?: NurbsEngine): Promise<MeasureAnswer>;
  /** Drop the job in flight (its promise rejects with {@link SupersededError}). */
  cancel(): void;
  /** Cancel and release the worker. */
  dispose(): void;
}

interface Pending {
  readonly id: number;
  readonly onStage?: (s: NurbsStage) => void;
  resolve(answer: Answer): void;
  reject(err: Error): void;
}

/** The compute module, loaded on demand for the synchronous fallback. */
export type CoreLoader = () => Promise<
  Pick<
    typeof import('./workers/nurbs-core'),
    | 'convertAndMesh'
    | 'convertToDoc'
    | 'measureDocument'
    | 'meshDocument'
    | 'meshTestBoard'
    | 'probeDocument'
    | 'toRails'
  >
>;

const loadCore: CoreLoader = () => import('./workers/nurbs-core');

export function createNurbsClient(
  spawn: TransportFactory = spawnNurbsWorker,
  core: CoreLoader = loadCore,
): NurbsClient {
  let nextId = 0;
  // The newest request: the only one whose promise is still live.
  let pending: Pending | null = null;
  let transport: NurbsTransport | null = null;
  // A request the worker has not answered yet (possibly a stale one), and the newest
  // request waiting behind it.
  let busy = false;
  let waiting: NurbsRequest | null = null;
  // Set once a spawn returned null: from then on every job runs on this thread.
  let synchronous = false;

  const stop = (): void => {
    transport?.terminate();
    transport = null;
    busy = false;
    waiting = null;
  };

  /** Settle the current job's promise with an error and forget it. */
  const abandon = (err: Error): void => {
    const p = pending;
    pending = null;
    waiting = null;
    p?.reject(err);
  };

  const fail = (err: unknown): void => {
    stop();
    abandon(err instanceof Error ? err : new Error(String(err)));
  };

  /** Hand the worker the waiting request, if any. */
  const flush = (): void => {
    const req = waiting;
    waiting = null;
    if (!req || !transport) return;
    try {
      busy = true;
      transport.post(req);
    } catch (err) {
      fail(err);
    }
  };

  const handlers: TransportHandlers = {
    onMessage(res) {
      if (res.kind === 'progress') {
        if (pending && res.id === pending.id) pending.onStage?.(res.stage);
        return;
      }
      // Any answer frees the worker, stale or not.
      busy = false;
      const p = pending;
      if (p && res.id === p.id) {
        pending = null;
        if (res.kind === 'measured') {
          const { kind: _kind, id: _id, ...answer } = res;
          p.resolve(answer);
        } else if (res.kind === 'probed') {
          p.resolve(res.ok ? { ok: true, probes: res.probes } : { ok: false, error: res.error });
        } else if (res.kind === 'to-rails') {
          p.resolve(
            res.ok
              ? { ok: true, board: res.board, conversion: res.conversion, issues: res.issues }
              : { ok: false, error: res.error, issues: res.issues },
          );
        } else if (res.kind === 'converted') {
          p.resolve(
            res.ok
              ? { ok: true, doc: res.doc, conversion: res.conversion, issues: res.issues }
              : { ok: false, error: res.error, issues: res.issues },
          );
        } else if (res.ok) {
          p.resolve({
            ok: true,
            issues: res.issues,
            summary: res.summary,
            timings: res.timings,
            mesh: res.mesh,
            probes: res.probes,
          });
        } else {
          p.resolve({ ok: false, error: res.error, issues: res.issues });
        }
      }
      flush();
    },
    onError(message) {
      fail(new Error(message));
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
      req.kind === 'classic'
        ? compute.convertAndMesh(req.board, req.options, progress)
        : req.kind === 'doc'
          ? compute.meshDocument(req.doc, req.reference, req.options, progress, req.probes)
          : req.kind === 'probe'
            ? compute.probeDocument(req.doc, req.probes)
            : req.kind === 'convert'
              ? compute.convertToDoc(req.board)
              : req.kind === 'to-rails'
                ? compute.toRails(req)
                : req.kind === 'measure'
                  ? compute.measureDocument(req.doc)
                  : compute.meshTestBoard(req.name, req.options, progress);
    if (pending !== p) return; // superseded during the (blocking) compute: drop
    pending = null;
    p.resolve(out);
  };

  const submit = <A extends Answer>(
    build: (id: number) => NurbsRequest,
    onStage?: (s: NurbsStage) => void,
  ): Promise<A> => {
    // The previous job, if it is still waiting for its answer, is stale from here on.
    const previous = pending;
    pending = null;
    previous?.reject(new SupersededError());
    const id = ++nextId;
    const req = build(id);
    return new Promise<A>((resolve, reject) => {
      const p: Pending = { id, onStage, resolve: resolve as (a: Answer) => void, reject };
      pending = p;
      let t: NurbsTransport | null;
      try {
        t = ensureTransport();
      } catch (err) {
        // The worker could not even be constructed (blocked, offline, CSP).
        fail(err);
        return;
      }
      if (!t) {
        runSynchronously(req, p).catch((err: unknown) => {
          if (pending === p) abandon(err instanceof Error ? err : new Error(String(err)));
        });
        return;
      }
      // Newest wins: it replaces any request still waiting for the worker.
      waiting = req;
      if (!busy) flush();
    });
  };

  return {
    classic: (board, options, onStage) =>
      submit<NurbsAnswer>((id) => ({ kind: 'classic', id, board, options }), onStage),
    test: (name, options, onStage) =>
      submit<NurbsAnswer>((id) => ({ kind: 'test', id, name, options }), onStage),
    doc: (doc, reference, options, onStage, probes = []) =>
      submit<NurbsAnswer>((id) => ({ kind: 'doc', id, doc, reference, options, probes }), onStage),
    probe: (doc, probes, engine) =>
      submit<ProbeAnswer>((id) => ({
        kind: 'probe',
        id,
        doc,
        probes,
        ...(engine ? { engine } : {}),
      })),
    convert: (board) => submit<ConvertAnswer>((id) => ({ kind: 'convert', id, board })),
    toRails: (source) =>
      submit<ToRailsAnswer>((id) =>
        'model' in source
          ? { kind: 'to-rails', id, doc: source }
          : { kind: 'to-rails', id, classic: source },
      ),
    measure: (doc, engine) =>
      submit<MeasureAnswer>((id) => ({ kind: 'measure', id, doc, ...(engine ? { engine } : {}) })),
    cancel() {
      const p = pending;
      pending = null;
      waiting = null;
      p?.reject(new SupersededError());
    },
    dispose() {
      abandon(new SupersededError());
      stop();
    },
  };
}
