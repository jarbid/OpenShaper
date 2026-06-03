import {
  getLength,
  getMaxRocker,
  getMaxThickness,
  getMaxWidth,
  tessellateBoard,
  type BezierBoard,
  type BoardMesh,
} from '@openshaper/kernel';
import { BufferAttribute, BufferGeometry } from 'three';

// Tessellation walks many stations, each interpolating a cross-section — the
// heaviest 3D cost, and far heavier at fine target-face sizes. We offload it to a
// Web Worker (below) and memoize results by board identity + target size. The
// kernel is immutable and swaps the board reference on every edit, so a new
// reference invalidates the cache; a WeakMap lets superseded boards be GC'd.
const meshCache = new WeakMap<BezierBoard, Map<number, BoardMesh>>();

const getCached = (board: BezierBoard, faceSize: number): BoardMesh | undefined =>
  meshCache.get(board)?.get(faceSize);

const putCached = (board: BezierBoard, faceSize: number, mesh: BoardMesh): void => {
  let byFace = meshCache.get(board);
  if (!byFace) {
    byFace = new Map();
    meshCache.set(board, byFace);
  }
  byFace.set(faceSize, mesh);
};

// --- worker plumbing (lazy, client-only) ---------------------------------
let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, (mesh: BoardMesh) => void>();

const ensureWorker = (): Worker => {
  if (worker) return worker;
  worker = new Worker(new URL('./tessellate.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<{ id: number; mesh: BoardMesh }>) => {
    const resolve = pending.get(e.data.id);
    if (resolve) {
      pending.delete(e.data.id);
      resolve(e.data.mesh);
    }
  };
  return worker;
};

/**
 * Tessellate the board at `targetFaceSize` (cm), off the main thread when a Worker
 * is available (browser), falling back to synchronous tessellation otherwise (SSR /
 * tests). Results are cached by `(board, targetFaceSize)`.
 */
export function tessellateAsync(board: BezierBoard, targetFaceSize: number): Promise<BoardMesh> {
  const cached = getCached(board, targetFaceSize);
  if (cached) return Promise.resolve(cached);

  if (typeof Worker === 'undefined') {
    const mesh = tessellateBoard(board, { targetFaceSize });
    putCached(board, targetFaceSize, mesh);
    return Promise.resolve(mesh);
  }

  const id = nextId++;
  return new Promise<BoardMesh>((resolve) => {
    pending.set(id, (mesh) => {
      putCached(board, targetFaceSize, mesh);
      resolve(mesh);
    });
    ensureWorker().postMessage({ id, board, targetFaceSize });
  });
}

/**
 * Build a centered Three.js BufferGeometry from a kernel mesh. Positions are copied
 * because `center()` translates them in place — we must not mutate the cached mesh.
 */
export function meshToGeometry(mesh: BoardMesh): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(mesh.positions), 3));
  g.setAttribute('normal', new BufferAttribute(mesh.normals, 3));
  g.setIndex(new BufferAttribute(mesh.indices, 1));
  g.computeBoundingBox();
  g.center();
  return g;
}

/**
 * Synchronous board → centered BufferGeometry (used by tests and as a non-worker
 * fallback). The interactive view uses {@link tessellateAsync} + {@link meshToGeometry}.
 */
export function boardGeometry(board: BezierBoard, targetFaceSize?: number): BufferGeometry {
  return meshToGeometry(tessellateBoard(board, targetFaceSize ? { targetFaceSize } : {}));
}

/**
 * Rough board size (cm) for camera framing, computed straight from kernel getters
 * — no tessellation needed, so it stays synchronous and cheap.
 */
export function boardSpan(board: BezierBoard): number {
  const span = Math.max(
    getLength(board),
    getMaxWidth(board),
    getMaxThickness(board) + getMaxRocker(board),
  );
  return Number.isFinite(span) && span > 0 ? span : 200;
}
