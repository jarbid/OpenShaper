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
import { createMeshQueue, type MeshQueue } from './mesh-queue';

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
let queue: MeshQueue | null = null;

const ensureQueue = (): MeshQueue => {
  if (queue) return queue;
  const worker = new Worker(new URL('./tessellate.worker.ts', import.meta.url), {
    type: 'module',
  });
  const q = createMeshQueue(
    (id, board, targetFaceSize) => worker.postMessage({ id, board, targetFaceSize }),
    putCached,
  );
  worker.onmessage = (e: MessageEvent<{ id: number; mesh: BoardMesh }>) =>
    q.receive(e.data.id, e.data.mesh);
  queue = q;
  return q;
};

/**
 * Tessellate the board at `targetFaceSize` (cm), off the main thread when a Worker
 * is available (browser), falling back to synchronous tessellation otherwise (SSR /
 * tests). Results are cached by `(board, targetFaceSize)`.
 *
 * Pass the `signal` of the effect that asked: once every asker of a job that has
 * not started yet has aborted, the job is dropped (see mesh-queue.ts).
 */
export function tessellateAsync(
  board: BezierBoard,
  targetFaceSize: number,
  signal?: AbortSignal,
): Promise<BoardMesh> {
  const cached = getCached(board, targetFaceSize);
  if (cached) return Promise.resolve(cached);

  if (typeof Worker === 'undefined') {
    const mesh = tessellateBoard(board, { targetFaceSize });
    putCached(board, targetFaceSize, mesh);
    return Promise.resolve(mesh);
  }

  return ensureQueue().request(board, targetFaceSize, signal);
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
 * The bounding-box centre of a board mesh — exactly what `geometry.center()`
 * subtracts in {@link meshToGeometry}.
 *
 * Anything built in board coordinates (fins, guide lines) must be wrapped in a
 * group translated by the negation of this to stay aligned with the hull.
 */
export const boardCenter = (mesh: BoardMesh): [number, number, number] => {
  const p = mesh.positions;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i]!;
    const y = p[i + 1]!;
    const z = p[i + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
};

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
