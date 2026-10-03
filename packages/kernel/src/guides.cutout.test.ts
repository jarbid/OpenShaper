// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * P33: a guide ring at a station inside a swallow / fish notch must follow the foam,
 * which is two lobes there, rather than one ring drawn straight across the notch.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { board, getLength } from './board';
import { splineFromKnots } from './bezier-spline';
import { crossSectionLoops, crossSectionRing } from './guides';
import { knotFromArray } from './knot';
import { CUTOUT_EPS, cachedOutlineSegments, yInOut } from './outline-cutout';
import { parseBrdGeometry } from './test-support/brd-geometry';

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = resolve(here, '../../../docs/specs/golden');
const shortboard = parseBrdGeometry(readFileSync(resolve(goldenDir, 'shortboard.brd'), 'utf8'));
const LENGTH = getLength(shortboard);

const third = (ax: number, ay: number, bx: number, by: number): [number, number] => [
  ax + (bx - ax) / 3,
  ay + (by - ay) / 3,
];

/** Same swallow as tessellate.cutout.test.ts: notch bottom (18,0), tail tips (0,±9). */
const swallowBoard = board(
  splineFromKnots([
    knotFromArray([18, 0, 18, 0, ...third(18, 0, 0, 9)], false, false),
    knotFromArray([0, 9, ...third(0, 9, 18, 0), ...third(0, 9, 90, 23.5)], false, false),
    knotFromArray(
      [90, 23.5, ...third(90, 23.5, 0, 9), ...third(90, 23.5, LENGTH, 0)],
      false,
      false,
    ),
    knotFromArray([LENGTH, 0, ...third(LENGTH, 0, 90, 23.5), LENGTH, 0], false, false),
  ]),
  shortboard.bottom,
  shortboard.deck,
  shortboard.crossSections,
  shortboard.interpolationType,
  shortboard.fins,
);

const STEPS = 24;

describe('guide rings in a tail notch (P33)', () => {
  it('splits into two lobes that stay out of the notch', () => {
    const x = 8;
    const { yIn } = yInOut(cachedOutlineSegments(swallowBoard.outline), x);
    expect(yIn).toBeGreaterThan(CUTOUT_EPS); // the premise: x is inside the notch

    // The single ring (what the overlay drew before) cuts straight through it.
    const ring = crossSectionRing(swallowBoard, x, STEPS)!;
    expect(ring.some((p) => Math.abs(p.y) < yIn - 1e-6)).toBe(true);

    const loops = crossSectionLoops(swallowBoard, x, STEPS)!;
    expect(loops).toHaveLength(2);
    const right = loops[0]!;
    const left = loops[1]!;
    for (const p of right) expect(p.y).toBeGreaterThanOrEqual(yIn - 1e-9);
    for (const p of left) expect(p.y).toBeLessThanOrEqual(-yIn + 1e-9);
  });

  it('is the plain ring outside the notch and on boards without one', () => {
    expect(crossSectionLoops(swallowBoard, 60, STEPS)).toEqual([
      crossSectionRing(swallowBoard, 60, STEPS),
    ]);
    expect(crossSectionLoops(shortboard, 8, STEPS)).toEqual([
      crossSectionRing(shortboard, 8, STEPS),
    ]);
  });
});
