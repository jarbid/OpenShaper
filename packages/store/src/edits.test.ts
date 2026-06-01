/**
 * Unit tests for edits.ts.
 *
 * board-store.test.ts already covers:
 *   - moveControlPoint (via the store action) and undo/redo coalescing.
 *   - moveKnotTangent with continuous=true (collinearity preservation).
 *
 * This file covers the paths NOT exercised by that test:
 *   - moveKnotEnd: correct delta application to tangent handles.
 *   - moveKnotTangent with continuous=false: opposite handle is unchanged.
 *   - withSpline: replacing each spline target kind (outline/deck/bottom/crossSection).
 *   - getTargetSpline: correctly retrieves the right spline for each target kind.
 */
import {
  board,
  crossSection,
  getLength,
  getMaxWidth,
  knot,
  splineFromKnots,
  vec2,
  type BezierBoard,
} from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import {
  enforceJunctions,
  getTargetSpline,
  insertCrossSection,
  moveKnotEnd,
  moveKnotTangent,
  removeCrossSection,
  scaleBoard,
  withSpline,
  type SplineTarget,
} from './edits';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSpline() {
  return splineFromKnots([
    knot(vec2(0, 0), vec2(-5, 0), vec2(5, 0), true),
    knot(vec2(100, 0), vec2(95, 0), vec2(105, 0), true),
  ]);
}

function makeBoard(): BezierBoard {
  const outline = makeSpline();
  const bottom = splineFromKnots([
    knot(vec2(0, 5), vec2(-5, 5), vec2(5, 5)),
    knot(vec2(100, 5), vec2(95, 5), vec2(105, 5)),
  ]);
  const deck = splineFromKnots([
    knot(vec2(0, 11), vec2(-5, 11), vec2(5, 11)),
    knot(vec2(100, 11), vec2(95, 11), vec2(105, 11)),
  ]);
  const prof = splineFromKnots([
    knot(vec2(0, 5), vec2(0, 5), vec2(10, 5)),
    knot(vec2(10, 8), vec2(10, 6), vec2(10, 8)),
  ]);
  const cs = [crossSection(0, prof), crossSection(50, prof), crossSection(100, prof)];
  return board(outline, bottom, deck, cs);
}

// ---------------------------------------------------------------------------
// moveKnotEnd
// ---------------------------------------------------------------------------

describe('moveKnotEnd', () => {
  it('moves the endpoint to the new position', () => {
    const s = makeSpline();
    const moved = moveKnotEnd(s, 0, vec2(10, 20));
    expect(moved.knots[0]!.end.x).toBeCloseTo(10, 9);
    expect(moved.knots[0]!.end.y).toBeCloseTo(20, 9);
  });

  it('translates tangentToPrev by the same delta as the endpoint', () => {
    const s = makeSpline();
    const k0 = s.knots[0]!;
    // original end=(0,0), tangentToPrev=(-5,0). Move end to (10,20): delta=(10,20).
    const moved = moveKnotEnd(s, 0, vec2(10, 20));
    expect(moved.knots[0]!.tangentToPrev.x).toBeCloseTo(k0.tangentToPrev.x + 10, 9);
    expect(moved.knots[0]!.tangentToPrev.y).toBeCloseTo(k0.tangentToPrev.y + 20, 9);
  });

  it('translates tangentToNext by the same delta as the endpoint', () => {
    const s = makeSpline();
    const k0 = s.knots[0]!;
    const moved = moveKnotEnd(s, 0, vec2(10, 20));
    expect(moved.knots[0]!.tangentToNext.x).toBeCloseTo(k0.tangentToNext.x + 10, 9);
    expect(moved.knots[0]!.tangentToNext.y).toBeCloseTo(k0.tangentToNext.y + 20, 9);
  });

  it('leaves other knots unchanged', () => {
    const s = makeSpline();
    const moved = moveKnotEnd(s, 0, vec2(10, 20));
    expect(moved.knots[1]).toEqual(s.knots[1]);
  });

  it('returns a new spline instance (immutability)', () => {
    const s = makeSpline();
    const moved = moveKnotEnd(s, 0, vec2(10, 20));
    expect(moved).not.toBe(s);
  });

  it('works on any knot index, including the last', () => {
    const s = makeSpline();
    const moved = moveKnotEnd(s, 1, vec2(200, 5));
    expect(moved.knots[1]!.end.x).toBeCloseTo(200, 9);
  });
});

// ---------------------------------------------------------------------------
// moveKnotTangent — continuous = false (no mirroring)
// ---------------------------------------------------------------------------

describe('moveKnotTangent (continuous=false)', () => {
  it('moves only the specified "next" handle when not continuous', () => {
    const s = splineFromKnots([
      knot(vec2(0, 0), vec2(-1, 0), vec2(1, 0), false), // continuous=false
      knot(vec2(10, 0), vec2(9, 0), vec2(11, 0), false),
    ]);
    const moved = moveKnotTangent(s, 0, 'next', vec2(3, 4));
    expect(moved.knots[0]!.tangentToNext.x).toBeCloseTo(3, 9);
    expect(moved.knots[0]!.tangentToNext.y).toBeCloseTo(4, 9);
    // prev handle must remain unchanged
    expect(moved.knots[0]!.tangentToPrev.x).toBeCloseTo(-1, 9);
    expect(moved.knots[0]!.tangentToPrev.y).toBeCloseTo(0, 9);
  });

  it('moves only the specified "prev" handle when not continuous', () => {
    const s = splineFromKnots([
      knot(vec2(0, 0), vec2(-1, 0), vec2(1, 0), false),
      knot(vec2(10, 0), vec2(9, 0), vec2(11, 0), false),
    ]);
    const moved = moveKnotTangent(s, 0, 'prev', vec2(-5, 2));
    expect(moved.knots[0]!.tangentToPrev.x).toBeCloseTo(-5, 9);
    expect(moved.knots[0]!.tangentToPrev.y).toBeCloseTo(2, 9);
    // next handle unchanged
    expect(moved.knots[0]!.tangentToNext.x).toBeCloseTo(1, 9);
    expect(moved.knots[0]!.tangentToNext.y).toBeCloseTo(0, 9);
  });
});

// ---------------------------------------------------------------------------
// moveKnotTangent — continuous = true (collinearity; board-store covers one case
// already, here we verify the "prev" direction path and length preservation)
// ---------------------------------------------------------------------------

describe('moveKnotTangent (continuous=true, prev direction)', () => {
  it('keeps the "next" handle collinear through the endpoint when "prev" is moved', () => {
    const s = splineFromKnots([
      knot(vec2(0, 0), vec2(-1, 0), vec2(1, 0), true),
      knot(vec2(10, 0), vec2(9, 0), vec2(11, 0), true),
    ]);
    // Move prev handle straight down
    const moved = moveKnotTangent(s, 0, 'prev', vec2(0, -2));
    const k = moved.knots[0]!;
    // next should mirror: same direction from end, original length 1 (was (1,0))
    expect(k.tangentToNext.x).toBeCloseTo(0, 9);
    expect(k.tangentToNext.y).toBeCloseTo(1, 9);
  });
});

// ---------------------------------------------------------------------------
// getTargetSpline
// ---------------------------------------------------------------------------

describe('getTargetSpline', () => {
  it('returns the outline spline for target kind "outline"', () => {
    const b = makeBoard();
    const t: SplineTarget = { kind: 'outline' };
    expect(getTargetSpline(b, t)).toBe(b.outline);
  });

  it('returns the deck spline for target kind "deck"', () => {
    const b = makeBoard();
    const t: SplineTarget = { kind: 'deck' };
    expect(getTargetSpline(b, t)).toBe(b.deck);
  });

  it('returns the bottom spline for target kind "bottom"', () => {
    const b = makeBoard();
    const t: SplineTarget = { kind: 'bottom' };
    expect(getTargetSpline(b, t)).toBe(b.bottom);
  });

  it('returns the correct cross-section spline by index', () => {
    const b = makeBoard();
    const t: SplineTarget = { kind: 'crossSection', index: 1 };
    expect(getTargetSpline(b, t)).toBe(b.crossSections[1]!.spline);
  });
});

// ---------------------------------------------------------------------------
// withSpline
// ---------------------------------------------------------------------------

describe('withSpline', () => {
  const replacement = splineFromKnots([
    knot(vec2(0, 99), vec2(0, 99), vec2(10, 99)),
    knot(vec2(100, 99), vec2(90, 99), vec2(100, 99)),
  ]);

  it('replaces the outline and leaves other splines unchanged', () => {
    const b = makeBoard();
    const next = withSpline(b, { kind: 'outline' }, replacement);
    expect(next.outline).toBe(replacement);
    expect(next.bottom).toBe(b.bottom);
    expect(next.deck).toBe(b.deck);
  });

  it('replaces the bottom and leaves other splines unchanged', () => {
    const b = makeBoard();
    const next = withSpline(b, { kind: 'bottom' }, replacement);
    expect(next.bottom).toBe(replacement);
    expect(next.outline).toBe(b.outline);
    expect(next.deck).toBe(b.deck);
  });

  it('replaces the deck and leaves other splines unchanged', () => {
    const b = makeBoard();
    const next = withSpline(b, { kind: 'deck' }, replacement);
    expect(next.deck).toBe(replacement);
    expect(next.outline).toBe(b.outline);
    expect(next.bottom).toBe(b.bottom);
  });

  it('replaces the correct cross-section spline by index', () => {
    const b = makeBoard();
    const next = withSpline(b, { kind: 'crossSection', index: 1 }, replacement);
    expect(next.crossSections[1]!.spline).toBe(replacement);
    // position is preserved
    expect(next.crossSections[1]!.position).toBe(b.crossSections[1]!.position);
    // other cross-sections untouched
    expect(next.crossSections[0]!.spline).toBe(b.crossSections[0]!.spline);
    expect(next.crossSections[2]!.spline).toBe(b.crossSections[2]!.spline);
  });

  it('returns a new board instance (immutability)', () => {
    const b = makeBoard();
    const next = withSpline(b, { kind: 'outline' }, replacement);
    expect(next).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// enforceJunctions — shared curve junctions can't be pulled apart
// ---------------------------------------------------------------------------

describe('enforceJunctions', () => {
  it('snaps cross-section center endpoints onto the stringer (x=0)', () => {
    const b = makeBoard();
    // Pull both center endpoints of cross-section 1 off the stringer.
    const drifted = withSpline(
      b,
      { kind: 'crossSection', index: 1 },
      splineFromKnots([
        knot(vec2(3, 5), vec2(3, 5), vec2(10, 5)),
        knot(vec2(-2, 8), vec2(10, 6), vec2(-2, 8)),
      ]),
    );
    const fixed = enforceJunctions(drifted, { kind: 'crossSection', index: 1 });
    const ks = fixed.crossSections[1]!.spline.knots;
    expect(ks[0]!.end.x).toBeCloseTo(0, 9);
    expect(ks[ks.length - 1]!.end.x).toBeCloseTo(0, 9);
    // y is preserved (only the off-axis component is clamped).
    expect(ks[0]!.end.y).toBeCloseTo(5, 9);
    expect(ks[ks.length - 1]!.end.y).toBeCloseTo(8, 9);
  });

  it('snaps the outline nose endpoint onto the centerline (y=0) but leaves the tail free', () => {
    const b = makeBoard();
    const drifted = withSpline(
      b,
      { kind: 'outline' },
      splineFromKnots([
        knot(vec2(0, 4), vec2(-5, 4), vec2(5, 4)), // nose pulled off centerline
        knot(vec2(100, 12), vec2(95, 12), vec2(105, 12)), // legitimate tail width
      ]),
    );
    const fixed = enforceJunctions(drifted, { kind: 'outline' });
    expect(fixed.outline.knots[0]!.end.y).toBeCloseTo(0, 9);
    expect(fixed.outline.knots[1]!.end.y).toBeCloseTo(12, 9); // tail untouched
  });

  it('drags the bottom nose/tail tips to follow an edited deck (deck wins)', () => {
    const b = makeBoard();
    const movedDeck = withSpline(
      b,
      { kind: 'deck' },
      splineFromKnots([
        knot(vec2(0, 20), vec2(-5, 20), vec2(5, 20)),
        knot(vec2(100, 22), vec2(95, 22), vec2(105, 22)),
      ]),
    );
    const fixed = enforceJunctions(movedDeck, { kind: 'deck' });
    expect(fixed.bottom.knots[0]!.end).toEqual(fixed.deck.knots[0]!.end);
    expect(fixed.bottom.knots[fixed.bottom.knots.length - 1]!.end).toEqual(
      fixed.deck.knots[fixed.deck.knots.length - 1]!.end,
    );
  });

  it('drags the deck tips to follow an edited bottom (bottom wins)', () => {
    const b = makeBoard();
    const movedBottom = withSpline(
      b,
      { kind: 'bottom' },
      splineFromKnots([
        knot(vec2(0, -3), vec2(-5, -3), vec2(5, -3)),
        knot(vec2(100, -1), vec2(95, -1), vec2(105, -1)),
      ]),
    );
    const fixed = enforceJunctions(movedBottom, { kind: 'bottom' });
    expect(fixed.deck.knots[0]!.end).toEqual(fixed.bottom.knots[0]!.end);
    expect(fixed.deck.knots[fixed.deck.knots.length - 1]!.end).toEqual(
      fixed.bottom.knots[fixed.bottom.knots.length - 1]!.end,
    );
  });

  it('is idempotent (already-joined board is unchanged on a second pass)', () => {
    const once = enforceJunctions(makeBoard());
    const twice = enforceJunctions(once);
    expect(twice.deck.knots).toEqual(once.deck.knots);
    expect(twice.bottom.knots).toEqual(once.bottom.knots);
    expect(twice.outline.knots).toEqual(once.outline.knots);
  });
});

// ---------------------------------------------------------------------------
// insertCrossSection / removeCrossSection
// ---------------------------------------------------------------------------

describe('insertCrossSection', () => {
  it('inserts a section at the position, kept sorted, returning its index', () => {
    const b = makeBoard(); // sections at 0, 50, 100
    const r = insertCrossSection(b, 25);
    expect(r).not.toBeNull();
    expect(r!.board.crossSections).toHaveLength(b.crossSections.length + 1);
    expect(r!.board.crossSections[r!.index]!.position).toBeCloseTo(25, 6);
    const ps = r!.board.crossSections.map((c) => c.position);
    expect(ps).toEqual([...ps].sort((a, c) => a - c));
  });

  it('returns null for a position outside the board', () => {
    const b = makeBoard();
    expect(insertCrossSection(b, -5)).toBeNull();
    expect(insertCrossSection(b, 1000)).toBeNull();
  });
});

describe('removeCrossSection', () => {
  it('removes a real section', () => {
    const withTwo = insertCrossSection(makeBoard(), 25)!.board; // 0,25,50,100
    const after = removeCrossSection(withTwo, 1); // remove pos 25
    expect(after.crossSections).toHaveLength(withTwo.crossSections.length - 1);
    expect(after.crossSections.map((c) => c.position)).not.toContain(25);
  });

  it('is a no-op for dummy endpoints or when only one real section remains', () => {
    const b = makeBoard(); // a single real section (index 1)
    expect(removeCrossSection(b, 0)).toBe(b); // nose dummy
    expect(removeCrossSection(b, b.crossSections.length - 1)).toBe(b); // tail dummy
    expect(removeCrossSection(b, 1)).toBe(b); // would leave zero real sections
  });
});

describe('scaleBoard', () => {
  it('scales length independently of width', () => {
    const b = makeBoard(); // length 100, sections at 0/50/100
    const s = scaleBoard(b, 2, 1, 1);
    expect(getLength(s)).toBeCloseTo(getLength(b) * 2, 6);
    expect(getMaxWidth(s)).toBeCloseTo(getMaxWidth(b), 6);
    // cross-section positions scale with length.
    expect(s.crossSections.map((c) => c.position)).toEqual(
      b.crossSections.map((c) => c.position * 2),
    );
  });

  it('scales width independently of length', () => {
    const b = makeBoard();
    const s = scaleBoard(b, 1, 1.5, 1);
    expect(getMaxWidth(s)).toBeCloseTo(getMaxWidth(b) * 1.5, 6);
    expect(getLength(s)).toBeCloseTo(getLength(b), 6);
  });
});
