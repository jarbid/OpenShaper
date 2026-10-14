// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Exact primitives (design §6.11). Curves: lines, polylines, circles and arcs
 * as rational quadratics (P&T A7.1), the periodic circle, and one conic
 * segment. Surfaces: planes, bilinear and Bézier patches, revolutions (A8.1)
 * with the sphere and torus, extrusions with the cylinder. Every primitive is
 * on `[0, 1]` (period 1) per direction, except a plane with an explicit domain.
 *
 * A circle frame is given by two axes: `xAxis` is normalised, `yAxis` is made
 * perpendicular to it (Gram–Schmidt) and normalised, so the circle lies in the
 * plane they span and turns from `xAxis` towards `yAxis`.
 */
import { clampedBasis, clampedUniformKnots, periodicBasis } from './basis';
import { bezierCurve, makeCurve } from './curve';
import { fail } from './errors';
import { makeSurface, surfaceFromHomogeneous } from './surface';
import { resolveTolerances } from './tolerance';
import type {
  Basis,
  ClampedCurve,
  Interval,
  NurbsCurve,
  NurbsSurface,
  PeriodicCurve,
  Point2,
  Point3,
} from './types';

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

// ---------------------------------------------------------------------------
// Surfaces (design §6.11, step F2)
// ---------------------------------------------------------------------------

const unitInterval: Interval = [0, 1];

function checkInterval(d: Interval, what: string): void {
  if (!Number.isFinite(d[0]) || !Number.isFinite(d[1]))
    fail('non-finite', `${what} domain is not finite`);
  if (!(d[1] > d[0])) fail('empty-domain', `${what} domain [${d[0]}, ${d[1]}] has no length`);
}

function unit3(a: Point3, what: string): Point3 {
  checkPoint(a, what, 3);
  const n = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
  if (!(n > 0) || !Number.isFinite(n)) fail('dimension-mismatch', `${what} has zero length`);
  return { x: a.x / n, y: a.y / n, z: a.z / n };
}

const cross3 = (a: Point3, b: Point3): Point3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

/**
 * A unit vector perpendicular to the unit `a`, chosen deterministically: `e`,
 * the coordinate axis least aligned with `a` (the first on ties), made
 * perpendicular to `a`. For `a = +z` it is `+x`.
 */
function perpendicular(a: Point3): Point3 {
  const ax = Math.abs(a.x);
  const ay = Math.abs(a.y);
  const az = Math.abs(a.z);
  const e =
    ax <= ay && ax <= az
      ? { x: 1, y: 0, z: 0 }
      : ay <= az
        ? { x: 0, y: 1, z: 0 }
        : { x: 0, y: 0, z: 1 };
  const d = e.x * a.x + e.y * a.y + e.z * a.z;
  return unit3({ x: e.x - d * a.x, y: e.y - d * a.y, z: e.z - d * a.z }, 'perpendicular');
}

/**
 * The plane `S(u, v) = origin + u·uAxis + v·vAxis` over `domain` (default
 * `[0, 1]²`): bilinear, degree (1, 1), control points at the domain corners.
 * `n = uAxis × vAxis` (normalised). The axes must span a plane.
 */
export function planeSurface(
  origin: Point3,
  uAxis: Point3,
  vAxis: Point3,
  domain?: { readonly u: Interval; readonly v: Interval },
): NurbsSurface {
  checkPoint(origin, 'origin', 3);
  checkPoint(uAxis, 'uAxis', 3);
  checkPoint(vAxis, 'vAxis', 3);
  const du = domain?.u ?? unitInterval;
  const dv = domain?.v ?? unitInterval;
  checkInterval(du, 'u');
  checkInterval(dv, 'v');
  const c = cross3(uAxis, vAxis);
  const nu = Math.sqrt(uAxis.x * uAxis.x + uAxis.y * uAxis.y + uAxis.z * uAxis.z);
  const nv = Math.sqrt(vAxis.x * vAxis.x + vAxis.y * vAxis.y + vAxis.z * vAxis.z);
  if (
    !(Math.sqrt(c.x * c.x + c.y * c.y + c.z * c.z) > Math.sin(resolveTolerances().angle) * nu * nv)
  ) {
    fail('dimension-mismatch', 'uAxis and vAxis are parallel (or zero): they span no plane');
  }
  const pts: number[] = [];
  for (const u of du) {
    for (const v of dv) {
      pts.push(
        origin.x + u * uAxis.x + v * vAxis.x,
        origin.y + u * uAxis.y + v * vAxis.y,
        origin.z + u * uAxis.z + v * vAxis.z,
      );
    }
  }
  return makeSurface({
    u: clampedBasis(1, [du[0], du[0], du[1], du[1]]),
    v: clampedBasis(1, [dv[0], dv[0], dv[1], dv[1]]),
    points: pts,
  });
}

/**
 * The bilinear patch through four corners on `[0, 1]²`: `p10` is `S(1, 0)`,
 * `p01` is `S(0, 1)`. With `p00 = 0`, `p10 = x`, `p01 = y`, `p11 = (1, 1, 1)` it
 * is the hyperbolic paraboloid `z = xy`.
 */
export function bilinearPatch(p00: Point3, p10: Point3, p01: Point3, p11: Point3): NurbsSurface {
  for (const [p, w] of [
    [p00, 'p00'],
    [p10, 'p10'],
    [p01, 'p01'],
    [p11, 'p11'],
  ] as const) {
    checkPoint(p, w, 3);
  }
  return bezierSurface(
    [p00.x, p00.y, p00.z, p01.x, p01.y, p01.z, p10.x, p10.y, p10.z, p11.x, p11.y, p11.z],
    2,
    2,
  );
}

/**
 * A tensor-product Bézier patch of degree `(countU − 1, countV − 1)` on
 * `[0, 1]²`: Euclidean points u-major (point `(i, j)` at `(i · countV + j) · 3`)
 * and optional weights.
 */
export function bezierSurface(
  points: ArrayLike<number>,
  countU: number,
  countV: number,
  weights?: ArrayLike<number>,
): NurbsSurface {
  for (const [n, w] of [
    [countU, 'countU'],
    [countV, 'countV'],
  ] as const) {
    if (!Number.isInteger(n) || n < 2)
      fail('too-few-points', `${w} must be an integer ≥ 2; got ${n}`, { value: n });
  }
  const knots = (n: number): Float64Array => {
    const U = new Float64Array(2 * n);
    U.fill(1, n);
    return U;
  };
  return makeSurface({
    u: clampedBasis(countU - 1, knots(countU)),
    v: clampedBasis(countV - 1, knots(countV)),
    points,
    weights,
  });
}

/**
 * The unit circle (or arc of `angle`) as a template in the plane: control
 * points `(a_i, b_i)`, weights and basis. A full turn is the periodic 8-point
 * circle of {@link periodicCircle}; an arc is A7.1 from angle 0.
 */
function circleTemplate(
  angle: number,
  full: boolean,
): {
  readonly basis: Basis;
  readonly ab: Float64Array;
  readonly w: Float64Array;
} {
  if (full) {
    const ab = new Float64Array(16);
    const w = new Float64Array(8);
    for (let i = 0; i < 8; i++) {
      const [a, b] = SQUARE[(i + 1) % 8]!;
      ab[2 * i] = a;
      ab[2 * i + 1] = b;
      w[i] = i % 2 === 0 ? SQRT1_2 : 1;
    }
    return { basis: periodicBasis(2, [0, 0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75], 1), ab, w };
  }
  const arc = arcFromFrame(2, (cs, sn, k) => [k * cs, k * sn], 1, 0, angle);
  const n = arc.basis.count;
  const ab = new Float64Array(2 * n);
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const wi = arc.cw[3 * i + 2]!;
    ab[2 * i] = arc.cw[3 * i]! / wi;
    ab[2 * i + 1] = arc.cw[3 * i + 1]! / wi;
    w[i] = wi;
  }
  return { basis: arc.basis, ab, w };
}

/**
 * P&T A8.1 (MakeRevolvedSurf): the surface swept by `profile` turning by
 * `angle` (radians, `0 < angle ≤ 2π`, default a full turn) about the axis
 * through `axisOrigin` along `axisDir`, counter-clockwise seen from the tip of
 * `axisDir` (right-hand rule). u is the turn on `[0, 1]`, v the profile's own
 * parameter (its basis is shared by reference). A full turn (within `angle` of
 * 2π) gives a periodic u (the 8-point periodic circle); a periodic profile
 * gives a periodic v.
 *
 * Each profile control point `P_j` (weight `w_j`) is rotated rigidly: with
 * `O_j` its foot on the axis, `X_j = (P_j − O_j)/r_j`, `Y_j = axis × X_j`,
 * `P_ij = O_j + r_j (a_i X_j + b_i Y_j)` and `w_ij = w_i w_j` for the circle
 * template `(a_i, b_i, w_i)`. A point exactly on the axis (`r_j = 0`) stays
 * put: the row collapses to a pole. The surface is exactly the rotated profile
 * (rotation is linear, so it commutes with the rational combination).
 * Orientation: `Su` turns about the axis, so `n = Su × Sv` points away from the
 * axis when the profile runs in `+axisDir` on the side `X_j` points to.
 */
export function revolve(
  profile: NurbsCurve<3>,
  axisOrigin: Point3,
  axisDir: Point3,
  angle: number = 2 * Math.PI,
): NurbsSurface {
  if (profile.dim !== 3)
    fail('dimension-mismatch', `revolve needs a 3D profile; got ${profile.dim}`);
  checkPoint(axisOrigin, 'axisOrigin', 3);
  const d = unit3(axisDir, 'axisDir');
  if (!Number.isFinite(angle)) fail('non-finite', `angle is not finite: ${angle}`);
  const tol = resolveTolerances();
  const full = 2 * Math.PI;
  if (!(angle > 0))
    fail('empty-domain', `revolve angle must be > 0; got ${angle}`, { value: angle });
  if (angle > full + tol.angle) fail('param-out-of-domain', `revolve angle ${angle} exceeds 2π`);
  const tpl = circleTemplate(angle, angle >= full - tol.angle);
  const nu = tpl.basis.count;
  const nv = profile.basis.count;
  const pts = new Float64Array(nu * nv * 3);
  const wts = new Float64Array(nu * nv);
  for (let j = 0; j < nv; j++) {
    const wj = profile.cw[4 * j + 3]!;
    const P = {
      x: profile.cw[4 * j]! / wj,
      y: profile.cw[4 * j + 1]! / wj,
      z: profile.cw[4 * j + 2]! / wj,
    };
    const t = (P.x - axisOrigin.x) * d.x + (P.y - axisOrigin.y) * d.y + (P.z - axisOrigin.z) * d.z;
    const O = { x: axisOrigin.x + t * d.x, y: axisOrigin.y + t * d.y, z: axisOrigin.z + t * d.z };
    const X = { x: P.x - O.x, y: P.y - O.y, z: P.z - O.z };
    const r = Math.sqrt(X.x * X.x + X.y * X.y + X.z * X.z);
    const Xh = r > 0 ? { x: X.x / r, y: X.y / r, z: X.z / r } : X;
    const Yh = cross3(d, Xh);
    for (let i = 0; i < nu; i++) {
      const a = tpl.ab[2 * i]!;
      const b = tpl.ab[2 * i + 1]!;
      const k = (i * nv + j) * 3;
      if (r > 0) {
        pts[k] = O.x + r * (a * Xh.x + b * Yh.x);
        pts[k + 1] = O.y + r * (a * Xh.y + b * Yh.y);
        pts[k + 2] = O.z + r * (a * Xh.z + b * Yh.z);
      } else {
        pts[k] = P.x;
        pts[k + 1] = P.y;
        pts[k + 2] = P.z;
      }
      wts[i * nv + j] = tpl.w[i]! * wj;
    }
  }
  return makeSurface({ u: tpl.basis, v: profile.basis, points: pts, weights: wts });
}

/**
 * The sphere of radius `r` about `center`, revolved about the `+z` axis: u
 * periodic (the turn, from `+x` towards `+y`), v clamped from the south pole
 * (v = 0) to the north pole (v = 1) through the exact two-quarter-arc
 * semicircle (control points on the circumscribed square, corner weights
 * `√2/2`). The pole rows are exactly collapsed. `n` points outward, so
 * `k₁ = k₂ = −1/r`; at the poles the normal is degenerate (`limitNormal`
 * gives `∓z`).
 */
export function sphere(center: Point3, r: number): NurbsSurface {
  checkPoint(center, 'center', 3);
  checkRadius(r);
  const { x, y, z } = center;
  const profile = makeCurve({
    dim: 3,
    basis: clampedBasis(2, [0, 0, 0, 0.5, 0.5, 1, 1, 1]),
    points: [x, y, z - r, x + r, y, z - r, x + r, y, z, x + r, y, z + r, x, y, z + r],
    weights: [1, SQRT1_2, 1, SQRT1_2, 1],
  });
  return revolve(profile, center, { x: 0, y: 0, z: 1 });
}

/**
 * The ring torus about `center` with axis `axis`: tube radius `r`, distance
 * `R > r` from the axis to the tube centre. Doubly periodic: u turns about the
 * axis, v round the tube (the periodic 8-point circle in the plane of `X` and
 * the axis, starting on the outer equator, turning towards `+axis`). `X` is
 * the deterministic perpendicular of `axis` (`+x` for a `+z` axis). `n` points
 * out of the tube: `k = −1/r` round the tube and `−cos φ/(R + r cos φ)` along
 * the parallels, `φ` the tube angle from the outer equator.
 */
export function torus(center: Point3, axis: Point3, R: number, r: number): NurbsSurface {
  checkPoint(center, 'center', 3);
  checkRadius(r);
  checkRadius(R);
  if (!(R > r)) fail('unsupported', `a ring torus needs R > r; got R = ${R}, r = ${r}`);
  const a = unit3(axis, 'axis');
  const X = perpendicular(a);
  const tube = periodicCircle(
    { x: center.x + R * X.x, y: center.y + R * X.y, z: center.z + R * X.z },
    X,
    a,
    r,
  );
  return revolve(tube, center, a);
}

/**
 * The extrusion (P&T §8.3, general cylinder) `S(u, v) = C(u) + v·dir` for
 * `v ∈ [0, 1]`: u is the curve's parameter (its basis shared by reference), v
 * linear. Weights are the curve's in both rows. `n = C′ × dir` (normalised).
 */
export function extrude(c: NurbsCurve<3>, dir: Point3): NurbsSurface {
  if (c.dim !== 3) fail('dimension-mismatch', `extrude needs a 3D curve; got ${c.dim}`);
  checkPoint(dir, 'dir', 3);
  if (!(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z > 0)) {
    fail('dimension-mismatch', 'extrusion direction has zero length');
  }
  const n = c.basis.count;
  const cw = new Float64Array(n * 8);
  for (let i = 0; i < n; i++) {
    const w = c.cw[4 * i + 3]!;
    for (let k = 0; k < 4; k++) cw[8 * i + k] = c.cw[4 * i + k]!;
    cw[8 * i + 4] = c.cw[4 * i]! + w * dir.x;
    cw[8 * i + 5] = c.cw[4 * i + 1]! + w * dir.y;
    cw[8 * i + 6] = c.cw[4 * i + 2]! + w * dir.z;
    cw[8 * i + 7] = w;
  }
  return surfaceFromHomogeneous({ u: c.basis, v: clampedBasis(1, [0, 0, 1, 1]), cw });
}

/**
 * The cylinder of radius `r` and height `h` on the circle about `base` in the
 * plane perpendicular to `axis`: the extrusion of the periodic circle by
 * `h · axis/|axis|`. u periodic (turning by the right-hand rule about `axis`,
 * from its deterministic perpendicular), v from the base (0) to the top (1).
 * `n` points outward: principal curvatures `(0, −1/r)`.
 */
export function cylinder(base: Point3, axis: Point3, r: number, h: number): NurbsSurface {
  checkPoint(base, 'base', 3);
  checkRadius(r);
  if (!Number.isFinite(h)) fail('non-finite', `height is not finite: ${h}`, { value: h });
  if (!(h > 0)) fail('unsupported', `height must be > 0; got ${h}`, { value: h });
  const a = unit3(axis, 'axis');
  const X = perpendicular(a);
  const c = periodicCircle(base, X, cross3(a, X), r);
  return extrude(c, { x: h * a.x, y: h * a.y, z: h * a.z });
}
