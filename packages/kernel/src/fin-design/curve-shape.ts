// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Exact shape queries on a spline, for the fin designer: which way each coordinate runs
 * along the curve, where it peaks, and where it crosses a given value. All split each
 * cubic segment at the roots of its derivative, so none depends on a sampling
 * resolution. Crossings are then found by bisection on a monotone piece, to full
 * floating-point precision.
 */
import type { Coeffs } from '../bezier-curve';
import type { Spline } from '../bezier-spline';
import { vec2, type Vec2 } from '../vec2';

type Axis = 'x' | 'y';

const cubicCoeffs = (k: Coeffs, axis: Axis): [number, number, number, number] =>
  axis === 'x' ? [k.ax, k.bx, k.cx, k.dx] : [k.ay, k.by, k.cy, k.dy];
/** Roots in (0, 1) of the derivative 3a·t² + 2b·t + c, ascending. */
const derivativeRoots = (a: number, b: number, c: number): number[] => {
  const A = 3 * a;
  const B = 2 * b;
  const scale = Math.max(Math.abs(A), Math.abs(B), Math.abs(c));
  if (scale === 0) return [];
  const roots: number[] = [];
  if (Math.abs(A) <= 1e-12 * scale) {
    if (Math.abs(B) > 1e-12 * scale) roots.push(-c / B);
  } else {
    const disc = B * B - 4 * A * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      roots.push((-B - sq) / (2 * A), (-B + sq) / (2 * A));
    }
  }
  return roots.filter((t) => t > 0 && t < 1).sort((p, q) => p - q);
};

/**
 * The direction `axis` runs along the spline, as a run-length list of signs: +1
 * increasing, −1 decreasing. Stretches where it doesn't change are left out, so a curve
 * that rises, pauses, and rises again is `[1]`.
 */
export const slopeSigns = (s: Spline, axis: Axis): number[] => {
  const signs: number[] = [];
  for (const k of s.coeffs) {
    const [a, b, c] = cubicCoeffs(k, axis);
    const cuts = [0, ...derivativeRoots(a, b, c), 1];
    const scale = Math.abs(3 * a) + Math.abs(2 * b) + Math.abs(c);
    for (let i = 0; i < cuts.length - 1; i++) {
      const t = (cuts[i]! + cuts[i + 1]!) / 2;
      const d = (3 * a * t + 2 * b) * t + c;
      if (Math.abs(d) <= 1e-12 * scale) continue;
      const sign = Math.sign(d);
      if (signs[signs.length - 1] !== sign) signs.push(sign);
    }
  }
  return signs;
};

/** A point on a spline: segment index, parameter within it, and position. */
export interface SplinePoint {
  readonly segment: number;
  readonly t: number;
  readonly point: Vec2;
}

const pointOn = (k: Coeffs, t: number): Vec2 =>
  vec2(((k.ax * t + k.bx) * t + k.cx) * t + k.dx, ((k.ay * t + k.by) * t + k.cy) * t + k.dy);

/** Point at t on a segment; the segment's own end points exactly at t = 0 and 1. */
const pointAt = (s: Spline, segment: number, t: number): Vec2 => {
  const c = s.curves[segment]!;
  return t === 0 ? c.p0 : t === 1 ? c.p3 : pointOn(s.coeffs[segment]!, t);
};

/** The exact lowest and highest points of the spline along `axis`. */
export const splineExtremes = (
  s: Spline,
  axis: Axis,
): { readonly min: SplinePoint; readonly max: SplinePoint } => {
  let min: SplinePoint | null = null;
  let max: SplinePoint | null = null;
  s.coeffs.forEach((k, segment) => {
    const [a, b, c] = cubicCoeffs(k, axis);
    for (const t of [0, ...derivativeRoots(a, b, c), 1]) {
      const point = pointAt(s, segment, t);
      const v = point[axis];
      if (!min || v < min.point[axis]) min = { segment, t, point };
      if (!max || v > max.point[axis]) max = { segment, t, point };
    }
  });
  if (!min || !max) throw new Error('splineExtremes: spline has no segments');
  return { min, max };
};

const BISECT_STEPS = 60;

/** The t in [t0, t1] where `at(t)` equals v; it must be monotone there. */
const solveMonotone = (at: (t: number) => number, v: number, t0: number, t1: number): number => {
  // Exact on an end: bisection would only approach it.
  if (at(t0) === v) return t0;
  if (at(t1) === v) return t1;
  const rising = at(t1) >= at(t0);
  let lo = t0;
  let hi = t1;
  for (let i = 0; i < BISECT_STEPS; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid) < v === rising) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
};

/**
 * Every point where the spline's `axis` coordinate equals `v`, in order along the curve.
 * A crossing at a piece boundary can be reported twice, once from each side.
 */
export const crossings = (s: Spline, axis: Axis, v: number): SplinePoint[] => {
  const out: SplinePoint[] = [];
  eachCrossing(s, axis, v, (segment, t) => {
    out.push({ segment, t, point: pointAt(s, segment, t) });
    return false;
  });
  return out;
};

/**
 * Calls `hit` with each crossing in order along the curve, until it returns true. The
 * coordinate is read on its own, as {@link pointAt} works it out but without making a
 * point at every bisection step: this is the fin blade's innermost loop.
 */
const eachCrossing = (
  s: Spline,
  axis: Axis,
  v: number,
  hit: (segment: number, t: number) => boolean,
): void => {
  for (let segment = 0; segment < s.coeffs.length; segment++) {
    const k = s.coeffs[segment]!;
    const [a, b, c, d] = cubicCoeffs(k, axis);
    const curve = s.curves[segment]!;
    const p0 = curve.p0[axis];
    const p3 = curve.p3[axis];
    const at = (t: number) => (t === 0 ? p0 : t === 1 ? p3 : ((a * t + b) * t + c) * t + d);
    const cuts = [0, ...derivativeRoots(a, b, c), 1];
    for (let i = 0; i < cuts.length - 1; i++) {
      const lo = Math.min(at(cuts[i]!), at(cuts[i + 1]!));
      const hi = Math.max(at(cuts[i]!), at(cuts[i + 1]!));
      if (v < lo || v > hi) continue;
      if (hit(segment, solveMonotone(at, v, cuts[i]!, cuts[i + 1]!))) return;
    }
  }
};

/**
 * y at x on a spline whose x never decreases (a section face or a taper; the rules
 * guarantee it). Exact, unlike the board's Newton-based `valueAt`, whose 0.03 mm
 * tolerance suits a board but not a normalised unit-chord curve.
 */
export const yAtX = (s: Spline, x: number): number => {
  let y: number | null = null;
  eachCrossing(s, 'x', x, (segment, t) => {
    y = pointAt(s, segment, t).y;
    return true;
  });
  if (y === null) throw new RangeError(`yAtX: x = ${x} is outside the curve`);
  return y;
};
