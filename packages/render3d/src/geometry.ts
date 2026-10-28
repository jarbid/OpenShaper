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
import { boardCurvatureMesh, type CurvatureMesh } from './curvature-mesh';
import { boardDeviationMesh, type DeviationMesh } from './deviation-mesh';
import { apexGuideLine, type GuideLine } from './guide-lines';
import { createMeshQueue, type MeshQueue, type WorkerReply } from './mesh-queue';
import type { WorkerRequest } from './worker-protocol';

// Tessellation walks many stations, each interpolating a cross-section — the
// heaviest 3D cost, and far heavier at fine target-face sizes. We offload it to a
// Web Worker (below) and memoize results by board identity + target size. The
// kernel is immutable and swaps the board reference on every edit, so a new
// reference is a new cache key.
//
// The cache is a small LRU, not a WeakMap: the undo history keeps up to 200 old
// boards alive, and a WeakMap would keep each one's mesh (1–3.4 MB) alive with it.
// A handful of entries covers what is actually reused — the current board, shared
// by hull, fins and guides, and the last few undo steps.
export const MESH_CACHE_SIZE = 8;
/**
 * Curvature results are 3–5 MB each and only the current board's is on screen;
 * two covers switching between the analysis modes and one step of undo.
 */
export const CURVATURE_CACHE_SIZE = 2;
/**
 * Deviation results are the viewport mesh plus a float per vertex (1–7 MB); two
 * covers one step of undo and a change of mesh quality.
 */
export const DEVIATION_CACHE_SIZE = 2;

/** A least-recently-used cache keyed by board identity and a key compared by identity. */
const createLru = <R, K = number>(size: number) => {
  // Most recently used last.
  const entries: { board: BezierBoard; key: K; value: R }[] = [];
  const find = (board: BezierBoard, key: K) =>
    entries.findIndex((e) => e.board === board && e.key === key);
  return {
    get(board: BezierBoard, key: K): R | undefined {
      const i = find(board, key);
      if (i === -1) return undefined;
      const [hit] = entries.splice(i, 1);
      entries.push(hit!);
      return hit!.value;
    },
    put(board: BezierBoard, key: K, value: R): void {
      const i = find(board, key);
      if (i !== -1) entries.splice(i, 1);
      entries.push({ board, key, value });
      if (entries.length > size) entries.shift();
    },
    size: () => entries.length,
  };
};

const meshCache = createLru<BoardMesh>(MESH_CACHE_SIZE);
const curvatureCache = createLru<CurvatureMesh>(CURVATURE_CACHE_SIZE);

/**
 * What a deviation job is for, besides the board: the ghost it is measured against
 * and the mesh density. Interned per (ghost, face size), because the queue and the
 * cache compare keys by identity.
 */
interface DeviationKey {
  readonly ghost: BezierBoard;
  readonly faceSize: number;
}
const deviationKeys = new WeakMap<BezierBoard, Map<number, DeviationKey>>();
const deviationKey = (ghost: BezierBoard, faceSize: number): DeviationKey => {
  let byFace = deviationKeys.get(ghost);
  if (!byFace) {
    byFace = new Map();
    deviationKeys.set(ghost, byFace);
  }
  let key = byFace.get(faceSize);
  if (!key) {
    key = { ghost, faceSize };
    byFace.set(faceSize, key);
  }
  return key;
};

const deviationCache = createLru<DeviationMesh, DeviationKey>(DEVIATION_CACHE_SIZE);

/**
 * Apex guides are a few hundred points each; as many as meshes, so every board whose
 * mesh is cached can have its line back without a second job.
 */
const apexCache = createLru<GuideLine | null>(MESH_CACHE_SIZE);

/** Test hook: how many meshes the cache holds. */
export const meshCacheSize = (): number => meshCache.size();

// --- worker plumbing (lazy, client-only) ---------------------------------

/**
 * A job queue backed by its own lazily started tessellation worker.
 *
 * Meshes, curvature, deviation and the apex guide each get one: a curvature job takes
 * the better part of a second, a deviation job a tenth to a third of one, an apex job
 * tens of milliseconds, and on a shared worker every mesh a drag asks for would wait
 * behind them.
 */
const workerQueue = <R, K = number>(
  toRequest: (id: number, board: BezierBoard, key: K) => WorkerRequest,
  onResult: (board: BezierBoard, key: K, result: R) => void,
): (() => MeshQueue<R, K>) => {
  let queue: MeshQueue<R, K> | null = null;
  return () => {
    if (queue) return queue;
    const worker = new Worker(new URL('./tessellate.worker.ts', import.meta.url), {
      type: 'module',
    });
    const q = createMeshQueue<R, K>(
      (id, board, key) => worker.postMessage(toRequest(id, board, key)),
      onResult,
    );
    worker.onmessage = (e: MessageEvent<WorkerReply<R>>) => {
      const r = e.data;
      if ('error' in r) q.fail(r.id, new Error(r.error));
      else q.receive(r.id, r.result);
    };
    // The worker script failed to load or crashed: settle everything. The next
    // request starts a fresh worker.
    worker.onerror = (e) => {
      e.preventDefault();
      worker.terminate();
      if (queue === q) queue = null;
      q.failAll(new Error(e.message || 'Tessellation worker failed'));
    };
    queue = q;
    return q;
  };
};

const meshQueue = workerQueue<BoardMesh>(
  (id, board, targetFaceSize) => ({ kind: 'mesh', id, board, targetFaceSize }),
  (board, faceSize, mesh) => meshCache.put(board, faceSize, mesh),
);

/** Curvature has one job per board; the queue's key is unused. */
const CURVATURE_KEY = 0;
const curvatureQueue = workerQueue<CurvatureMesh>(
  (id, board) => ({ kind: 'curvature', id, board }),
  (board, key, result) => curvatureCache.put(board, key, result),
);

const deviationQueue = workerQueue<DeviationMesh, DeviationKey>(
  (id, board, { ghost, faceSize }) => ({
    kind: 'deviation',
    id,
    board,
    ghost,
    targetFaceSize: faceSize,
  }),
  (board, key, result) => deviationCache.put(board, key, result),
);

const apexQueue = workerQueue<GuideLine | null>(
  (id, board, targetFaceSize) => ({ kind: 'apex', id, board, targetFaceSize }),
  (board, faceSize, line) => apexCache.put(board, faceSize, line),
);

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
  const cached = meshCache.get(board, targetFaceSize);
  if (cached) return Promise.resolve(cached);

  if (typeof Worker === 'undefined') {
    const mesh = tessellateBoard(board, { targetFaceSize });
    meshCache.put(board, targetFaceSize, mesh);
    return Promise.resolve(mesh);
  }

  return meshQueue().request(board, targetFaceSize, signal);
}

/**
 * The board's exact curvature analysis (`curvature-mesh.ts`): fit, then tessellate
 * with curvature at every vertex. Same contract as {@link tessellateAsync} — off the
 * main thread when it can be, cached, and dropped while still waiting once every
 * asker's `signal` has aborted.
 *
 * Rejects for a concave tail, which the fit does not model; callers check
 * `curvatureUnsupported` first so as to say why rather than fail.
 */
export function curvatureAsync(board: BezierBoard, signal?: AbortSignal): Promise<CurvatureMesh> {
  const cached = curvatureCache.get(board, CURVATURE_KEY);
  if (cached) return Promise.resolve(cached);

  if (typeof Worker === 'undefined') {
    try {
      const result = boardCurvatureMesh(board);
      curvatureCache.put(board, CURVATURE_KEY, result);
      return Promise.resolve(result);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  return curvatureQueue().request(board, CURVATURE_KEY, signal);
}

/**
 * The board's deviation from `ghost` (`deviation-mesh.ts`): its viewport mesh at
 * `targetFaceSize`, with the signed distance to the ghost at every vertex. Same
 * contract as {@link tessellateAsync} — off the main thread when it can be, cached
 * by `(board, ghost, targetFaceSize)`, and dropped while still waiting once every
 * asker's `signal` has aborted.
 */
export function deviationAsync(
  board: BezierBoard,
  ghost: BezierBoard,
  targetFaceSize: number,
  signal?: AbortSignal,
): Promise<DeviationMesh> {
  const key = deviationKey(ghost, targetFaceSize);
  const cached = deviationCache.get(board, key);
  if (cached) return Promise.resolve(cached);

  if (typeof Worker === 'undefined') {
    try {
      const result = boardDeviationMesh(board, ghost, targetFaceSize);
      deviationCache.put(board, key, result);
      return Promise.resolve(result);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  return deviationQueue().request(board, key, signal);
}

/**
 * The rail apex guide (`apexGuideLine`) at the mesh density for `targetFaceSize`. Same
 * contract as {@link tessellateAsync} — off the main thread when it can be, cached by
 * `(board, targetFaceSize)`, and dropped while still waiting once every asker's
 * `signal` has aborted. Resolves to null for a board with no line to draw.
 */
export function apexGuideAsync(
  board: BezierBoard,
  targetFaceSize: number,
  signal?: AbortSignal,
): Promise<GuideLine | null> {
  const cached = apexCache.get(board, targetFaceSize);
  if (cached !== undefined) return Promise.resolve(cached);

  if (typeof Worker === 'undefined') {
    try {
      const line = apexGuideLine(board, targetFaceSize);
      apexCache.put(board, targetFaceSize, line);
      return Promise.resolve(line);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  return apexQueue().request(board, targetFaceSize, signal);
}

/**
 * The deviation analysis as a BufferGeometry, in board coordinates (not centred: the
 * caller places it, as for the curvature analysis).
 *
 * `aDeviation` is (signed distance in cm, 1) where there is data and (0, 0) where
 * there is none: NaN never reaches the GPU, where comparisons with it are not
 * reliable across drivers. The other arrays are the cached result's own — read,
 * never written.
 */
export function deviationGeometry(mesh: DeviationMesh): BufferGeometry {
  const packed = new Float32Array(mesh.deviation.length * 2);
  mesh.deviation.forEach((d, i) => {
    if (Number.isNaN(d)) return;
    packed[i * 2] = d;
    packed[i * 2 + 1] = 1;
  });
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(mesh.positions, 3));
  g.setAttribute('normal', new BufferAttribute(mesh.normals, 3));
  g.setAttribute('aDeviation', new BufferAttribute(packed, 2));
  g.setIndex(new BufferAttribute(mesh.indices, 1));
  g.computeBoundingSphere();
  return g;
}

/**
 * The curvature analysis as a BufferGeometry, in board coordinates (not centred:
 * the caller places it with the hull's offset, as for fins and guides).
 *
 * Group 0 is the hull, carrying `aMean`, `aGauss` and `aRadius` for the analysis
 * shader; group 1 is the two end caps, which have no curvature and take a plain
 * material. The arrays are the cached result's own — read, never written.
 */
export function curvatureGeometry(mesh: CurvatureMesh): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(mesh.positions, 3));
  g.setAttribute('normal', new BufferAttribute(mesh.normals, 3));
  g.setAttribute('aMean', new BufferAttribute(mesh.mean, 1));
  g.setAttribute('aGauss', new BufferAttribute(mesh.gaussian, 1));
  g.setAttribute('aRadius', new BufferAttribute(mesh.minRadius, 1));
  g.setIndex(new BufferAttribute(mesh.indices, 1));
  g.addGroup(0, mesh.hullIndexCount, 0);
  g.addGroup(mesh.hullIndexCount, mesh.indices.length - mesh.hullIndexCount, 1);
  g.computeBoundingSphere();
  return g;
}

/**
 * A plain shaded BufferGeometry of an external surface (`ExternalSurface.curvature`),
 * in board coordinates and NOT centred: the caller places it with the hull's offset,
 * as for the curvature and deviation surfaces. The arrays are the result's own, read
 * and never written. Normals are the exact ones the surface came with.
 */
export function surfaceGeometry(mesh: BoardMesh): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(mesh.positions, 3));
  g.setAttribute('normal', new BufferAttribute(mesh.normals, 3));
  g.setIndex(new BufferAttribute(mesh.indices, 1));
  g.computeBoundingSphere();
  return g;
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
