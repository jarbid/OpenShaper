// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Tests for adjustCrossSectionsToThicknessAndWidth — the coupling that slaves each
 * interior station's centerline thickness to the rocker+deck and its width to the
 * outline (legacy BezierBoard.adjustCrosssectionsToThicknessAndWidth).
 */
import { describe, expect, it } from 'vitest';
import {
  adjustCrossSectionsToThicknessAndWidth,
  board,
  crossSection,
  csCenterThickness,
  csWidth,
  getThicknessAtPos,
  getWidthAtPos,
  knot,
  splineFromKnots,
  vec2,
  type BezierBoard,
} from './index';

// A profile of thickness 3 (y: 0→3) and width 16 (maxX 8) — deliberately NOT matching
// the board curves below, so adjust must resize it.
const makeProfile = () =>
  splineFromKnots([
    knot(vec2(0, 0), vec2(0, 0), vec2(8, 0), true),
    knot(vec2(8, 3), vec2(8, 1), vec2(8, 3), true),
  ]);

// A tiny nose/tail dummy section (near-zero dimensions, as in a loaded board).
const makeDummy = () =>
  splineFromKnots([
    knot(vec2(0, 0), vec2(0, 0), vec2(0.1, 0), true),
    knot(vec2(0.1, 0.1), vec2(0.1, 0.05), vec2(0.1, 0.1), true),
  ]);

function makeBoard(): BezierBoard {
  // outline: half-width 0→15→2 over length 100 (width = 2·y).
  const outline = splineFromKnots([
    knot(vec2(0, 0), vec2(-1, 0), vec2(1, 0), true),
    knot(vec2(50, 15), vec2(40, 15), vec2(60, 15), true),
    knot(vec2(100, 2), vec2(90, 2), vec2(110, 2), true),
  ]);
  // bottom (rocker) and deck: thickness = deck − bottom (6 at mid).
  const bottom = splineFromKnots([
    knot(vec2(0, 0), vec2(-1, 0), vec2(1, 0), true),
    knot(vec2(50, 8), vec2(40, 8), vec2(60, 8), true),
    knot(vec2(100, 0), vec2(90, 0), vec2(110, 0), true),
  ]);
  const deck = splineFromKnots([
    knot(vec2(0, 2), vec2(-1, 2), vec2(1, 2), true),
    knot(vec2(50, 14), vec2(40, 14), vec2(60, 14), true),
    knot(vec2(100, 2), vec2(90, 2), vec2(110, 2), true),
  ]);
  const cs = [
    crossSection(0, makeDummy()),
    crossSection(25, makeProfile()),
    crossSection(50, makeProfile()),
    crossSection(75, makeProfile()),
    crossSection(100, makeDummy()),
  ];
  return board(outline, bottom, deck, cs);
}

describe('adjustCrossSectionsToThicknessAndWidth', () => {
  it('scales each interior station to the board thickness & width at its position', () => {
    const b = makeBoard();
    const out = adjustCrossSectionsToThicknessAndWidth(b);
    for (let i = 1; i < out.crossSections.length - 1; i++) {
      const cs = out.crossSections[i]!;
      expect(csCenterThickness(cs)).toBeCloseTo(getThicknessAtPos(b, cs.position), 6);
      expect(csWidth(cs)).toBeCloseTo(getWidthAtPos(b, cs.position), 6);
    }
  });

  it('keeps each station centre endpoint on the stringer (x = 0) — JC-4-x survives adjust', () => {
    // adjust runs in the commit pipeline AFTER enforceJunctions snaps section centre
    // endpoints to x = 0; scaleCrossSection scales about the origin, so x = 0 stays 0
    // and the stringer lock is not silently violated by the later resize.
    const b = makeBoard();
    const out = adjustCrossSectionsToThicknessAndWidth(b);
    for (let i = 1; i < out.crossSections.length - 1; i++) {
      expect(out.crossSections[i]!.spline.knots[0]!.end.x).toBeCloseTo(0, 9);
    }
  });

  it('leaves the nose/tail dummy stations untouched (same reference)', () => {
    const b = makeBoard();
    const out = adjustCrossSectionsToThicknessAndWidth(b);
    expect(out.crossSections[0]).toBe(b.crossSections[0]);
    expect(out.crossSections[out.crossSections.length - 1]).toBe(
      b.crossSections[b.crossSections.length - 1],
    );
  });

  it('is a fixed point: re-running on a settled board returns the same reference', () => {
    const once = adjustCrossSectionsToThicknessAndWidth(makeBoard());
    const twice = adjustCrossSectionsToThicknessAndWidth(once);
    expect(twice).toBe(once);
  });

  it('grows the stations when the deck is raised (rocker/deck owns thickness)', () => {
    const settled = adjustCrossSectionsToThicknessAndWidth(makeBoard());
    const midBefore = settled.crossSections[2]!; // station at x=50
    const thickBefore = csCenterThickness(midBefore);

    // Raise the whole deck by 4 cm → thickness at every station grows by 4.
    const raisedDeck = splineFromKnots(
      settled.deck.knots.map((k) =>
        knot(
          vec2(k.end.x, k.end.y + 4),
          vec2(k.tangentToPrev.x, k.tangentToPrev.y + 4),
          vec2(k.tangentToNext.x, k.tangentToNext.y + 4),
          k.continuous,
          k.other,
        ),
      ),
    );
    const raised = board(
      settled.outline,
      settled.bottom,
      raisedDeck,
      settled.crossSections,
      settled.interpolationType,
    );
    const out = adjustCrossSectionsToThicknessAndWidth(raised);
    const midAfter = out.crossSections[2]!;
    expect(csCenterThickness(midAfter)).toBeCloseTo(getThicknessAtPos(raised, 50), 6);
    expect(csCenterThickness(midAfter)).toBeGreaterThan(thickBefore);
  });

  it('returns the same board when there are no interior stations', () => {
    const b = makeBoard();
    const noInterior = board(b.outline, b.bottom, b.deck, [
      b.crossSections[0]!,
      b.crossSections[b.crossSections.length - 1]!,
    ]);
    expect(adjustCrossSectionsToThicknessAndWidth(noInterior)).toBe(noInterior);
  });
});
