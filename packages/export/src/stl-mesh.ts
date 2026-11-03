// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Binary STL from an indexed triangle mesh (the NURBS engine's grid mesh), welded by position.
 *
 * The grid mesh keeps separate vertices where the two sides meet at a collapsed end row (a pointed
 * tail, nose or notch bottom) so each has its own normal. STL has no indices, so only positions
 * matter: vertices at the same float32 position are one vertex, and a triangle that two of its
 * corners collapse onto has no area and is dropped. What remains is closed (every edge in exactly two
 * triangles, opposite ways) whenever the mesh is. The facet normals are computed from the triangles.
 */

/** An indexed triangle mesh: counter-clockwise outward triangles over float32 positions (stride 3). */
export interface StlMeshInput {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
}

/** Vertex index by float32 position, so coincident vertices of the mesh become one. */
const weldIndices = (positions: Float32Array): Uint32Array => {
  const n = positions.length / 3;
  const canon = new Uint32Array(n);
  const bits = new Int32Array(positions.buffer, positions.byteOffset, positions.length);
  const seen = new Map<string, number>();
  for (let v = 0; v < n; v++) {
    // -0 and +0 are one position
    const x = positions[3 * v]! === 0 ? 0 : bits[3 * v]!;
    const y = positions[3 * v + 1]! === 0 ? 0 : bits[3 * v + 1]!;
    const z = positions[3 * v + 2]! === 0 ? 0 : bits[3 * v + 2]!;
    const key = `${x},${y},${z}`;
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, v);
      canon[v] = v;
    } else canon[v] = first;
  }
  return canon;
};

/**
 * Write the mesh as a binary STL (80-byte header, count, 50 bytes per facet), welded and without
 * degenerate facets. `onProgress` is called with the share written, now and then.
 */
export const stlFromMesh = (
  mesh: StlMeshInput,
  opts: { name?: string; onProgress?: (done: number) => void } = {},
): Uint8Array => {
  const { positions, indices } = mesh;
  const canon = weldIndices(positions);
  const tris: number[] = [];
  for (let k = 0; k < indices.length; k += 3) {
    const a = indices[k]!;
    const b = indices[k + 1]!;
    const c = indices[k + 2]!;
    const ca = canon[a]!;
    const cb = canon[b]!;
    const cc = canon[c]!;
    if (ca === cb || cb === cc || ca === cc) continue;
    tris.push(ca, cb, cc);
  }
  const count = tris.length / 3;
  const bytes = new Uint8Array(84 + count * 50);
  const header = `OpenShaper STL ${opts.name ?? 'openshaper'}`.slice(0, 80);
  for (let i = 0; i < header.length; i++) bytes[i] = header.charCodeAt(i) & 0x7f;
  const view = new DataView(bytes.buffer);
  view.setUint32(80, count, true);
  let o = 84;
  const step = Math.max(1, Math.floor(count / 20));
  for (let t = 0; t < count; t++) {
    const a = 3 * tris[3 * t]!;
    const b = 3 * tris[3 * t + 1]!;
    const c = 3 * tris[3 * t + 2]!;
    const ux = positions[b]! - positions[a]!;
    const uy = positions[b + 1]! - positions[a + 1]!;
    const uz = positions[b + 2]! - positions[a + 2]!;
    const vx = positions[c]! - positions[a]!;
    const vy = positions[c + 1]! - positions[a + 1]!;
    const vz = positions[c + 2]! - positions[a + 2]!;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 0) {
      nx /= len;
      ny /= len;
      nz /= len;
    }
    for (const v of [nx, ny, nz]) {
      view.setFloat32(o, v, true);
      o += 4;
    }
    for (const p of [a, b, c]) {
      for (let k = 0; k < 3; k++) {
        view.setFloat32(o, positions[p + k]!, true);
        o += 4;
      }
    }
    o += 2;
    if (opts.onProgress && t % step === 0) opts.onProgress(t / count);
  }
  return bytes;
};
