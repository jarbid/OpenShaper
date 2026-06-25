// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { board, getArea, getLength, getVolume } from './board';
import { splineFromKnots } from './bezier-spline';
import { knotFromArray } from './knot';
import { hasTailCutout, outlineSegments, yInOut } from './outline-cutout';
import { parseBrdGeometry } from './test-support/brd-geometry';

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = resolve(here, '../../../docs/specs/golden');
const shortboard = parseBrdGeometry(readFileSync(resolve(goldenDir, 'shortboard.brd'), 'utf8'));
const LENGTH = getLength(shortboard);

const third = (ax: number, ay: number, bx: number, by: number): [number, number] => [
  ax + (bx - ax) / 3,
  ay + (by - ay) / 3,
];

// Swallow outline: notch bottom (18,0) → tail tip (0,9) → wide (90,23.5) → nose.
const swallowOutline = splineFromKnots([
  knotFromArray([18, 0, 18, 0, ...third(18, 0, 0, 9)], false, false),
  knotFromArray([0, 9, ...third(0, 9, 18, 0), ...third(0, 9, 90, 23.5)], false, false),
  knotFromArray([90, 23.5, ...third(90, 23.5, 0, 9), ...third(90, 23.5, LENGTH, 0)], false, false),
  knotFromArray([LENGTH, 0, ...third(LENGTH, 0, 90, 23.5), LENGTH, 0], false, false),
]);

// "Filled" outline: the SAME rail (tip → wide → nose) but with the notch removed —
// a normal blunt-tail board. The tip's forward handle matches the swallow's rail.
const filledOutline = splineFromKnots([
  knotFromArray([0, 9, 0, 9, ...third(0, 9, 90, 23.5)], false, false),
  knotFromArray([90, 23.5, ...third(90, 23.5, 0, 9), ...third(90, 23.5, LENGTH, 0)], false, false),
  knotFromArray([LENGTH, 0, ...third(LENGTH, 0, 90, 23.5), LENGTH, 0], false, false),
]);

const withOutline = (outline: typeof swallowOutline) =>
  board(
    outline,
    shortboard.bottom,
    shortboard.deck,
    shortboard.crossSections,
    shortboard.interpolationType,
    shortboard.fins,
  );

const swallowBoard = withOutline(swallowOutline);
const filledBoard = withOutline(filledOutline);

describe('board cutout: volume / area honor the notch', () => {
  it('a real shortboard is not misdetected as a cutout', () => {
    expect(hasTailCutout(shortboard.outline)).toBe(false);
  });

  it('the swallow removes planshape area equal to the notch (independent oracle)', () => {
    // Notch planshape area = 2·∫ y_in dx over the cutout, integrated independently.
    const seg = outlineSegments(swallowOutline);
    const N = 4000;
    const x1 = 18;
    let notchArea = 0;
    let prev = 2 * yInOut(seg, 0).yIn;
    for (let i = 1; i <= N; i++) {
      const x = (x1 * i) / N;
      const cur = 2 * yInOut(seg, x).yIn;
      notchArea += ((prev + cur) / 2) * (x1 / N);
      prev = cur;
    }
    const areaDiff = getArea(filledBoard) - getArea(swallowBoard);
    expect(notchArea).toBeGreaterThan(50); // sanity: the notch is sizeable
    expect(Math.abs(areaDiff - notchArea) / notchArea).toBeLessThan(0.1);
  });

  it('the swallow has strictly less volume than the filled board', () => {
    const vSwallow = getVolume(swallowBoard);
    const vFilled = getVolume(filledBoard);
    expect(vSwallow).toBeGreaterThan(0);
    expect(vSwallow).toBeLessThan(vFilled);
    // The notch removes a meaningful but not dominant share of foam.
    expect(vSwallow).toBeGreaterThan(vFilled * 0.6);
  });
});
