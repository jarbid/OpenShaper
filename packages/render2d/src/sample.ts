import { value, type Spline, type Vec2 } from '@openshaper/kernel';

/** Sample a spline into a polyline of world points (perCurve points per segment). */
export const sampleSpline = (spline: Spline, perCurve = 24): Vec2[] => {
  const pts: Vec2[] = [];
  spline.coeffs.forEach((c, ci) => {
    const start = ci === 0 ? 0 : 1; // avoid duplicating shared knots
    for (let i = start; i <= perCurve; i++) {
      pts.push(value(c, i / perCurve));
    }
  });
  return pts;
};

/** Axis-aligned bounds of a set of points. */
export const boundsOf = (pts: Vec2[]) => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
};
