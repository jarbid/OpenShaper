import {
  LENGTH_TOLERANCE,
  MIN_MAX_SPLITS,
  POS_MAX_ITERATIONS,
  POS_TOLERANCE,
} from './constants';
import type { Knot } from './knot';
import type { Vec2 } from './vec2';
import { vec2 } from './vec2';

/**
 * A single cubic bezier segment, ported from legacy `cadcore.BezierCurve`.
 *
 * Effective control points follow the legacy mapping between two knots:
 *   p0 = start.end, c1 = start.tangentToNext, c2 = end.tangentToPrev, p3 = end.end
 *
 * Evaluation uses the legacy "cubeless" Horner form with precomputed coefficients
 * (Don Lancaster's formulation):
 *   x = ((ax·t + bx)·t + cx)·t + dx
 */
export interface CubicBezier {
  readonly p0: Vec2;
  readonly c1: Vec2;
  readonly c2: Vec2;
  readonly p3: Vec2;
}

export const curveFromKnots = (start: Knot, end: Knot): CubicBezier => ({
  p0: start.end,
  c1: start.tangentToNext,
  c2: end.tangentToPrev,
  p3: end.end,
});

export const curveFromPoints = (p0: Vec2, c1: Vec2, c2: Vec2, p3: Vec2): CubicBezier => ({
  p0,
  c1,
  c2,
  p3,
});

/** Precomputed polynomial coefficients (legacy coeff0..coeff7) plus endpoints. */
export interface Coeffs {
  readonly ax: number;
  readonly bx: number;
  readonly cx: number;
  readonly dx: number;
  readonly ay: number;
  readonly by: number;
  readonly cy: number;
  readonly dy: number;
  readonly p0x: number;
  readonly p3x: number;
}

export const coeffsOf = (c: CubicBezier): Coeffs => {
  const { p0, c1, c2, p3 } = c;
  return {
    // x = At^3 + Bt^2 + Ct + D
    ax: p3.x + 3 * (-c2.x + c1.x) - p0.x,
    bx: 3 * (c2.x - 2 * c1.x + p0.x),
    cx: 3 * (c1.x - p0.x),
    dx: p0.x,
    ay: p3.y + 3 * (-c2.y + c1.y) - p0.y,
    by: 3 * (c2.y - 2 * c1.y + p0.y),
    cy: 3 * (c1.y - p0.y),
    dy: p0.y,
    p0x: p0.x,
    p3x: p3.x,
  };
};

export const xValue = (k: Coeffs, t: number): number => ((k.ax * t + k.bx) * t + k.cx) * t + k.dx;
export const yValue = (k: Coeffs, t: number): number => ((k.ay * t + k.by) * t + k.cy) * t + k.dy;
export const value = (k: Coeffs, t: number): Vec2 => vec2(xValue(k, t), yValue(k, t));

export const xDeriv = (k: Coeffs, t: number): number => (3 * k.ax * t + 2 * k.bx) * t + k.cx;
export const yDeriv = (k: Coeffs, t: number): number => (3 * k.ay * t + 2 * k.by) * t + k.cy;
export const xDeriv2 = (k: Coeffs, t: number): number => 6 * k.ax * t + 2 * k.bx;
export const yDeriv2 = (k: Coeffs, t: number): number => 6 * k.ay * t + 2 * k.by;

/**
 * Tangent angle. NOTE the legacy convention is `atan2(dx, dy)` (x over y), not the
 * usual `atan2(dy, dx)` — this reflects BoardCAD's board-coordinate orientation.
 * Preserved exactly so ported geometry matches the legacy.
 */
export const tangent = (k: Coeffs, t: number): number => Math.atan2(xDeriv(k, t), yDeriv(k, t));
export const normal = (k: Coeffs, t: number): number => tangent(k, t) + Math.PI / 2;

export const tangentVector = (k: Coeffs, t: number): Vec2 => {
  const a = tangent(k, t);
  return vec2(Math.cos(a), Math.sin(a));
};

export const curvature = (k: Coeffs, t: number): number => {
  const dx = xDeriv(k, t);
  const dy = yDeriv(k, t);
  const ddx = xDeriv2(k, t);
  const ddy = yDeriv2(k, t);
  return (dx * ddy - dy * ddx) / Math.pow(dx * dx + dy * dy, 1.5);
};

/** Solve for the parameter t that yields a given x. Newton with bisection fallback. */
export const tForX = (k: Coeffs, x: number, startT?: number): number => {
  const t0Guess = startT ?? (x - k.p3x) / (k.p0x - k.p3x);
  let tn = t0Guess;
  let xn = xValue(k, tn);
  let error = x - xn;
  let n = 0;
  while (Math.abs(error) > POS_TOLERANCE && n++ < POS_MAX_ITERATIONS) {
    const slope = 1 / xDeriv(k, tn);
    tn = tn + error * slope;
    xn = xValue(k, tn);
    error = x - xn;
  }
  if (
    tn < 0 ||
    tn > 1 ||
    Number.isNaN(tn) ||
    n >= POS_MAX_ITERATIONS ||
    Math.abs(error) > POS_TOLERANCE
  ) {
    tn = tForXBisect(k, x, 0, 1, MIN_MAX_SPLITS);
  }
  return tn;
};

const tForXBisect = (k: Coeffs, x: number, t0: number, t1: number, nrOfSplits: number): number => {
  let bestT = 0;
  let bestError = 1e9;
  const seg = (t1 - t0) / nrOfSplits;
  for (let i = 1; i < nrOfSplits; i++) {
    const t = seg * i + t0;
    if (t < 0 || t > 1) continue;
    const error = Math.abs(x - xValue(k, t));
    if (error < bestError) {
      bestError = error;
      bestT = t;
    }
  }
  if (bestError < POS_TOLERANCE) return bestT;
  if (nrOfSplits <= 2) return bestT;
  return tForXBisect(k, x, bestT - seg, bestT + seg, Math.floor(nrOfSplits / 2));
};

export const yForX = (k: Coeffs, x: number): number => {
  const guess = (x - k.p0x) / (k.p3x - k.p0x);
  const t = tForX(k, x, guess);
  return yValue(k, t);
};

/** Recursive arc length over [t0, t1] (legacy chord-vs-polyline subdivision). */
export const length = (k: Coeffs, t0 = 0, t1 = 1): number => {
  const x0 = xValue(k, t0);
  const y0 = yValue(k, t0);
  const x1 = xValue(k, t1);
  const y1 = yValue(k, t1);
  const ts = (t1 - t0) / 2 + t0;
  const sx = xValue(k, ts);
  const sy = yValue(k, ts);
  const poly = Math.hypot(sx - x0, sy - y0) + Math.hypot(x1 - sx, y1 - sy);
  const chord = Math.hypot(x1 - x0, y1 - y0);
  if (poly - chord > LENGTH_TOLERANCE && t1 - t0 > 0.001) {
    return length(k, t0, ts) + length(k, ts, t1);
  }
  return poly;
};
