// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The "Deviation from ghost" analysis: the board's viewport mesh with, at every
 * vertex, its signed distance to the ghost board (`ghostDeviation` in the kernel).
 *
 * Pure, so it runs in the tessellation worker and in tests alike. The mesh is the
 * very one the hull shows at the same face size (`tessellateBoard` is deterministic),
 * so the deviation map is drawn on the hull's own triangles. Its vertices come a ring
 * per station, and the kernel builds each ghost section once per station.
 */
import {
  ghostDeviation,
  tessellateBoard,
  type BezierBoard,
  type BoardMesh,
} from '@openshaper/kernel';

export interface DeviationMesh extends BoardMesh {
  /**
   * Per vertex: signed distance (cm) to the ghost's surface in the vertex's station
   * plane. Positive is more foam than the ghost, negative less. NaN is no data:
   * past the ghost's ends, and the end caps' hubs (see {@link fanHubs}).
   */
  deviation: Float32Array;
  /** The smallest and largest deviation on the mesh (cm), or null with no data at all. */
  range: readonly [number, number] | null;
  /** How many vertices have no data. */
  noData: number;
}

/**
 * The most triangles a vertex of the mesh's stitched bands belongs to: two rings of
 * quads meet at it, and of the four quads around it, it is the corner shared by both
 * of their triangles in two and by one in the other two. A vertex on the end ring has
 * fewer. Pinned by `deviation-mesh.test.ts` on both of the tessellator's paths.
 */
export const BAND_VALENCE = 6;

/**
 * The vertices the mesh fans its end caps to: the tip of a pointed end, the middle
 * of a blunt end's transom, the centroid of a notch lobe's end. Each closes a whole
 * ring, so it belongs to one triangle per ring point, more than any band vertex.
 *
 * A hub is not a point of the lofted surface. A pointed tip is where the section
 * shrinks to nothing, and a transom's middle lies inside the section, in the very
 * plane the deviation is measured in: either way there is no section edge for it to
 * be measured from, and the distance the kernel would give is to the ghost's edge
 * from inside the foam. So the map leaves hubs as no data, and the cap's triangles
 * shade from their rim's colours into the no-data hatch.
 */
export const fanHubs = (indices: Uint32Array, vertexCount: number): number[] => {
  const valence = new Uint32Array(vertexCount);
  for (const v of indices) valence[v]!++;
  const hubs: number[] = [];
  for (let v = 0; v < vertexCount; v++) if (valence[v]! > BAND_VALENCE) hubs.push(v);
  return hubs;
};

/**
 * The board's viewport mesh at `targetFaceSize`, with its deviation from `ghost` at
 * every vertex.
 */
export const boardDeviationMesh = (
  board: BezierBoard,
  ghost: BezierBoard,
  targetFaceSize: number,
): DeviationMesh => {
  const mesh = tessellateBoard(board, { targetFaceSize });
  const vertexCount = mesh.positions.length / 3;
  const deviation = Float32Array.from(ghostDeviation(ghost, mesh.positions));
  for (const v of fanHubs(mesh.indices, vertexCount)) deviation[v] = Number.NaN;

  let lo = Infinity;
  let hi = -Infinity;
  let noData = 0;
  for (const d of deviation) {
    if (Number.isNaN(d)) {
      noData++;
      continue;
    }
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  return { ...mesh, deviation, range: lo <= hi ? [lo, hi] : null, noData };
};

/** Every buffer in a result, for the worker to transfer back. */
export const deviationTransferables = (m: DeviationMesh): ArrayBuffer[] =>
  [m.positions, m.normals, m.indices, m.deviation].map((a) => a.buffer as ArrayBuffer);
