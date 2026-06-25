// SPDX-License-Identifier: GPL-3.0-or-later
import { board, crossSection, knot, splineFromKnots, vec2 } from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import { planOutlineLoop } from './board-curves';
import { exportStl } from './stl';

const third = (ax: number, ay: number, bx: number, by: number): [number, number] => [
  ax + (bx - ax) / 3,
  ay + (by - ay) / 3,
];

// Swallow outline (length 100): notch bottom (12,0) → tip (0,6) → wide (50,15) → nose (100,0).
const swallowOutline = splineFromKnots([
  knot(vec2(12, 0), vec2(12, 0), vec2(...third(12, 0, 0, 6))),
  knot(vec2(0, 6), vec2(...third(0, 6, 12, 0)), vec2(...third(0, 6, 50, 15))),
  knot(vec2(50, 15), vec2(...third(50, 15, 0, 6)), vec2(...third(50, 15, 100, 0))),
  knot(vec2(100, 0), vec2(...third(100, 0, 50, 15)), vec2(100, 0)),
]);

const swallowBoard = board(
  swallowOutline,
  splineFromKnots([
    knot(vec2(0, 5), vec2(-5, 5), vec2(5, 5)),
    knot(vec2(100, 5), vec2(95, 5), vec2(105, 5)),
  ]),
  splineFromKnots([
    knot(vec2(0, 11), vec2(-5, 11), vec2(5, 11)),
    knot(vec2(100, 11), vec2(95, 11), vec2(105, 11)),
  ]),
  [
    crossSection(
      0,
      splineFromKnots([
        knot(vec2(0, 5), vec2(0, 5), vec2(8, 5)),
        knot(vec2(8, 8), vec2(8, 6), vec2(8, 8)),
      ]),
    ),
    crossSection(
      50,
      splineFromKnots([
        knot(vec2(0, 5), vec2(0, 5), vec2(8, 5)),
        knot(vec2(8, 8), vec2(8, 6), vec2(8, 8)),
      ]),
    ),
    crossSection(
      100,
      splineFromKnots([
        knot(vec2(0, 5), vec2(0, 5), vec2(8, 5)),
        knot(vec2(8, 8), vec2(8, 6), vec2(8, 8)),
      ]),
    ),
  ],
);

describe('export: concave tail', () => {
  it('planOutlineLoop traces the notch (non-monotonic in x)', () => {
    const loop = planOutlineLoop(swallowBoard, 200);
    // Somewhere along the top rail x must decrease (the wall folds back to the tip).
    let folds = false;
    for (let i = 1; i < loop.length; i++) {
      if (loop[i]!.x < loop[i - 1]!.x - 0.01) {
        folds = true;
        break;
      }
    }
    expect(folds).toBe(true);
  });

  it('exportStl emits the notch gap in the tail (two pods)', () => {
    const stl = exportStl(swallowBoard, { lengthSteps: 80, ringSteps: 40 });
    expect(stl).toContain('solid');
    expect(stl).toContain('facet');

    // Parse vertices; the tail notch keeps foam off the stringer, the body welds to it.
    let notchMinAbsY = Infinity;
    let bodyMinAbsY = Infinity;
    const num = String.raw`-?\d+\.?\d*(?:e[+-]?\d+)?`;
    const re = new RegExp(`vertex\\s+(${num})\\s+(${num})\\s+`, 'g');
    for (const m of stl.matchAll(re)) {
      const x = Number(m[1]);
      const ay = Math.abs(Number(m[2]));
      if (x >= 3 && x <= 9) notchMinAbsY = Math.min(notchMinAbsY, ay);
      if (x >= 40 && x <= 60) bodyMinAbsY = Math.min(bodyMinAbsY, ay);
    }
    expect(notchMinAbsY).toBeGreaterThan(0.5);
    expect(bodyMinAbsY).toBeLessThan(0.5);
  });
});
