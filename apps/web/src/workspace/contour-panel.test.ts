// SPDX-License-Identifier: GPL-3.0-or-later
/** The Bottom panel's words and numbers: how each number is written and typed, its steps and its slider. */
import type { ContourDial } from '@openshaper/store/rails';
import { describe, expect, it } from 'vitest';
import { lengthUnitByKey } from '../format';
import {
  SLIDER_STEPS,
  dialNumber,
  dialStep,
  dialSuffix,
  fromSliderPosition,
  heldNote,
  parseDialNumber,
  rangeEnd,
  runText,
  sliderPosition,
} from './contour-panel';

const CM = lengthUnitByKey('cm');
const MM = lengthUnitByKey('mm');
const IN = lengthUnitByKey('in');

const dial = (patch: Partial<ContourDial> = {}): ContourDial => ({
  key: 'depth',
  label: 'Depth',
  unit: 'length',
  note: '',
  value: 0.3,
  min: 0,
  max: 1.2,
  ...patch,
});

describe('the slider', () => {
  it('runs from the least to the most, holds what is outside, and has no travel where the range has none', () => {
    expect(sliderPosition(0, 0, 1.2)).toBe(0);
    expect(sliderPosition(1.2, 0, 1.2)).toBe(SLIDER_STEPS);
    expect(sliderPosition(0.6, 0, 1.2)).toBe(SLIDER_STEPS / 2);
    expect(sliderPosition(-5, 0, 1.2)).toBe(0);
    expect(sliderPosition(50, 0, 1.2)).toBe(SLIDER_STEPS);
    expect(sliderPosition(1, 1, 1)).toBe(0);
  });

  it('is its own inverse to the step it has', () => {
    for (const p of [0, 1, 37, 100, 199, 200]) {
      expect(sliderPosition(fromSliderPosition(p, 0, 1.37), 0, 1.37)).toBe(p);
    }
    expect(fromSliderPosition(-3, 2, 4)).toBe(2);
    expect(fromSliderPosition(999, 2, 4)).toBe(4);
  });
});

describe('numbers in the display unit', () => {
  it('writes a length in the unit at its decimals, a share as a whole percent and a count as it is', () => {
    expect(dialNumber('length', 0.3, CM)).toBe('0.30');
    expect(dialNumber('length', 0.3, MM)).toBe('3.0');
    expect(dialNumber('length', 2.54, IN)).toBe('1.000');
    expect(dialNumber('percent', 0.7, CM)).toBe('70');
    expect(dialNumber('count', 2.2, CM)).toBe('2');
    expect([
      dialSuffix('length', MM),
      dialSuffix('length', IN),
      dialSuffix('percent', CM),
      dialSuffix('count', CM),
    ]).toEqual(['mm', 'in', '%', '']);
  });

  it('reads typed text back in the same terms, and nothing for text with no number', () => {
    expect(parseDialNumber('length', '3', MM)).toBeCloseTo(0.3, 9);
    expect(parseDialNumber('length', '0.3', CM)).toBeCloseTo(0.3, 9);
    expect(parseDialNumber('length', '0.125', IN)).toBeCloseTo(0.3175, 9);
    expect(parseDialNumber('percent', '70', CM)).toBeCloseTo(0.7, 9);
    expect(parseDialNumber('percent', '12,5', CM)).toBeCloseTo(0.125, 9);
    expect(parseDialNumber('count', '3.9', CM)).toBe(3);
    for (const unit of ['length', 'percent', 'count'] as const) {
      expect(parseDialNumber(unit, 'abc', CM)).toBeNull();
      expect(parseDialNumber(unit, '', CM)).toBeNull();
    }
  });

  it('writes the ends of a range as a small length does: a depth is a few millimetres', () => {
    expect(rangeEnd('length', 0, MM)).toBe('0 mm');
    expect(rangeEnd('length', 1.37, MM)).toBe('14 mm');
    expect(rangeEnd('percent', 0.05, CM)).toBe('5%');
    expect(rangeEnd('count', 4, CM)).toBe('4');
  });
});

describe('the arrow keys', () => {
  it('step a depth by a fifth of a millimetre and a place by a centimetre, ten times that with Shift', () => {
    expect(dialStep('depth', 'length', false)).toBeCloseTo(0.02, 9);
    expect(dialStep('depth', 'length', true)).toBeCloseTo(0.1, 9);
    expect(dialStep('from', 'length', false)).toBe(1);
    expect(dialStep('to', 'length', true)).toBe(10);
    expect(dialStep('pitch', 'length', false)).toBeCloseTo(0.1, 9);
    expect(dialStep('width', 'percent', false)).toBeCloseTo(0.01, 9);
    expect(dialStep('width', 'percent', true)).toBeCloseTo(0.1, 9);
    expect(dialStep('count', 'count', true)).toBe(1);
  });
});

describe('what a held number says', () => {
  it('names the end it was held at, and says nothing for a number that was not held', () => {
    expect(heldNote(5, dial(), MM)).toBe('Held at the most this board allows here, 12 mm.');
    expect(heldNote(-1, dial(), CM)).toBe('Held at the least this board allows here, 0 cm.');
    expect(heldNote(0.5, dial(), CM)).toBeNull();
    expect(heldNote(1.2 + 1e-12, dial(), CM)).toBeNull();
  });

  it('writes where a contour runs in the display unit', () => {
    expect(runText(70, 150, CM)).toBe('70.00 cm to 150.00 cm');
    expect(runText(70, 150, MM)).toContain('700');
  });
});
