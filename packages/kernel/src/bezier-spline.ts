import {
  coeffsOf,
  curvature,
  curveFromKnots,
  length as curveLength,
  maxX as curveMaxX,
  minMaxNumerical,
  minX as curveMinX,
  tangent,
  tForMinMaxNumerical,
  tForX,
  value,
  xValue,
  yForX,
  type Coeffs,
  type CubicBezier,
} from './bezier-curve';
import { T_ONE } from './constants';
import { getRoot, simpsonIntegral } from './math';
import { scaleKnot, type Knot } from './knot';
import type { Vec2 } from './vec2';
import { vec2 } from './vec2';

/**
 * A piecewise cubic spline, ported from legacy `cadcore.BezierSpline`.
 *
 * Built from an ordered list of knots; segment i spans knots[i]..knots[i+1].
 * Per-segment coefficients are precomputed once (the legacy recomputed lazily with
 * dirty flags). Immutable: editing produces a new spline in `@board-studio/store`.
 */
export interface Spline {
  readonly knots: readonly Knot[];
  readonly curves: readonly CubicBezier[];
  readonly coeffs: readonly Coeffs[];
}

export const splineFromKnots = (knots: readonly Knot[]): Spline => {
  const curves: CubicBezier[] = [];
  const coeffs: Coeffs[] = [];
  for (let i = 0; i < knots.length - 1; i++) {
    const c = curveFromKnots(knots[i]!, knots[i + 1]!);
    curves.push(c);
    coeffs.push(coeffsOf(c));
  }
  return { knots, curves, coeffs };
};

export const nrOfCurves = (s: Spline): number => s.curves.length;
export const nrOfControlPoints = (s: Spline): number => s.knots.length;

/** Scale the whole spline (legacy order: vertical=y, horizontal=x). Returns a new spline. */
export const scaleSpline = (s: Spline, verticalScale: number, horizontalScale: number): Spline =>
  splineFromKnots(s.knots.map((k) => scaleKnot(k, horizontalScale, verticalScale)));

// --- TT (global 0..1 over all segments) lookups, legacy getPointByTT/getNormalByTT ---

const ttToSegment = (s: Spline, tt: number): { index: number; t: number } => {
  const n = nrOfCurves(s);
  let index = Math.floor(tt * n);
  let t = tt * n - index;
  if (tt >= 1) {
    index = n - 1;
    t = T_ONE;
  }
  return { index, t };
};

export const pointByTT = (s: Spline, tt: number): Vec2 => {
  const { index, t } = ttToSegment(s, tt);
  return value(s.coeffs[index]!, t);
};

export const normalByTT = (s: Spline, tt: number): number => {
  const { index, t } = ttToSegment(s, tt);
  return tangent(s.coeffs[index]!, t) + Math.PI / 2;
};

/** Global tt whose normal angle equals `angle` (legacy getTTByNormal via root find). */
export const ttByNormal = (s: Spline, angle: number): number =>
  getRoot((tt) => normalByTT(s, tt), angle, 0, 1);

// --- segment lookup (legacy findMatchingBezierSegment: simple then min/max) ---

const findSegmentSimple = (s: Spline, pos: number): number => {
  for (let i = 0; i < s.curves.length; i++) {
    const lx = s.knots[i]!.end.x;
    const ux = s.knots[i + 1]!.end.x;
    if (lx <= pos && ux >= pos) return i;
  }
  return -1;
};

const findSegmentMinMax = (s: Spline, pos: number): number => {
  for (let i = 0; i < s.coeffs.length; i++) {
    const lx = curveMinX(s.coeffs[i]!);
    const ux = curveMaxX(s.coeffs[i]!);
    if ((lx <= pos && ux >= pos) || (ux <= pos && lx >= pos)) return i;
  }
  return -1;
};

export const findSegment = (s: Spline, pos: number): number => {
  const simple = findSegmentSimple(s, pos);
  return simple < 0 ? findSegmentMinMax(s, pos) : simple;
};

// --- evaluation ---

/** y at a given x along the spline (legacy getValueAt). Returns 0 if out of range. */
export const valueAt = (s: Spline, pos: number): number => {
  const i = findSegment(s, pos);
  return i === -1 ? 0 : yForX(s.coeffs[i]!, pos);
};

export const splineLength = (s: Spline): number =>
  s.coeffs.reduce((acc, k) => acc + curveLength(k), 0);

export const maxX = (s: Spline): number => {
  let m = -1e5;
  for (const k of s.coeffs) m = Math.max(m, curveMaxX(k));
  return m;
};

// NOTE: legacy uses inconsistent loop bounds across these — maxX/minY scan all
// segments, while minX/maxY skip the last segment. Reproduced for golden fidelity.
export const minX = (s: Spline): number => {
  let m = Number.MAX_VALUE;
  for (let i = 0; i < s.coeffs.length - 1; i++) m = Math.min(m, curveMinX(s.coeffs[i]!));
  return m;
};

export const maxY = (s: Spline): number => {
  let m = -Number.MAX_VALUE;
  for (let i = 0; i < s.coeffs.length - 1; i++)
    m = Math.max(m, minMaxNumerical(s.coeffs[i]!, 'y', 'max'));
  return m;
};

export const minY = (s: Spline): number => {
  let m = 1e5;
  for (const k of s.coeffs) m = Math.min(m, minMaxNumerical(k, 'y', 'min'));
  return m;
};

export const tangentAt = (s: Spline, pos: number): number => {
  const i = findSegment(s, pos);
  if (i === -1) return 0;
  const k = s.coeffs[i]!;
  return tangent(k, tForX(k, pos));
};

export const normalAngle = (s: Spline, pos: number): number => tangentAt(s, pos) - Math.PI / 2;

/** Unit normal as the legacy returns it: (sin(angle), cos(angle)). */
export const normalAt = (s: Spline, pos: number): Vec2 => {
  const angle = normalAngle(s, pos);
  return vec2(Math.sin(angle), Math.cos(angle));
};

export const curvatureAt = (s: Spline, pos: number): number => {
  const i = findSegment(s, pos);
  if (i === -1) return 0;
  const k = s.coeffs[i]!;
  return curvature(k, tForX(k, pos));
};

/** Numerical integral of y over [a,b] using composite Simpson (legacy getIntegral). */
export const integral = (s: Spline, a: number, b: number, splits: number): number =>
  simpsonIntegral((x) => valueAt(s, x), a, b, splits);

/** Max y, searched only where x falls in [x0,x1] (legacy getMaxYInRange). */
export const maxYInRange = (s: Spline, x0: number, x1: number): number => {
  let max = -1e5;
  for (const k of s.coeffs) {
    const lx = curveMinX(k);
    const ux = curveMaxX(k);
    if (lx > x1 || ux < x0) continue;
    const t0 = tForX(k, x0, 0.1);
    const t1 = tForX(k, x1, 0.9);
    max = Math.max(max, minMaxNumerical(k, 'y', 'max', t0, t1));
  }
  return max;
};

/** x at the spline's global max y (legacy getXForMaxY). */
export const xForMaxY = (s: Spline): number => {
  let max = -1e5;
  let best: Coeffs | undefined;
  for (const k of s.coeffs) {
    const cur = minMaxNumerical(k, 'y', 'max');
    if (cur > max) {
      max = cur;
      best = k;
    }
  }
  if (!best) return 0;
  return xValue(best, tForMinMaxNumerical(best, 'y', 'max'));
};

/** x at the max y, restricted to where x falls in [x0,x1] (legacy getXForMaxYInRange). */
export const xForMaxYInRange = (s: Spline, x0: number, x1: number): number => {
  let max = -1e5;
  let best: Coeffs | undefined;
  for (const k of s.coeffs) {
    const lx = curveMinX(k);
    const ux = curveMaxX(k);
    if (lx > x1 || ux < x0) continue;
    const t0 = tForX(k, x0, 0.1);
    const t1 = tForX(k, x1, 0.9);
    const cur = minMaxNumerical(k, 'y', 'max', t0, t1);
    if (cur > max) {
      max = cur;
      best = k;
    }
  }
  if (!best) return 0;
  return xValue(best, tForMinMaxNumerical(best, 'y', 'max'));
};
