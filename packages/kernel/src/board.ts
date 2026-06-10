// SPDX-License-Identifier: GPL-3.0-or-later
import {
  maxY as splineMaxY,
  pointByS,
  pointByTT,
  sByNormalReverse,
  scaleSpline,
  splineLength,
  ttByNormal,
  valueAt,
  valueAtReverse,
  xForMaxY,
  type Spline,
} from './bezier-spline';
import { DEG_TO_RAD, T_ONE, T_ZERO } from './constants';
import {
  crossSection as makeCrossSection,
  csCenterThickness,
  csWidth,
  interpolateCrossSection,
  scaleCrossSection,
  type CrossSection,
} from './cross-section';
import { simpsonIntegral, trapezoidIntegralXY } from './math';
import { vec2, type Vec2 } from './vec2';

/**
 * Cross-section interpolation strategy (legacy AbstractBezierBoardSurfaceModel.ModelType).
 *
 * Both models are implemented for the integration path: `getCrossSectionAreaAt`
 * dispatches on this type, so volume / center-of-mass / area distribution follow
 * the selected model (the sLinear port is pinned to golden data in
 * board.slinear.test.ts). Rendering and exports (`getInterpolatedCrossSection`,
 * tessellation) always use the control-point model — porting the sLinear surface
 * into the mesh/preview path is still open.
 */
export type InterpolationType = 'controlPoint' | 'sLinear';

/**
 * The surfboard model, ported from legacy `board.BezierBoard`.
 *
 * Geometry:
 *   - outline: half-width vs length (p32). width = 2·y.
 *   - bottom:  rocker curve (p33). rocker = y.
 *   - deck:    deck curve (p34).
 *   - crossSections: profile sections by longitudinal position (p35), sorted,
 *     including the dummy zero-sections at nose (pos 0) and tail (pos length).
 *
 * Internal units are centimeters (so volume is cm³, area cm²).
 */
export interface BezierBoard {
  readonly outline: Spline;
  readonly bottom: Spline;
  readonly deck: Spline;
  /** Sorted by position ascending; index 0 = nose dummy, last = tail dummy. */
  readonly crossSections: readonly CrossSection[];
  readonly interpolationType: InterpolationType;
}

// Legacy fixed integration resolutions (BezierBoard.*_SPLITS) — the *defaults*
// of getVolume / getArea / getCenterOfMass, kept so the port reproduces the
// golden values (board.golden.test.ts pins area/volume to 1%, and the sLinear
// port pins volume to 1e-4 relative). Callers that need more accuracy override
// the splits per call, or integrate with `adaptiveSimpson` (math.ts); making
// adaptive the default would require relaxing the sLinear golden volume band
// from 1e-4 to ~1e-2. Quadrupling these moves volume/CoM on the golden boards
// by < 0.5%, but planshape area by up to ~0.63% (longboard) — AREA_SPLITS is
// the least-converged legacy resolution (see board.integration.test.ts).
const VOLUME_X_SPLITS = 10;
const VOLUME_Y_SPLITS = 30;
const AREA_SPLITS = 10;
const MASS_X_SPLITS = 10;
const MASS_Y_SPLITS = 10;

/** Overridable integration resolutions for the volume / center-of-mass integrals. */
export interface IntegrationOptions {
  /** Trapezoid splits per cross-section area sample (legacy VOLUME_X/MASS_X_SPLITS). */
  sectionSplits?: number;
  /** Longitudinal Simpson panels (legacy VOLUME_Y/MASS_Y_SPLITS). */
  lengthSplits?: number;
}

export const board = (
  outline: Spline,
  bottom: Spline,
  deck: Spline,
  crossSections: readonly CrossSection[],
  interpolationType: InterpolationType = 'controlPoint',
): BezierBoard => ({ outline, bottom, deck, crossSections, interpolationType });

// --- dimensions ---

export const getLength = (b: BezierBoard): number => {
  let length = 0;
  for (const k of b.outline.knots) if (k.end.x > length) length = k.end.x;
  return length;
};

export const getWidthAtPos = (b: BezierBoard, pos: number): number => valueAt(b.outline, pos) * 2;
export const getRockerAtPos = (b: BezierBoard, pos: number): number => valueAt(b.bottom, pos);
export const getDeckAtPos = (b: BezierBoard, pos: number): number => valueAt(b.deck, pos);
export const getThicknessAtPos = (b: BezierBoard, pos: number): number =>
  getDeckAtPos(b, pos) - getRockerAtPos(b, pos);

export const getMaxWidth = (b: BezierBoard): number => splineMaxY(b.outline) * 2;
export const getMaxWidthPos = (b: BezierBoard): number => xForMaxY(b.outline);
export const getCenterWidth = (b: BezierBoard): number => getWidthAtPos(b, getLength(b) / 2);
export const getThickness = (b: BezierBoard): number => getThicknessAtPos(b, getLength(b) / 2);
export const getMaxRocker = (b: BezierBoard): number => splineMaxY(b.bottom);
export const getLengthOverCurve = (b: BezierBoard): number => splineLength(b.bottom);

const everyMillimeter = (b: BezierBoard, pick: (pos: number, cur: number) => void): void => {
  const steps = Math.floor(getLength(b) * 10);
  for (let i = 0; i < steps; i++) {
    const pos = i / 10;
    pick(pos, getThicknessAtPos(b, pos));
  }
};

export const getMaxThickness = (b: BezierBoard): number => {
  let max = -1e5;
  everyMillimeter(b, (_pos, cur) => {
    if (cur > max) max = cur;
  });
  return max;
};

export const getMaxThicknessPos = (b: BezierBoard): number => {
  let max = -1e5;
  let maxPos = -1e5;
  everyMillimeter(b, (pos, cur) => {
    if (cur > max) {
      max = cur;
      maxPos = pos;
    }
  });
  return maxPos;
};

// --- cross-section selection / interpolation ---

/** Nearest real (non-dummy) cross-section index; scans indices 1..size-2. */
export const getNearestCrossSectionIndex = (b: BezierBoard, pos: number): number => {
  let nearest = -1;
  let nearestPos = -3e5;
  for (let i = 1; i < b.crossSections.length - 1; i++) {
    const cur = b.crossSections[i]!;
    if (nearest === -1 || Math.abs(nearestPos - pos) > Math.abs(cur.position - pos)) {
      nearest = i;
      nearestPos = cur.position;
    }
  }
  return nearest;
};

/** Previous real cross-section index for x (legacy getPreviousCrossSectionIndex). */
const getPreviousCrossSectionIndex = (b: BezierBoard, pos: number): number => {
  let index = getNearestCrossSectionIndex(b, pos);
  if (b.crossSections[index]!.position >= pos) index -= 1;
  if (index === 0) index = 1;
  if (index > b.crossSections.length - 2) index = b.crossSections.length;
  return index;
};

/** Next real cross-section index for x (legacy getNextCrossSectionIndex). */
const getNextCrossSectionIndex = (b: BezierBoard, pos: number): number => {
  let index = getNearestCrossSectionIndex(b, pos);
  if (b.crossSections[index]!.position < pos) index += 1;
  if (index === 0) index = 1;
  if (index > b.crossSections.length - 2) index = b.crossSections.length - 2;
  return index;
};

const getPreviousCrossSectionPos = (b: BezierBoard, pos: number): number => {
  let index = getNearestCrossSectionIndex(b, pos);
  if (b.crossSections[index]!.position >= pos) index -= 1;
  return b.crossSections[index]!.position;
};

const getNextCrossSectionPos = (b: BezierBoard, pos: number): number => {
  let index = getNearestCrossSectionIndex(b, pos);
  if (b.crossSections[index]!.position < pos) index += 1;
  return b.crossSections[index]!.position;
};

/** Interpolated + board-scaled cross-section at x (legacy getInterpolatedCrossSection). */
export const getInterpolatedCrossSection = (b: BezierBoard, x: number): CrossSection | null => {
  const cs = b.crossSections;
  if (cs.length === 0 || x < 0 || x > getLength(b)) return null;

  let index = getNearestCrossSectionIndex(b, x);
  if (cs[index]!.position > x) index -= 1;
  let nextIndex = index + 1;

  const firstPos = cs[index]!.position;
  const secondPos = cs[nextIndex]!.position;
  let t = (x - firstPos) / (secondPos - firstPos);
  if (!Number.isFinite(t)) t = 0;

  if (index < 1) index = 1;
  if (nextIndex > cs.length - 2) {
    index = cs.length - 2;
    nextIndex = index;
  }

  const interpolated = interpolateCrossSection(cs[index]!, cs[nextIndex]!, t);

  let thickness = getThicknessAtPos(b, x);
  if (thickness < 0.5) thickness = 0.5;
  let width = getWidthAtPos(b, x);
  if (width < 0.5) width = 0.5;

  const scaled = scaleCrossSection(interpolated, thickness, width);
  return makeCrossSection(x, scaled.spline);
};

// Below this (cm) a station is considered already at the target dimension, so it
// is left alone — avoids pointless re-allocation (and float drift) on edits that
// don't move that station's thickness/width.
const ADJUST_EPS = 1e-6;

/**
 * Re-scale every interior (non-dummy) station so its centerline thickness and width
 * match the board's global curves at that position — legacy
 * `BezierBoard.adjustCrosssectionsToThicknessAndWidth`, which the legacy app runs after
 * every rocker / outline / cross-section edit.
 *
 * This is what couples the curves: the rocker+deck own a station's centerline thickness
 * (`getThicknessAtPos`) and the outline owns its width (`getWidthAtPos`), so editing a
 * global curve resizes the stored stations in that area, and a section edit only restyles
 * the profile shape. The nose/tail dummies (index 0 and last) are left untouched — their
 * ~zero dimensions would blow up the scale. Returns the same board reference when no
 * station needed to move (so undo / React don't see churn).
 */
export const adjustCrossSectionsToThicknessAndWidth = (b: BezierBoard): BezierBoard => {
  const cs = b.crossSections;
  if (cs.length <= 2) return b;
  let changed = false;
  const next = cs.map((c, i) => {
    if (i === 0 || i === cs.length - 1) return c;
    const targetThickness = getThicknessAtPos(b, c.position);
    const targetWidth = getWidthAtPos(b, c.position);
    if (
      Math.abs(csCenterThickness(c) - targetThickness) < ADJUST_EPS &&
      Math.abs(csWidth(c) - targetWidth) < ADJUST_EPS
    ) {
      return c;
    }
    const scaled = scaleCrossSection(c, targetThickness, targetWidth);
    if (scaled !== c) changed = true;
    return scaled;
  });
  return changed ? board(b.outline, b.bottom, b.deck, next, b.interpolationType) : b;
};

// --- sLinear (station-linear / arc-length) interpolation model ---

// Legacy fixed area resolution inside the sLinear surface model (it ignores the
// `splits` argument and uses BezierBoard.AREA_SPLITS). Kept fixed for golden fidelity.
const SLINEAR_AREA_SPLITS = AREA_SPLITS;

/** Center thickness of a cross-section at x≈0 (legacy getThicknessAtPos(ZERO)). */
const csThicknessAtZero = (spline: Spline): number =>
  valueAtReverse(spline, T_ZERO) - valueAt(spline, T_ZERO);

/**
 * 3D-ish point on the sLinear surface at longitudinal x and arc-length parameter
 * s∈[0,1], between normal angles [minAngle,maxAngle] (degrees). Returns the
 * cross-section-plane point as (y = lateral, z = height incl. rocker). Ported from
 * BezierBoardSLinearInterpolationSurfaceModel.getPointAt.
 */
const sLinearPoint = (
  b: BezierBoard,
  xIn: number,
  s: number,
  minAngle: number,
  maxAngle: number,
): { y: number; z: number } => {
  const len = getLength(b);
  let x = xIn;
  if (x < 0.1) x = 0.1;
  if (x > len - 0.1) x = len - 0.1;

  const c1 = b.crossSections[getPreviousCrossSectionIndex(b, x)]!;
  const c2 = b.crossSections[getNextCrossSectionIndex(b, x)]!;

  const targetWidth = getWidthAtPos(b, x);
  const targetThickness = getThicknessAtPos(b, x);

  const c1Width = csWidth(c1);
  const c1Thickness = csThicknessAtZero(c1.spline);
  const c2Width = csWidth(c2);
  const c2Thickness = csThicknessAtZero(c2.spline);

  // scaleSpline(vertical, horizontal); legacy scale(thicknessScale, widthScale).
  const c1Spline = scaleSpline(c1.spline, targetThickness / c1Thickness, targetWidth / c1Width);
  const c2Spline = scaleSpline(c2.spline, targetThickness / c2Thickness, targetWidth / c2Width);

  let s1min = T_ONE;
  let s2min = T_ONE;
  let s1max = T_ZERO;
  let s2max = T_ZERO;
  if (minAngle > 0.0) {
    s1min = sByNormalReverse(c1Spline, minAngle * DEG_TO_RAD, true);
    s2min = sByNormalReverse(c2Spline, minAngle * DEG_TO_RAD, true);
  }
  if (maxAngle < 270.0) {
    s1max = sByNormalReverse(c1Spline, maxAngle * DEG_TO_RAD, true);
    s2max = sByNormalReverse(c2Spline, maxAngle * DEG_TO_RAD, true);
  }

  const current1S = (s1max - s1min) * s + s1min;
  const current2S = (s2max - s2min) * s + s2min;

  const pos1 = getPreviousCrossSectionPos(b, x);
  const pos2 = getNextCrossSectionPos(b, x);

  const v1: Vec2 = pointByS(c1Spline, current1S);
  const v2: Vec2 = pointByS(c2Spline, current2S);

  const d = (x - pos1) / (pos2 - pos1);
  const retX = (1 - d) * v1.x + d * v2.x; // lateral (point.y in legacy)
  const retY = (1 - d) * v1.y + d * v2.y; // height before rocker
  const rocker = getRockerAtPos(b, x);
  return { y: retX, z: retY + rocker };
};

/** Cross-sectional area at x using the sLinear model (legacy getCrosssectionAreaAt). */
const getSLinearCrossSectionAreaAt = (b: BezierBoard, x: number): number => {
  const deckSample = (s: number) => {
    const p = sLinearPoint(b, x, s, -90.0, 90.0);
    return vec2(p.y, p.z);
  };
  const bottomSample = (s: number) => {
    const p = sLinearPoint(b, x, s, 90.0, 360.0);
    return vec2(p.y, p.z);
  };
  const deckIntegral = trapezoidIntegralXY(deckSample, 0.0, 1.0, SLINEAR_AREA_SPLITS);
  const bottomIntegral = trapezoidIntegralXY(bottomSample, 0.0, 1.0, SLINEAR_AREA_SPLITS);
  let area = (deckIntegral - bottomIntegral) * 2.0;
  if (area < 0) area = 0;
  return area;
};

// --- area / volume / mass (control-point interpolation model) ---

/** Cross-sectional area at x using the control-point interpolation model. */
const getControlPointCrossSectionAreaAt = (b: BezierBoard, x: number, splits: number): number => {
  const cs = getInterpolatedCrossSection(b, x);
  if (!cs) return 0;
  const ttAtRail = ttByNormal(cs.spline, (90 * Math.PI) / 180);
  const sample = (tt: number) => pointByTT(cs.spline, tt);
  const deckIntegral = trapezoidIntegralXY(sample, ttAtRail, 1.0, splits);
  const bottomIntegral = trapezoidIntegralXY(sample, 0.0, ttAtRail, splits);
  let area = (deckIntegral - bottomIntegral) * 2;
  if (area < 0) area = 0;
  return area;
};

/**
 * Cross-sectional area at x. Dispatches on the board's interpolation model:
 *  - `controlPoint`: integrates the interpolated section's deck/bottom (legacy
 *    BezierBoardControlPointInterpolationSurfaceModel).
 *  - `sLinear`: integrates arc-length-parameterized points blended between the two
 *    bounding stations (legacy BezierBoardSLinearInterpolationSurfaceModel). The
 *    sLinear model uses a fixed AREA_SPLITS internally, mirroring the legacy.
 */
export const getCrossSectionAreaAt = (b: BezierBoard, x: number, splits: number): number =>
  b.interpolationType === 'sLinear'
    ? getSLinearCrossSectionAreaAt(b, x)
    : getControlPointCrossSectionAreaAt(b, x, splits);

/** Board volume in cm³ (legacy getVolume). */
export const getVolume = (b: BezierBoard, opts: IntegrationOptions = {}): number => {
  if (b.crossSections.length < 3) return 0;
  const { sectionSplits = VOLUME_X_SPLITS, lengthSplits = VOLUME_Y_SPLITS } = opts;
  const a = 0.01;
  const bEnd = getLength(b) - 0.01;
  return simpsonIntegral((x) => getCrossSectionAreaAt(b, x, sectionSplits), a, bEnd, lengthSplits);
};

/** Planshape area in cm² (legacy getArea): integral of width over length. */
export const getArea = (b: BezierBoard, splits: number = AREA_SPLITS): number =>
  simpsonIntegral((x) => getWidthAtPos(b, x), T_ZERO, getLength(b) - T_ZERO, splits);

/** Longitudinal center of mass (legacy getCenterOfMass), assuming uniform density. */
export const getCenterOfMass = (b: BezierBoard, opts: IntegrationOptions = {}): number => {
  if (b.crossSections.length < 3) return 0;
  const { sectionSplits = MASS_X_SPLITS, lengthSplits = MASS_Y_SPLITS } = opts;
  const a = 0.01;
  const bEnd = getLength(b) - 0.01;
  const step = (bEnd - a) / lengthSplits;
  let momentSum = 0;
  let weightSum = 0;
  let an = a;
  let x0 = getCrossSectionAreaAt(b, an, sectionSplits);
  for (let i = 0; i < lengthSplits; i++) {
    let x1 = getCrossSectionAreaAt(b, an + step / 2, sectionSplits);
    let x2 = getCrossSectionAreaAt(b, an + step, sectionSplits);
    if (Number.isNaN(x0)) x0 = 0;
    if (Number.isNaN(x1)) x1 = 0;
    if (Number.isNaN(x2)) x2 = 0;
    const integral = (step / 6) * (x0 + 4 * x1 + x2);
    momentSum += (an + step / 2) * integral;
    weightSum += integral;
    an += step;
    x0 = x2;
  }
  return momentSum / weightSum;
};
