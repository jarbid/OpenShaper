import type { Spline, Vec2 } from '@openshaper/kernel';

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const cross = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;
const along = (a: Vec2, v: Vec2, t: number): Vec2 => ({ x: a.x + v.x * t, y: a.y + v.y * t });

/** Relative angular tolerance avoids unstable intersections of nearly parallel handles. */
const intersection = (a: Vec2, u: Vec2, b: Vec2, v: Vec2): number | null => {
  const det = cross(u, v);
  if (Math.abs(det) <= 1e-6 * Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y) || det === 0) return null;
  const t = cross(sub(b, a), v) / det;
  return Number.isFinite(t) ? t : null;
};

export interface TunniGeometry {
  a: Vec2;
  b: Vec2;
  c1: Vec2;
  c2: Vec2;
  point: Vec2 | null;
}

/**
 * Original implementation of the Tunni equations documented at
 * https://github.com/OliverLeenders/Tunni-Lines (concept: Eduardo Tunni / FontLab).
 */
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

export const moveTunniLine = (g: TunniGeometry, delta: Vec2): [Vec2, Vec2] | null => {
  const p = along(g.c1, delta, 1),
    line = sub(g.c2, g.c1);
  return handles(
    g,
    intersection(g.a, sub(g.c1, g.a), p, line),
    intersection(g.b, sub(g.c2, g.b), p, line),
  );
};

export const balanceTunni = (g: TunniGeometry): [Vec2, Vec2] | null => {
  if (!g.point) return null;
  const first = intersection(g.a, sub(g.c1, g.a), g.b, sub(g.c2, g.b));
  const last = intersection(g.b, sub(g.c2, g.b), g.a, sub(g.c1, g.a));
  if (first === null || last === null) return null;
  const average = (1 / first + 1 / last) / 2;
  return handles(g, first * average, last * average);
};
