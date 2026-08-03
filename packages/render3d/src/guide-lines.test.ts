// SPDX-License-Identifier: GPL-3.0-or-later
import {
  board,
  crossSection,
  knot,
  splineFromKnots,
  vec2,
  type BezierBoard,
  type CrossSection,
} from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import { guideLines } from './guide-lines';

const FACE = 1.5; // draft density — fewer stations, faster tests

/**
 * Rounded rail profile, reused at every station: bottom-centreline -> rail -> deck-
 * centreline, per the (distance-from-centreline, height) convention `cross-section.ts`
 * documents. Both knots sit at x=0 so the ring's tt=0 and tt=1 samples are the
 * bottom and deck centreline points `stringerLoop` expects.
 */
const prof = () =>
  splineFromKnots([
    knot(vec2(0, 5), vec2(0, 5), vec2(10, 5)),
    knot(vec2(0, 8), vec2(10, 6), vec2(0, 8)),
  ]);

/**
 * A well-formed 100 cm board whose REAL cross-sections sit at `positions`. The
 * first and last entries are the nose/tail dummies the kernel expects, and are
 * the ones `guideLines` must skip.
 */
function makeBoard(positions: number[]): BezierBoard {
  const k = (ex: number, ey: number) => knot(vec2(ex, ey), vec2(ex - 5, ey), vec2(ex + 5, ey));
  const outline = splineFromKnots([k(0, 0), k(50, 20), k(100, 0)]);
  const bottom = splineFromKnots([k(0, 5), k(100, 5)]);
  const deck = splineFromKnots([k(0, 11), k(100, 11)]);
  const cs: CrossSection[] = [
    crossSection(0, prof()),
    ...positions.map((p) => crossSection(p, prof())),
    crossSection(100, prof()),
  ];
  return board(outline, bottom, deck, cs);
}

describe('guideLines', () => {
  it('draws a ring per REAL cross-section, skipping the nose/tail dummies', () => {
    expect(guideLines(makeBoard([25, 50, 75]), FACE, null).sections).toHaveLength(3);
  });

  it('closes every ring so the polyline meets itself', () => {
    const pts = guideLines(makeBoard([50]), FACE, null).sections[0]!.points;
    expect(pts.length).toBeGreaterThan(3);
    expect(pts[pts.length - 1]).toEqual(pts[0]);
  });

  it('produces a stringer loop that stays on the centreline', () => {
    const g = guideLines(makeBoard([50]), FACE, null);
    expect(g.stringer).not.toBeNull();
    expect(g.stringer!.points.length).toBeGreaterThan(3);
    // 1e-6 cm, not 0: the arc-length sampler (`pointByCurveLengthAt`) that walks the
    // profile spline converges numerically rather than landing bit-exact on the knot,
    // the same residual `guides.test.ts` in the kernel documents and tolerates.
    for (const [, y] of g.stringer!.points) expect(Math.abs(y)).toBeLessThan(1e-6);
  });

  it('gains a ring when a station is added', () => {
    const before = guideLines(makeBoard([25, 75]), FACE, null).sections.length;
    const after = guideLines(makeBoard([25, 50, 75]), FACE, null).sections.length;
    expect(after).toBe(before + 1);
  });

  it('loses a ring when a station is deleted', () => {
    const before = guideLines(makeBoard([25, 50, 75]), FACE, null).sections.length;
    const after = guideLines(makeBoard([25, 75]), FACE, null).sections.length;
    expect(after).toBe(before - 1);
  });

  it('keys rings by station position, so an insert does not renumber the rest', () => {
    const before = guideLines(makeBoard([25, 75]), FACE, null).sections.map((s) => s.key);
    const after = guideLines(makeBoard([25, 50, 75]), FACE, null).sections.map((s) => s.key);
    for (const key of before) expect(after).toContain(key);
    expect(new Set(after).size).toBe(after.length);
  });

  it('marks the ring at activeX as active', () => {
    const g = guideLines(makeBoard([25, 50, 75]), FACE, 50);
    expect(g.activeKey).not.toBeNull();
    expect(g.sections.filter((s) => s.key === g.activeKey)).toHaveLength(1);
  });

  it('has no active ring when activeX matches no station', () => {
    expect(guideLines(makeBoard([25, 75]), FACE, 50).activeKey).toBeNull();
    expect(guideLines(makeBoard([25, 75]), FACE, null).activeKey).toBeNull();
  });

  it('renders nothing for a board with no real cross-sections', () => {
    const g = guideLines(makeBoard([]), FACE, null);
    expect(g.sections).toEqual([]);
    expect(g.activeKey).toBeNull();
  });
});
