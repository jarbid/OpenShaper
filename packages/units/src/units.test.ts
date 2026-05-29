import { describe, expect, it } from 'vitest';

import {
  CENTIMETER,
  CENTIMETER_PR_FOOT,
  CENTIMETER_PR_METER,
  CUBICCENTIMETER_PR_LITRE,
  CUBICCENTIMETER_PR_US_PINT,
  FEET_PR_METER,
  FOOT,
  INCH,
  INCHES_PR_FOOT,
  METER,
  MILLIMETER,
  MILLIMETER_PR_CENTIMETER,
  POUNDS_PR_KG,
  SQUARECENTIMETER_PR_METER,
  SQUAREMETER,
  Unit,
  UnitSettings,
  convertAreaToUnit,
  convertCombinedStringToValue,
  convertDensityToUnit,
  convertFractionStringToValue,
  convertInputStringToInternalDensityUnit,
  convertInputStringToInternalLengthUnit,
  convertInputStringToInternalVolumeUnit,
  convertInputStringToInternalWeightUnit,
  convertLengthToUnit,
  convertMomentOfInertiaToUnit,
  convertVolumeToUnit,
  convertWeightToUnit,
} from './index.js';

describe('constants', () => {
  it('match the legacy UnitUtils values', () => {
    expect(INCH).toBe(2.54);
    expect(INCHES_PR_FOOT).toBe(12);
    expect(FOOT).toBe(2.54 * 12);
    expect(CENTIMETER_PR_METER).toBe(100);
    expect(MILLIMETER_PR_CENTIMETER).toBe(10);
    expect(METER).toBe(100);
    expect(CENTIMETER).toBe(1);
    expect(MILLIMETER).toBe(0.1);
    expect(SQUARECENTIMETER_PR_METER).toBe(10000);
    expect(SQUAREMETER).toBe(10000);
    expect(CUBICCENTIMETER_PR_LITRE).toBe(1000);
    expect(CUBICCENTIMETER_PR_US_PINT).toBe(473);
    expect(CENTIMETER_PR_FOOT).toBe(2.54 * 12);
    expect(FEET_PR_METER).toBe(100 / (2.54 * 12));
    expect(POUNDS_PR_KG).toBe(2.20462262);
  });

  it('exposes the legacy unit ordinals', () => {
    expect(Unit.CENTIMETERS).toBe(0);
    expect(Unit.INCHES).toBe(1);
    expect(Unit.MILLIMETERS).toBe(2);
    expect(Unit.INCHES_DECIMAL).toBe(3);
    expect(Unit.METERS).toBe(4);
  });
});

describe('convertFractionStringToValue', () => {
  it('parses simple fractions', () => {
    expect(convertFractionStringToValue('1/2')).toBe(0.5);
    expect(convertFractionStringToValue('3/16')).toBe(3 / 16);
    expect(convertFractionStringToValue(' 7 / 8 ')).toBe(7 / 8);
  });

  it('returns 0 on malformed input (legacy swallows the exception)', () => {
    expect(convertFractionStringToValue('abc')).toBe(0);
    expect(convertFractionStringToValue('1/')).toBe(0);
  });
});

describe('convertCombinedStringToValue', () => {
  it('parses whole numbers', () => {
    expect(convertCombinedStringToValue('6')).toBe(6);
    expect(convertCombinedStringToValue('  12  ')).toBe(12);
  });

  it('parses fractions and mixed numbers', () => {
    expect(convertCombinedStringToValue('3/4')).toBe(0.75);
    expect(convertCombinedStringToValue('6 3/4')).toBe(6.75);
  });

  it('strips trailing non-numeric characters', () => {
    expect(convertCombinedStringToValue('6cm')).toBe(6);
    expect(convertCombinedStringToValue('6"')).toBe(6);
  });
});

describe('convertInputStringToInternalLengthUnit (-> centimeters)', () => {
  it('parses feet/inches notation', () => {
    // 6'3" = 6*12*2.54 + 3*2.54
    expect(convertInputStringToInternalLengthUnit(`6'3"`)).toBeCloseTo(
      6 * 12 * INCH + 3 * INCH,
      10,
    );
    expect(convertInputStringToInternalLengthUnit(`6'`)).toBeCloseTo(6 * 12 * INCH, 10);
    expect(convertInputStringToInternalLengthUnit(`3"`)).toBeCloseTo(3 * INCH, 10);
  });

  it('parses inch fractions', () => {
    expect(convertInputStringToInternalLengthUnit(`6 3/4"`)).toBeCloseTo(6.75 * INCH, 10);
  });

  it('parses explicit metric markers', () => {
    expect(convertInputStringToInternalLengthUnit('15cm')).toBeCloseTo(15, 10);
    expect(convertInputStringToInternalLengthUnit('150mm')).toBeCloseTo(15, 10);
    expect(convertInputStringToInternalLengthUnit('1.83m')).toBeCloseTo(183, 10);
  });

  it('honours comma as decimal separator', () => {
    expect(convertInputStringToInternalLengthUnit('1,83m')).toBeCloseTo(183, 10);
  });

  it('uses the selected unit when no marker is present', () => {
    expect(convertInputStringToInternalLengthUnit('10', Unit.CENTIMETERS)).toBeCloseTo(10, 10);
    expect(convertInputStringToInternalLengthUnit('10', Unit.MILLIMETERS)).toBeCloseTo(1, 10);
    expect(convertInputStringToInternalLengthUnit('10', Unit.METERS)).toBeCloseTo(1000, 10);
    expect(convertInputStringToInternalLengthUnit('10', Unit.INCHES)).toBeCloseTo(10 * INCH, 10);
  });
});

describe('convertInputStringToInternalWeightUnit (-> kilograms)', () => {
  it('parses common weight units', () => {
    expect(convertInputStringToInternalWeightUnit('5kg')).toBeCloseTo(5, 10);
    expect(convertInputStringToInternalWeightUnit('500gram')).toBeCloseTo(0.5, 10);
    expect(convertInputStringToInternalWeightUnit('10lbs')).toBeCloseTo(10 * 0.45359237, 10);
    expect(convertInputStringToInternalWeightUnit('8oz')).toBeCloseTo(8 * 0.0283495231, 10);
  });

  it('defaults by selected unit when no marker', () => {
    expect(convertInputStringToInternalWeightUnit('10', Unit.INCHES)).toBeCloseTo(
      10 * 0.45359237,
      10,
    );
    expect(convertInputStringToInternalWeightUnit('10', Unit.CENTIMETERS)).toBeCloseTo(10, 10);
  });
});

describe('convertInputStringToInternalVolumeUnit (-> liters)', () => {
  it('parses liter and cubic-meter notation', () => {
    expect(convertInputStringToInternalVolumeUnit('30l')).toBeCloseTo(30, 10);
    expect(convertInputStringToInternalVolumeUnit('2m3')).toBeCloseTo(2000, 10);
  });

  it('parses cubic feet', () => {
    expect(convertInputStringToInternalVolumeUnit('1ft3')).toBeCloseTo(28.3168466, 6);
  });
});

describe('convertInputStringToInternalDensityUnit (-> kg/l)', () => {
  it('parses an explicit weight/volume ratio', () => {
    // 2kg / 1l
    expect(convertInputStringToInternalDensityUnit('2kg/l')).toBeCloseTo(2, 10);
  });

  it('guesses the natural volume for a bare weight unit', () => {
    // grams default to grams-per-litre: 36g => 36 / 1 = 36? weight(0.036) / 1.0
    expect(convertInputStringToInternalDensityUnit('36gram')).toBeCloseTo(0.036, 10);
  });
});

describe('convertLengthToUnit — INCHES fraction formatting (denominator 16)', () => {
  const f = (v: number, large = false, acc = 16) =>
    convertLengthToUnit(v, large, Unit.INCHES, acc);

  it('formats exact whole inches', () => {
    expect(f(1 * INCH)).toBe('1"');
    expect(f(6 * INCH)).toBe('6"');
  });

  it('reduces fractions to lowest terms', () => {
    expect(f(1.5 * INCH)).toBe('1 1/2"'); // 8/16 -> 1/2
    expect(f(1.25 * INCH)).toBe('1 1/4"'); // 4/16 -> 1/4
    expect(f((1 + 3 / 16) * INCH)).toBe('1 3/16"'); // stays 3/16
    expect(f((6 + 3 / 4) * INCH)).toBe('6 3/4"');
  });

  it('formats sub-inch fractions with no whole part', () => {
    expect(f(0.5 * INCH)).toBe('1/2"');
    expect(f((1 / 16) * INCH)).toBe('1/16"');
  });

  it('formats zero', () => {
    expect(f(0)).toBe('0"');
  });

  it('formats negatives', () => {
    // Legacy emits a space after the sign and between feet/inches (faithful to
    // UnitUtils.convertLengthToUnit's format-string assembly).
    expect(f(-1 * INCH)).toBe('- 1"');
    expect(f(-1.5 * INCH)).toBe('- 1 1/2"');
  });

  it('promotes to feet with useLargeUnits', () => {
    // 6 ft exactly: inches=72 > 36 -> "6'0"" (inches part is 0, appended directly).
    expect(f(FOOT * 6, true)).toBe(`6'0"`);
    // 6'3"  -> legacy inserts a space between the feet and inches parts.
    expect(f(6 * 12 * INCH + 3 * INCH, true)).toBe(`6' 3"`);
    // 6'3 1/2"
    expect(f(6 * 12 * INCH + 3.5 * INCH, true)).toBe(`6' 3 1/2"`);
  });

  it('does not promote to feet below the 36-inch threshold', () => {
    // 36 inches: inches==36 is NOT > 36, so stays in inches
    expect(f(36 * INCH, true)).toBe('36"');
    // 37 inches: 37 > 36 -> "3' 1"" (legacy space between feet and inches)
    expect(f(37 * INCH, true)).toBe(`3' 1"`);
  });

  it('honours alternative fraction accuracies', () => {
    // denominator 8: 3/16 of an inch -> trunc(0.1875*8)=1 -> 1/8
    expect(f((1 + 3 / 16) * INCH, false, 8)).toBe('1 1/8"');
    // denominator 4: 0.5 inch -> 2/4 -> 1/2
    expect(f(1.5 * INCH, false, 4)).toBe('1 1/2"');
    // denominator 2: 0.5 inch -> 1/2
    expect(f(1.5 * INCH, false, 2)).toBe('1 1/2"');
  });
});

describe('convertLengthToUnit — metric & decimal-inch', () => {
  it('formats centimeters', () => {
    expect(convertLengthToUnit(12.345, false, Unit.CENTIMETERS)).toBe('12.35 cm');
    expect(convertLengthToUnit(250, true, Unit.CENTIMETERS)).toBe('2.500 m');
    expect(convertLengthToUnit(50, true, Unit.CENTIMETERS)).toBe('50.00 cm');
  });

  it('formats meters', () => {
    expect(convertLengthToUnit(183, false, Unit.METERS)).toBe('1.830 m');
  });

  it('formats millimeters', () => {
    expect(convertLengthToUnit(15, false, Unit.MILLIMETERS)).toBe('150.0 mm');
  });

  it('formats decimal inches', () => {
    expect(convertLengthToUnit(6 * INCH, false, Unit.INCHES_DECIMAL)).toBe('6.00"');
    expect(convertLengthToUnit(6 * INCH, false, Unit.INCHES_DECIMAL, 16, 3)).toBe('6.000"');
    // feet promotion: 6'3.00"
    expect(
      convertLengthToUnit(6 * 12 * INCH + 3 * INCH, true, Unit.INCHES_DECIMAL),
    ).toBe(`6'3.00"`);
  });
});

describe('area / volume / weight / density / inertia formatting', () => {
  it('formats area', () => {
    // 1 m^2 = 10000 cm^2
    expect(convertAreaToUnit(10000, Unit.CENTIMETERS)).toBe('1.000 m²');
    expect(convertAreaToUnit(10000, Unit.INCHES)).toBe(`${(10000 * 0.00107639104).toFixed(3)} ft²`);
  });

  it('formats volume (always liters)', () => {
    // 3000 cm^3 = 3 liters
    expect(convertVolumeToUnit(3000, Unit.CENTIMETERS)).toBe('3.000 liters');
    expect(convertVolumeToUnit(3000, Unit.INCHES)).toBe('3.000 liters');
  });

  it('formats weight', () => {
    expect(convertWeightToUnit(3, false, Unit.CENTIMETERS)).toBe('3.000 Kg');
    expect(convertWeightToUnit(0.5, true, Unit.CENTIMETERS)).toBe('500 gram');
    expect(convertWeightToUnit(0.45359237, false, Unit.INCHES)).toBe('1.000 lbs');
    expect(convertWeightToUnit(0.0283495231, true, Unit.INCHES)).toBe('1.000 oz');
  });

  it('formats density', () => {
    expect(convertDensityToUnit(0.04, Unit.CENTIMETERS)).toBe('0.040 kg/l');
    expect(convertDensityToUnit(0.04, Unit.INCHES)).toBe(
      `${(0.04 * 62.4279606).toFixed(3)} lbs/ft²`,
    );
  });

  it('formats moment of inertia (note the leading space in suffix)', () => {
    expect(convertMomentOfInertiaToUnit(1.5, Unit.CENTIMETERS)).toBe('1.500 kg/m²');
    expect(convertMomentOfInertiaToUnit(1, Unit.INCHES)).toBe(
      `${(1 * POUNDS_PR_KG * FEET_PR_METER * FEET_PR_METER).toFixed(3)} lb/ft²`,
    );
  });
});

describe('round-trips: parse then format', () => {
  it('length: feet/inches round-trips through INCHES formatting', () => {
    const cm = convertInputStringToInternalLengthUnit(`6'3 1/2"`);
    // Legacy reassembles with spaces between feet/inches/fraction.
    expect(convertLengthToUnit(cm, true, Unit.INCHES)).toBe(`6' 3 1/2"`);
  });

  it('length: metric cm round-trips', () => {
    const cm = convertInputStringToInternalLengthUnit('183.5cm');
    expect(convertLengthToUnit(cm, false, Unit.CENTIMETERS)).toBe('183.50 cm');
  });

  it('weight: pounds round-trip', () => {
    const kg = convertInputStringToInternalWeightUnit('7.5lbs');
    expect(convertWeightToUnit(kg, false, Unit.INCHES)).toBe('7.500 lbs');
  });

  it('a range of inch values round-trips at 16ths', () => {
    for (let sixteenths = 1; sixteenths <= 16 * 24; sixteenths++) {
      const inches = sixteenths / 16;
      const cm = inches * INCH;
      const formatted = convertLengthToUnit(cm, false, Unit.INCHES);
      const reparsed = convertInputStringToInternalLengthUnit(formatted);
      expect(reparsed).toBeCloseTo(cm, 6);
    }
  });
});

describe('UnitSettings (legacy stateful wrapper)', () => {
  it('defaults to inches and applies state to conversions', () => {
    const s = new UnitSettings();
    expect(s.getCurrentUnit()).toBe(Unit.INCHES);
    expect(s.convertLengthToCurrentUnit(1.5 * INCH, false)).toBe('1 1/2"');

    s.setCurrentUnit(Unit.CENTIMETERS);
    expect(s.convertLengthToCurrentUnit(12.345, false)).toBe('12.35 cm');

    s.setFractionAccuracy(8);
    s.setCurrentUnit(Unit.INCHES);
    expect(s.convertLengthToCurrentUnit((1 + 3 / 16) * INCH, false)).toBe('1 1/8"');

    s.setNrOfDecimals(1);
    s.setCurrentUnit(Unit.INCHES_DECIMAL);
    expect(s.convertLengthToCurrentUnit(6 * INCH, false)).toBe('6.0"');
  });

  it('parse wrappers use the selected unit', () => {
    const s = new UnitSettings(Unit.CENTIMETERS);
    expect(s.convertInputStringToInternalLengthUnit('10')).toBeCloseTo(10, 10);
  });
});
