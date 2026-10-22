// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Row membership against geom's `classifyUV` (the oracle the design names,
 * docs/design/board2.md §9.6): the same ray-crossing rule with the ray along
 * the row. Every random point (seeded) of rows across a loop must classify
 * the same; points within `point` of the loop are skipped (`classifyUV` calls
 * them boundary). Loops: the sample document's plan, a seeded off-knot loop,
 * and the notched loop, which is not a graph over x.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyUV,
  closestPointOnCurve,
  makeTrimLoop,
  makeTrimmedSurface,
  resolveTolerances,
  toClamped,
} from '@openshaper/geom';
import type { PeriodicCurve } from '@openshaper/geom';
import { mulberry32 } from '@openshaper/geom/testing';
import { heightFieldSurface, planCurvePcurve } from '../height-field';
import { planCurve, planExtent, planPieces } from '../plan';
import { flatField, notchedLoopFixture, offKnotLoop, sampleDoc } from '../testing';
import { rowClassifier } from './membership';

function check(loop: PeriodicCurve<2>, seed: number, rowsAtPieceEnds = false): number {
  const tol = resolveTolerances();
  const e = planExtent(planPieces(loop));
  const hf = flatField([e.xMin - 1, e.xMax + 1], [e.yMin - 1, e.yMax + 1], 0, 2, 2);
  const l = makeTrimLoop([toClamped(planCurvePcurve(loop, hf), 0)], { snap: true });
  if (!l.ok) throw new Error('loop');
  const ts = makeTrimmedSurface(heightFieldSurface(hf, 'none'), l.value);
  if (!ts.ok) throw new Error('trimmed');
  const rc = rowClassifier(loop);
  const rng = mulberry32(seed);
  let compared = 0;
  // Rows through the pieces' end points exercise the half-open crossing rule;
  // not the rows through the loop's extreme x (a tangency, degenerate for
  // any ray rule: there the two seam pieces' shared end is computed twice).
  const ends = planPieces(loop)
    .map((p) => p.p[0]!)
    .filter((x) => x - e.xMin > tol.point && e.xMax - x > tol.point);
  const rows = rowsAtPieceEnds ? ends.length : 40;
  for (let r = 0; r < rows; r++) {
    const x = rowsAtPieceEnds ? ends[r]! : e.xMin - 0.5 + rng() * (e.xMax - e.xMin + 1);
    const ys = rc.crossings(x);
    for (let k = 0; k < 40; k++) {
      const y = e.yMin - 0.5 + rng() * (e.yMax - e.yMin + 1);
      const foot = closestPointOnCurve(loop, { x, y });
      if (Math.hypot(foot.point.x - x, foot.point.y - y) <= 10 * tol.point) continue;
      const uv = { u: (x - hf.x[0]) / (hf.x[1] - hf.x[0]), v: (y - hf.y[0]) / (hf.y[1] - hf.y[0]) };
      const want = classifyUV(ts.value, uv) === 'inside';
      expect(rc.inside(ys, y), `seed ${seed}: (${x}, ${y})`).toBe(want);
      compared++;
    }
  }
  return compared;
}

describe('rowClassifier', () => {
  it('agrees with classifyUV on the sample plan', () => {
    expect(check(planCurve(sampleDoc().plan), 3)).toBeGreaterThan(1000);
  });
  it('agrees with classifyUV on an off-knot loop', () => {
    const rng = mulberry32(17);
    expect(check(planCurve(offKnotLoop(rng)), 17)).toBeGreaterThan(1000);
  });
  it('agrees with classifyUV on the notched loop (not a graph over x)', () => {
    expect(check(planCurve(notchedLoopFixture()), 29)).toBeGreaterThan(1000);
  });
  it('agrees with classifyUV on rows through the loop’s piece ends', () => {
    expect(check(planCurve(sampleDoc().plan), 31, true)).toBeGreaterThan(200);
    expect(check(planCurve(offKnotLoop(mulberry32(37))), 37, true)).toBeGreaterThan(200);
  });
});
