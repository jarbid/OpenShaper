// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * From the grid mesh's principal curvatures at its vertices to the 3D view's three
 * analysis quantities, in the view's own signs and units.
 *
 * Pure (no board2, no geom): `nurbs-core.ts` feeds it, the tests check it against the
 * closed forms of a sphere and a cylinder.
 *
 * ## Conventions
 *
 * `meshBoard` already reports `k1 >= k2` with the **convex positive** sign and the
 * outward normal (a sphere of radius `r` has `k1 = k2 = 1/r`), which is the view's
 * (and the classic engine's `CurvatureMesh`) convention. So
 *
 *     mean = (k1 + k2) / 2        gaussian = k1 * k2        radius = 1 / max(|k1|, |k2|)
 *
 * A vertex whose curvature is not finite (a tip point, a collapsed edge) is undefined:
 * it keeps mean 0 and the capped radius, and is flagged so the display scales leave it
 * out.
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

/** The view's quantities for convex-positive principal curvatures `(k1, k2)`. */
export const convexCurvatures = (k1: number, k2: number): ConvexCurvatures => {
  const kmax = Math.max(Math.abs(k1), Math.abs(k2));
  return {
    mean: (k1 + k2) / 2,
    gaussian: k1 * k2,
    radius: kmax > 1 / MAX_RADIUS ? 1 / kmax : MAX_RADIUS,
  };
};

export interface CurvatureArrays {
  readonly mean: Float32Array;
  readonly gaussian: Float32Array;
  readonly minRadius: Float32Array;
  /** 1 where the curvature is undefined (not finite). */
  readonly undefinedAt: Uint8Array;
}

/** {@link convexCurvatures} at every vertex of a mesh. */
export const curvatureArrays = (k1: Float32Array, k2: Float32Array): CurvatureArrays => {
  const n = k1.length;
  const mean = new Float32Array(n);
  const gaussian = new Float32Array(n);
  const minRadius = new Float32Array(n).fill(MAX_RADIUS);
  const undefinedAt = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = k1[i]!;
    const b = k2[i]!;
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      undefinedAt[i] = 1;
      continue;
    }
    const c = convexCurvatures(a, b);
    mean[i] = c.mean;
    gaussian[i] = c.gaussian;
    minRadius[i] = c.radius;
  }
  return { mean, gaussian, minRadius, undefinedAt };
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
 * Give vertices whose curvature is undefined (`SAMPLE_DEGENERATE`: a collapsed edge,
 * a tip point) no weight in the display scales, in place, and return `area`. They keep
 * mean 0 and the capped radius, and as flat spots they would drag the percentiles
 * down; the classic engine leaves its cap vertices out of the scales the same way.
 */
export const excludeUndefined = (
  area: Float64Array,
  undefinedAt: ArrayLike<number>,
): Float64Array => {
  for (let i = 0; i < area.length; i++) if (undefinedAt[i]) area[i] = 0;
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
