import { getInterpolatedCrossSection, getLength, getRockerAtPos, type BezierBoard } from './board';
import { pointByTT } from './bezier-spline';

/**
 * A triangle mesh of the board surface, ready for upload to a GPU buffer.
 *
 * Coordinate convention (cm): X = nose..tail length axis, Y = width (across,
 * rail-to-rail), Z = height (up). `positions` and `normals` are flat xyz triples;
 * `indices` are triangle vertex indices (3 per triangle).
 */
export interface BoardMesh {
  positions: Float32Array;
  indices: Uint32Array;
  normals: Float32Array;
}

export interface TessellateOptions {
  /** Number of longitudinal stations sampled across the length (default 120). */
  lengthSteps?: number;
  /** Number of points around each cross-section ring (default 48). */
  ringSteps?: number;
}

const DEFAULT_LENGTH_STEPS = 120;
const DEFAULT_RING_STEPS = 48;

const isFinite3 = (x: number, y: number, z: number): boolean =>
  Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);

interface Vert3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Build a full cross-section ring at station `x` as `ringSteps` 3D points.
 *
 * The profile spline runs in (x = distance from centerline, y = height) and
 * describes the +Y rail half. We walk tt 0..1 down the +Y side, then mirror the
 * tt 1..0 sweep onto the -Y side, giving a closed loop around the section.
 * Returns null if the section is missing or degenerate (NaN / collapsed).
 */
const buildRing = (board: BezierBoard, x: number, ringSteps: number): Vert3[] | null => {
  const cs = getInterpolatedCrossSection(board, x);
  if (!cs) return null;

  const rocker = getRockerAtPos(board, x);
  if (!Number.isFinite(rocker)) return null;

  // Half the ring on each rail. Use an even count so both sides match.
  const half = Math.max(2, Math.floor(ringSteps / 2));
  const ring: Vert3[] = [];

  // +Y rail: tt 0 (bottom centerline) -> tt 1 (deck centerline).
  for (let i = 0; i < half; i++) {
    const tt = i / (half - 1);
    const p = pointByTT(cs.spline, tt);
    const vx = x;
    const vy = p.x;
    const vz = p.y + rocker;
    if (!isFinite3(vx, vy, vz)) return null;
    ring.push({ x: vx, y: vy, z: vz });
  }

  // -Y rail: tt 1 -> tt 0, mirrored across the centerline (y = -profile.x).
  // Skip the two shared centerline endpoints (tt=1 and tt=0) to avoid duplicates.
  for (let i = half - 2; i >= 1; i--) {
    const tt = i / (half - 1);
    const p = pointByTT(cs.spline, tt);
    const vx = x;
    const vy = -p.x;
    const vz = p.y + rocker;
    if (!isFinite3(vx, vy, vz)) return null;
    ring.push({ x: vx, y: vy, z: vz });
  }

  if (ring.length < 3) return null;
  return ring;
};

const addVert = (positions: number[], v: Vert3): number => {
  const index = positions.length / 3;
  positions.push(v.x, v.y, v.z);
  return index;
};

/**
 * Tessellate a board into a closed triangle mesh.
 *
 * Samples `lengthSteps` stations across (0, length), builds a `ringSteps`-point
 * cross-section ring at each, stitches adjacent rings with quads (two triangles),
 * and caps the nose/tail with fans to a tip vertex. Per-vertex normals are the
 * area-weighted average of adjacent face normals.
 *
 * Robust against null/degenerate sections (skipped) and NaN samples.
 */
export const tessellateBoard = (board: BezierBoard, opts: TessellateOptions = {}): BoardMesh => {
  const lengthSteps = Math.max(2, Math.floor(opts.lengthSteps ?? DEFAULT_LENGTH_STEPS));
  const ringSteps = Math.max(4, Math.floor(opts.ringSteps ?? DEFAULT_RING_STEPS));

  const length = getLength(board);
  const empty = (): BoardMesh => ({
    positions: new Float32Array(0),
    indices: new Uint32Array(0),
    normals: new Float32Array(0),
  });
  if (!Number.isFinite(length) || length <= 0) return empty();

  // A tiny inset keeps us off the exact tips where the interpolated section is null.
  const eps = Math.min(0.5, length * 1e-3);
  const x0 = eps;
  const x1 = length - eps;

  const positions: number[] = [];
  const indices: number[] = [];

  // Each entry: the vertex indices for one ring (a closed loop).
  const rings: number[][] = [];

  for (let s = 0; s < lengthSteps; s++) {
    const x = x0 + ((x1 - x0) * s) / (lengthSteps - 1);
    const ring = buildRing(board, x, ringSteps);
    if (!ring) continue;
    const idx = ring.map((v) => addVert(positions, v));
    rings.push(idx);
  }

  if (rings.length < 2) return empty();

  // Stitch adjacent rings.
  for (let r = 0; r < rings.length - 1; r++) {
    const a = rings[r]!;
    const b = rings[r + 1]!;
    // Rings can differ in length if a degenerate section produced fewer points;
    // stitch only the shared prefix to stay robust.
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const i0 = i;
      const i1 = (i + 1) % n;
      const a0 = a[i0]!;
      const a1 = a[i1]!;
      const b0 = b[i0]!;
      const b1 = b[i1]!;
      // Quad (a0,a1,b1,b0) -> two triangles, wound consistently.
      indices.push(a0, b0, a1);
      indices.push(a1, b0, b1);
    }
  }

  // Cap the ends with a tip vertex fan.
  const capEnd = (ring: number[], tipX: number, reverse: boolean): void => {
    if (ring.length < 3) return;
    // Tip vertex = centroid of the ring collapsed to the centerline (y=0).
    let zSum = 0;
    for (const vi of ring) zSum += positions[vi * 3 + 2]!;
    const tipZ = zSum / ring.length;
    if (!isFinite3(tipX, 0, tipZ)) return;
    const tip = addVert(positions, { x: tipX, y: 0, z: tipZ });
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const i0 = ring[i]!;
      const i1 = ring[(i + 1) % n]!;
      if (reverse) indices.push(tip, i1, i0);
      else indices.push(tip, i0, i1);
    }
  };

  capEnd(rings[0]!, x0 - eps, true);
  capEnd(rings[rings.length - 1]!, x1 + eps, false);

  // --- per-vertex normals: average of adjacent face normals ---
  const vertexCount = positions.length / 3;
  const normals = new Float32Array(positions.length);

  for (let t = 0; t < indices.length; t += 3) {
    const ia = indices[t]!;
    const ib = indices[t + 1]!;
    const ic = indices[t + 2]!;

    const ax = positions[ia * 3]!;
    const ay = positions[ia * 3 + 1]!;
    const az = positions[ia * 3 + 2]!;
    const bx = positions[ib * 3]!;
    const by = positions[ib * 3 + 1]!;
    const bz = positions[ib * 3 + 2]!;
    const cx = positions[ic * 3]!;
    const cy = positions[ic * 3 + 1]!;
    const cz = positions[ic * 3 + 2]!;

    const e1x = bx - ax;
    const e1y = by - ay;
    const e1z = bz - az;
    const e2x = cx - ax;
    const e2y = cy - ay;
    const e2z = cz - az;

    // Cross product (unnormalized => area-weighted).
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    if (!isFinite3(nx, ny, nz)) continue;

    normals[ia * 3] = normals[ia * 3]! + nx;
    normals[ia * 3 + 1] = normals[ia * 3 + 1]! + ny;
    normals[ia * 3 + 2] = normals[ia * 3 + 2]! + nz;
    normals[ib * 3] = normals[ib * 3]! + nx;
    normals[ib * 3 + 1] = normals[ib * 3 + 1]! + ny;
    normals[ib * 3 + 2] = normals[ib * 3 + 2]! + nz;
    normals[ic * 3] = normals[ic * 3]! + nx;
    normals[ic * 3 + 1] = normals[ic * 3 + 1]! + ny;
    normals[ic * 3 + 2] = normals[ic * 3 + 2]! + nz;
  }

  for (let v = 0; v < vertexCount; v++) {
    const nx = normals[v * 3]!;
    const ny = normals[v * 3 + 1]!;
    const nz = normals[v * 3 + 2]!;
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-9 && Number.isFinite(len)) {
      normals[v * 3] = nx / len;
      normals[v * 3 + 1] = ny / len;
      normals[v * 3 + 2] = nz / len;
    } else {
      // Degenerate vertex: fall back to a stable up normal rather than NaN/zero.
      normals[v * 3] = 0;
      normals[v * 3 + 1] = 0;
      normals[v * 3 + 2] = 1;
    }
  }

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    normals,
  };
};
