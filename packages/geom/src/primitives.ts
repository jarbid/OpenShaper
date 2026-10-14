// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Exact curve primitives (design §6.11; surfaces follow in F2): lines,
 * polylines, circles and arcs as rational quadratics (P&T A7.1), the periodic
 * circle, and one conic segment. Every primitive is on `[0, 1]` (period 1).
 *
 * A circle frame is given by two axes: `xAxis` is normalised, `yAxis` is made
 * perpendicular to it (Gram–Schmidt) and normalised, so the circle lies in the
 * plane they span and turns from `xAxis` towards `yAxis`.
 */
import { clampedBasis, clampedUniformKnots, periodicBasis } from './basis';
import { bezierCurve, makeCurve } from './curve';
import { fail } from './errors';
import { resolveTolerances } from './tolerance';
import type { ClampedCurve, Interval, PeriodicCurve, Point2, Point3 } from './types';

const SQRT1_2 = Math.SQRT1_2;

function checkPoint(p: Point2 | Point3, what: string, dim: 2 | 3): void {
  const ok =
    Number.isFinite(p.x) && Number.isFinite(p.y) && (dim === 2 || Number.isFinite((p as Point3).z));
  if (!ok) fail('non-finite', `${what} is not finite`);
}

function checkRadius(r: number): void {
  if (!Number.isFinite(r)) fail('non-finite', `radius is not finite: ${r}`, { value: r });
  if (!(r > 0)) fail('unsupported', `radius must be > 0; got ${r}`, { value: r });
}

/** The orthonormal in-plane frame `(X, Y)` of design's circle convention. */
function frame(xAxis: Point3, yAxis: Point3): { X: Point3; Y: Point3 } {
  checkPoint(xAxis, 'xAxis', 3);
  checkPoint(yAxis, 'yAxis', 3);
  const nx = Math.sqrt(xAxis.x * xAxis.x + xAxis.y * xAxis.y + xAxis.z * xAxis.z);
  if (!(nx > 0)) fail('dimension-mismatch', 'xAxis has zero length');
  const X = { x: xAxis.x / nx, y: xAxis.y / nx, z: xAxis.z / nx };
  const d = yAxis.x * X.x + yAxis.y * X.y + yAxis.z * X.z;
  const yx = yAxis.x - d * X.x;
  const yy = yAxis.y - d * X.y;
  const yz = yAxis.z - d * X.z;
  const ny = Math.sqrt(yx * yx + yy * yy + yz * yz);
  const ny0 = Math.sqrt(yAxis.x * yAxis.x + yAxis.y * yAxis.y + yAxis.z * yAxis.z);
  // Parallel axes span no plane; `angle` is the parallel test of design §7.
  if (!(ny > Math.sin(resolveTolerances().angle) * ny0)) {
    fail(
      'dimension-mismatch',
      'xAxis and yAxis are parallel (or yAxis is zero): they span no plane',
    );
  }
  return { X, Y: { x: yx / ny, y: yy / ny, z: yz / ny } };
}

/** The straight segment from `a` (t = 0) to `b` (t = 1): degree 1. */
export function line(a: Point3, b: Point3): ClampedCurve<3> {
  checkPoint(a, 'a', 3);
  checkPoint(b, 'b', 3);
  return bezierCurve(3, [a.x, a.y, a.z, b.x, b.y, b.z]);
}

/** The planar segment from `a` to `b`: degree 1. */
export function line2(a: Point2, b: Point2): ClampedCurve<2> {
  checkPoint(a, 'a', 2);
  checkPoint(b, 'b', 2);
  return bezierCurve(2, [a.x, a.y, b.x, b.y]);
}

/**
 * The degree-1 curve through `points` (stride `dim`), uniformly parameterised:
 * vertex `i` at `t = i/(m)` for `m` segments. `closed` appends the first point,
 * so the curve ends where it starts (`isClosed` is true).
 */
export function polyline<D extends 2 | 3>(
  points: ArrayLike<number>,
  dim: D,
  closed = false,
): ClampedCurve<D> {
  if (dim !== 2 && dim !== 3)
    fail('dimension-mismatch', `polyline dimension must be 2 or 3; got ${String(dim)}`);
  const n = points.length / dim;
  if (!Number.isInteger(n))
    fail('size-mismatch', `${points.length} values do not form ${dim}D points`);
  const min = closed ? 3 : 2;
  if (n < min)
    fail('too-few-points', `a ${closed ? 'closed ' : ''}polyline needs ≥ ${min} points; got ${n}`);
  const count = closed ? n + 1 : n;
  const pts = new Float64Array(count * dim);
  for (let i = 0; i < n * dim; i++) pts[i] = points[i]!;
  if (closed) for (let k = 0; k < dim; k++) pts[n * dim + k] = points[k]!;
  return makeCurve({ dim, basis: clampedBasis(1, clampedUniformKnots(1, count)), points: pts });
}

/**
 * P&T A7.1 (MakeNurbsCircle): the arc of radius `r` about `center` from angle
 * `a0` to `a1` (radians, `0 < a1 − a0 ≤ 2π`), measured from `xAxis` towards
 * `yAxis`. Split into `narcs ≤ 4` equal rational quadratic segments of sweep
 * `dθ ≤ π/2` with double interior knots; inner weights `cos(dθ/2)`. The inner
 * control point is the tangent intersection, written in closed form
 * (`r / cos(dθ/2)` along the mid-angle) instead of A7.1's `Intersect3DLines`:
 * the same point, without the line solve.
 */
export function circleArc(
  center: Point3,
  xAxis: Point3,
  yAxis: Point3,
  r: number,
  a0: number,
  a1: number,
): ClampedCurve<3> {
  checkPoint(center, 'center', 3);
  checkRadius(r);
  const { X, Y } = frame(xAxis, yAxis);
  const at = (cs: number, sn: number, k: number): readonly [number, number, number] => [
    center.x + k * (cs * X.x + sn * Y.x),
    center.y + k * (cs * X.y + sn * Y.y),
    center.z + k * (cs * X.z + sn * Y.z),
  ];
  return arcFromFrame(3, at, r, a0, a1) as ClampedCurve<3>;
}

/** A7.1 on a generic in-plane point map `at(cos, sin, radius)`. */
function arcFromFrame<D extends 2 | 3>(
  dim: D,
  at: (cs: number, sn: number, k: number) => readonly number[],
  r: number,
  a0: number,
  a1: number,
): ClampedCurve<D> {
  if (!Number.isFinite(a0) || !Number.isFinite(a1))
    fail('non-finite', `arc angles [${a0}, ${a1}] are not finite`);
  const theta = a1 - a0;
  if (!(theta > 0))
    fail('empty-domain', `arc sweep a1 − a0 must be > 0; got ${theta}`, { value: theta });
  const full = 2 * Math.PI;
  if (theta > full + resolveTolerances().angle) {
    fail('param-out-of-domain', `arc sweep ${theta} exceeds 2π`, { value: theta });
  }
  const narcs = theta <= Math.PI / 2 ? 1 : theta <= Math.PI ? 2 : theta <= 1.5 * Math.PI ? 3 : 4;
  const dtheta = theta / narcs;
  const w1 = Math.cos(dtheta / 2); // dtheta/2 is the base angle
  const count = 2 * narcs + 1;
  const pts = new Float64Array(count * dim);
  const wts = new Float64Array(count);
  const put = (i: number, p: readonly number[], w: number): void => {
    for (let k = 0; k < dim; k++) pts[i * dim + k] = p[k]!;
    wts[i] = w;
  };
  put(0, at(Math.cos(a0), Math.sin(a0), r), 1);
  let angle = a0;
  for (let i = 1; i <= narcs; i++) {
    const mid = angle + dtheta / 2;
    angle = i === narcs ? a1 : a0 + i * dtheta;
    put(2 * i - 1, at(Math.cos(mid), Math.sin(mid), r / w1), w1);
    put(2 * i, at(Math.cos(angle), Math.sin(angle), r), 1);
  }
  // Load the knot vector
  const U = new Float64Array(count + 3);
  for (let i = 0; i < 3; i++) U[count + i] = 1;
  for (let i = 1; i < narcs; i++) {
    U[1 + 2 * i] = i / narcs;
    U[2 + 2 * i] = i / narcs;
  }
  return makeCurve({
    dim,
    basis: clampedBasis(2, U),
    points: pts,
    weights: wts,
  }) as ClampedCurve<D>;
}

/** In-plane coordinates of the classical 9-point circle: square corners and edge midpoints. */
const SQUARE = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
] as const;
const SQUARE_KNOTS = [0, 0, 0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1, 1, 1];

function squareCircle<D extends 2 | 3>(
  dim: D,
  at: (u: number, v: number) => readonly number[],
): ClampedCurve<D> {
  const pts = new Float64Array(9 * dim);
  const wts = new Float64Array(9);
  for (let i = 0; i < 9; i++) {
    const [u, v] = SQUARE[i % 8]!;
    const p = at(u, v);
    for (let k = 0; k < dim; k++) pts[i * dim + k] = p[k]!;
    wts[i] = i % 2 === 1 ? SQRT1_2 : 1;
  }
  return makeCurve({
    dim,
    basis: clampedBasis(2, SQUARE_KNOTS),
    points: pts,
    weights: wts,
  }) as ClampedCurve<D>;
}

/**
 * The full circle as the classical 9-point rational quadratic (A7.1 with four
 * quarter arcs): control points on the circumscribed square with exact
 * coordinates, corner weights `√2/2`, knots `[0,0,0,¼,¼,½,½,¾,¾,1,1,1]`.
 * `C(0) = C(1) = center + r·X`.
 */
export function circle(center: Point3, xAxis: Point3, yAxis: Point3, r: number): ClampedCurve<3> {
  checkPoint(center, 'center', 3);
  checkRadius(r);
  const { X, Y } = frame(xAxis, yAxis);
  return squareCircle(3, (u, v) => [
    center.x + r * (u * X.x + v * Y.x),
    center.y + r * (u * X.y + v * Y.y),
    center.z + r * (u * X.z + v * Y.z),
  ]);
}

/**
 * A planar circle (counter-clockwise: signed curvature `+1/r`): the 9-point
 * full circle, or with `arc = [a0, a1]` the A7.1 arc between those angles.
 */
export function circle2(center: Point2, r: number, arc?: Interval): ClampedCurve<2> {
  checkPoint(center, 'center', 2);
  checkRadius(r);
  if (arc === undefined) return squareCircle(2, (u, v) => [center.x + r * u, center.y + r * v]);
  return arcFromFrame(2, (cs, sn, k) => [center.x + k * cs, center.y + k * sn], r, arc[0], arc[1]);
}

/**
 * The full circle as a periodic rational quadratic with 8 unique control
 * points (the 9-point circle without its duplicate): one period of knots
 * `[0, 0, ¼, ¼, ½, ½, ¾, ¾]`, period 1. With the periodic convention (basis
 * function `i` multiplies control point `i mod 8`), the double knot at 0 makes
 * the curve pass through the last control point there, so the points start at
 * the first corner: `C(0) = P_7 = center + r·X`.
 */
export function periodicCircle(
  center: Point3,
  xAxis: Point3,
  yAxis: Point3,
  r: number,
): PeriodicCurve<3> {
  checkPoint(center, 'center', 3);
  checkRadius(r);
  const { X, Y } = frame(xAxis, yAxis);
  const pts = new Float64Array(24);
  const wts = new Float64Array(8);
  for (let i = 0; i < 8; i++) {
    const [u, v] = SQUARE[(i + 1) % 8]!;
    pts[3 * i] = center.x + r * (u * X.x + v * Y.x);
    pts[3 * i + 1] = center.y + r * (u * X.y + v * Y.y);
    pts[3 * i + 2] = center.z + r * (u * X.z + v * Y.z);
    wts[i] = i % 2 === 0 ? SQRT1_2 : 1;
  }
  const basis = periodicBasis(2, [0, 0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75], 1);
  return makeCurve({ dim: 3, basis, points: pts, weights: wts });
}

/**
 * One rational quadratic conic segment (P&T §7.5; the A7.3 segment) from `p0`
 * to `p2` with tangents meeting at `apex`. The shape parameter `ρ ∈ (0, 1)`
 * sets the middle weight `w1 = ρ / (1 − ρ)`: `ρ < ½` an ellipse, `ρ = ½` a
 * parabola (polynomial), `ρ > ½` a hyperbola. A circular arc of half-angle φ
 * has `w1 = cos φ`. This is the rail-fullness control of plan decision D5.
 */
export function conicArc(p0: Point3, apex: Point3, p2: Point3, rho: number): ClampedCurve<3> {
  checkPoint(p0, 'p0', 3);
  checkPoint(apex, 'apex', 3);
  checkPoint(p2, 'p2', 3);
  if (!Number.isFinite(rho)) fail('non-finite', `rho is not finite: ${rho}`, { value: rho });
  if (!(rho > 0 && rho < 1))
    fail('weight-not-positive', `rho must lie in (0, 1); got ${rho}`, { value: rho });
  const w1 = rho / (1 - rho);
  return bezierCurve(3, [p0.x, p0.y, p0.z, apex.x, apex.y, apex.z, p2.x, p2.y, p2.z], [1, w1, 1]);
}
