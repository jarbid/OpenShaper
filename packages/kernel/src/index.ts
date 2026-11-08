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
export * from './fin-design/futures-tab';
export * from './fin-design/fin-tab';
export * from './fin-design/fin-design';
export * from './fin-design/fin-rules';
export * from './fin-design/fin-readouts';
export * from './fin-design/blade';
export * from './fin-design/blade-surface';
export * from './fin-design/fin-placement';
export * from './fin-design/fin-clearance';
export * from './fin-design/naca';
export * from './fin-design/split-foil';
export * from './fin-design/mesh-slice';
export * from './fin-design/fin-mesh';
export * from './fin-design/fairness';
export * from './fin-design/smooth-blade';
export * from './fin-design/panel-fit';
export {
  defaultCanard,
  defaultFinDesign,
  defaultKeel,
  defaultSingleFin,
  defaultTwinFin,
  defaultTaper,
  flatFace,
} from './fin-design/fin-defaults';
export * from './fin-design/swept-loft';
export { yAtX } from './fin-design/curve-shape';
