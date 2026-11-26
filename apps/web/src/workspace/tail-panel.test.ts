// SPDX-License-Identifier: GPL-3.0-or-later
/** The Tail panel's words and numbers: the shapes it offers, the dials' positions and steps, how a length is written and typed, why a dial is off. */
import { TAIL_SHAPES } from '@openshaper/store/rails';
import { describe, expect, it } from 'vitest';
import { lengthUnitByKey } from '../format';
import {
  DIAL_STEPS,
  SHAPE_CHOICES,
  SHAPE_NOTES,
  THUMBNAILS,
  dialFromPosition,
  dialPosition,
  heldNote,
  lengthNumber,
  lengthStep,
  notchOffReason,
  parseLength,
  sentence,
  shapeLabel,
  widthOffReason,
} from './tail-panel';

const CM = lengthUnitByKey('cm');
const MM = lengthUnitByKey('mm');
const IN = lengthUnitByKey('in');

describe('the shapes the picker offers', () => {
  it('are the store’s, in its order, each with a name, a note and a thumbnail', () => {
    expect(SHAPE_CHOICES.map((c) => c.id)).toEqual([...TAIL_SHAPES]);
    expect(SHAPE_CHOICES.map((c) => c.label)).toEqual([
      'Squash',
      'Round',
      'Pin',
      'Diamond',
      'Swallow',
      'Fish',
    ]);
    for (const c of SHAPE_CHOICES) {
      expect(SHAPE_NOTES[c.id].length).toBeGreaterThan(20);
      expect(THUMBNAILS[c.id]).toMatch(/^M[\d. ]+[CL]/);
    }
    expect(shapeLabel('custom')).toBe('Custom');
    expect(shapeLabel('fish')).toBe('Fish');
    expect(SHAPE_NOTES.custom).toMatch(/Choose a shape to replace/);
  });

  it('start a corner’s name with a capital', () => {
    expect(sentence('tail corner, left')).toBe('Tail corner, left');
    expect(sentence('')).toBe('');
  });
});

describe('a slider position', () => {
  const range = { min: 2, max: 12 };
  it('runs from the least a dial holds to the most, and is held to it', () => {
    expect(dialPosition(2, range)).toBe(0);
    expect(dialPosition(12, range)).toBe(DIAL_STEPS);
    expect(dialPosition(7, range)).toBe(DIAL_STEPS / 2);
    expect(dialPosition(-5, range)).toBe(0);
    expect(dialPosition(99, range)).toBe(DIAL_STEPS);
    expect(dialFromPosition(0, range)).toBe(2);
    expect(dialFromPosition(DIAL_STEPS, range)).toBe(12);
    expect(dialFromPosition(DIAL_STEPS / 2, range)).toBe(7);
    expect(dialFromPosition(-9, range)).toBe(2);
    expect(dialFromPosition(9999, range)).toBe(12);
  });

  it('is the least end for a range of no width', () => {
    expect(dialPosition(5, { min: 5, max: 5 })).toBe(0);
  });
});

describe('a length as the field shows it and takes it', () => {
  it('is written in the display unit at its decimals', () => {
    expect(lengthNumber(11.54, CM)).toBe('11.54');
    expect(lengthNumber(11.54, MM)).toBe('115.4');
    expect(lengthNumber(2.54, IN)).toBe('1.000');
  });

  it('is typed in the display unit and read back in cm, and is none when it is not a number', () => {
    expect(parseLength('12', CM)).toBeCloseTo(12, 9);
    expect(parseLength('120', MM)).toBeCloseTo(12, 9);
    expect(parseLength('5', IN)).toBeCloseTo(12.7, 9);
    expect(parseLength('wide', CM)).toBeNull();
  });

  it('steps by the unit’s fine step, ten times that with Shift', () => {
    expect(lengthStep(CM, false)).toBeCloseTo(0.1, 9);
    expect(lengthStep(CM, true)).toBeCloseTo(1, 9);
    expect(lengthStep(MM, false)).toBeCloseTo(0.05, 9);
    expect(lengthStep(IN, false)).toBeCloseTo(2.54 / 16, 9);
  });
});

describe('why a dial is off', () => {
  it('gives the width of every shape and none of a Custom tail', () => {
    for (const c of SHAPE_CHOICES) expect(widthOffReason(c.id)).toBeNull();
    expect(widthOffReason('custom')).toMatch(/drawn by hand/);
  });

  it('gives the notch to a swallow and a fish alone, and says what to choose', () => {
    expect(notchOffReason('swallow')).toBeNull();
    expect(notchOffReason('fish')).toBeNull();
    expect(notchOffReason('squash')).toBe(
      'A squash tail has no notch. Choose Swallow or Fish to cut one.',
    );
    expect(notchOffReason('round')).toMatch(/^A round tail has no notch/);
    expect(notchOffReason('custom')).toMatch(/Choose Swallow or Fish first/);
  });
});

describe('what is said when a number is held', () => {
  const range = { min: 5, max: 20 };
  it('names the dial and the end it was held at, in the display unit', () => {
    expect(heldNote('Width', 30, range, CM)).toBe(
      'Width held at the most this tail can have, 20.00 cm.',
    );
    expect(heldNote('Width', 1, range, MM)).toBe(
      'Width held at the least this tail can have, 50.0 mm.',
    );
    expect(heldNote('Notch depth', 20.0000000001, range, CM)).toBeNull();
    expect(heldNote('Radius', 10, range, CM)).toBeNull();
    expect(heldNote('Radius', 10, null, CM)).toBeNull();
  });
});
