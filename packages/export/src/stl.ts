import {
  buildFinBladeMesh,
  getLength,
  hasTailCutout,
  loftPoint,
  loftSection,
  ringFractions,
  resolveFins,
  tessellateBoard,
  tessellationSteps,
  type BezierBoard,
  type BoardMesh,
} from '@openshaper/kernel';

/** Options for {@link exportStl}. */
export interface StlOptions {
  /** Number of longitudinal stations sampled along the board length. Overrides `targetFaceSize`. */
  lengthSteps?: number;
  /** Number of profile samples around each cross-section ring (per side). Overrides `targetFaceSize`. */
  ringSteps?: number;
  /**
   * Target face edge length in cm; the default ~0.5 cm yields a dense, non-faceted
   * mesh suitable for CNC/print, independent of any lighter viewport setting.
   */
  targetFaceSize?: number;
  /** `solid` name written into the STL. Default `openshaper`. */
  name?: string;
  /** Include foiled fin blade solids (default true). */
  includeFins?: boolean;
}

/** Fine default so exported parts are smooth on rails / nose / tail. */
const DEFAULT_FACE_SIZE = 0.5;

interface P3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** ASCII-STL float format (sign-mantissa-e-sign-exponent), matching the legacy STL writer. */
const f = (n: number): string => (Number.isFinite(n) ? n : 0).toExponential(6);

/**
 * Sample a single longitudinal station into one rail's worth of 3D points.
 *
 * Only the +Y half: the caller mirrors it. `f` runs 0 (bottom centreline) to 1
 * (deck centreline) as fractional arc length along the profile.
 *
 * The STL is a second, independent loft from the viewport mesh — different
 * station formula, different ring count — so it goes through the kernel's
 * `loftSection` to guarantee the two describe the same surface. See `loft.ts`
 * for why the surface is defined by blending sampled points rather than control
 * points.
 */
const sampleRing = (board: BezierBoard, pos: number, ringSteps: number): P3[] | null => {
  const section = loftSection(board, pos);
  if (!section) return null;
  const fs = ringFractions(board, ringSteps + 1);
  const ring: P3[] = [];
  for (let r = 0; r <= ringSteps; r++) {
    const p = loftPoint(section, fs[r]!);
    ring.push({ x: pos, y: p.x, z: p.y + section.rocker });
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

/** One facet as 12 numbers: the unit normal, then the three vertices. */
const writeFacet = (out: number[], a: P3, b: P3, c: P3): void => {
  const n = triNormal(a, b, c);
  out.push(n.x, n.y, n.z, a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
};

/**
 * The board's surface (and fins) as STL facets, 12 numbers each (normal, then
 * three vertices); shared by the binary and the ASCII writers.
 *
 * Cross-section rings are sampled along the length and stitched into a closed
 * watertight-ish hull: each pair of adjacent rings forms a quad band (two
 * triangles) on the `+y` side and a mirrored band on the `-y` side; the nose and
 * tail rings are fanned to a centre point to cap the ends.
 */
const stlFacets = (board: BezierBoard, opts: StlOptions): number[] => {
  // Derive density from a fine target face size unless explicit counts are given.
  // The kernel ring count covers the full closed loop; STL samples one rail (per
  // side) and mirrors it, so use half the loop count.
  const derived = tessellationSteps(board, opts.targetFaceSize ?? DEFAULT_FACE_SIZE);
  const lengthSteps = Math.max(2, opts.lengthSteps ?? derived.lengthSteps);
  const ringSteps = Math.max(3, opts.ringSteps ?? Math.ceil(derived.ringSteps / 2));
  const length = getLength(board);

  const out: number[] = [];

  // A concave tail (swallow / fish) cannot be expressed by the single-rail mirror
  // loft below — its notch would collapse. Use the kernel's watertight cutout mesh
  // instead (ringSteps here is one rail; the kernel mesh wants the full loop).
  if (hasTailCutout(board.outline)) {
    writeMesh(out, tessellateBoard(board, { lengthSteps, ringSteps: ringSteps * 2 }));
    if (opts.includeFins !== false) {
      for (const fin of resolveFins(board)) writeMesh(out, buildFinBladeMesh(fin));
    }
    return out;
  }

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

  // Foiled fin blade solids (same coordinate frame as the hull: X length, Y width, Z up).
  if (opts.includeFins !== false) {
    for (const fin of resolveFins(board)) writeMesh(out, buildFinBladeMesh(fin));
  }

  return out;
};

/**
 * Export a board's surface as a binary STL: an 80-byte header, a facet count, then
 * 50 bytes per facet (float32 normal and vertices, little-endian). About a fifth
 * the size of the ASCII form and far faster to write; every slicer and CAD tool
 * reads it. The header deliberately does not start with "solid", which some
 * readers take as the mark of an ASCII file.
 */
export const exportStl = (board: BezierBoard, opts: StlOptions = {}): Uint8Array => {
  const facets = stlFacets(board, opts);
  const count = facets.length / 12;
  const bytes = new Uint8Array(84 + count * 50);
  const header = `OpenShaper STL ${opts.name ?? 'openshaper'}`.slice(0, 80);
  for (let i = 0; i < header.length; i++) bytes[i] = header.charCodeAt(i) & 0x7f;
  const view = new DataView(bytes.buffer);
  view.setUint32(80, count, true);
  let o = 84;
  for (let i = 0; i < facets.length; i += 12) {
    for (let k = 0; k < 12; k++) {
      const v = facets[i + k]!;
      view.setFloat32(o, Number.isFinite(v) ? v : 0, true);
      o += 4;
    }
    o += 2; // attribute byte count: 0
  }
  return bytes;
};

/**
 * The same surface as an ASCII STL string, in the legacy writer's number format.
 * Kept for tools and tests that want readable text; the app exports binary.
 */
export const exportStlAscii = (board: BezierBoard, opts: StlOptions = {}): string => {
  const name = opts.name ?? 'openshaper';
  const facets = stlFacets(board, opts);
  const out: string[] = [`solid ${name}`];
  for (let i = 0; i < facets.length; i += 12) {
    const v = (k: number) => f(facets[i + k]!);
    out.push(`facet normal ${v(0)} ${v(1)} ${v(2)}`);
    out.push('outer loop');
    out.push(`vertex ${v(3)} ${v(4)} ${v(5)}`);
    out.push(`vertex ${v(6)} ${v(7)} ${v(8)}`);
    out.push(`vertex ${v(9)} ${v(10)} ${v(11)}`);
    out.push('endloop');
    out.push('endfacet');
  }
  out.push(`endsolid ${name}`);
  return out.join('\n') + '\n';
};

/** Write every triangle of a kernel mesh as STL facets. */
const writeMesh = (out: number[], mesh: BoardMesh): void => {
  const { positions, indices } = mesh;
  const at = (i: number): P3 => ({
    x: positions[i * 3]!,
    y: positions[i * 3 + 1]!,
    z: positions[i * 3 + 2]!,
  });
  for (let t = 0; t < indices.length; t += 3) {
    writeFacet(out, at(indices[t]!), at(indices[t + 1]!), at(indices[t + 2]!));
  }
};
