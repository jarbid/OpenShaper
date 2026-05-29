/**
 * Value -> display-string formatting, ported from the legacy `UnitUtils`
 * `convert*ToCurrentUnit` / `convert*ToUnit` methods.
 *
 * All inputs are in INTERNAL units:
 *   - length  -> centimeters
 *   - area    -> square centimeters
 *   - volume  -> cubic centimeters
 *   - weight  -> kilograms
 *   - density -> kilograms per liter
 *   - moment of inertia -> kg·m²
 *
 * Output strings reproduce the legacy `String.format` output exactly, including
 * the imperial feet/inch/fraction reduction logic.
 */

import {
  CENTIMETER_PR_METER,
  CUBICCENTIMETER_PR_LITRE,
  FEET_PR_METER,
  INCH,
  INCHES_PR_FOOT,
  MILLIMETER_PR_CENTIMETER,
  POUNDS_PR_KG,
  UNIT_GRAMS_STR,
  UNIT_KILOGRAMS_STR,
  UNIT_KILOGRAMSPRLITER_STR,
  UNIT_KILOGRAMSPRMETERSQUARED_STR,
  UNIT_LITERS_STR,
  UNIT_OUNCE_STR,
  UNIT_POUNDS_STR,
  UNIT_POUNDSPRFOOT_STR,
  UNIT_POUNDSPRFOOTSQUARED_STR,
  UNIT_SQUAREFEET_STR,
  UNIT_SQUAREMETERS_STR,
  Unit,
} from './constants.js';
import { formatFixed } from './internal.js';

/** Default fraction denominator for imperial display (legacy `mFractionAccuracy`). */
export const DEFAULT_FRACTION_ACCURACY = 16;
/** Default decimal places for decimal-inch display (legacy `mNrOfDecimals`). */
export const DEFAULT_NR_OF_DECIMALS = 2;

/**
 * Format an internal centimeter length as a display string in `unit`.
 * Ported from `UnitUtils.convertLengthToUnit`.
 *
 * @param value             length in centimeters
 * @param useLargeUnits     promote to feet / meters when large enough
 * @param unit              target display unit
 * @param fractionAccuracy  imperial fraction denominator (2/4/8/16, default 16)
 * @param nrOfDecimals      decimals for INCHES_DECIMAL (default 2)
 */
export function convertLengthToUnit(
  value: number,
  useLargeUnits: boolean,
  unit: Unit,
  fractionAccuracy = DEFAULT_FRACTION_ACCURACY,
  nrOfDecimals = DEFAULT_NR_OF_DECIMALS,
): string {
  switch (unit) {
    case Unit.INCHES:
      return formatInchesFraction(value, useLargeUnits, fractionAccuracy);

    case Unit.METERS:
      return `${formatFixed(value / CENTIMETER_PR_METER, 3)} m`;

    case Unit.MILLIMETERS:
      return `${formatFixed(value * MILLIMETER_PR_CENTIMETER, 1)} mm`;

    case Unit.INCHES_DECIMAL:
      return formatInchesDecimal(value, useLargeUnits, nrOfDecimals);

    case Unit.CENTIMETERS:
    default: {
      if (useLargeUnits && value > CENTIMETER_PR_METER) {
        return `${formatFixed(value / CENTIMETER_PR_METER, 3)} m`;
      }
      return `${formatFixed(value, 2)} cm`;
    }
  }
}

function formatInchesFraction(
  value: number,
  useLargeUnits: boolean,
  fractionAccuracy: number,
): string {
  let prefix = '';
  if (value < 0) {
    prefix = '-';
  }
  value = Math.abs(value);

  let feet = 0;
  let inches = 0;
  let fraction = 0;
  let divider = fractionAccuracy;

  inches = Math.trunc(value / INCH);

  let hasFeet = false;
  if (useLargeUnits && inches > 3 * INCHES_PR_FOOT) {
    feet = Math.trunc(inches / INCHES_PR_FOOT);
    inches %= INCHES_PR_FOOT;
    hasFeet = true;
  }

  const hasInches = inches >= 1;

  // Fractional remainder of an inch, scaled by the denominator.
  // NOTE — deliberate improvement over legacy: the legacy `(int)` truncation here
  // displayed e.g. "3 7/16" for a value the user entered as "3 1/2", because IEEE-754
  // error makes 0.5*16 evaluate to 7.9999984 and truncate to 7. A tiny epsilon snaps
  // past that float noise (well below one fraction step) so honest inputs round-trip.
  fraction = Math.trunc((value / INCH - (inches + feet * 12)) * divider + 1e-4);

  let hasFraction = false;
  if (fraction > 0) {
    // Reduce the fraction by repeatedly dividing out factors of two.
    while (fraction % 2 === 0) {
      fraction /= 2;
      divider /= 2;
    }
    hasFraction = true;
  }

  // Reassemble in legacy order: [feet'] [inches] [fraction] then quote.
  let out = prefix;
  if (hasFeet) {
    out += `${feet}'`;
  }
  if (hasInches) {
    if (out.length > 0) out += ' ';
    out += `${inches}`;
  }
  if (hasFraction) {
    if (out.length > 0) out += ' ';
    out += `${fraction}/${divider}`;
  }

  // Legacy: if nothing was emitted (or only sign / only feet), emit "0".
  if (out.length === 0 || out === '-' || out.endsWith("'")) {
    out += '0';
  }
  out += '"';

  return out;
}

function formatInchesDecimal(
  value: number,
  useLargeUnits: boolean,
  nrOfDecimals: number,
): string {
  let prefix = '';
  if (value < 0) {
    prefix = '-';
  }
  value = Math.abs(value);

  let feet = 0;
  let inches = value / INCH;

  let hasFeet = false;
  if (useLargeUnits && inches > 3 * INCHES_PR_FOOT) {
    feet = Math.trunc(inches / INCHES_PR_FOOT);
    inches -= feet * INCHES_PR_FOOT;
    hasFeet = true;
  }

  let out = prefix;
  if (hasFeet) {
    out += `${feet}'`;
  }
  out += `${formatFixed(inches, nrOfDecimals)}"`;
  return out;
}

/**
 * Format an internal square-centimeter area.
 * Ported from `UnitUtils.convertAreaToCurrentUnit`.
 */
export function convertAreaToUnit(value: number, unit: Unit): string {
  switch (unit) {
    case Unit.INCHES:
    case Unit.INCHES_DECIMAL:
      return `${formatFixed(value * 0.00107639104, 3)} ${UNIT_SQUAREFEET_STR}`;
    case Unit.CENTIMETERS:
    case Unit.MILLIMETERS:
    case Unit.METERS:
    default:
      return `${formatFixed(value / (CENTIMETER_PR_METER * CENTIMETER_PR_METER), 3)} ${UNIT_SQUAREMETERS_STR}`;
  }
}

/**
 * Format an internal cubic-centimeter volume (always liters in legacy).
 * Ported from `UnitUtils.convertVolumeToCurrentUnit`.
 */
export function convertVolumeToUnit(value: number, _unit?: Unit): string {
  void _unit; // Legacy always formats liters regardless of selected unit.
  return `${formatFixed(value / CUBICCENTIMETER_PR_LITRE, 3)} ${UNIT_LITERS_STR}`;
}

/**
 * Format an internal kilogram weight.
 * Ported from `UnitUtils.convertWeightToCurrentUnit`.
 */
export function convertWeightToUnit(value: number, useSmallUnits: boolean, unit: Unit): string {
  switch (unit) {
    case Unit.INCHES:
    case Unit.INCHES_DECIMAL:
      if (useSmallUnits && value < 1.0) {
        return `${formatFixed(value / 0.0283495231, 3)} ${UNIT_OUNCE_STR}`;
      }
      return `${formatFixed(value / 0.45359237, 3)} ${UNIT_POUNDS_STR}`;
    case Unit.CENTIMETERS:
    case Unit.MILLIMETERS:
    case Unit.METERS:
    default:
      if (useSmallUnits && value < 1.0) {
        return `${formatFixed(value * 1000, 0)} ${UNIT_GRAMS_STR}`;
      }
      return `${formatFixed(value, 3)} ${UNIT_KILOGRAMS_STR}`;
  }
}

/**
 * Format an internal kg/l density.
 * Ported from `UnitUtils.convertDensityToCurrentUnit`.
 */
export function convertDensityToUnit(value: number, unit: Unit): string {
  switch (unit) {
    case Unit.INCHES:
    case Unit.INCHES_DECIMAL:
      return `${formatFixed(value * 62.4279606, 3)} ${UNIT_POUNDSPRFOOT_STR}`;
    case Unit.CENTIMETERS:
    case Unit.MILLIMETERS:
    case Unit.METERS:
    default:
      return `${formatFixed(value, 3)} ${UNIT_KILOGRAMSPRLITER_STR}`;
  }
}

/**
 * Format an internal kg·m² moment of inertia.
 * Ported from `UnitUtils.convertMomentOfInertiaToCurrentUnit`.
 */
export function convertMomentOfInertiaToUnit(value: number, unit: Unit): string {
  switch (unit) {
    case Unit.INCHES:
    case Unit.INCHES_DECIMAL:
      return `${formatFixed(value * POUNDS_PR_KG * FEET_PR_METER * FEET_PR_METER, 3)}${UNIT_POUNDSPRFOOTSQUARED_STR}`;
    case Unit.CENTIMETERS:
    case Unit.MILLIMETERS:
    case Unit.METERS:
    default:
      return `${formatFixed(value, 3)}${UNIT_KILOGRAMSPRMETERSQUARED_STR}`;
  }
}
