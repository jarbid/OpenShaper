// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * @openshaper/kernel — pure geometry + board model.
 *
 * Port target (Task #5) of the legacy Java packages:
 *   - cadcore: BezierCurve, BezierSpline, BezierKnot, BezierFit, MathUtils, VecMath
 *   - board:   BezierBoard, BezierBoardCrossSection, surface-interpolation models
 *
 * Everything here is framework-agnostic and side-effect free. The legacy
 * port is complete for the curve, board, interpolation and volume code; what
 * still differs from BoardCAD-LE on purpose is listed in docs/specs/divergences.md.
 */
export * from './vec2';
export * from './constants';
export * from './math';
export * from './knot';
export * from './bezier-curve';
export * from './bezier-fit';
export * from './bezier-spline';
export * from './cross-section';
export * from './rail-profile';
export * from './outline-cutout';
export * from './board';
export * from './surface';
export * from './rail-band';
export * from './rail-facets';
export {
  bisectionLadder,
  RAIL_ANGLE_MODES,
  type RailAngleMode,
  type RailLeftover,
} from './rail-facet-fit';
export * from './loft';
export * from './section-fit';
export * from './bspline-surface';
export * from './board-surface';
export * from './tessellate';
export * from './guides';
export * from './fins';
export * from './tunni';
export * from './curvature-comb';
