import { tessellateBoard, type BezierBoard, type BoardMesh } from '@openshaper/kernel';
import { BufferAttribute, BufferGeometry } from 'three';

// Tessellation walks ~120 stations, each interpolating a cross-section — the
// heaviest per-frame cost in the 3D view. Both consumers below (mesh + span) need
// it, and appearance toggles (material/lighting) re-render the view without
// changing the board, so memoize by board identity. The kernel is immutable and
// swaps the board reference on every edit, so a new reference invalidates the
// cache; a WeakMap lets superseded boards be GC'd.
const meshCache = new WeakMap<BezierBoard, BoardMesh>();

const tessellate = (board: BezierBoard): BoardMesh => {
  const hit = meshCache.get(board);
  if (hit) return hit;
  const mesh = tessellateBoard(board);
  meshCache.set(board, mesh);
  return mesh;
};

/**
 * Build a centered Three.js BufferGeometry from the kernel board tessellation.
 * Centering puts the board's bounding-box midpoint at the origin so a fixed
 * camera/orbit target frames it regardless of board size.
 */
export function boardGeometry(board: BezierBoard): BufferGeometry {
  const mesh = tessellate(board);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(mesh.positions, 3));
  g.setAttribute('normal', new BufferAttribute(mesh.normals, 3));
  g.setIndex(new BufferAttribute(mesh.indices, 1));
  g.computeBoundingBox();
  g.center();
  return g;
}

/** Rough board size (max bbox dimension, cm) for camera framing. */
export function boardSpan(board: BezierBoard): number {
  const mesh = tessellate(board);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = mesh.positions[i]!;
    if (x < min) min = x;
    if (x > max) max = x;
  }
  return Number.isFinite(max - min) && max > min ? max - min : 200;
}
