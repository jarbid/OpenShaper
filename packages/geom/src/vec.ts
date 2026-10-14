// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Small-vector maths on {@link Point2} / {@link Point3} and affine maps,
 * exported as the `vec` namespace so generic names (`add`, `dot`) stay out of
 * the package's top level (design §4.9).
 *
 * Every function returns a new frozen-free plain record and never mutates its
 * inputs. A value with a `z` property is treated as 3D.
 */
import type { Affine2, Affine3, Point2, Point3 } from './types';

type V = Point2 | Point3;
const is3 = (a: V): a is Point3 => (a as Point3).z !== undefined;

export function add(a: Point3, b: Point3): Point3;
export function add(a: Point2, b: Point2): Point2;
export function add(a: V, b: V): V {
  return is3(a)
    ? { x: a.x + b.x, y: a.y + b.y, z: a.z + (b as Point3).z }
    : { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Point3, b: Point3): Point3;
export function sub(a: Point2, b: Point2): Point2;
export function sub(a: V, b: V): V {
  return is3(a)
    ? { x: a.x - b.x, y: a.y - b.y, z: a.z - (b as Point3).z }
    : { x: a.x - b.x, y: a.y - b.y };
}

export function scale(a: Point3, k: number): Point3;
export function scale(a: Point2, k: number): Point2;
export function scale(a: V, k: number): V {
  return is3(a) ? { x: a.x * k, y: a.y * k, z: a.z * k } : { x: a.x * k, y: a.y * k };
}

export function dot(a: Point3, b: Point3): number;
export function dot(a: Point2, b: Point2): number;
export function dot(a: V, b: V): number {
  return is3(a) ? a.x * b.x + a.y * b.y + a.z * (b as Point3).z : a.x * b.x + a.y * b.y;
}

/** 3D: the cross product. 2D: its z component `a.x·b.y − a.y·b.x` (> 0 ⇔ b is counter-clockwise of a). */
export function cross(a: Point3, b: Point3): Point3;
export function cross(a: Point2, b: Point2): number;
export function cross(a: V, b: V): Point3 | number {
  if (!is3(a)) return a.x * b.y - a.y * b.x;
  const bz = (b as Point3).z;
  return { x: a.y * bz - a.z * b.y, y: a.z * b.x - a.x * bz, z: a.x * b.y - a.y * b.x };
}

/** Euclidean length (`Math.sqrt` of the dot product, not `Math.hypot`: design §9). */
export function norm(a: V): number {
  return Math.sqrt(is3(a) ? a.x * a.x + a.y * a.y + a.z * a.z : a.x * a.x + a.y * a.y);
}

export function distance(a: Point3, b: Point3): number;
export function distance(a: Point2, b: Point2): number;
export function distance(a: V, b: V): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = is3(a) ? a.z - (b as Point3).z : 0;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** `a + (b − a)·s`. */
export function lerp(a: Point3, b: Point3, s: number): Point3;
export function lerp(a: Point2, b: Point2, s: number): Point2;
export function lerp(a: V, b: V, s: number): V {
  return is3(a)
    ? { x: a.x + (b.x - a.x) * s, y: a.y + (b.y - a.y) * s, z: a.z + ((b as Point3).z - a.z) * s }
    : { x: a.x + (b.x - a.x) * s, y: a.y + (b.y - a.y) * s };
}

/**
 * The unit vector along `a`, or `null` when `|a| ≤ tol` (default 0: only the
 * zero vector) or the length is not finite. Never returns NaN.
 */
export function normalize(a: Point3, tol?: number): Point3 | null;
export function normalize(a: Point2, tol?: number): Point2 | null;
export function normalize(a: V, tol = 0): V | null {
  const n = norm(a);
  if (!(n > tol) || !Number.isFinite(n)) return null;
  return is3(a) ? { x: a.x / n, y: a.y / n, z: a.z / n } : { x: a.x / n, y: a.y / n };
}

/** The angle in [0, π] between `a` and `b`: `atan2(|a × b|, a · b)`, accurate near 0 and π. */
export function angleBetween(a: Point3, b: Point3): number;
export function angleBetween(a: Point2, b: Point2): number;
export function angleBetween(a: V, b: V): number {
  if (is3(a)) {
    const c = cross(a, b as Point3);
    return Math.atan2(norm(c), dot(a, b as Point3));
  }
  return Math.atan2(Math.abs(cross(a, b)), dot(a, b));
}

/** Applies a row-major 3×4 affine map: `m · [x, y, z, 1]ᵀ`. */
export function applyAffine3(m: Affine3, p: Point3): Point3 {
  return {
    x: m[0] * p.x + m[1] * p.y + m[2] * p.z + m[3],
    y: m[4] * p.x + m[5] * p.y + m[6] * p.z + m[7],
    z: m[8] * p.x + m[9] * p.y + m[10] * p.z + m[11],
  };
}

/** Applies a row-major 2×3 affine map `[a, b, tx, c, d, ty]`. */
export function applyAffine2(m: Affine2, p: Point2): Point2 {
  return { x: m[0] * p.x + m[1] * p.y + m[2], y: m[3] * p.x + m[4] * p.y + m[5] };
}

/** Determinant of the linear part (negative: the map reverses orientation). */
export function affineDeterminant(m: Affine2 | Affine3): number {
  if (m.length === 6) return m[0] * m[4] - m[1] * m[3];
  return (
    m[0] * (m[5] * m[10] - m[6] * m[9]) -
    m[1] * (m[4] * m[10] - m[6] * m[8]) +
    m[2] * (m[4] * m[9] - m[5] * m[8])
  );
}

/** The map `p ↦ a(b(p))`: apply `b` first, then `a`. */
export function composeAffine3(a: Affine3, b: Affine3): Affine3 {
  const r = (i: number, j: number): number =>
    a[4 * i]! * b[j]! + a[4 * i + 1]! * b[4 + j]! + a[4 * i + 2]! * b[8 + j]!;
  const t = (i: number): number => r(i, 3) + a[4 * i + 3]!;
  return [
    r(0, 0),
    r(0, 1),
    r(0, 2),
    t(0),
    r(1, 0),
    r(1, 1),
    r(1, 2),
    t(1),
    r(2, 0),
    r(2, 1),
    r(2, 2),
    t(2),
  ];
}
