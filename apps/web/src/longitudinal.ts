import { splineLengthToX, splineXAtLength, type Spline } from '@openshaper/kernel';

/** How board-length positions are measured: straight along x, or over the bottom curve. */
export type MeasurementAxis = 'x-axis' | 'o-curve';

/**
 * Converts board-length positions between the model's x and the selected measurement.
 * Geometry always stays in x; only what is shown and typed goes through this.
 */
export interface Longitudinal {
  axis: MeasurementAxis;
  /** Model x → the number to show. */
  toDisplay: (x: number) => number;
  /** A shown or typed number → model x. */
  toModel: (distance: number) => number;
  /**
   * Appended to every converted readout, so an over-curve number is never mistaken
   * for a straight one (BoardCAD-LE's " O.C"). Empty on the x axis.
   */
  mark: string;
}

const identity = (value: number) => value;

/**
 * Over the curve means along `bottom`, the board's bottom rocker. Takes the spline rather
 * than the board so a memo keyed on it survives edits that leave the rocker alone.
 */
export const longitudinalFor = (bottom: Spline | null, axis: MeasurementAxis): Longitudinal =>
  axis === 'o-curve' && bottom
    ? {
        axis,
        toDisplay: (x) => splineLengthToX(bottom, x),
        toModel: (distance) => splineXAtLength(bottom, distance),
        mark: ' o/c',
      }
    : { axis, toDisplay: identity, toModel: identity, mark: '' };
