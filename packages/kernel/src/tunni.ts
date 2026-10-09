// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Tunni lines for one cubic segment: the line joining its two inner handles, and the
 * Tunni point that controls their balance. Original implementation of the equations
 * documented at https://github.com/OliverLeenders/Tunni-Lines (concept: Eduardo Tunni /
 * FontLab). Every move keeps the segment's anchors and tangent directions; only the two
 * handle lengths change.
 */
import type { Spline } from './bezier-spline';
import { cross, length, sub, type Vec2 } from './vec2';

const along = (a: Vec2, v: Vec2, t: number): Vec2 => ({ x: a.x + v.x * t, y: a.y + v.y * t });

/**
 * Parameter along `u` (from `a`) where the line `a + t·u` meets `b + s·v`. A relative
 * angular tolerance rejects nearly parallel rays, whose intersection is unstable.
 */
const intersection = (a: Vec2, u: Vec2, b: Vec2, v: Vec2): number | null => {
  const det = cross(u, v);
  if (det === 0 || Math.abs(det) <= 1e-6 * length(u) * length(v)) return null;
  const t = cross(sub(b, a), v) / det;
  return Number.isFinite(t) ? t : null;
};

export interface TunniGeometry {
  a: Vec2;
  b: Vec2;
  c1: Vec2;
  c2: Vec2;
  /** Null when the handle rays do not meet on the curve's side (parallel, S-curve). */
  point: Vec2 | null;
}

/** Tunni line and point of segment `index` (knot `index` → `index + 1`), or null. */
export const tunniGeometry = (s: Spline, index: number): TunniGeometry | null => {
  const first = s.knots[index];
  const last = s.knots[index + 1];
  if (!first || !last) return null;
  const a = first.end,
    b = last.end,
    c1 = first.tangentToNext,
    c2 = last.tangentToPrev;
  const u = sub(c1, a),
    v = sub(c2, b),
    line = sub(c2, c1);
  // The line must intersect both handle rays uniquely.
  if (intersection(a, u, c1, line) === null || intersection(b, v, c1, line) === null) return null;
  const t = intersection(a, u, b, v);
  const q = intersection(b, v, a, u);
  let point: Vec2 | null = null;
  const chord = sub(b, a);
  if (t !== null && q !== null && t > 0 && q > 0 && cross(chord, u) * cross(chord, v) > 0) {
    const apex = along(a, u, t);
    point = {
      x: 2 * c1.x - a.x + 2 * c2.x - b.x - apex.x,
      y: 2 * c1.y - a.y + 2 * c2.y - b.y - apex.y,
    };
  }
  return { a, b, c1, c2, point };
};

/** Reject crossing an anchor rather than reversing its tangent direction. */
const handles = (
  g: TunniGeometry,
  first: number | null,
  last: number | null,
): [Vec2, Vec2] | null => {
  if (first === null || last === null || first <= 1e-8 || last <= 1e-8) return null;
  const result: [Vec2, Vec2] = [
    along(g.a, sub(g.c1, g.a), first),
    along(g.b, sub(g.c2, g.b), last),
  ];
  return result.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)) ? result : null;
};

/** Handles that put the Tunni point at `point`, or null if that would reverse one. */
export const moveTunniPoint = (g: TunniGeometry, point: Vec2): [Vec2, Vec2] | null => {
  if (!g.point) return null;
  const u = sub(g.c1, g.a),
    v = sub(g.c2, g.b);
  const t = intersection(g.a, u, g.b, v);
  if (t === null) return null;
  const apex = along(g.a, u, t);
  const r = {
    x: (point.x + apex.x - g.a.x - g.b.x) / 2,
    y: (point.y + apex.y - g.a.y - g.b.y) / 2,
  };
  const det = cross(u, v);
  return handles(g, cross(r, v) / det, cross(u, r) / det);
};

/** Handles after translating the Tunni line by `delta` (motion along it is ignored). */
export const moveTunniLine = (g: TunniGeometry, delta: Vec2): [Vec2, Vec2] | null => {
  const p = along(g.c1, delta, 1),
    line = sub(g.c2, g.c1);
  return handles(
    g,
    intersection(g.a, sub(g.c1, g.a), p, line),
    intersection(g.b, sub(g.c2, g.b), p, line),
  );
};

/** Equal-tension handles: the Tunni line made parallel to the anchor chord. */
export const balanceTunni = (g: TunniGeometry): [Vec2, Vec2] | null => {
  if (!g.point) return null;
  const first = intersection(g.a, sub(g.c1, g.a), g.b, sub(g.c2, g.b));
  const last = intersection(g.b, sub(g.c2, g.b), g.a, sub(g.c1, g.a));
  if (first === null || last === null) return null;
  const average = (1 / first + 1 / last) / 2;
  return handles(g, first * average, last * average);
};
