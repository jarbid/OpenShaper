/**
 * Input-string parsing, ported from the legacy `UnitUtils` `convert*` parse
 * helpers. All functions return values in the relevant INTERNAL unit:
 *   - length  -> centimeters
 *   - weight  -> kilograms
 *   - volume  -> liters
 *   - density -> kilograms per liter
 *
 * The legacy parser is permissive and swallows exceptions (returning a partial
 * or zero value). We preserve that behavior: malformed input yields `0` (or the
 * best-effort partial value) rather than throwing.
 */

import { INCH, Unit } from './constants.js';

/** Parse a bare fraction such as `"3/16"`. Returns `0` on failure (legacy). */
export function convertFractionStringToValue(string: string): number {
  const sa = string.split('/');
  const num = Number.parseFloat((sa[0] ?? '').trim());
  const den = Number.parseFloat((sa[1] ?? '').trim());
  if (!Number.isFinite(num) || !Number.isFinite(den)) {
    return 0;
  }
  return num / den;
}

/**
 * Parse a "combined" number that may contain a whole part and/or a fraction,
 * e.g. `"6"`, `"3/4"`, `"6 3/4"`. Non-numeric trailing characters are stripped.
 * Ported from `UnitUtils.convertCombinedStringToValue`.
 */
export function convertCombinedStringToValue(string: string): number {
  let value = 0;

  // Trim leading whitespace.
  string = string.replace(/^\s+/, '');

  // Remove all non-numeric characters at the end of the string.
  let n = string.length;
  while (n > 0 && !isDigit(string.charAt(n - 1))) {
    n--;
  }
  string = string.substring(0, n);

  // "6 3/4" form: whole part + space + fraction.
  if (string.includes(' ') && string.includes('/')) {
    const sa = string.split(/\s+/);
    string = sa[0] ?? '';
    value += convertFractionStringToValue((sa[1] ?? '').trim());
  }

  if (string.includes('/')) {
    value += convertFractionStringToValue(string.trim());
  } else if (string.trim().length > 0) {
    const parsed = Number.parseFloat(string.trim());
    if (Number.isFinite(parsed)) {
      value += parsed;
    }
  }

  return value;
}

/**
 * Parse a length string to internal centimeters.
 * Ported from `UnitUtils.convertInputStringToInternalLengthUnit`.
 *
 * @param string       the user input (e.g. `6'3\"`, `15cm`, `1.83m`)
 * @param selectedUnit the unit assumed when the string carries no unit marker
 */
export function convertInputStringToInternalLengthUnit(
  string: string,
  selectedUnit: Unit = Unit.INCHES,
): number {
  let value = 0;

  try {
    string = string.replace(/,/g, '.');

    if (string.includes("'") || string.includes('"')) {
      if (string.includes("'")) {
        const sa = string.split("'");
        if (sa.length > 1) {
          string = sa[1] ?? '';
        } else {
          string = '';
        }
        value += convertCombinedStringToValue(sa[0] ?? '') * 12 * INCH;
      }
      if (string.includes('"')) {
        string = string.substring(0, string.indexOf('"'));
      }
      value += convertCombinedStringToValue(string) * INCH;
    } else if (string.includes('m')) {
      // Note: legacy also tests LanguageResource "UNITMETER_STR" (== "meter");
      // matching the embedded 'm' covers those locale strings too.
      if (string.endsWith('mm') || string.endsWith('milimeter')) {
        string = string.substring(0, string.indexOf('m'));
        value += convertCombinedStringToValue(string) * 0.1;
      } else if (string.endsWith('cm') || string.endsWith('centimeter')) {
        string = string.substring(0, string.indexOf('c'));
        value += convertCombinedStringToValue(string) * 1;
      } else if (string.endsWith('m') || string.endsWith('meter')) {
        string = string.substring(0, string.indexOf('m'));
        value += convertCombinedStringToValue(string) * 100;
      } else {
        value += convertCombinedStringToValue(string) * 1; // Default to centimeter
      }
    } else {
      let mul = 1;
      switch (selectedUnit) {
        case Unit.MILLIMETERS:
          mul = 0.1;
          break;
        case Unit.INCHES:
          mul = INCH;
          break;
        case Unit.METERS:
          mul = 100.0;
          break;
        case Unit.CENTIMETERS:
        default:
          mul = 1.0;
          break;
      }
      value += convertCombinedStringToValue(string) * mul;
    }
  } catch {
    // Legacy swallows exceptions and returns the partial value.
  }

  return value;
}

/**
 * Parse a weight string to internal kilograms.
 * Ported from `UnitUtils.convertInputStringToInternalWeightUnit`.
 */
export function convertInputStringToInternalWeightUnit(
  string: string,
  selectedUnit: Unit = Unit.INCHES,
): number {
  let value = 0;
  let mul = 0;

  try {
    string = string.replace(/,/g, '.');
    if (string.endsWith('kg') || string.endsWith('kilo') || string.endsWith('kilogram')) {
      mul = 1; // Default to kg
    } else if (string.endsWith('g') || string.endsWith('gram')) {
      mul = 0.001; // Gram to kg
    } else if (string.endsWith('lb') || string.endsWith('lbs') || string.endsWith('pounds')) {
      mul = 0.45359237; // Pound to kg
    } else if (string.endsWith('oz') || string.endsWith('ounces')) {
      mul = 0.0283495231; // Ounce to kg
    } else {
      // Unknown, use current logic
      switch (selectedUnit) {
        case Unit.INCHES:
          mul = 0.45359237;
          break;
        default:
          mul = 1;
          break;
      }
    }
    value += convertCombinedStringToValue(string) * mul;
  } catch {
    // Legacy swallows exceptions.
  }

  return value;
}

/**
 * Parse a volume string to internal liters.
 * Ported from `UnitUtils.convertInputStringToInternalVolumeUnit`.
 */
export function convertInputStringToInternalVolumeUnit(string: string): number {
  let value = 0;
  let mul = 1;

  try {
    string = string.replace(/,/g, '.');
    if (
      string.endsWith('l') ||
      string.endsWith('liter') ||
      string.endsWith('litre') ||
      string.endsWith('dm^3') ||
      string.endsWith('dm³') ||
      string.endsWith('dm3')
    ) {
      mul = 1; // Default to cubic dm (liter)
    } else if (
      string.endsWith('m') ||
      string.endsWith('m3') ||
      string.endsWith('m^3') ||
      string.endsWith('m³') ||
      string.endsWith('cubicmeter') ||
      string.endsWith('cubic') ||
      string.endsWith('cubic meter') ||
      string.endsWith('cubicmetre') ||
      string.endsWith('cubic metre')
    ) {
      mul = 1000.0; // to cubic meter
    } else if (
      string.endsWith('cubic feet') ||
      string.endsWith('cubic foot') ||
      string.endsWith('cubic ft') ||
      string.endsWith('cu feet') ||
      string.endsWith('cu foot') ||
      string.endsWith('cu ft') ||
      string.endsWith('ft³') ||
      string.endsWith('ft') ||
      string.endsWith('ft3') ||
      string.endsWith('feet³') ||
      string.endsWith('foot³') ||
      string.endsWith('feet^3') ||
      string.endsWith('foot^3') ||
      string.endsWith('ft^3')
    ) {
      mul = 28.3168466; // cubic foot to liter
    }

    if (string.charAt(string.length - 1) === '3') {
      string = string.substring(0, string.length - 1);
    }

    value = convertCombinedStringToValue(string) * mul;
  } catch {
    // Legacy swallows exceptions.
  }

  return value;
}

/**
 * Parse a density string to internal kilograms per liter.
 * Ported from `UnitUtils.convertInputStringToInternalDensityUnit`.
 */
export function convertInputStringToInternalDensityUnit(
  string: string,
  selectedUnit: Unit = Unit.INCHES,
): number {
  let weight = 0.0;
  let volume = 0.0;

  try {
    string = string.replace(/,/g, '.');
    if (string.includes('/')) {
      const sa = string.split('/');
      weight = convertInputStringToInternalWeightUnit(sa[0] ?? '', selectedUnit);
      volume = convertInputStringToInternalVolumeUnit('1' + (sa[1] ?? ''));
    } else {
      weight = convertInputStringToInternalWeightUnit(string, selectedUnit);

      // Guess the most natural volume unit.
      if (string.endsWith('kg') || string.endsWith('kilo') || string.endsWith('kilogram')) {
        volume = 1000.0; // one cubic meter
      } else if (string.endsWith('g') || string.endsWith('gram')) {
        volume = 1.0; // gram per litre
      } else if (
        string.endsWith('lb') ||
        string.endsWith('lbs') ||
        string.endsWith('pounds')
      ) {
        volume = 28.3168466; // pound per cubic foot
      } else if (string.endsWith('oz') || string.endsWith('ounces')) {
        volume = 0.016387064; // ounce per cubic inch
      } else {
        switch (selectedUnit) {
          case Unit.INCHES:
            volume = 28.3168466;
            break;
          default:
            volume = 1;
            break;
        }
      }
    }
  } catch {
    // Legacy swallows exceptions.
  }

  return weight / volume;
}

function isDigit(ch: string): boolean {
  return ch.length === 1 && ch >= '0' && ch <= '9';
}
