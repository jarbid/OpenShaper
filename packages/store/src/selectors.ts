import {
  getArea,
  getCenterOfMass,
  getCenterWidth,
  getLength,
  getMaxRocker,
  getMaxThickness,
  getMaxThicknessPos,
  getMaxWidth,
  getMaxWidthPos,
  getThickness,
  getVolume,
  type BezierBoard,
} from '@openshaper/kernel';

/**
 * Derived board specs for the spec sidebar. Thin wrappers over the kernel getters
 * so the UI never touches geometry directly. Lengths are centimeters; volume cm³.
 */
export interface BoardSpecs {
  length: number;
  maxWidth: number;
  maxWidthPos: number;
  centerWidth: number;
  thickness: number;
  maxThickness: number;
  maxThicknessPos: number;
  maxRocker: number;
  /** Liters (volume cm³ / 1000) for display convenience. */
  volumeLiters: number;
  volume: number;
  area: number;
  centerOfMass: number;
}

// Volume/area are the heaviest selectors (numerical integration), so memoize by
// board identity — the store swaps the board reference on every edit, so a new
// reference correctly invalidates the cache.
const cache = new WeakMap<BezierBoard, BoardSpecs>();

export const selectSpecs = (b: BezierBoard): BoardSpecs => {
  const hit = cache.get(b);
  if (hit) return hit;
  const volume = getVolume(b);
  const specs: BoardSpecs = {
    length: getLength(b),
    maxWidth: getMaxWidth(b),
    maxWidthPos: getMaxWidthPos(b),
    centerWidth: getCenterWidth(b),
    thickness: getThickness(b),
    maxThickness: getMaxThickness(b),
    maxThicknessPos: getMaxThicknessPos(b),
    maxRocker: getMaxRocker(b),
    volume,
    volumeLiters: volume / 1000,
    area: getArea(b),
    centerOfMass: getCenterOfMass(b),
  };
  cache.set(b, specs);
  return specs;
};
