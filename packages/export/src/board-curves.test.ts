// SPDX-License-Identifier: GPL-3.0-or-later
import { knot, splineFromKnots, vec2 } from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import { planOutlineLoop, planOutlineRail } from './board-curves';
import { makeTestBoard } from './fixture.test-helper';

const third = (ax: number, ay: number, bx: number, by: number): [number, number] => [
  ax + (bx - ax) / 3,
  ay + (by - ay) / 3,
];

// Swallow outline (length 100): notch bottom (12,0) → tip (0,6) → wide (50,15) → nose (100,0).
// Non-monotonic in x, so planOutlineRail must take the parametric branch.
const swallowOutline = splineFromKnots([
  knot(vec2(12, 0), vec2(12, 0), vec2(...third(12, 0, 0, 6))),
  knot(vec2(0, 6), vec2(...third(0, 6, 12, 0)), vec2(...third(0, 6, 50, 15))),
  knot(vec2(50, 15), vec2(...third(50, 15, 0, 6)), vec2(...third(50, 15, 100, 0))),
  knot(vec2(100, 0), vec2(...third(100, 0, 50, 15)), vec2(100, 0)),
]);

describe('planOutlineRail', () => {
  const plain = makeTestBoard();
  const swallow = { ...plain, outline: swallowOutline };

  // The loop IS the rail plus its mirror — that identity is what lets the 1:1 PDF print a
  // half template without a second sampler. Both sampling branches must honour it.
  for (const [label, board] of [
    ['an x-sampled outline', plain],
    ['a parametric (tail-cutout) outline', swallow],
  ] as const) {
    it(`is exactly half of planOutlineLoop for ${label}`, () => {
      const rail = planOutlineRail(board, 40);
      const loop = planOutlineLoop(board, 40);
      expect(loop).toEqual([...rail, ...[...rail].reverse().map((p) => ({ x: p.x, y: -p.y }))]);
      expect(loop.length).toBe(rail.length * 2);
    });
  }

  it('stays on the +y side of the stringer', () => {
    for (const p of planOutlineRail(plain, 40)) expect(p.y).toBeGreaterThanOrEqual(0);
    for (const p of planOutlineRail(swallow, 40)) expect(p.y).toBeGreaterThanOrEqual(0);
  });
});
