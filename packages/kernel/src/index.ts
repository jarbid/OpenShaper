/**
 * @board-studio/kernel — pure geometry + board model.
 *
 * Port target (Task #5) of the legacy Java packages:
 *   - cadcore: BezierCurve, BezierSpline, BezierKnot, BezierFit, MathUtils, VecMath
 *   - board:   BezierBoard, BezierBoardCrossSection, surface-interpolation models
 *
 * Everything here is framework-agnostic and side-effect free.
 *
 * Ported so far: vec2, constants, knot, bezier-curve.
 * Still to port: bezier-spline, bezier-board, cross-section, surface models, volume.
 */
export * from './vec2';
export * from './constants';
export * from './math';
export * from './knot';
export * from './bezier-curve';
export * from './bezier-spline';
export * from './cross-section';
export * from './board';
