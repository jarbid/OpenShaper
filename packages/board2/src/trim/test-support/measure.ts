// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Measuring helpers shared by the trim measurement tests (`bridge.measure.test.ts`,
 * `native.measure.test.ts`) and the probe's test: the two-sided gap between a mesh slice and a
 * section polyline, the distance from a point to a segment, and the thickness of a closed mesh
 * through a plan point. Test-only.
 */

export const segDist = (
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number => {
  const ex = bx - ax;
  const ey = by - ay;
  const ee = ex * ex + ey * ey;
  const f = ee > 0 ? Math.min(1, Math.max(0, ((px - ax) * ex + (py - ay) * ey) / ee)) : 0;
  return Math.hypot(px - ax - f * ex, py - ay - f * ey);
};

/** Two-sided gap between a slice (segments `y1 z1 y2 z2 face`) and a section polyline `y z …`. */
export function gap(
  slice: Float64Array,
  section: Float64Array,
): { max: number; y: number; z: number } {
  let max = 0;
  let wy = 0;
  let wz = 0;
  const pts = section.length / 2;
  for (let i = 0; i < pts; i++) {
    let d = Infinity;
    for (let s = 0; s < slice.length; s += 5) {
      d = Math.min(
        d,
        segDist(
          section[2 * i]!,
          section[2 * i + 1]!,
          slice[s]!,
          slice[s + 1]!,
          slice[s + 2]!,
          slice[s + 3]!,
        ),
      );
    }
    if (d > max) {
      max = d;
      wy = section[2 * i]!;
      wz = section[2 * i + 1]!;
    }
  }
  for (let s = 0; s < slice.length; s += 5) {
    for (const o of [0, 2]) {
      let d = Infinity;
      for (let i = 0; i + 1 < pts; i++) {
        d = Math.min(
          d,
          segDist(
            slice[s + o]!,
            slice[s + o + 1]!,
            section[2 * i]!,
            section[2 * i + 1]!,
            section[2 * i + 2]!,
            section[2 * i + 3]!,
          ),
        );
      }
      if (d > max) {
        max = d;
        wy = slice[s + o]!;
        wz = slice[s + o + 1]!;
      }
    }
  }
  return { max, y: wy, z: wz };
}

/** Thickness (cm) of a closed mesh straight up through (x, y): top crossing less bottom; NaN if it misses. */
export function thicknessAt(
  m: { readonly positions: Float32Array; readonly indices: Uint32Array },
  x: number,
  y: number,
): number {
  const p = m.positions;
  const idx = m.indices;
  let lo = Infinity;
  let hi = -Infinity;
  for (let t = 0; t < idx.length; t += 3) {
    const a = 3 * idx[t]!;
    const b = 3 * idx[t + 1]!;
    const c = 3 * idx[t + 2]!;
    const ex = p[b]! - p[a]!;
    const ey = p[b + 1]! - p[a + 1]!;
    const fx = p[c]! - p[a]!;
    const fy = p[c + 1]! - p[a + 1]!;
    const det = ex * fy - fx * ey;
    if (det === 0) continue;
    const px = x - p[a]!;
    const py = y - p[a + 1]!;
    const u = (px * fy - fx * py) / det;
    const v = (ex * py - px * ey) / det;
    if (u < 0 || v < 0 || u + v > 1) continue;
    const z = p[a + 2]! + u * (p[b + 2]! - p[a + 2]!) + v * (p[c + 2]! - p[a + 2]!);
    lo = Math.min(lo, z);
    hi = Math.max(hi, z);
  }
  return hi > lo ? hi - lo : Number.NaN;
}

/**
 * One side's part of a slice (segments `y1 z1 y2 z2 face`, both sides): `side` 0 is the plus
 * side (y >= 0) and 1 the minus side. A panel runs across the stringer, so a segment that
 * crosses it is clipped there. The y of the result keeps the slice's sign.
 */
export function halfOfSlice(slice: Float64Array, side: 0 | 1): Float64Array {
  const sign = side === 0 ? 1 : -1;
  const half: number[] = [];
  for (let s = 0; s < slice.length; s += 5) {
    let ya = sign * slice[s]!;
    let za = slice[s + 1]!;
    let yb = sign * slice[s + 2]!;
    let zb = slice[s + 3]!;
    if (ya < 0 && yb < 0) continue;
    if (ya < 0) {
      za += ((0 - ya) / (yb - ya)) * (zb - za);
      ya = 0;
    } else if (yb < 0) {
      zb += ((0 - yb) / (ya - yb)) * (za - zb);
      yb = 0;
    }
    half.push(sign * ya, za, sign * yb, zb, slice[s + 4]!);
  }
  return Float64Array.from(half);
}
