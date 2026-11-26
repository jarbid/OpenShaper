// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The Bottom panel's words and numbers, with no React: how a contour's numbers are written and typed in the
 * display unit (a length in the unit, a share of the width as a percent, a count as it is), the steps of the
 * arrow keys, what a position on a slider means, and the plain sentences the panel says.
 *
 * A contour's numbers come from the store with their ranges (`contourDials`); nothing here knows a limit.
 */
import type { ContourDial, ContourKey, DialInfo } from '@openshaper/store/rails';
import {
  cmToUnitNumber,
  fmtLen,
  fmtSmallLen,
  parseTypedLen,
  unitDecimals,
  unitSuffix,
  type LengthUnit,
} from '../format';

/** Positions on a slider, from the least a number may be to the most. */
export const SLIDER_STEPS = 200;

/** The slider position (0 to {@link SLIDER_STEPS}) of a value held to a range. A range of no width is the least end. */
export function sliderPosition(value: number, min: number, max: number): number {
  if (!(max > min)) return 0;
  const held = Math.min(max, Math.max(min, value));
  return Math.round(((held - min) / (max - min)) * SLIDER_STEPS);
}

/** The value at a slider position. */
export function fromSliderPosition(position: number, min: number, max: number): number {
  return min + (Math.min(SLIDER_STEPS, Math.max(0, position)) / SLIDER_STEPS) * (max - min);
}

/** A number as its field shows it: a length in the display unit, a share of the width as a whole percent, a count. */
export function dialNumber(unit: DialInfo['unit'], value: number, units: LengthUnit): string {
  switch (unit) {
    case 'length':
      return cmToUnitNumber(value, units).toFixed(unitDecimals(units));
    case 'percent':
      return (value * 100).toFixed(0);
    case 'count':
      return String(Math.round(value));
  }
}

/** Typed text as a number of the dial (cm, a fraction or a count), or null when it is not a number. */
export function parseDialNumber(
  unit: DialInfo['unit'],
  text: string,
  units: LengthUnit,
): number | null {
  switch (unit) {
    case 'length':
      return parseTypedLen(text, units);
    case 'percent': {
      const n = Number.parseFloat(text.replace(',', '.'));
      return Number.isFinite(n) ? n / 100 : null;
    }
    case 'count': {
      const n = Number.parseInt(text, 10);
      return Number.isFinite(n) ? n : null;
    }
  }
}

/** The suffix beside a field: the display unit, a percent sign, or nothing. */
export const dialSuffix = (unit: DialInfo['unit'], units: LengthUnit): string =>
  unit === 'length' ? unitSuffix(units) : unit === 'percent' ? '%' : '';

/** A dial's value and range as a short readout under its slider ("0 mm" and "13.7 mm"). */
export function rangeEnd(unit: DialInfo['unit'], value: number, units: LengthUnit): string {
  switch (unit) {
    case 'length':
      return fmtSmallLen(value, units);
    case 'percent':
      return `${(value * 100).toFixed(0)}%`;
    case 'count':
      return String(Math.round(value));
  }
}

/**
 * An arrow key's step in the dial's own terms (cm, a fraction, a count): a depth by a fifth of a millimetre, ten
 * times that with Shift (a depth is a few millimetres, so the display unit's own step would be a third of it);
 * a place along the board by a centimetre, ten with Shift; any other length by a millimetre, ten with Shift;
 * a width or a centre by one percent, ten with Shift; a count by one.
 */
export function dialStep(key: DialInfo['key'], unit: DialInfo['unit'], big: boolean): number {
  if (unit === 'count') return 1;
  if (unit === 'percent') return big ? 0.1 : 0.01;
  if (key === 'depth') return big ? 0.1 : 0.02;
  if (key === 'from' || key === 'to') return big ? 10 : 1;
  return big ? 1 : 0.1;
}

/** The sentence a held number gets: asked past the least or the most the board allows, or null when it was not. */
export function heldNote(asked: number, dial: ContourDial, units: LengthUnit): string | null {
  const slack = 1e-9;
  if (asked > dial.max + slack) {
    return `Held at the most this board allows here, ${rangeEnd(dial.unit, dial.max, units)}.`;
  }
  if (asked < dial.min - slack) {
    return `Held at the least this board allows here, ${rangeEnd(dial.unit, dial.min, units)}.`;
  }
  return null;
}

/** Where a contour runs, for a row of the list: "70 cm to 150 cm from the tail". */
export function runText(from: number, to: number, units: LengthUnit): string {
  return `${fmtLen(from, units)} to ${fmtLen(to, units)}`;
}

/** A contour's depth for a row of the list. */
export const depthText = (depth: number, units: LengthUnit): string => fmtSmallLen(depth, units);

/** What the face says for a board with no contour. */
export const NO_CONTOURS =
  'The bottom is flat. Add a contour to shape it: a concave, a vee or channels, each with its depth and where along the board it runs.';

/** What the panel says under the list when the board holds the most contours. */
export const AT_THE_MOST = 'This board holds as many contours as the engine builds.';

/** A key of the law along the board, as the panel names it. */
export const keyName = (key: ContourKey, count: number): string => `Key ${key.index} of ${count}`;
