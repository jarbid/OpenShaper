import {
  convertInputStringToInternalLengthUnit,
  convertLengthToUnit,
  convertLengthToUnitNumber,
  convertVolumeToUnit,
  Unit,
} from '@openshaper/units';

/**
 * A user-selectable length unit for display + input across the app. Wraps the
 * units-package `Unit` ordinal with the presentation choices the UI needs
 * (label, feet/meter promotion). Shapers work in mm, so that is the default.
 */
export interface LengthUnit {
  /** Stable id persisted to localStorage. */
  key: string;
  /** Toolbar label. */
  label: string;
  /** Underlying units-package unit. */
  unit: Unit;
  /** Promote to feet / meters for large values (legacy `useLargeUnits`). */
  large: boolean;
}

export const LENGTH_UNITS: LengthUnit[] = [
  { key: 'mm', label: 'mm', unit: Unit.MILLIMETERS, large: false },
  { key: 'cm', label: 'cm', unit: Unit.CENTIMETERS, large: false },
  { key: 'in', label: 'in', unit: Unit.INCHES, large: false },
  { key: 'ftin', label: 'ft·in', unit: Unit.INCHES, large: true },
];

/** Default length unit — mm, the unit shapers think in. */
export const DEFAULT_LENGTH_UNIT: LengthUnit = LENGTH_UNITS[0]!;

export const lengthUnitByKey = (key: string | null): LengthUnit =>
  LENGTH_UNITS.find((u) => u.key === key) ?? DEFAULT_LENGTH_UNIT;

/** Format an internal centimeter length per the chosen unit. */
export const fmtLen = (cm: number, u: LengthUnit): string =>
  convertLengthToUnit(cm, u.large, u.unit);

/** Volume is always shown in liters (matches the legacy convention). */
export const fmtVol = (cm3: number): string => convertVolumeToUnit(cm3);

/**
 * The shaper's shorthand for a board: `length × width × thickness` in the active
 * unit (e.g. `6'2" × 19 1/4" × 2 1/2"`). Used for the copyable spec headline.
 */
export const fmtDimsHeadline = (
  lengthCm: number,
  widthCm: number,
  thicknessCm: number,
  u: LengthUnit,
): string => `${fmtLen(lengthCm, u)} × ${fmtLen(widthCm, u)} × ${fmtLen(thicknessCm, u)}`;

/** Numeric value of an internal cm length in the chosen unit (for editable fields). */
export const cmToUnitNumber = (cm: number, u: LengthUnit): number =>
  convertLengthToUnitNumber(cm, u.unit);

/** Decimals to show in an editable field for the chosen unit. */
export const unitDecimals = (u: LengthUnit): number => {
  switch (u.unit) {
    case Unit.MILLIMETERS:
      return 1;
    case Unit.INCHES:
    case Unit.INCHES_DECIMAL:
      return 3;
    default:
      return 2;
  }
};

/** Short suffix shown beside editable fields. */
export const unitSuffix = (u: LengthUnit): string => {
  switch (u.unit) {
    case Unit.MILLIMETERS:
      return 'mm';
    case Unit.INCHES:
    case Unit.INCHES_DECIMAL:
      return 'in';
    default:
      return 'cm';
  }
};

/** Parse a user-typed length (in the chosen unit) back to internal centimeters. */
export const parseLen = (text: string, u: LengthUnit): number =>
  convertInputStringToInternalLengthUnit(text, u.unit);
