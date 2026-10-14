// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * How far a board's surface lies from a reference ("ghost") board's, point by point:
 * the deviation map the 3D view paints.
 *
 * Measured in each point's station plane. A point at length position x is compared
 * with the ghost's cross-section at the same x, taken as the closed loops the mesh
 * draws there (`crossSectionLoops`), so inside a swallow / fish notch the ghost is its
 * two lobes and not one ring across the gap. Both boards keep the tail at x = 0 (a
 * rule, never detected), so x means the same on both and there is no alignment step.
 * There should not be one: aligning the two would hide a change of length, which is
 * exactly the kind of change a shaper wants to see.
 *
 * Signed: positive where the point lies outside the ghost (more foam than the
 * reference), negative inside it (less), zero on it. NaN where the ghost has no
 * section at that x — past either of its ends, or where its section degenerates —
 * which the view shows as "no data".
 *
 * The distance is the shortest one within the station plane, not in 3D. On the deck,
 * bottom and rails, whose surface runs along the board, the two agree. Near the tips,
 * where the surface turns to face along the length, a change of length shows up as a
 * difference across the section: that is what the station plane measures there.
 */
import { getLength, type BezierBoard } from './board';
import { crossSectionLoops, type GuidePoint } from './guides';
import { tessellationSteps } from './tessellate';

/**
 * Default spacing (cm) of the points around each ghost ring, turned into a count the
 * way the mesh sizes its own rings (`tessellationSteps`, capped where the mesh caps
 * it: 400 points, which a quarter centimetre reaches on all three golden boards).
 *
 * The ghost ring is a polygon through points on the ghost's surface, so each chord
 * cuts slightly inside a convex stretch of the section (a rail) and outside a concave
 * one (a tuck, a bottom concave). A point exactly on the ghost's surface between two
 * ring points reads that chord's sagitta instead of zero. Measured with every ring
 * vertex of each golden board's mesh against the board itself, worst |deviation|:
 *
 *   ghost ring    shortboard   funboard   longboard     (fine mesh, 0.5 cm faces)
 *   400              0.052 mm    0.089 mm    0.082 mm
 *   800              0.022 mm    0.041 mm    0.027 mm
 *   1600             0.009 mm    0.017 mm    0.009 mm
 *
 * 400 keeps the worst case under a tenth of a millimetre, a tenth of the tightest band
 * the view offers, at well under half the cost of 1600 (`deviation.test.ts` pins it).
 */
export const DEVIATION_RING_SPACING = 0.25;

/**
 * How far (cm) past either end of the ghost a point may lie and still be measured
 * against the end section rather than read as "no data". Ten microns: the mesh stores
 * positions as 32-bit floats, which can put a station that sits exactly on the end a
 * rounding error beyond it, and that must not turn a whole ring grey.
 */
export const DEVIATION_END_TOLERANCE = 1e-3;

export interface GhostDeviationOptions {
  /**
   * Points per ghost ring, counted as the mesh counts them. Default: derived from
   * {@link DEVIATION_RING_SPACING}.
   */
  ringSteps?: number;
}

/** Floats per packed edge: start (y, z), direction (dy, dz), and 1 / |direction|². */
const EDGE = 5;

/**
 * Edges per bounding box. A point is measured against every box first and only opens
 * the boxes that could hold an edge nearer than the best so far, or that the
 * horizontal line through it crosses on its +y side (the inside test). On a 400-point
 * ring that is a handful of its 25 boxes. Same answer as visiting every edge (the
 * tests check it against a brute-force one); on the golden boards' meshes the whole
 * measurement takes a third to a half of the time.
 */
const CHUNK = 16;

/** A station's ghost loops, packed for measuring points against. */
interface Station {
  /** {@link EDGE} floats per edge, loop after loop. */
  readonly edges: Float64Array;
  /** Per {@link CHUNK} consecutive edges: minY, maxY, minZ, maxZ. */
  readonly boxes: Float64Array;
}

const packLoops = (loops: readonly (readonly GuidePoint[])[]): Station => {
  let count = 0;
  for (const loop of loops) count += loop.length;
  const edges = new Float64Array(count * EDGE);
  const boxes = new Float64Array(Math.ceil(count / CHUNK) * 4);
  let e = 0;
  for (const loop of loops) {
    const n = loop.length;
    for (let i = 0; i < n; i++, e++) {
      const a = loop[i]!;
      const b = loop[(i + 1) % n]!;
      const dy = b.y - a.y;
      const dz = b.z - a.z;
      const len2 = dy * dy + dz * dz;
      const k = e * EDGE;
      edges[k] = a.y;
      edges[k + 1] = a.z;
      edges[k + 2] = dy;
      edges[k + 3] = dz;
      edges[k + 4] = len2 > 0 ? 1 / len2 : 0;

      const c = Math.floor(e / CHUNK) * 4;
      const first = e % CHUNK === 0;
      boxes[c] = first ? Math.min(a.y, b.y) : Math.min(boxes[c]!, a.y, b.y);
      boxes[c + 1] = first ? Math.max(a.y, b.y) : Math.max(boxes[c + 1]!, a.y, b.y);
      boxes[c + 2] = first ? Math.min(a.z, b.z) : Math.min(boxes[c + 2]!, a.z, b.z);
      boxes[c + 3] = first ? Math.max(a.z, b.z) : Math.max(boxes[c + 3]!, a.z, b.z);
    }
  }
  return { edges, boxes };
};

/** The squared distance from (y, z) to edge `e`. */
const edgeDist2 = (edges: Float64Array, e: number, y: number, z: number): number => {
  const k = e * EDGE;
  const dy = edges[k + 2]!;
  const dz = edges[k + 3]!;
  const py = y - edges[k]!;
  const pz = z - edges[k + 1]!;
  let t = (py * dy + pz * dz) * edges[k + 4]!;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ey = py - t * dy;
  const ez = pz - t * dz;
  return ey * ey + ez * ez;
};

/**
 * Whether edge `e` crosses the horizontal line through (y, z) on its +y side. Strict
 * at one end and not the other, so a vertex two edges share counts once; and it
 * implies the edge is not horizontal.
 */
const crossesRight = (edges: Float64Array, e: number, y: number, z: number): boolean => {
  const k = e * EDGE;
  const ay = edges[k]!;
  const az = edges[k + 1]!;
  const dz = edges[k + 3]!;
  return az > z !== az + dz > z && y < ay + ((z - az) / dz) * edges[k + 2]!;
};

/**
 * Signed distance from (y, z) to a station's loops: the nearest edge gives the size,
 * an even-odd crossing count gives the side. The loops never overlap (one ring, or a
 * notch's two separate lobes), so odd parity over all of them means inside one.
 *
 * `hint` is the box that held the nearest edge last time; it is searched first, so
 * that for a run of neighbouring points most boxes are ruled out at a glance. It is
 * updated in place. The answer does not depend on it.
 */
const signedDistance = (s: Station, y: number, z: number, hint: { box: number }): number => {
  const { edges, boxes } = s;
  const edgeCount = edges.length / EDGE;
  const boxCount = boxes.length / 4;
  let best = Infinity;
  let bestBox = -1;

  const seed = hint.box >= 0 && hint.box < boxCount ? hint.box : 0;
  for (let e = seed * CHUNK, end = Math.min(edgeCount, e + CHUNK); e < end; e++) {
    const d2 = edgeDist2(edges, e, y, z);
    if (d2 < best) {
      best = d2;
      bestBox = seed;
    }
  }

  let inside = false;
  for (let c = 0; c < boxCount; c++) {
    const b = c * 4;
    const minY = boxes[b]!;
    const maxY = boxes[b + 1]!;
    const minZ = boxes[b + 2]!;
    const maxZ = boxes[b + 3]!;
    const gy = y < minY ? minY - y : y > maxY ? y - maxY : 0;
    const gz = z < minZ ? minZ - z : z > maxZ ? z - maxZ : 0;
    const near = c !== seed && gy * gy + gz * gz < best;
    const line = z >= minZ && z <= maxZ && y < maxY;
    if (!near && !line) continue;
    for (let e = c * CHUNK, end = Math.min(edgeCount, e + CHUNK); e < end; e++) {
      if (near) {
        const d2 = edgeDist2(edges, e, y, z);
        if (d2 < best) {
          best = d2;
          bestBox = c;
        }
      }
      if (line && crossesRight(edges, e, y, z)) inside = !inside;
    }
  }

  if (best === Infinity) return Number.NaN;
  hint.box = bestBox;
  const d = Math.sqrt(best);
  if (d === 0) return 0;
  return inside ? -d : d;
};

/**
 * The signed distance from the point (y, z) to closed loops in one station plane:
 * positive outside every loop, negative inside one. NaN with no loops.
 *
 * The single-point form of {@link ghostDeviation}, for analytic checks and one-off
 * probes.
 */
export const signedDistanceToLoops = (
  loops: readonly (readonly GuidePoint[])[],
  y: number,
  z: number,
): number => signedDistance(packLoops(loops), y, z, { box: 0 });

/** The ghost's packed loops at `x`, or null where it has no section to measure against. */
const stationAt = (
  ghost: BezierBoard,
  x: number,
  length: number,
  ringSteps: number,
): Station | null => {
  if (!Number.isFinite(x)) return null;
  if (x < -DEVIATION_END_TOLERANCE || x > length + DEVIATION_END_TOLERANCE) return null;
  const loops = crossSectionLoops(ghost, Math.min(length, Math.max(0, x)), ringSteps);
  return loops ? packLoops(loops) : null;
};

/**
 * The signed station-plane distance (cm) from each point to the ghost's surface:
 * positive where the point lies outside the ghost (more foam), negative inside it
 * (less). NaN where the ghost has no section at the point's x.
 *
 * `points` is flat (x, y, z) triples in board cm — a mesh's `positions` as they are.
 * The ghost's loops are built once per distinct x, so a mesh, whose vertices come a
 * whole ring per station, costs one ghost section per station.
 *
 * The points are taken to lie on a board's surface. A point that does not (the hub a
 * mesh fans its end caps to) still gets a number, but it is the distance from the
 * inside of a section to its edge, which says nothing about either board's surface.
 */
export const ghostDeviation = (
  ghost: BezierBoard,
  points: ArrayLike<number>,
  opts: GhostDeviationOptions = {},
): Float64Array => {
  const count = Math.floor(points.length / 3);
  const out = new Float64Array(count).fill(Number.NaN);
  const length = getLength(ghost);
  if (!Number.isFinite(length) || length <= 0) return out;
  const ringSteps = opts.ringSteps ?? tessellationSteps(ghost, DEVIATION_RING_SPACING).ringSteps;

  const stations = new Map<number, Station | null>();
  const hint = { box: 0 };
  let lastX = Number.NaN;
  let station: Station | null = null;
  for (let i = 0; i < count; i++) {
    const x = points[i * 3]!;
    // A mesh lists a ring's points together, so this is nearly always the same station.
    if (x !== lastX) {
      lastX = x;
      let hit = stations.get(x);
      if (hit === undefined) {
        hit = stationAt(ghost, x, length, ringSteps);
        stations.set(x, hit);
      }
      station = hit;
    }
    if (station) out[i] = signedDistance(station, points[i * 3 + 1]!, points[i * 3 + 2]!, hint);
  }
  return out;
};
