import type { BezierBoard, BoardMesh } from '@openshaper/kernel';

/**
 * Scheduling for the tessellation worker.
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
export interface MeshQueue {
  request(board: BezierBoard, targetFaceSize: number, signal?: AbortSignal): Promise<BoardMesh>;
  /** Hand back the worker's result for job `id`. */
  receive(id: number, mesh: BoardMesh): void;
}

interface Job {
  id: number;
  board: BezierBoard;
  faceSize: number;
  /** Callers still interested in the result. */
  live: number;
  promise: Promise<BoardMesh>;
  resolve: (mesh: BoardMesh) => void;
  reject: (err: unknown) => void;
}

export function createMeshQueue(
  post: (id: number, board: BezierBoard, targetFaceSize: number) => void,
  onResult: (board: BezierBoard, targetFaceSize: number, mesh: BoardMesh) => void = () => {},
): MeshQueue {
  let nextId = 1;
  let inFlight: Job | null = null;
  const waiting: Job[] = [];
  // Jobs not yet finished, by board and face size, so identical asks share one.
  const open = new WeakMap<BezierBoard, Map<number, Job>>();

  const forget = (job: Job): void => {
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

  const release = (job: Job): void => {
    job.live--;
    if (job.live > 0 || job === inFlight) return;
    const i = waiting.indexOf(job);
    if (i === -1) return;
    waiting.splice(i, 1);
    forget(job);
    job.reject(new DOMException('Superseded before it started', 'AbortError'));
  };

  const newJob = (board: BezierBoard, faceSize: number): Job => {
    let resolve!: (mesh: BoardMesh) => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<BoardMesh>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const job: Job = { id: nextId++, board, faceSize, live: 0, promise, resolve, reject };
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

    receive(id, mesh) {
      const job = inFlight;
      if (!job || job.id !== id) return;
      inFlight = null;
      forget(job);
      onResult(job.board, job.faceSize, mesh);
      job.resolve(mesh);
      pump();
    },
  };
}
