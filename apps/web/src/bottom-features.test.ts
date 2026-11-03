// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { lengthUnitByKey } from './format';
import { fieldText, parseField, sameShown, type FieldKind } from './bottom-features';

/** Field values round-trip through the text a field shows, in every unit the editor offers. */
describe('bottom feature fields', () => {
  const cm = [0.05, 0.1, 0.25, 0.3, 0.333, 1.2, 3, 12.5, 60.25, 143.6];
  const fractions = [0.05, 0.3, 0.4, 0.7, 1];
  const half = (kind: FieldKind, unit: string) =>
    kind !== 'length'
      ? kind === 'percent'
        ? 0.005
        : 0
      : { mm: 0.05, cm: 0.005, in: 0.0005 * 2.54 }[unit]!;

  it.each(['mm', 'cm', 'in'])(
    'lengths in %s: shown text parses to the value within half a step',
    (key) => {
      const units = lengthUnitByKey(key);
      for (const v of cm) {
        const text = fieldText(v, 'length', units);
        const back = parseField(text, 'length', units)!;
        expect(Math.abs(back - v), `${v} -> ${text}`).toBeLessThanOrEqual(
          half('length', key) + 1e-9,
        );
        // and the text is stable: committing what is shown changes nothing
        expect(fieldText(back, 'length', units)).toBe(text);
        expect(sameShown(back, v, 'length', units)).toBe(true);
      }
    },
  );

  it('fractions are percentages and counts are whole numbers, in any unit', () => {
    const units = lengthUnitByKey('in');
    for (const v of fractions) {
      expect(parseField(fieldText(v, 'percent', units), 'percent', units)).toBeCloseTo(v, 12);
    }
    expect(fieldText(0.4, 'percent', units)).toBe('40');
    expect(parseField('2', 'count', units)).toBe(2);
    expect(fieldText(2.4, 'count', units)).toBe('2');
  });

  it('text with no number is no value', () => {
    const units = lengthUnitByKey('mm');
    for (const kind of ['length', 'percent', 'count'] as const) {
      expect(parseField('', kind, units)).toBeNull();
      expect(parseField('x', kind, units)).toBeNull();
    }
  });

  it('a value typed in one unit is the same length in the others', () => {
    const mm = parseField('3', 'length', lengthUnitByKey('mm'))!;
    expect(mm).toBeCloseTo(0.3, 12);
    expect(parseField('0.3', 'length', lengthUnitByKey('cm'))).toBeCloseTo(mm, 12);
    expect(parseField('0.118', 'length', lengthUnitByKey('in'))!).toBeCloseTo(mm, 2);
  });
});
