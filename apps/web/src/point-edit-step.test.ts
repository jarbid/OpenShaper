import { expect, it } from 'vitest';
import { lengthUnitByKey } from './format';
import { pointEditStep } from './point-edit-step';

it('uses progressively finer readable increments as the view zooms in', () => {
  const units = lengthUnitByKey('mm');
  expect([2, 4, 10, 20, 200, 2000].map((scale) => pointEditStep(units, scale))).toEqual([
    10, 5, 2, 1, 0.1, 0.01,
  ]);
});

it('returns the step in the current display unit', () => {
  expect(pointEditStep(lengthUnitByKey('cm'), 20)).toBe(0.1);
  expect(pointEditStep(lengthUnitByKey('in'), 2 / 2.54)).toBe(1);
});

it.each([undefined, 0, -1, Infinity, NaN])(
  'uses the existing increment without a valid viewport: %s',
  (scale) => {
    expect(pointEditStep(lengthUnitByKey('mm'), scale)).toBe(5);
  },
);
