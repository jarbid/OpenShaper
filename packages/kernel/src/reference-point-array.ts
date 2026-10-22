import { value, xValue, type Coeffs } from './bezier-curve';
import { splineLengthToX, splineXAtLength, type Spline } from './bezier-spline';
import type { Vec2 } from './vec2';

/** Guide intersection tolerance in cm, independent of viewport scale. */
const EPS = 1e-8;
export const MAX_REFERENCE_ARRAY_STATIONS = 10000;

/** Split at exact x extrema so bisection also finds returning rails and tail cutouts. */
const breaks = (c: Coeffs): number[] => {
  const a = 3 * c.ax;
  const b = 2 * c.bx;
  const d = c.cx;
  const roots: number[] = [];
  if (Math.abs(a) < 1e-14) {
    if (Math.abs(b) >= 1e-14) roots.push(-d / b);
  } else {
    const discriminant = b * b - 4 * a * d;
    if (discriminant >= 0) {
      const q = -0.5 * (b + (b >= 0 ? 1 : -1) * Math.sqrt(discriminant));
      roots.push(q / a);
      if (q !== 0) roots.push(d / q);
    }
  }
  return [0, ...roots.filter((t) => t > 0 && t < 1).sort((x, y) => x - y), 1];
};

/**
 * Intersect a spline with x = n * interval (cm), starting at n = 1. Local spline x is board Y for
 * cross-sections. Includes every branch, deduplicates shared knots, and never
 * extrapolates. A coincident vertical segment contributes its endpoints. When
 * overCurve is supplied, intervals measure arc length on that bottom rocker,
 * then intersect this spline at the corresponding model X positions.
 */
export function referencePointArray(spline: Spline, interval: number, overCurve?: Spline): Vec2[] {
  if (!Number.isFinite(interval) || interval <= 0) throw new Error('Enter a positive interval.');
  if (spline.curves.length === 0) return [];
  const controlX = spline.curves.flatMap((c) => [c.p0.x, c.c1.x, c.c2.x, c.p3.x]);
  const toDistance = (x: number) => (overCurve ? splineLengthToX(overCurve, x) : x);
  const minDistance = toDistance(Math.min(...controlX));
  const maxDistance = toDistance(Math.max(...controlX));
  // Legacy arc-length integration omits tiny endpoint parameter slices. Include
  // an endpoint station when its distance matches the interval within that precision.
  const rangeEpsilon = overCurve
    ? EPS * Math.max(1, Math.abs(minDistance), Math.abs(maxDistance))
    : EPS;
  const first = Math.max(1, Math.ceil((minDistance - rangeEpsilon) / interval));
  const last = Math.floor((maxDistance + rangeEpsilon) / interval);
  if (
    !Number.isSafeInteger(first) ||
    !Number.isSafeInteger(last) ||
    last - first + 1 > MAX_REFERENCE_ARRAY_STATIONS
  ) {
    throw new Error('Choose a larger interval (maximum 10,000 stations).');
  }
  const segments = spline.coeffs.flatMap((c) => {
    const ts = breaks(c);
    return ts.slice(1).map((end, i) => ({ c, start: ts[i]!, end }));
  });
  const points: Vec2[] = [];
  for (let n = first; n <= last; n++) {
    const distance = n * interval;
    const x = overCurve ? splineXAtLength(overCurve, distance) : distance;
    const station: Vec2[] = [];
    const add = (c: Coeffs, t: number) => {
      const point = { x, y: value(c, t).y };
      if (!station.some((old) => Math.abs(old.y - point.y) <= EPS)) station.push(point);
    };
    for (const { c, start, end } of segments) {
      const x0 = xValue(c, start);
      const x1 = xValue(c, end);
      if (x < Math.min(x0, x1) - EPS || x > Math.max(x0, x1) + EPS) continue;
      if (Math.abs(x0 - x) <= EPS) add(c, start);
      if (Math.abs(x1 - x) <= EPS) add(c, end);
      if (Math.abs(x0 - x) <= EPS || Math.abs(x1 - x) <= EPS) continue;
      let lo = start;
      let hi = end;
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (xValue(c, mid) < x === x1 > x0) lo = mid;
        else hi = mid;
      }
      add(c, (lo + hi) / 2);
    }
    points.push(...station.sort((a, b) => a.y - b.y));
  }
  return points;
}
