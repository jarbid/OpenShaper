/**
 * Unit constants ported from the legacy `cadcore.UnitUtils` (BoardCAD-LE).
 *
 * The internal length unit of OpenShaper is the CENTIMETER, matching the
 * legacy engine. All conversion factors below are expressed relative to that
 * internal unit unless otherwise noted.
 */

/**
 * Selectable display units, ported from the legacy `int` constants on
 * `UnitUtils`. The numeric values are preserved so persisted documents /
 * golden fixtures that store the raw legacy ordinal continue to resolve.
 */
export const Unit = {
  CENTIMETERS: 0,
  INCHES: 1,
  MILLIMETERS: 2,
  INCHES_DECIMAL: 3,
  METERS: 4,
} as const;

export type Unit = (typeof Unit)[keyof typeof Unit];

// --- Imperial length ---------------------------------------------------------

/** Centimeters per inch. */
export const INCH = 2.54;
/** Inches per foot. */
export const INCHES_PR_FOOT = 12;
/** Centimeters per foot (`INCH * INCHES_PR_FOOT`). */
export const FOOT = INCH * INCHES_PR_FOOT;

// --- Metric length -----------------------------------------------------------

export const CENTIMETER_PR_METER = 100;
export const MILLIMETER_PR_CENTIMETER = 10;
/** Centimeters in a meter (alias of `CENTIMETER_PR_METER`). */
export const METER = CENTIMETER_PR_METER;
/** The internal length unit. */
export const CENTIMETER = 1;
/** Centimeters in a millimeter. */
export const MILLIMETER = 0.1;

// --- Area --------------------------------------------------------------------

export const SQUARECENTIMETER_PR_METER = 10000;
export const SQUAREMETER = SQUARECENTIMETER_PR_METER;

// --- Volume ------------------------------------------------------------------

export const CUBICCENTIMETER_PR_LITRE = 1000;
export const CUBICCENTIMETER_PR_US_PINT = 473;

// --- Mixed -------------------------------------------------------------------

export const CENTIMETER_PR_FOOT = INCH * INCHES_PR_FOOT;
export const FEET_PR_METER = CENTIMETER_PR_METER / CENTIMETER_PR_FOOT;

export const POUNDS_PR_KG = 2.20462262;

// --- Unit suffix strings -----------------------------------------------------
// Ported from the default (fallback) `LanguageResource.properties`. These are
// the literal strings the legacy `String.format` calls produced. The `²`
// character is U+00B2 (superscript two). Note the leading space baked into the
// moment-of-inertia strings, preserved from the legacy resource file.

export const UNIT_SQUAREFEET_STR = 'ft²';
export const UNIT_SQUAREMETERS_STR = 'm²';
export const UNIT_LITERS_STR = 'liters';
export const UNIT_POUNDS_STR = 'lbs';
export const UNIT_KILOGRAMS_STR = 'Kg';
export const UNIT_OUNCE_STR = 'oz';
export const UNIT_GRAMS_STR = 'gram';
export const UNIT_POUNDSPRFOOT_STR = 'lbs/ft²';
export const UNIT_KILOGRAMSPRLITER_STR = 'kg/l';
export const UNIT_POUNDSPRFOOTSQUARED_STR = ' lb/ft²';
export const UNIT_KILOGRAMSPRMETERSQUARED_STR = ' kg/m²';
