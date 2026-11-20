// SPDX-License-Identifier: GPL-3.0-or-later
/** The Deck panel's words and numbers: the shapes, the dial's steps, the number as typed and shown, the reasons it is off. */
import { describe, expect, it } from 'vitest';
import { lengthUnitByKey } from '../format';
import {
  CROWN_STEPS,
  SHAPE_CHOICES,
  SHAPE_NOTES,
  crownFromPosition,
  crownNumber,
  crownOffReason,
  crownPosition,
  crownStep,
  heldNote,
  parseCrown,
  shapeLabel,
} from './deck-panel';

const CM = lengthUnitByKey('cm');
const MM = lengthUnitByKey('mm');
const IN = lengthUnitByKey('in');
const RANGE = { min: 0.05, max: 4.05 };

describe('the shapes', () => {
  it('are Flat and Domed to choose, and Custom is a name and not a choice', () => {
    expect(SHAPE_CHOICES.map((c) => c.label)).toEqual(['Flat', 'Domed']);
    expect(shapeLabel('flat')).toBe('Flat');
    expect(shapeLabel('domed')).toBe('Domed');
    expect(shapeLabel('custom')).toBe('Custom');
  });

  it('each have a sentence of a shaper’s words', () => {
    for (const s of ['flat', 'domed', 'custom'] as const) {
      expect(SHAPE_NOTES[s].length).toBeGreaterThan(30);
    }
    expect(SHAPE_NOTES.custom).toContain('undo');
  });
});

describe('the crown dial', () => {
  it('runs from the least crown to the most, in CROWN_STEPS steps', () => {
    expect(crownPosition(RANGE.min, RANGE)).toBe(0);
    expect(crownPosition(RANGE.max, RANGE)).toBe(CROWN_STEPS);
    expect(crownPosition(2.05, RANGE)).toBe(CROWN_STEPS / 2);
    expect(crownFromPosition(0, RANGE)).toBe(RANGE.min);
    expect(crownFromPosition(CROWN_STEPS, RANGE)).toBe(RANGE.max);
    expect(crownFromPosition(CROWN_STEPS / 2, RANGE)).toBeCloseTo(2.05, 12);
  });

  it('holds a crown past either end to the end, and a range of no width to its least end', () => {
    expect(crownPosition(-3, RANGE)).toBe(0);
    expect(crownPosition(99, RANGE)).toBe(CROWN_STEPS);
    expect(crownPosition(1, { min: 1, max: 1 })).toBe(0);
    expect(crownFromPosition(-5, RANGE)).toBe(RANGE.min);
    expect(crownFromPosition(CROWN_STEPS * 3, RANGE)).toBe(RANGE.max);
  });

  it('steps by the unit’s fine step, ten times that with Shift', () => {
    expect(crownStep(CM, false)).toBeCloseTo(0.1, 12);
    expect(crownStep(CM, true)).toBeCloseTo(1, 12);
    expect(crownStep(MM, false)).toBeCloseTo(0.05, 12);
    expect(crownStep(IN, false)).toBeCloseTo(0.0625 * 2.54, 12);
  });

  it('shows the number in the display unit and reads what is typed in it', () => {
    expect(crownNumber(2.456, CM)).toBe('2.46');
    expect(crownNumber(2.456, MM)).toBe('24.6');
    expect(crownNumber(2.54, IN)).toBe('1.000');
    expect(parseCrown('2.4', CM)).toBeCloseTo(2.4, 12);
    expect(parseCrown('24', MM)).toBeCloseTo(2.4, 12);
    expect(parseCrown('', CM)).toBeNull();
    expect(parseCrown('abc', CM)).toBeNull();
  });
});

describe('why the dial is off', () => {
  it('says a flat deck has no crown, and a drawn one would be replaced by it', () => {
    expect(crownOffReason('flat', true)).toMatch(/flat deck has no crown/i);
    expect(crownOffReason('custom', true)).toMatch(/drawn by hand/);
    expect(crownOffReason('domed', false)).toMatch(/too thin/);
    expect(crownOffReason('domed', true)).toBeNull();
  });

  it('says when a crown was held at the most the station can hold', () => {
    expect(heldNote(9, RANGE, CM)).toBe('Held at the most this station can hold, 4.05 cm.');
    expect(heldNote(4.05, RANGE, CM)).toBeNull();
    expect(heldNote(1, RANGE, CM)).toBeNull();
    expect(heldNote(9, null, CM)).toBeNull();
  });
});
