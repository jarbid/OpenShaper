import type { BezierBoard, BoardMesh } from '@openshaper/kernel';

/**
 * Scheduling for the tessellation worker.
 *
 * Generic over what a job produces, because the same scheduling serves two jobs:
 * the viewport mesh (keyed by target face size) and the exact curvature analysis
 * (`curvature-mesh.ts`, one key). Each runs on its own worker with its own queue,
 * so a second-long curvature fit never holds up the mesh a drag is waiting for.
 *
 * Every edit swaps the board, and the hull, the fins and the guides each ask for
 * the new board's mesh (the latter two only for its centre). Posting each ask
 * straight to the worker queued one ~40 ms job per pointer move — faster than the
 * worker drains them — plus duplicates for the same board. This queue:
 *
 *  - shares one job between every caller asking for the same `(board, faceSize)`;
 *  - keeps one job in flight and holds the rest here, where they can still be
 *    dropped;
 *  - drops a waiting job once every caller that asked for it has aborted (their
 *    effect was cleaned up because the board moved on), so a drag only ever
 *    computes the in-flight job and the latest board.
 *
 * A dropped job's promise rejects with an `AbortError`; the callers that asked for
 * it have all gone, so nobody observes it. A job already in flight is never
 * dropped — its result still lands in the cache.
 */
/** What the tessellation worker posts back for job `id`. */
export type WorkerReply<R = BoardMesh> = { id: number; result: R } | { id: number; error: string };

export interface MeshQueue<R = BoardMesh> {
  /** `key` tells jobs for the same board apart: the face size, for meshes. */
  request(board: BezierBoard, key: number, signal?: AbortSignal): Promise<R>;
  /** Hand back the worker's result for job `id`. */
  receive(id: number, result: R): void;
  /** The worker failed job `id`: reject it and move on to the next one. */
  fail(id: number, error: unknown): void;
  /** The worker itself is gone (failed to load, crashed): reject every job. */
  failAll(error: unknown): void;
}

interface Job<R> {
  id: number;
  board: BezierBoard;
  faceSize: number;
  /** Callers still interested in the result. */
  live: number;
  promise: Promise<R>;
  resolve: (result: R) => void;
  reject: (err: unknown) => void;
}

export function createMeshQueue<R = BoardMesh>(
  post: (id: number, board: BezierBoard, key: number) => void,
  onResult: (board: BezierBoard, key: number, result: R) => void = () => {},
): MeshQueue<R> {
  type J = Job<R>;
  let nextId = 1;
  let inFlight: J | null = null;
  const waiting: J[] = [];
  // Jobs not yet finished, by board and key, so identical asks share one.
  const open = new WeakMap<BezierBoard, Map<number, J>>();

  const forget = (job: J): void => {
    const byFace = open.get(job.board);
    byFace?.delete(job.faceSize);
    if (byFace?.size === 0) open.delete(job.board);
  };

  const pump = (): void => {
    if (inFlight) return;
    const job = waiting.shift();
    if (!job) return;
    inFlight = job;
    post(job.id, job.board, job.faceSize);
  };

  const release = (job: J): void => {
    job.live--;
    if (job.live > 0 || job === inFlight) return;
    const i = waiting.indexOf(job);
    if (i === -1) return;
    waiting.splice(i, 1);
    forget(job);
    job.reject(new DOMException('Superseded before it started', 'AbortError'));
  };

  const newJob = (board: BezierBoard, faceSize: number): J => {
    let resolve!: (result: R) => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<R>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const job: J = { id: nextId++, board, faceSize, live: 0, promise, resolve, reject };
    let byFace = open.get(board);
    if (!byFace) {
      byFace = new Map();
      open.set(board, byFace);
    }
    byFace.set(faceSize, job);
    waiting.push(job);
    return job;
  };

  return {
    request(board, faceSize, signal) {
      const job = open.get(board)?.get(faceSize) ?? newJob(board, faceSize);
      if (signal?.aborted) {
        // Nobody will wait for it; don't let it keep a fresh job alive.
        if (job.live === 0) {
          job.live = 1;
          release(job);
        }
        return job.promise;
      }
      job.live++;
      signal?.addEventListener('abort', () => release(job), { once: true });
      pump();
      return job.promise;
    },

    receive(id, result) {
      const job = inFlight;
      if (!job || job.id !== id) return;
      inFlight = null;
      forget(job);
      onResult(job.board, job.faceSize, result);
      job.resolve(result);
      pump();
    },

    fail(id, error) {
      const job = inFlight;
      if (!job || job.id !== id) return;
      inFlight = null;
      forget(job);
      job.reject(error);
      pump();
    },

    failAll(error) {
      const jobs = inFlight ? [inFlight, ...waiting] : [...waiting];
      inFlight = null;
      waiting.length = 0;
      for (const job of jobs) {
        forget(job);
        job.reject(error);
      }
    },
  };
}
