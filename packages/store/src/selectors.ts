import {
  getArea,
  getCenterOfMass,
  getCenterWidth,
  getLength,
  getLengthOverCurve,
  getMaxRocker,
  getMaxThickness,
  getMaxThicknessPos,
  getMaxWidth,
  getMaxWidthPos,
  getRockerAtPos,
  getThickness,
  getThicknessAtPos,
  getVolume,
  getWidthAtPos,
  type BezierBoard,
} from '@openshaper/kernel';

/**
 * Derived board specs for the spec sidebar. Thin wrappers over the kernel getters
 * so the UI never touches geometry directly. Lengths are centimeters; volume cm³.
 *
 * The nose/tail station readouts mirror legacy `BoardSpec.updateMeasurements`: the
 * board axis runs tail (x = 0) → nose (x = length), measurements are taken one and
 * two feet in from each tip (FOOT = 30.48 cm), and "nose/tail rocker" is the raw
 * bottom-curve height at the tip (legacy reads `getRockerAtPos` directly — no
 * baseline subtraction). The tip is sampled a hair inside the end (the legacy
 * `length - 0.005` / `0.001` epsilons) to stay off the curve endpoint.
 */
export interface BoardSpecs {
  length: number;
  /** Length measured along the bottom rocker curve (legacy getLengthOverCurve). */
  lengthOverCurve: number;

  maxWidth: number;
  maxWidthPos: number;
  centerWidth: number;
  /** Width one foot in from the nose. */
  noseWidth: number;
  /** Width one foot in from the tail. */
  tailWidth: number;

  /** Thickness at the longitudinal center. */
  thickness: number;
  maxThickness: number;
  maxThicknessPos: number;
  /** Thickness one foot in from the nose. */
  noseThickness: number;
  /** Thickness one foot in from the tail. */
  tailThickness: number;

  maxRocker: number;
  /** Rocker at the nose tip. */
  noseRocker: number;
  /** Rocker one foot in from the nose. */
  noseRocker1: number;
  /** Rocker two feet in from the nose. */
  noseRocker2: number;
  /** Rocker at the tail tip. */
  tailRocker: number;
  /** Rocker one foot in from the tail. */
  tailRocker1: number;
  /** Rocker two feet in from the tail. */
  tailRocker2: number;

  /** Liters (volume cm³ / 1000) for display convenience. */
  volumeLiters: number;
  volume: number;
  area: number;
  centerOfMass: number;
}

/** One foot in centimeters (legacy `UnitUtils.FOOT = 12 * 2.54`). */
const FOOT = 30.48;
/** How far inside each end the "tip" rocker is sampled (legacy epsilons). */
const NOSE_TIP_INSET = 0.005;
const TAIL_TIP_INSET = 0.001;

// Volume/area are the heaviest selectors (numerical integration), so memoize by
// board identity — the store swaps the board reference on every edit, so a new
// reference correctly invalidates the cache. The station readouts are O(1) point
// evaluations and ride along on the same cache for free.
const cache = new WeakMap<BezierBoard, BoardSpecs>();

export const selectSpecs = (b: BezierBoard): BoardSpecs => {
  const hit = cache.get(b);
  if (hit) return hit;

  const length = getLength(b);
  const noseFoot = length - FOOT;
  const tailFoot = FOOT;
  const noseTwoFoot = length - 2 * FOOT;
  const tailTwoFoot = 2 * FOOT;

  const volume = getVolume(b);
  const specs: BoardSpecs = {
    length,
    lengthOverCurve: getLengthOverCurve(b),

    maxWidth: getMaxWidth(b),
    maxWidthPos: getMaxWidthPos(b),
    centerWidth: getCenterWidth(b),
    noseWidth: getWidthAtPos(b, noseFoot),
    tailWidth: getWidthAtPos(b, tailFoot),

    thickness: getThickness(b),
    maxThickness: getMaxThickness(b),
    maxThicknessPos: getMaxThicknessPos(b),
    noseThickness: getThicknessAtPos(b, noseFoot),
    tailThickness: getThicknessAtPos(b, tailFoot),

    maxRocker: getMaxRocker(b),
    noseRocker: getRockerAtPos(b, length - NOSE_TIP_INSET),
    noseRocker1: getRockerAtPos(b, noseFoot),
    noseRocker2: getRockerAtPos(b, noseTwoFoot),
    tailRocker: getRockerAtPos(b, TAIL_TIP_INSET),
    tailRocker1: getRockerAtPos(b, tailFoot),
    tailRocker2: getRockerAtPos(b, tailTwoFoot),

    volume,
    volumeLiters: volume / 1000,
    area: getArea(b),
    centerOfMass: getCenterOfMass(b),
  };
  cache.set(b, specs);
  return specs;
};
