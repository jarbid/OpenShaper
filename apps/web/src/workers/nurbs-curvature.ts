// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * From geom's exact principal curvatures at the tessellation vertices to the 3D view's
 * three analysis quantities, in the view's own signs and units.
 *
 * Pure (no board2, no geom): `nurbs-core.ts` feeds it, the tests check it against the
 * analytic sphere and cylinder.
 *
 * ## Conventions
 *
 * geom measures a normal curvature as positive where the surface bends **towards**
 * the normal `n = Su × Sv`; with an outward normal a sphere of radius `r` has
 * `k1 = k2 = −1/r`. The view (and the classic engine's `CurvatureMesh`) reads mean
 * curvature as positive where convex. So with the outward normal,
 *
 *     mean = −(k1 + k2) / 2        gaussian = k1 · k2        radius = 1 / max(|k1|, |k2|)
 *
 * A B-rep face whose `sameSense` is false has the outward normal `−Su × Sv`; the
 * curvatures geom reports are relative to `+Su × Sv`, so reversing the normal gives
 * `(k1, k2) → (−k2, −k1)`. The Gaussian curvature does not change.
 */
import {
  MAX_RADIUS,
  RADIUS_PERCENTILES,
  SCALE_PERCENTILE,
  weightedQuantiles,
} from '@openshaper/render3d/curvature-mesh';
import type { NurbsScale } from './nurbs-protocol';

export interface ConvexCurvatures {
  /** 1/cm, positive where convex. */
  readonly mean: number;
  /** 1/cm². */
  readonly gaussian: number;
  /** cm, capped at the view's {@link MAX_RADIUS} so a flat spot stays finite. */
  readonly radius: number;
}

/**
 * The view's quantities for principal curvatures `(k1, k2)` as geom reports them on a
 * face with the given `sameSense` (see the module comment).
 */
export const convexCurvatures = (k1: number, k2: number, sameSense: boolean): ConvexCurvatures => {
  const a = sameSense ? k1 : -k2;
  const b = sameSense ? k2 : -k1;
  const kmax = Math.max(Math.abs(a), Math.abs(b));
  return {
    mean: -(a + b) / 2,
    gaussian: a * b,
    radius: kmax > 1 / MAX_RADIUS ? 1 / kmax : MAX_RADIUS,
  };
};

/** Per-vertex area (a third of every incident triangle), the weight of the display scales. */
export const vertexAreas = (
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  vertexCount: number,
): Float64Array => {
  const area = new Float64Array(vertexCount);
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t]!;
    const b = indices[t + 1]!;
    const c = indices[t + 2]!;
    const ux = positions[3 * b]! - positions[3 * a]!;
    const uy = positions[3 * b + 1]! - positions[3 * a + 1]!;
    const uz = positions[3 * b + 2]! - positions[3 * a + 2]!;
    const wx = positions[3 * c]! - positions[3 * a]!;
    const wy = positions[3 * c + 1]! - positions[3 * a + 1]!;
    const wz = positions[3 * c + 2]! - positions[3 * a + 2]!;
    const third = Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 6;
    area[a] = area[a]! + third;
    area[b] = area[b]! + third;
    area[c] = area[c]! + third;
  }
  return area;
};

/**
 * The display scales of the three modes: the same area-weighted percentiles as the
 * classic engine's curvature mesh (`SCALE_PERCENTILE`, `RADIUS_PERCENTILES`), so a
 * board reads the same on either surface.
 */
export const curvatureScale = (
  mean: Float32Array,
  gaussian: Float32Array,
  minRadius: Float32Array,
  area: Float64Array,
): NurbsScale => {
  const magnitudes = (a: Float32Array) => Float64Array.from(a, Math.abs);
  const [meanLimit] = weightedQuantiles(magnitudes(mean), area, [SCALE_PERCENTILE]);
  const [gaussLimit] = weightedQuantiles(magnitudes(gaussian), area, [SCALE_PERCENTILE]);
  const [tight, flat] = weightedQuantiles(minRadius, area, RADIUS_PERCENTILES);
  return { mean: meanLimit!, gaussian: gaussLimit!, radius: [tight!, flat!] };
};

/**
 * Replace normals that geom could not define (zero length: a collapsed edge) with the
 * area-weighted normal of the triangles around the vertex, in place. Returns how many
 * were repaired. A vertex with no usable triangle keeps its zero normal.
 */
export const repairNormals = (
  positions: ArrayLike<number>,
  normals: Float32Array,
  indices: ArrayLike<number>,
): number => {
  const bad = new Set<number>();
  for (let v = 0; v < normals.length / 3; v++) {
    if (Math.hypot(normals[3 * v]!, normals[3 * v + 1]!, normals[3 * v + 2]!) < 0.5) bad.add(v);
  }
  if (bad.size === 0) return 0;
  const acc = new Map<number, [number, number, number]>();
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t]!;
    const b = indices[t + 1]!;
    const c = indices[t + 2]!;
    if (!bad.has(a) && !bad.has(b) && !bad.has(c)) continue;
    const ux = positions[3 * b]! - positions[3 * a]!;
    const uy = positions[3 * b + 1]! - positions[3 * a + 1]!;
    const uz = positions[3 * b + 2]! - positions[3 * a + 2]!;
    const wx = positions[3 * c]! - positions[3 * a]!;
    const wy = positions[3 * c + 1]! - positions[3 * a + 1]!;
    const wz = positions[3 * c + 2]! - positions[3 * a + 2]!;
    // Not normalised: the cross product's length is twice the area, the weight.
    const n: [number, number, number] = [uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx];
    for (const v of [a, b, c]) {
      if (!bad.has(v)) continue;
      const s = acc.get(v) ?? [0, 0, 0];
      s[0] += n[0];
      s[1] += n[1];
      s[2] += n[2];
      acc.set(v, s);
    }
  }
  let repaired = 0;
  for (const [v, s] of acc) {
    const len = Math.hypot(s[0], s[1], s[2]);
    if (!(len > 0)) continue;
    normals[3 * v] = s[0] / len;
    normals[3 * v + 1] = s[1] / len;
    normals[3 * v + 2] = s[2] / len;
    repaired++;
  }
  return repaired;
};
