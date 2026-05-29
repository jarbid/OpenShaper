import {
  maxY as splineMaxY,
  pointByTT,
  scaleSpline as _scaleSpline,
  splineLength,
  ttByNormal,
  valueAt,
  xForMaxY,
  type Spline,
} from './bezier-spline';
import { T_ZERO } from './constants';
import {
  crossSection as makeCrossSection,
  csWidth,
  interpolateCrossSection,
  scaleCrossSection,
  type CrossSection,
} from './cross-section';
import { simpsonIntegral, trapezoidIntegralXY } from './math';

void _scaleSpline; // re-exported via index; referenced to keep import side-effect explicit

/**
 * Cross-section interpolation strategy (legacy AbstractBezierBoardSurfaceModel.ModelType).
 * Only `controlPoint` (the legacy default) is implemented; `sLinear` is a TODO.
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

// Legacy fixed integration resolutions (BezierBoard.*_SPLITS). Kept fixed so the
// port reproduces golden volume/area; adaptive refinement is a future option.
const VOLUME_X_SPLITS = 10;
const VOLUME_Y_SPLITS = 30;
const AREA_SPLITS = 10;
const MASS_X_SPLITS = 10;
const MASS_Y_SPLITS = 10;

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

// --- area / volume / mass (control-point interpolation model) ---

/**
 * Cross-sectional area at x (legacy ControlPointInterpolation model). Integrates
 * y dx along the deck (rail→deck-center) and bottom (bottom-center→rail) portions
 * of the interpolated section and doubles for both sides.
 */
export const getCrossSectionAreaAt = (b: BezierBoard, x: number, splits: number): number => {
  if (b.interpolationType !== 'controlPoint') {
    throw new Error(`interpolationType '${b.interpolationType}' not yet implemented`);
  }
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

/** Board volume in cm³ (legacy getVolume). */
export const getVolume = (b: BezierBoard): number => {
  if (b.crossSections.length < 3) return 0;
  const a = 0.01;
  const bEnd = getLength(b) - 0.01;
  return simpsonIntegral(
    (x) => getCrossSectionAreaAt(b, x, VOLUME_X_SPLITS),
    a,
    bEnd,
    VOLUME_Y_SPLITS,
  );
};

/** Planshape area in cm² (legacy getArea): integral of width over length. */
export const getArea = (b: BezierBoard): number =>
  simpsonIntegral((x) => getWidthAtPos(b, x), T_ZERO, getLength(b) - T_ZERO, AREA_SPLITS);

/** Longitudinal center of mass (legacy getCenterOfMass), assuming uniform density. */
export const getCenterOfMass = (b: BezierBoard): number => {
  if (b.crossSections.length < 3) return 0;
  const a = 0.01;
  const bEnd = getLength(b) - 0.01;
  const step = (bEnd - a) / MASS_Y_SPLITS;
  let momentSum = 0;
  let weightSum = 0;
  let an = a;
  let x0 = getCrossSectionAreaAt(b, an, MASS_X_SPLITS);
  for (let i = 0; i < MASS_Y_SPLITS; i++) {
    let x1 = getCrossSectionAreaAt(b, an + step / 2, MASS_X_SPLITS);
    let x2 = getCrossSectionAreaAt(b, an + step, MASS_X_SPLITS);
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
