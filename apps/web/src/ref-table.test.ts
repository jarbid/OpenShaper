import { describe, expect, it } from 'vitest';
import { LENGTH_UNITS } from './format';
import type { Longitudinal } from './longitudinal';
import {
  defaultInterval,
  generateStations,
  parsePastedRows,
  stationToDisplay,
  stationToModel,
} from './ref-table';

const cm = LENGTH_UNITS.find((u) => u.key === 'cm')!;
const inch = LENGTH_UNITS.find((u) => u.key === 'in')!;
const straight: Longitudinal = { axis: 'x-axis', toDisplay: (x) => x, toModel: (d) => d, mark: '' };
/** A stand-in over-curve mapping: the curve is 10% longer than the straight length. */
const curved: Longitudinal = {
  axis: 'o-curve',
  toDisplay: (x) => x * 1.1,
  toModel: (d) => d / 1.1,
  mark: ' o/c',
};

describe('station positions', () => {
  it('measures from the tail or the nose, and round-trips', () => {
    expect(stationToDisplay(30, 'tail', straight, 180)).toBe(30);
    expect(stationToDisplay(30, 'nose', straight, 180)).toBe(150);
    for (const lon of [straight, curved])
      for (const origin of ['tail', 'nose'] as const)
        expect(
          stationToModel(stationToDisplay(42, origin, lon, 180), origin, lon, 180),
        ).toBeCloseTo(42, 9);
  });

  it('measures over the curve when the app does', () => {
    expect(stationToDisplay(100, 'tail', curved, 180)).toBeCloseTo(110, 9);
    expect(stationToDisplay(100, 'nose', curved, 180)).toBeCloseTo(88, 9);
  });
});

describe('generateStations', () => {
  it('starts one interval in and stops before the far end', () => {
    expect(generateStations(50, 'tail', straight, 180)).toEqual([50, 100, 150]);
    expect(generateStations(60, 'tail', straight, 180)).toEqual([60, 120]);
    expect(generateStations(50, 'nose', straight, 180)).toEqual([130, 80, 30]);
  });

  it('spaces stations over the curve', () => {
    const xs = generateStations(55, 'tail', curved, 100);
    expect(xs.map((x) => x * 1.1)).toEqual([55].map((d) => expect.closeTo(d, 9)));
  });

  it('is empty for a non-positive spacing and capped for a tiny one', () => {
    expect(generateStations(0, 'tail', straight, 180)).toEqual([]);
    expect(generateStations(-5, 'tail', straight, 180)).toEqual([]);
    expect(generateStations(0.001, 'tail', straight, 180)).toHaveLength(200);
  });
});

describe('defaultInterval', () => {
  it('is a round number in the display unit', () => {
    expect(defaultInterval(cm)).toBe(10);
    expect(defaultInterval(inch)).toBeCloseTo(6 * 2.54, 9);
  });
});

describe('parsePastedRows', () => {
  it('reads tab, comma and space separated rows in the display unit, with fractions', () => {
    const { rows, bad } = parsePastedRows('12\t21 1/2\n24, 22\n36 22.5\n\n', inch);
    expect(bad).toEqual([]);
    const inches = rows.flat().map((cmValue) => cmValue / 2.54);
    expect(inches).toEqual([12, 21.5, 24, 22, 36, 22.5].map((v) => expect.closeTo(v, 9)));
  });

  it('treats a comma inside a semicolon-separated row as a decimal comma', () => {
    expect(parsePastedRows('30;54,5', cm).rows).toEqual([[30, 54.5]]);
  });

  it('reports the lines it could not read, by number', () => {
    const { rows, bad } = parsePastedRows('Station\tWidth\n30\t54\n30\n1\t2\t3', cm);
    expect(rows).toEqual([[30, 54]]);
    expect(bad).toEqual([1, 3, 4]);
  });
});
