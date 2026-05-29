import {
  getInterpolatedCrossSection,
  getLength,
  getRockerAtPos,
  pointByTT,
  type BezierBoard,
} from '@board-studio/kernel';

/** Options for {@link exportStl}. */
export interface StlOptions {
  /** Number of longitudinal stations sampled along the board length. Default 120. */
  lengthSteps?: number;
  /** Number of profile samples around each cross-section ring (per side). Default 48. */
  ringSteps?: number;
  /** `solid` name written into the STL. Default `boardstudio`. */
  name?: string;
}

interface P3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

const DEFAULT_LENGTH_STEPS = 120;
const DEFAULT_RING_STEPS = 48;

/** ASCII-STL float format (sign-mantissa-e-sign-exponent), matching the legacy STL writer. */
const f = (n: number): string => (Number.isFinite(n) ? n : 0).toExponential(6);

/**
 * Sample a single longitudinal station into a ring of 3D points.
 *
 * The interpolated cross-section profile runs (x = distance from centerline ≥ 0,
 * y = height) from bottom-centre (tt=0) to deck-centre (tt=1). We sample it with
 * `pointByTT` and lift it by the bottom rocker at this station so z is absolute
 * board height. `+x` gives one rail; we mirror `-x` for the other rail when stitching.
 */
const sampleRing = (board: BezierBoard, pos: number, ringSteps: number): P3[] | null => {
  const cs = getInterpolatedCrossSection(board, pos);
  if (!cs) return null;
  const rocker = getRockerAtPos(board, pos);
  const ring: P3[] = [];
  for (let r = 0; r <= ringSteps; r++) {
    const tt = r / ringSteps;
    const p = pointByTT(cs.spline, tt);
    ring.push({ x: pos, y: p.x, z: p.y + rocker });
  }
  return ring;
};

const triNormal = (a: P3, b: P3, c: P3): P3 => {
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const uz = b.z - a.z;
  const vx = c.x - a.x;
  const vy = c.y - a.y;
  const vz = c.z - a.z;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  if (len > 0) {
    nx /= len;
    ny /= len;
    nz /= len;
  }
  return { x: nx, y: ny, z: nz };
};

const writeFacet = (out: string[], a: P3, b: P3, c: P3): void => {
  const n = triNormal(a, b, c);
  out.push(`facet normal ${f(n.x)} ${f(n.y)} ${f(n.z)}`);
  out.push('outer loop');
  out.push(`vertex ${f(a.x)} ${f(a.y)} ${f(a.z)}`);
  out.push(`vertex ${f(b.x)} ${f(b.y)} ${f(b.z)}`);
  out.push(`vertex ${f(c.x)} ${f(c.y)} ${f(c.z)}`);
  out.push('endloop');
  out.push('endfacet');
};

/**
 * Export a board's surface as an ASCII STL string.
 *
 * Cross-section rings are sampled along the length and stitched into a closed
 * watertight-ish hull: each pair of adjacent rings forms a quad band (two
 * triangles) on the `+y` side and a mirrored band on the `-y` side; the nose and
 * tail rings are fanned to a centre point to cap the ends.
 */
export const exportStl = (board: BezierBoard, opts: StlOptions = {}): string => {
  const lengthSteps = Math.max(2, opts.lengthSteps ?? DEFAULT_LENGTH_STEPS);
  const ringSteps = Math.max(3, opts.ringSteps ?? DEFAULT_RING_STEPS);
  const name = opts.name ?? 'boardstudio';
  const length = getLength(board);

  // Build rings at interior stations (avoid the exact 0/length dummy sections,
  // which have zero/clamped dimensions; nudge in by a small epsilon like getVolume).
  const eps = Math.min(0.01, length / (lengthSteps * 4));
  const rings: P3[][] = [];
  for (let j = 0; j <= lengthSteps; j++) {
    const t = j / lengthSteps;
    const pos = eps + t * (length - 2 * eps);
    const ring = sampleRing(board, pos, ringSteps);
    if (ring) rings.push(ring);
  }

  const out: string[] = [];
  out.push(`solid ${name}`);

  for (let j = 0; j < rings.length - 1; j++) {
    const a = rings[j]!;
    const b = rings[j + 1]!;
    for (let r = 0; r < ringSteps; r++) {
      // +y side
      const p1 = a[r]!;
      const p2 = b[r]!;
      const p3 = b[r + 1]!;
      const p4 = a[r + 1]!;
      writeFacet(out, p1, p2, p3);
      writeFacet(out, p1, p3, p4);
      // mirrored -y side (reverse winding to keep normals outward)
      const m1 = { x: p1.x, y: -p1.y, z: p1.z };
      const m2 = { x: p2.x, y: -p2.y, z: p2.z };
      const m3 = { x: p3.x, y: -p3.y, z: p3.z };
      const m4 = { x: p4.x, y: -p4.y, z: p4.z };
      writeFacet(out, m1, m3, m2);
      writeFacet(out, m1, m4, m3);
    }
  }

  // End caps: fan each end ring (both sides) to its centre point.
  const cap = (ring: P3[] | undefined, noseEnd: boolean): void => {
    if (!ring) return;
    let cx = 0;
    let cz = 0;
    for (const p of ring) {
      cx += p.x;
      cz += p.z;
    }
    const c: P3 = { x: cx / ring.length, y: 0, z: cz / ring.length };
    for (let r = 0; r < ringSteps; r++) {
      const p2 = ring[r]!;
      const p3 = ring[r + 1]!;
      if (noseEnd) {
        writeFacet(out, c, p2, p3);
        writeFacet(out, c, { x: p3.x, y: -p3.y, z: p3.z }, { x: p2.x, y: -p2.y, z: p2.z });
      } else {
        writeFacet(out, c, p3, p2);
        writeFacet(out, c, { x: p2.x, y: -p2.y, z: p2.z }, { x: p3.x, y: -p3.y, z: p3.z });
      }
    }
  };
  cap(rings[0], false);
  cap(rings[rings.length - 1], true);

  out.push(`endsolid ${name}`);
  return out.join('\n') + '\n';
};
