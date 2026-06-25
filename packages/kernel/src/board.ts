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
import { adaptiveSimpson, simpsonIntegral, trapezoidIntegralXY } from './math';
import { noFins, type FinConfig } from './fins';
import { cachedOutlineSegments, hasTailCutout, yInOut, type WidthBounds } from './outline-cutout';
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
 *     including the dummy zero-sections at tail (pos 0) and nose (pos length).
 *
 * Internal units are centimeters (so volume is cm³, area cm²).
 */
export interface BezierBoard {
  readonly outline: Spline;
  readonly bottom: Spline;
  readonly deck: Spline;
  /** Sorted by position ascending; index 0 = tail dummy (x=0), last = nose dummy (x=length). */
  readonly crossSections: readonly CrossSection[];
  readonly interpolationType: InterpolationType;
  /** Parametric fin configuration (resolved to geometry on demand by `resolveFins`). */
  readonly fins: FinConfig;
}

// Legacy fixed integration resolutions (BezierBoard.*_SPLITS). These are NO LONGER
// the defaults of the *longitudinal* integral — getVolume / getArea / getCenterOfMass
// now drive the length axis with `adaptiveSimpson` (see ADAPTIVE_REL_TOL below).
// They survive as:
//   - VOLUME_X_SPLITS / MASS_X_SPLITS: the default trapezoid resolution of the INNER
//     cross-section area sample (getCrossSectionAreaAt), which stays legacy-pinned.
//   - the values reproduced when a caller passes explicit IntegrationOptions / splits,
//     so the legacy fixed-split numbers remain available on demand (and the sLinear
//     per-station area golden, which uses SLINEAR_AREA_SPLITS, is untouched).
// Quadrupling the longitudinal splits moved volume/CoM on the golden boards by < 0.5%,
// but planshape area by up to ~0.63% (longboard) — AREA_SPLITS was the least-converged
// legacy resolution. The adaptive default lands on the converged value; the resulting
// intentional divergences from legacy are recorded in docs/specs/divergences.md.
const VOLUME_X_SPLITS = 10;
const AREA_SPLITS = 10;
const MASS_X_SPLITS = 10;
// Legacy longitudinal split counts (VOLUME_Y_SPLITS=30, MASS_Y_SPLITS=10) are no
// longer defaults — the length axis is adaptive. Callers reproduce them by passing
// `lengthSplits` explicitly (see board.integration.test.ts).

// Relative tolerance for the adaptive longitudinal integral (volume / area / CoM).
// Chosen for the volume worker hot path: getVolume re-runs on every settled edit, so
// the integrand (a cross-section area sample) must not be over-evaluated. Measured on
// the golden boards, 1e-5 is fully converged — it reproduces the volume/area/CoM that a
// 4x-finer fixed Simpson gives, while costing only ~13–260 integrand calls per board
// (vs the legacy fixed ~90). 1e-6 roughly doubles the call count for no measurable
// accuracy gain on these boards; 1e-4 leaves volume ~0.17% short of converged on the
// funboard. See board.integration.test.ts for the convergence oracle.
const ADAPTIVE_REL_TOL = 1e-5;

/**
 * Integration resolution override for the volume / center-of-mass integrals.
 *
 * When omitted, the longitudinal integral is adaptive (ADAPTIVE_REL_TOL). Supplying
 * `lengthSplits` switches that axis back to the legacy fixed-split Simpson with that
 * many panels (reproducing legacy values bit-for-bit when the legacy counts are
 * passed). `sectionSplits` always overrides the inner cross-section trapezoid count.
 */
export interface IntegrationOptions {
  /** Trapezoid splits per cross-section area sample (legacy VOLUME_X/MASS_X_SPLITS). */
  sectionSplits?: number;
  /**
   * Longitudinal Simpson panels (legacy VOLUME_Y/MASS_Y_SPLITS). Omit for the
   * adaptive default; pass a number to force the legacy fixed-split integrator.
   */
  lengthSplits?: number;
}

export const board = (
  outline: Spline,
  bottom: Spline,
  deck: Spline,
  crossSections: readonly CrossSection[],
  interpolationType: InterpolationType = 'controlPoint',
  fins: FinConfig = noFins(),
): BezierBoard => ({ outline, bottom, deck, crossSections, interpolationType, fins });

// --- dimensions ---

export const getLength = (b: BezierBoard): number => {
  let length = 0;
  for (const k of b.outline.knots) if (k.end.x > length) length = k.end.x;
  return length;
};

/**
 * Inner/outer half-widths at station `x`. For a normal (single-valued) outline the
 * inner wall is 0 and the outer rail is the exact `valueAt` — bit-identical to the
 * legacy. For a concave tail (swallow / fish) the outline is non-monotonic, so the
 * widths come from the polyline `(y_in, y_out)` split instead.
 */
export const widthBoundsAt = (b: BezierBoard, pos: number): WidthBounds =>
  hasTailCutout(b.outline)
    ? yInOut(cachedOutlineSegments(b.outline), pos)
    : { yIn: 0, yOut: valueAt(b.outline, pos) };

/**
 * Full outer width at `x` (legacy getWidth = 2·outline.y). For a concave tail this
 * is the outer rail width (2·y_out); the notch is accounted for separately via
 * {@link widthBoundsAt} in volume/area/mesh so the section is scaled to the rail.
 */
export const getWidthAtPos = (b: BezierBoard, pos: number): number =>
  widthBoundsAt(b, pos).yOut * 2;
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
  return changed ? board(b.outline, b.bottom, b.deck, next, b.interpolationType, b.fins) : b;
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
/**
 * Lateral compression a concave-tail notch applies to a station's section. The
 * cutout loft squeezes the full section into the band [y_in, y_out], so the foam
 * cross-section area (matching the rendered mesh) scales by (y_out − y_in)/y_out.
 * 1 for a normal board, so volume / mass stay bit-identical.
 */
const cutoutAreaFactor = (b: BezierBoard, x: number): number => {
  const { yIn, yOut } = widthBoundsAt(b, x);
  if (yOut <= 1e-6) return 1;
  const f = (yOut - yIn) / yOut;
  return f < 0 ? 0 : f;
};

export const getCrossSectionAreaAt = (b: BezierBoard, x: number, splits: number): number => {
  const base =
    b.interpolationType === 'sLinear'
      ? getSLinearCrossSectionAreaAt(b, x)
      : getControlPointCrossSectionAreaAt(b, x, splits);
  // A concave tail removes the inner strip; normal boards are untouched.
  return hasTailCutout(b.outline) ? base * cutoutAreaFactor(b, x) : base;
};

/**
 * Board volume in cm³ (legacy getVolume).
 *
 * The longitudinal integral defaults to {@link adaptiveSimpson}; pass
 * `opts.lengthSplits` to force the legacy fixed-split Simpson instead. The inner
 * cross-section area sample always uses `sectionSplits` (legacy VOLUME_X_SPLITS).
 */
export const getVolume = (b: BezierBoard, opts: IntegrationOptions = {}): number => {
  if (b.crossSections.length < 3) return 0;
  const { sectionSplits = VOLUME_X_SPLITS, lengthSplits } = opts;
  const a = 0.01;
  const bEnd = getLength(b) - 0.01;
  const areaAt = (x: number): number => getCrossSectionAreaAt(b, x, sectionSplits);
  return lengthSplits === undefined
    ? adaptiveSimpson(areaAt, a, bEnd, ADAPTIVE_REL_TOL)
    : simpsonIntegral(areaAt, a, bEnd, lengthSplits);
};

/**
 * Planshape area in cm² (legacy getArea): integral of width over length.
 *
 * Defaults to {@link adaptiveSimpson}; pass `splits` to force the legacy
 * fixed-split Simpson (e.g. `getArea(b, 10)` reproduces the legacy value).
 */
export const getArea = (b: BezierBoard, splits?: number): number => {
  const a = T_ZERO;
  const bEnd = getLength(b) - T_ZERO;
  // Foam width = 2·(y_out − y_in): a concave tail's notch removes the inner strip.
  // For a normal outline y_in = 0, so this is exactly the legacy 2·outline.y.
  const widthAt = (x: number): number => {
    const { yIn, yOut } = widthBoundsAt(b, x);
    return (yOut - yIn) * 2;
  };
  return splits === undefined
    ? adaptiveSimpson(widthAt, a, bEnd, ADAPTIVE_REL_TOL)
    : simpsonIntegral(widthAt, a, bEnd, splits);
};

/**
 * Longitudinal center of mass (legacy getCenterOfMass), assuming uniform density.
 *
 * CoM = ∫ x·A(x) dx / ∫ A(x) dx. Both the moment and the weight integrals default
 * to {@link adaptiveSimpson} (replacing the legacy manual fixed-step Simpson loop);
 * pass `opts.lengthSplits` to fall back to the fixed-split integrator. The adaptive
 * NaN→0 guarding matches the legacy loop's per-sample guarding.
 */
export const getCenterOfMass = (b: BezierBoard, opts: IntegrationOptions = {}): number => {
  if (b.crossSections.length < 3) return 0;
  const { sectionSplits = MASS_X_SPLITS, lengthSplits } = opts;
  const a = 0.01;
  const bEnd = getLength(b) - 0.01;
  const areaAt = (x: number): number => getCrossSectionAreaAt(b, x, sectionSplits);

  if (lengthSplits === undefined) {
    const moment = adaptiveSimpson((x) => x * areaAt(x), a, bEnd, ADAPTIVE_REL_TOL);
    const weight = adaptiveSimpson(areaAt, a, bEnd, ADAPTIVE_REL_TOL);
    return moment / weight;
  }

  // Legacy fixed-step Simpson loop (kept bit-for-bit for the explicit override).
  const step = (bEnd - a) / lengthSplits;
  let momentSum = 0;
  let weightSum = 0;
  let an = a;
  let x0 = areaAt(an);
  for (let i = 0; i < lengthSplits; i++) {
    let x1 = areaAt(an + step / 2);
    let x2 = areaAt(an + step);
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
