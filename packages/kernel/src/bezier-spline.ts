// SPDX-License-Identifier: GPL-3.0-or-later
import {
  closestT,
  coeffsOf,
  curvature,
  curveFromKnots,
  curveLength,
  curveMaxX,
  curveMinX,
  minMaxNumerical,
  tangent,
  tForLength,
  tForMinMaxNumerical,
  tForTangent,
  tForX,
  value,
  xValue,
  yForX,
  yValue,
  type Coeffs,
  type CubicBezier,
} from './bezier-curve';
import { ANGLE_TOLERANCE, T_ONE, T_ZERO } from './constants';
import { clamp, getRoot, simpsonIntegral } from './math';
import { scaleKnot, type Knot } from './knot';
import type { Vec2 } from './vec2';
import { vec2 } from './vec2';

/**
 * A piecewise cubic spline, ported from legacy `cadcore.BezierSpline`.
 *
 * Built from an ordered list of knots; segment i spans knots[i]..knots[i+1].
 * Per-segment coefficients are precomputed once (the legacy recomputed lazily with
 * dirty flags). Immutable: editing produces a new spline in `@openshaper/store`.
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

/**
 * Nearest point on the whole spline to `p`: which curve segment, and the
 * parameter t within it (the search loop in legacy
 * `BezierSpline.getSplitControlPoint`). Returns null for a spline with no curves.
 * Feed `index`/`t` to `splitCurve(s.curves[index], t)` to insert a knot there.
 */
export const closestPointOnSpline = (s: Spline, p: Vec2): { index: number; t: number } | null => {
  if (s.coeffs.length === 0) return null;
  let bestIndex = 0;
  let bestT = 0;
  let bestDist = Infinity;
  for (let i = 0; i < s.coeffs.length; i++) {
    const k = s.coeffs[i]!;
    const tc = closestT(k, p.x, p.y);
    const d = Math.hypot(xValue(k, tc) - p.x, yValue(k, tc) - p.y);
    if (d < bestDist) {
      bestDist = d;
      bestIndex = i;
      bestT = tc;
    }
  }
  return { index: bestIndex, t: bestT };
};

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

// --- S (arc-length 0..1 over the whole spline), legacy getPointByS/getSByNormalReverse ---

/** Point at fractional arc length s∈[0,1] (legacy getPointByS → getPointByCurveLength). */
export const pointByS = (s: Spline, sFrac: number): Vec2 =>
  pointByCurveLength(s, sFrac * splineLength(s));

/** Point at a given cumulative arc length (legacy getPointByCurveLength). */
export const pointByCurveLength = (s: Spline, curveLengthAbs: number): Vec2 => {
  const total = splineLength(s);
  if (curveLengthAbs <= 0) return value(s.coeffs[0]!, T_ZERO);
  if (curveLengthAbs >= total) return value(s.coeffs[s.coeffs.length - 1]!, T_ONE);

  let l = curveLengthAbs;
  for (let i = 0; i < s.coeffs.length; i++) {
    const k = s.coeffs[i]!;
    const cur = curveLength(k);
    if (l < cur) return value(k, tForLength(k, l));
    l -= cur;
  }
  // Fallback (shouldn't reach): last point.
  return value(s.coeffs[s.coeffs.length - 1]!, T_ONE);
};

/** Cumulative arc length of segments [startIndex, endIndex) (legacy getLengthByControlPointIndex). */
const lengthByControlPointIndex = (s: Spline, startIndex: number, endIndex: number): number => {
  let length = 0;
  for (let i = startIndex; i < endIndex; i++) length += curveLength(s.coeffs[i]!);
  return length;
};

/**
 * Arc length to the point whose tangent angle equals `targetAngle`, searching
 * segments from the END toward the start (legacy getLengthByTangentReverse). The
 * `useMinimumAngleOnSharpCorners` flag controls corner handling, exactly as legacy.
 */
const lengthByTangentReverse = (
  s: Spline,
  targetAngle: number,
  useMinimumAngleOnSharpCorners: boolean,
): number => {
  let length = 0;
  let t = 0;
  let minAngleError = 10000;
  let minErrorT = -1;
  let minAngleErrorSection = -1;
  let targetFound = false;

  let i: number;
  for (i = s.coeffs.length - 1; i >= 0; i--) {
    const k = s.coeffs[i]!;
    const startAngle = tangent(k, T_ZERO);
    const endAngle = tangent(k, T_ONE);

    if (endAngle > targetAngle) {
      if (useMinimumAngleOnSharpCorners) {
        i += 1;
      } else {
        length = curveLength(k, T_ZERO, T_ONE - 0.05);
      }
      targetFound = true;
      break;
    }

    let initialT = (targetAngle - startAngle) / (endAngle - startAngle);
    if (initialT < 0.0) initialT = 0.0;
    if (initialT > 1.0) initialT = 1.0;
    let lastT = initialT + 0.1;
    if (lastT > 1.0) lastT -= 0.2;

    t = tForTangent(k, targetAngle, initialT, lastT);

    const tAngle = tangent(k, t);
    const angleError = Math.abs(tAngle - targetAngle);
    if (minAngleError > angleError) {
      minAngleError = angleError;
      minErrorT = t;
      minAngleErrorSection = i;
    }
    if (angleError <= ANGLE_TOLERANCE) {
      length = curveLength(k, T_ZERO, t);
      targetFound = true;
      break;
    }
  }

  if (!targetFound && minAngleErrorSection !== -1) {
    length = curveLength(s.coeffs[minAngleErrorSection]!, T_ZERO, minErrorT);
    i = minAngleErrorSection;
  }

  length += lengthByControlPointIndex(s, 0, i);
  return length;
};

/**
 * Fractional arc length s∈[ZERO,ONE] at the point whose NORMAL angle equals
 * `angle` (legacy getSByNormalReverse → getSByTangentReverse on angle−π/2).
 */
export const sByNormalReverse = (
  s: Spline,
  angle: number,
  useMinimumAngleOnSharpCorners = true,
): number => {
  const tangentAngle = angle - Math.PI / 2.0;
  const total = splineLength(s);
  const sFrac = lengthByTangentReverse(s, tangentAngle, useMinimumAngleOnSharpCorners) / total;
  return clamp(sFrac, T_ZERO, T_ONE);
};

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

// Reverse segment lookup (legacy findMatchingBezierSegmentReverse): scans from the
// last segment toward the first. Used by getValueAtReverse to pick the deck side.
const findSegmentSimpleReverse = (s: Spline, pos: number): number => {
  for (let i = s.curves.length - 1; i >= 0; i--) {
    const lx = s.knots[i]!.end.x;
    const ux = s.knots[i + 1]!.end.x;
    if ((lx <= pos && ux >= pos) || (ux <= pos && lx >= pos)) return i;
  }
  return -1;
};

const findSegmentMinMaxReverse = (s: Spline, pos: number): number => {
  for (let i = s.coeffs.length - 1; i >= 0; i--) {
    const lx = curveMinX(s.coeffs[i]!);
    const ux = curveMaxX(s.coeffs[i]!);
    if (lx <= pos && ux >= pos) return i;
  }
  return -1;
};

export const findSegmentReverse = (s: Spline, pos: number): number => {
  const simple = findSegmentSimpleReverse(s, pos);
  return simple < 0 ? findSegmentMinMaxReverse(s, pos) : simple;
};

// --- evaluation ---

/** y at a given x along the spline (legacy getValueAt). Returns 0 if out of range. */
export const valueAt = (s: Spline, pos: number): number => {
  const i = findSegment(s, pos);
  return i === -1 ? 0 : yForX(s.coeffs[i]!, pos);
};

/** y at x using the reverse segment search (legacy getValueAtReverse, deck side). */
export const valueAtReverse = (s: Spline, pos: number): number => {
  const i = findSegmentReverse(s, pos);
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
