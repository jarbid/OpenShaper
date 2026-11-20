// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The words of a STEP fit failure: each kind, in each display unit, with the place a stalled fit
 * reports (its part, its distance from the tail and its side).
 */
import { StepFitError } from '@openshaper/board2';
import { describe, expect, it } from 'vitest';
import { stepFitMessage } from './nurbs-core';

const stalled = (y: number | undefined): StepFitError =>
  new StepFitError(
    'stalled',
    'stalled',
    0.052,
    0.04,
    y === undefined ? undefined : { part: 'deck', x: 0.24, y },
  );

describe('stepFitMessage', () => {
  it('says where a stalled fit stopped, in the unit of the file', () => {
    expect(stepFitMessage(stalled(0.63), 'mm')).toBe(
      'The surface stopped converging on the deck, 2.40 mm from the tail on the left, at 0.52 mm from the board, over the 0.40 mm tolerance. Try fewer stations there or a smoother shape.',
    );
    expect(stepFitMessage(stalled(-0.63), 'cm')).toBe(
      'The surface stopped converging on the deck, 0.240 cm from the tail on the right, at 0.052 cm from the board, over the 0.040 cm tolerance. Try fewer stations there or a smoother shape.',
    );
    expect(stepFitMessage(stalled(0), 'in')).toBe(
      'The surface stopped converging on the deck, 0.094 in from the tail, at 0.020 in from the board, over the 0.016 in tolerance. Try fewer stations there or a smoother shape.',
    );
  });

  it('still words a stall that knows no place', () => {
    expect(stepFitMessage(stalled(undefined), 'mm')).toBe(
      'The surface stopped converging at 0.52 mm from the board, over the 0.40 mm tolerance. Try fewer stations there or a smoother shape.',
    );
  });

  it('words a miss of the tolerance, and keeps a budget failure’s own message', () => {
    const miss = new StepFitError('x', 'tolerance', 0.06, 0.04);
    expect(stepFitMessage(miss, 'mm')).toBe(
      'The surface could not be fitted within 0.40 mm (it reached 0.60 mm). Try fewer stations near the tail or a smaller feature.',
    );
    const over = new StepFitError(
      'The fit needs more control points than the limit.',
      'budget',
      0.1,
      0.04,
    );
    expect(stepFitMessage(over, 'mm')).toBe('The fit needs more control points than the limit.');
  });
});
