// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Principal curvatures at the vertices of a triangle mesh that carries exact vertex
 * normals, for the curvature view of the trim-and-blend engine (which has no surface to
 * differentiate).
 *
 * Convention (matches `meshBoard`, src/mesh.ts lines 27, 86 and the `measure` contract
 * in src/surface.ts line 292): units 1/cm for a mesh in cm, convex positive for an
 * outward normal (a sphere of radius R reads +1/R in both), and `k1 ≥ k2`. A vertex with
 * no usable triangle reads 0 and 0.
 *
 * Method: Rusinkiewicz, "Estimating Curvatures and Their Derivatives on Triangle
 * Meshes" (2004). On each triangle, in an orthonormal frame (u, v) of its plane, the
 * shape operator is the symmetric 2x2 II = [[l, m], [m, n]] with II e = dn for each edge
 * e and the difference dn of the normals at its ends. Each edge gives two equations
 *   l eu + m ev = dnu,   m eu + n ev = dnv,
 * so three edges give six equations for three unknowns, solved by the normal equations.
 * The tensor is carried into the tangent frame (t1, t2) of each corner's vertex normal
 * (the frame is rotated onto the face plane first) as
 *   l' = a.II a,  m' = a.II b,  n' = b.II b,   a, b = coordinates of t1, t2 in (u, v),
 * and added at the vertex weighted by the face's Voronoi corner area (Meyer et al.:
 * the right-angle-safe cotangent formula, with area/2 and area/4 for an obtuse
 * triangle). The weighted sum is divided by the weight sum, and the eigenvalues of the
 * 2x2 are the principal curvatures.
 *
 * Vertices are not welded: duplicated seam vertices keep their own normals and so
 * their own one-sided values, and a crease stays a crease.
 *
 * Cost: one pass over the triangles and one over the vertices, with scalar locals and
 * three accumulators per vertex. About 45 thousand vertices and 85 thousand triangles
 * take about 18 ms on the development machine (see curvature.test.ts).
 */
import { TRIM } from '../params';

export function vertexCurvature(
  positions: ArrayLike<number>,
  normals: ArrayLike<number>,
  indices: ArrayLike<number>,
): { k1: Float32Array; k2: Float32Array } {
  const nV = Math.floor(positions.length / 3);
  const k1 = new Float32Array(nV);
  const k2 = new Float32Array(nV);
  // Accumulated l', m', n' and the weight, per vertex.
  const acc = new Float64Array(4 * nV);
  const nTri = Math.floor(indices.length / 3);

  for (let t = 0; t < nTri; t++) {
    const i0 = indices[3 * t]!;
    const i1 = indices[3 * t + 1]!;
    const i2 = indices[3 * t + 2]!;
    if (!(i0 < nV && i1 < nV && i2 < nV) || i0 < 0 || i1 < 0 || i2 < 0) continue;
    const p0x = positions[3 * i0]!,
      p0y = positions[3 * i0 + 1]!,
      p0z = positions[3 * i0 + 2]!;
    const p1x = positions[3 * i1]!,
      p1y = positions[3 * i1 + 1]!,
      p1z = positions[3 * i1 + 2]!;
    const p2x = positions[3 * i2]!,
      p2y = positions[3 * i2 + 1]!,
      p2z = positions[3 * i2 + 2]!;
    // Edges e0 = p2-p1 (opposite vertex 0), e1 = p0-p2, e2 = p1-p0.
    const e0x = p2x - p1x,
      e0y = p2y - p1y,
      e0z = p2z - p1z;
    const e1x = p0x - p2x,
      e1y = p0y - p2y,
      e1z = p0z - p2z;
    const e2x = p1x - p0x,
      e2y = p1y - p0y,
      e2z = p1z - p0z;
    const l0 = e0x * e0x + e0y * e0y + e0z * e0z;
    const l1 = e1x * e1x + e1y * e1y + e1z * e1z;
    const l2 = e2x * e2x + e2y * e2y + e2z * e2z;
    // Face normal fn = e2 x (-e1) direction, its length is twice the area.
    let fx = e2y * -e1z - e2z * -e1y;
    let fy = e2z * -e1x - e2x * -e1z;
    let fz = e2x * -e1y - e2y * -e1x;
    const twoA = Math.sqrt(fx * fx + fy * fy + fz * fz);
    const lmax = Math.max(l0, l1, l2);
    if (!(twoA > 2 * TRIM.curvatureSliverArea * lmax)) continue;
    fx /= twoA;
    fy /= twoA;
    fz /= twoA;

    // Vertex normals and their differences along the edges.
    const n0x = normals[3 * i0]!,
      n0y = normals[3 * i0 + 1]!,
      n0z = normals[3 * i0 + 2]!;
    const n1x = normals[3 * i1]!,
      n1y = normals[3 * i1 + 1]!,
      n1z = normals[3 * i1 + 2]!;
    const n2x = normals[3 * i2]!,
      n2y = normals[3 * i2 + 1]!,
      n2z = normals[3 * i2 + 2]!;
    // Orient the face normal with the vertex normals so the frame rotation is small.
    if (fx * (n0x + n1x + n2x) + fy * (n0y + n1y + n2y) + fz * (n0z + n1z + n2z) < 0) {
      fx = -fx;
      fy = -fy;
      fz = -fz;
    }

    // Face frame u = e2 / |e2|, v = fn x u.
    const lu = Math.sqrt(l2);
    const ux = e2x / lu,
      uy = e2y / lu,
      uz = e2z / lu;
    const vx = fy * uz - fz * uy,
      vy = fz * ux - fx * uz,
      vz = fx * uy - fy * ux;

    // Edge and normal-difference coordinates in (u, v): edge k is opposite vertex k,
    // its normal difference runs between the same two ends.
    const eu0 = e0x * ux + e0y * uy + e0z * uz,
      ev0 = e0x * vx + e0y * vy + e0z * vz;
    const eu1 = e1x * ux + e1y * uy + e1z * uz,
      ev1 = e1x * vx + e1y * vy + e1z * vz;
    const eu2 = lu,
      ev2 = 0;
    const d0x = n2x - n1x,
      d0y = n2y - n1y,
      d0z = n2z - n1z;
    const d1x = n0x - n2x,
      d1y = n0y - n2y,
      d1z = n0z - n2z;
    const d2x = n1x - n0x,
      d2y = n1y - n0y,
      d2z = n1z - n0z;
    const du0 = d0x * ux + d0y * uy + d0z * uz,
      dv0 = d0x * vx + d0y * vy + d0z * vz;
    const du1 = d1x * ux + d1y * uy + d1z * uz,
      dv1 = d1x * vx + d1y * vy + d1z * vz;
    const du2 = d2x * ux + d2y * uy + d2z * uz,
      dv2 = d2x * vx + d2y * vy + d2z * vz;

    // Normal equations A^T A [l m n]^T = A^T b, with rows [eu ev 0] -> du and
    // [0 eu ev] -> dv per edge.
    const s11 = eu0 * eu0 + eu1 * eu1 + eu2 * eu2;
    const s12 = eu0 * ev0 + eu1 * ev1 + eu2 * ev2;
    const s22 = ev0 * ev0 + ev1 * ev1 + ev2 * ev2;
    // Matrix [[s11, s12, 0], [s12, s11 + s22, s12], [0, s12, s22]].
    const b1 = eu0 * du0 + eu1 * du1 + eu2 * du2;
    const b2 = ev0 * du0 + ev1 * du1 + ev2 * du2 + eu0 * dv0 + eu1 * dv1 + eu2 * dv2;
    const b3 = ev0 * dv0 + ev1 * dv1 + ev2 * dv2;
    const m22 = s11 + s22;
    const det = s11 * (m22 * s22 - s12 * s12) - s12 * (s12 * s22);
    const sc = l0 + l1 + l2;
    if (!(Math.abs(det) > TRIM.curvatureSolveDet * sc * sc * sc)) continue;
    // Cramer's rule.
    const fl = (b1 * (m22 * s22 - s12 * s12) - s12 * (b2 * s22 - s12 * b3)) / det;
    const fm = (s11 * (b2 * s22 - s12 * b3) - b1 * (s12 * s22)) / det;
    const fnn = (s11 * (m22 * b3 - s12 * b2) - s12 * (s12 * b3) + b1 * s12 * s12) / det;

    // Voronoi corner areas (cotangent form; area/2 and area/4 when obtuse).
    const area = 0.5 * twoA;
    // a_k is the dot product of the two edges meeting at corner k, so cot(angle k) = a_k / twoA.
    const a0 = -(e2x * e1x + e2y * e1y + e2z * e1z);
    const a1 = -(e2x * e0x + e2y * e0y + e2z * e0z);
    const a2 = -(e0x * e1x + e0y * e1y + e0z * e1z);
    const obtuse = a0 < 0 || a1 < 0 || a2 < 0;
    let w0: number, w1: number, w2: number;
    if (obtuse) {
      w0 = a0 < 0 ? area / 2 : area / 4;
      w1 = a1 < 0 ? area / 2 : area / 4;
      w2 = a2 < 0 ? area / 2 : area / 4;
    } else {
      // corner 0 gets (|e2|^2 cot(angle 2) + |e1|^2 cot(angle 1)) / 8, and so on.
      w0 = (l2 * a2 + l1 * a1) / (8 * twoA);
      w1 = (l0 * a0 + l2 * a2) / (8 * twoA);
      w2 = (l1 * a1 + l0 * a0) / (8 * twoA);
    }

    for (let c = 0; c < 3; c++) {
      const vi = c === 0 ? i0 : c === 1 ? i1 : i2;
      const w = c === 0 ? w0 : c === 1 ? w1 : w2;
      if (!(w > 0)) continue;
      let nx = c === 0 ? n0x : c === 1 ? n1x : n2x;
      let ny = c === 0 ? n0y : c === 1 ? n1y : n2y;
      let nz = c === 0 ? n0z : c === 1 ? n1z : n2z;
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (!(nl > 0) || !Number.isFinite(nl)) continue;
      nx /= nl;
      ny /= nl;
      nz /= nl;
      const cs = nx * fx + ny * fy + nz * fz;
      if (!(1 + cs > TRIM.curvatureFoldCos)) continue;
      // Vertex tangent frame: t1 is perpendicular to n (cross with the least-aligned axis).
      const ax = Math.abs(nx),
        ay = Math.abs(ny),
        az = Math.abs(nz);
      let t1x: number, t1y: number, t1z: number;
      if (ax <= ay && ax <= az) {
        t1x = 0;
        t1y = nz;
        t1z = -ny;
      } else if (ay <= az) {
        t1x = -nz;
        t1y = 0;
        t1z = nx;
      } else {
        t1x = ny;
        t1y = -nx;
        t1z = 0;
      }
      const tl = Math.sqrt(t1x * t1x + t1y * t1y + t1z * t1z);
      t1x /= tl;
      t1y /= tl;
      t1z /= tl;
      const t2x = ny * t1z - nz * t1y,
        t2y = nz * t1x - nx * t1z,
        t2z = nx * t1y - ny * t1x;
      // Rotation taking n to fn: R t = t c + (w x t) + w (w.t) / (1 + c), w = n x fn.
      const wx = ny * fz - nz * fy,
        wy = nz * fx - nx * fz,
        wz = nx * fy - ny * fx;
      const k = 1 / (1 + cs);
      // t1 rotated, then its (u, v) coordinates.
      let w_t = wx * t1x + wy * t1y + wz * t1z;
      const r1x = t1x * cs + (wy * t1z - wz * t1y) + wx * w_t * k;
      const r1y = t1y * cs + (wz * t1x - wx * t1z) + wy * w_t * k;
      const r1z = t1z * cs + (wx * t1y - wy * t1x) + wz * w_t * k;
      w_t = wx * t2x + wy * t2y + wz * t2z;
      const r2x = t2x * cs + (wy * t2z - wz * t2y) + wx * w_t * k;
      const r2y = t2y * cs + (wz * t2x - wx * t2z) + wy * w_t * k;
      const r2z = t2z * cs + (wx * t2y - wy * t2x) + wz * w_t * k;
      const au = r1x * ux + r1y * uy + r1z * uz,
        av = r1x * vx + r1y * vy + r1z * vz;
      const bu = r2x * ux + r2y * uy + r2z * uz,
        bv = r2x * vx + r2y * vy + r2z * vz;
      // l' = a.II a, m' = a.II b, n' = b.II b with II = [[fl, fm], [fm, fnn]].
      const lp = au * (fl * au + fm * av) + av * (fm * au + fnn * av);
      const mp = au * (fl * bu + fm * bv) + av * (fm * bu + fnn * bv);
      const np = bu * (fl * bu + fm * bv) + bv * (fm * bu + fnn * bv);
      const o = 4 * vi;
      acc[o] = acc[o]! + w * lp;
      acc[o + 1] = acc[o + 1]! + w * mp;
      acc[o + 2] = acc[o + 2]! + w * np;
      acc[o + 3] = acc[o + 3]! + w;
    }
  }

  for (let v = 0; v < nV; v++) {
    const o = 4 * v;
    const w = acc[o + 3]!;
    if (!(w > 0)) continue;
    const l = acc[o]! / w,
      m = acc[o + 1]! / w,
      n = acc[o + 2]! / w;
    const mean = 0.5 * (l + n);
    const r = Math.sqrt(0.25 * (l - n) * (l - n) + m * m);
    const hi = mean + r,
      lo = mean - r;
    if (Number.isFinite(hi) && Number.isFinite(lo)) {
      k1[v] = hi;
      k2[v] = lo;
    }
  }
  return { k1, k2 };
}
