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
  defaultFinConfig,
  getLength,
  getMaxWidth,
  getWidthAtPos,
  hasTailCutout,
  knot,
  resolveFins,
  splineFromKnots,
  value,
  vec2,
  type BezierBoard,
  type Knot,
  type Spline,
} from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import {
  alignTangentsHorizontal,
  alignTangentsVertical,
  blankLocks,
  canDeleteKnot,
  canLockKnot,
  constrainSectionToBlank,
  constrainToLock,
  deleteKnot,
  enforceJunctions,
  extendKnotTangent,
  fairKnot,
  getTargetSpline,
  insertCrossSection,
  insertKnotAt,
  moveCrossSectionPosition,
  moveKnotEnd,
  moveKnotTangent,
  removeCrossSection,
  rotateKnotTangent,
  scaleBoard,
  sectionApexIndex,
  setFinFromPlanPoint,
  setKnotContinuous,
  setKnotLock,
  setKnotTangentLength,
  stepKnotTangentLength,
  withFins,
  withSpline,
  zeroKnotTangent,
  type KnotHandles,
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

describe('point fairing and collapsed handles', () => {
  const uneven = () =>
    splineFromKnots([
      knot(vec2(0, 0), vec2(-2, 4), vec2(20, 25), true),
      knot(vec2(30, 12), vec2(5, -20), vec2(75, 40), false),
      knot(vec2(90, 6), vec2(60, -25), vec2(100, 6), true),
    ]);

  it('fairs an interior point along the neighbour chord with one-third handle lengths', () => {
    const out = fairKnot(uneven(), 1);
    const k = out.knots[1]!;
    const chordLength = Math.hypot(90, 6);
    const ux = 90 / chordLength;
    const uy = 6 / chordLength;
    const prevLength = Math.hypot(30, 12) / 3;
    const nextLength = Math.hypot(60, -6) / 3;

    expect(k.tangentToPrev.x).toBeCloseTo(k.end.x - ux * prevLength, 9);
    expect(k.tangentToPrev.y).toBeCloseTo(k.end.y - uy * prevLength, 9);
    expect(k.tangentToNext.x).toBeCloseTo(k.end.x + ux * nextLength, 9);
    expect(k.tangentToNext.y).toBeCloseTo(k.end.y + uy * nextLength, 9);
  });

  it('preserves a corner point while fairing its handles', () => {
    expect(uneven().knots[1]!.continuous).toBe(false);
    expect(fairKnot(uneven(), 1).knots[1]!.continuous).toBe(false);
  });

  it('collapses and re-extends an individual tangent toward its neighbour', () => {
    const collapsed = zeroKnotTangent(uneven(), 1, 'next');
    expect(collapsed.knots[1]!.tangentToNext).toEqual(collapsed.knots[1]!.end);

    const extended = extendKnotTangent(collapsed, 1, 'next');
    const k = extended.knots[1]!;
    expect(k.tangentToNext.x).toBeGreaterThan(k.end.x);
    expect(Math.hypot(k.tangentToNext.x - k.end.x, k.tangentToNext.y - k.end.y)).toBeCloseTo(5, 9);
  });
});

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
// Handle-angle locks
// ---------------------------------------------------------------------------

describe('handle-angle locks', () => {
  const R = Math.SQRT1_2;
  /** A handle's angle (rad) and length, measured from its point. */
  const angleOf = (k: Knot, which: 'prev' | 'next') => {
    const h = which === 'prev' ? k.tangentToPrev : k.tangentToNext;
    return Math.atan2(h.y - k.end.y, h.x - k.end.x);
  };
  const lengthOf = (k: Knot, which: 'prev' | 'next') => {
    const h = which === 'prev' ? k.tangentToPrev : k.tangentToNext;
    return Math.hypot(h.x - k.end.x, h.y - k.end.y);
  };
  // The middle point's handles leave at 135° and 45° — off-axis, so a direction that
  // drifted could not pass by coincidence. Smooth, it takes 225° and 45° instead.
  const diagonal = (continuous = false) =>
    splineFromKnots([
      knot(vec2(0, 0), vec2(-5, 0), vec2(5, 5), true),
      knot(vec2(50, 10), continuous ? vec2(46, 6) : vec2(46, 14), vec2(54, 14), continuous),
      knot(vec2(100, 0), vec2(95, 0), vec2(105, 0), true),
    ]);
  const locked = (continuous = false) => setKnotLock(diagonal(continuous), 1, true);

  it('locks the directions the handles have now, without moving them', () => {
    const s = diagonal();
    const before = s.knots[1]!;
    const k = setKnotLock(s, 1, true).knots[1]!;
    expect(k.lock?.prev?.x).toBeCloseTo(-R, 12);
    expect(k.lock?.prev?.y).toBeCloseTo(R, 12);
    expect(k.lock?.next?.x).toBeCloseTo(R, 12);
    expect(k.lock?.next?.y).toBeCloseTo(R, 12);
    expect(k.tangentToPrev).toBe(before.tangentToPrev);
    expect(k.tangentToNext).toBe(before.tangentToNext);
  });

  it('unlocking drops the lock entirely and leaves the handles alone', () => {
    const k = setKnotLock(locked(), 1, false).knots[1]!;
    expect(k).not.toHaveProperty('lock');
    expect(k.tangentToNext).toEqual(vec2(54, 14));
  });

  it('a dragged locked handle keeps its angle; its length is the reach along it', () => {
    // Straight up from (54,14) to (54,24): (4,14)·(√½,√½) = 18√½ along the 45° line.
    const k = moveKnotTangent(locked(), 1, 'next', vec2(54, 24)).knots[1]!;
    expect(angleOf(k, 'next')).toBeCloseTo(Math.PI / 4, 12);
    expect(lengthOf(k, 'next')).toBeCloseTo(18 * R, 12);
    expect(k.tangentToPrev).toEqual(vec2(46, 14)); // a corner's other handle stays put
  });

  it('collapses a locked handle dragged back past its point instead of flipping it', () => {
    const k = moveKnotTangent(locked(), 1, 'next', vec2(40, 0)).knots[1]!;
    expect(k.tangentToNext).toEqual(k.end);
  });

  it('brings a collapsed locked handle back out along its lock', () => {
    const collapsed = zeroKnotTangent(locked(), 1, 'next');
    expect(collapsed.knots[1]!.tangentToNext).toEqual(collapsed.knots[1]!.end);
    expect(collapsed.knots[1]!.lock).toEqual(locked().knots[1]!.lock);

    // Straight up again: a free handle would point up, a locked one returns at 45°.
    const k = moveKnotTangent(collapsed, 1, 'next', vec2(50, 30)).knots[1]!;
    expect(angleOf(k, 'next')).toBeCloseTo(Math.PI / 4, 12);
    expect(lengthOf(k, 'next')).toBeCloseTo(20 * R, 12);
  });

  it('on a locked smooth point, moving one handle leaves the other exactly where it was', () => {
    const k = moveKnotTangent(locked(true), 1, 'next', vec2(70, 20)).knots[1]!;
    expect(angleOf(k, 'next')).toBeCloseTo(Math.PI / 4, 12);
    expect(k.tangentToPrev).toEqual(vec2(46, 6));
  });

  it('a locked corner made smooth does not swing its other handle on the next drag', () => {
    const smooth = setKnotContinuous(locked(), 1, true);
    const k = moveKnotTangent(smooth, 1, 'next', vec2(70, 20)).knots[1]!;
    expect(k.tangentToPrev).toEqual(vec2(46, 14)); // still at 135°, not mirrored to 225°
  });

  it('making a half-locked corner smooth locks its free side opposite the other', () => {
    const halfLocked = setKnotLock(zeroKnotTangent(diagonal(), 1, 'prev'), 1, true);
    expect(halfLocked.knots[1]!.lock).not.toHaveProperty('prev');
    const k = setKnotContinuous(halfLocked, 1, true).knots[1]!;
    expect(k.lock?.prev?.x).toBeCloseTo(-R, 12);
    expect(k.lock?.prev?.y).toBeCloseTo(-R, 12);
  });

  it('a smooth point locks a collapsed side opposite its other handle; a corner leaves it free', () => {
    const smooth = setKnotLock(zeroKnotTangent(diagonal(true), 1, 'prev'), 1, true).knots[1]!;
    expect(smooth.lock?.prev?.x).toBeCloseTo(-R, 12);
    expect(smooth.lock?.prev?.y).toBeCloseTo(-R, 12);
    const corner = setKnotLock(zeroKnotTangent(diagonal(), 1, 'prev'), 1, true).knots[1]!;
    expect(corner.lock).not.toHaveProperty('prev');
    expect(corner.lock?.next).toBeDefined();
  });

  it('has nothing to lock when both handles are collapsed', () => {
    const bare = zeroKnotTangent(zeroKnotTangent(diagonal(), 1, 'prev'), 1, 'next');
    expect(canLockKnot(bare.knots[1]!)).toBe(false);
    expect(setKnotLock(bare, 1, true)).toBe(bare);
    expect(canLockKnot(diagonal().knots[1]!)).toBe(true);
  });

  it('re-locking keeps the stored direction of a collapsed handle', () => {
    const collapsed = zeroKnotTangent(locked(), 1, 'next');
    expect(setKnotLock(collapsed, 1, true)).toBe(collapsed);
  });

  it('fair keeps locked directions and only takes the faired lengths', () => {
    const k = fairKnot(locked(), 1).knots[1]!;
    const third = Math.hypot(50, 10) / 3; // both neighbours are √(50² + 10²) away
    expect(angleOf(k, 'next')).toBeCloseTo(Math.PI / 4, 12);
    expect(angleOf(k, 'prev')).toBeCloseTo((3 * Math.PI) / 4, 12);
    expect(lengthOf(k, 'next')).toBeCloseTo(third, 12);
    expect(lengthOf(k, 'prev')).toBeCloseTo(third, 12);
  });

  it('extends a collapsed locked handle along its lock, not toward the neighbour', () => {
    const k = extendKnotTangent(zeroKnotTangent(locked(), 1, 'next'), 1, 'next').knots[1]!;
    expect(angleOf(k, 'next')).toBeCloseTo(Math.PI / 4, 12);
    expect(lengthOf(k, 'next')).toBeCloseTo(5, 12);
  });

  it('aligning a locked point turns its lock with it: a horizontal lock', () => {
    const aligned = alignTangentsHorizontal(locked(), 1);
    expect(aligned.knots[1]!.lock).toEqual({ prev: vec2(-1, 0), next: vec2(1, 0) });
    const k = moveKnotTangent(aligned, 1, 'next', vec2(60, 30)).knots[1]!;
    expect(k.tangentToNext).toEqual(vec2(60, 10));
  });

  it('aligning a locked point vertical locks it vertical', () => {
    expect(alignTangentsVertical(locked(), 1).knots[1]!.lock).toEqual({
      prev: vec2(0, 1),
      next: vec2(0, 1),
    });
    expect(alignTangentsVertical(locked(true), 1).knots[1]!.lock).toEqual({
      prev: vec2(0, -1),
      next: vec2(0, 1),
    });
  });

  it('aligning a free point leaves it free', () => {
    expect(alignTangentsHorizontal(diagonal(), 1).knots[1]!).not.toHaveProperty('lock');
  });

  it('moving a locked point carries its handles and lock with it, exactly', () => {
    const k = moveKnotEnd(locked(), 1, vec2(52, 13)).knots[1]!;
    expect(k.tangentToNext).toEqual(vec2(56, 17));
    expect(k.tangentToPrev).toEqual(vec2(48, 17));
    expect(k.lock).toEqual(locked().knots[1]!.lock);
  });

  it('sets a locked handle length along its lock, and a free one along where it points', () => {
    const k = setKnotTangentLength(locked(), 1, 'next', 10).knots[1]!;
    expect(k.tangentToNext.x).toBeCloseTo(50 + 10 * R, 12);
    expect(k.tangentToNext.y).toBeCloseTo(10 + 10 * R, 12);

    const free = setKnotTangentLength(diagonal(), 1, 'prev', 2 * Math.SQRT2).knots[1]!;
    expect(free.tangentToPrev.x).toBeCloseTo(48, 12);
    expect(free.tangentToPrev.y).toBeCloseTo(12, 12);

    const negative = setKnotTangentLength(locked(), 1, 'next', -3).knots[1]!;
    expect(negative.tangentToNext).toEqual(negative.end);

    const bare = zeroKnotTangent(diagonal(), 1, 'next');
    expect(setKnotTangentLength(bare, 1, 'next', 4)).toBe(bare);
  });

  it('a point inserted next to a locked one starts free; the locked neighbour keeps its lock', () => {
    const s = locked();
    const ins = insertKnotAt(s, vec2(75, 8))!;
    const lockedKnot = ins.spline.knots.find((k) => k.end.x === 50 && k.end.y === 10)!;
    expect(lockedKnot.lock).toEqual(s.knots[1]!.lock);
    expect(ins.spline.knots[ins.index]!).not.toHaveProperty('lock');
    expect(angleOf(lockedKnot, 'next')).toBeCloseTo(Math.PI / 4, 12);
  });

  it("deleting a point keeps its neighbours' locks, their handles still on them", () => {
    const s = setKnotLock(setKnotLock(diagonal(), 0, true), 2, true);
    const out = deleteKnot(s, 1);
    expect(out.knots[0]!.lock).toEqual(s.knots[0]!.lock);
    expect(out.knots[1]!.lock).toEqual(s.knots[2]!.lock);
    expect(constrainToLock(out.knots[0]!)).toBe(out.knots[0]);
    expect(constrainToLock(out.knots[1]!)).toBe(out.knots[1]);
  });

  it('constrainToLock slides each locked handle onto its lock, keeping its reach along it', () => {
    const k = knot(vec2(0, 0), vec2(-3, 1), vec2(4, 3), false, false, {
      prev: vec2(-1, 0),
      next: vec2(1, 0),
    });
    const c = constrainToLock(k);
    expect(c.tangentToPrev).toEqual(vec2(-3, 0));
    expect(c.tangentToNext).toEqual(vec2(4, 0));
    expect(c.lock).toBe(k.lock);
  });

  it('every edit re-imposes a lock its handle had drifted from', () => {
    // A hand-edited file can carry a lock its handle does not follow: the next edit
    // that rewrites the point — here, merely making it smooth — pulls the handle on.
    const s = splineFromKnots([
      knot(vec2(0, 0), vec2(-5, 0), vec2(5, 5), true),
      knot(vec2(50, 10), vec2(46, 14), vec2(54, 14), false, false, { next: vec2(1, 0) }),
      knot(vec2(100, 0), vec2(95, 0), vec2(105, 0), true),
    ]);
    expect(setKnotContinuous(s, 1, false).knots[1]!.tangentToNext).toEqual(vec2(54, 10));
  });

  it('constrainToLock returns a free knot untouched', () => {
    const k = diagonal().knots[1]!;
    expect(constrainToLock(k)).toBe(k);
  });

  it('the junction pass keeps a locked board locked (and changes nothing else)', () => {
    const b = makeBoard();
    const lockedBoard = withSpline(b, { kind: 'outline' }, setKnotLock(b.outline, 0, true));
    const pinned = enforceJunctions(lockedBoard);
    expect(pinned.outline.knots[0]!.lock).toEqual(lockedBoard.outline.knots[0]!.lock);
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
// Keyboard handle edits: rotation and length steps
// ---------------------------------------------------------------------------

describe('keyboard handle edits', () => {
  const DEG = Math.PI / 180;
  const R = Math.SQRT1_2;
  const angleOf = (k: Knot, which: 'prev' | 'next') => {
    const h = which === 'prev' ? k.tangentToPrev : k.tangentToNext;
    return Math.atan2(h.y - k.end.y, h.x - k.end.x);
  };
  const lengthOf = (k: Knot, which: 'prev' | 'next') => {
    const h = which === 'prev' ? k.tangentToPrev : k.tangentToNext;
    return Math.hypot(h.x - k.end.x, h.y - k.end.y);
  };
  /** Signed angle from `a` to `b`, wrapped to (-π, π]. */
  const turnBetween = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
  // The middle point's `next` handle leaves at 45°, 4√2 long; its `prev` at 135° on a
  // corner and 225° on a smooth point, 5√2 long. Unequal lengths and off-axis angles,
  // so a swapped, rescaled or drifted handle could not pass by coincidence.
  const spline = (continuous: boolean) =>
    splineFromKnots([
      knot(vec2(0, 0), vec2(-5, 0), vec2(5, 5), true),
      knot(vec2(50, 10), continuous ? vec2(45, 5) : vec2(45, 15), vec2(54, 14), continuous),
      knot(vec2(100, 0), vec2(95, 0), vec2(105, 0), true),
    ]);

  describe('rotateKnotTangent', () => {
    it('turns one handle of a corner by exactly the angle, keeping its length', () => {
      const s = spline(false);
      const before = s.knots[1]!;
      const k = rotateKnotTangent(s, 1, 'next', 10 * DEG).knots[1]!;
      expect(turnBetween(angleOf(before, 'next'), angleOf(k, 'next'))).toBeCloseTo(10 * DEG, 12);
      expect(lengthOf(k, 'next')).toBeCloseTo(4 * Math.SQRT2, 12);
      // The point and the corner's other handle do not move.
      expect(k.end).toBe(before.end);
      expect(k.tangentToPrev).toBe(before.tangentToPrev);
    });

    it('a negative angle turns clockwise', () => {
      const k = rotateKnotTangent(spline(false), 1, 'next', -45 * DEG).knots[1]!;
      // 45° turned 45° clockwise is level with the point, 4√2 out.
      expect(k.tangentToNext.x).toBeCloseTo(50 + 4 * Math.SQRT2, 12);
      expect(k.tangentToNext.y).toBeCloseTo(10, 12);
    });

    it('turns both handles of a smooth point together, so they stay collinear', () => {
      for (const which of ['prev', 'next', 'both'] as const) {
        const k = rotateKnotTangent(spline(true), 1, which, -7 * DEG).knots[1]!;
        expect(angleOf(k, 'next')).toBeCloseTo(38 * DEG, 12);
        expect(angleOf(k, 'prev')).toBeCloseTo(-142 * DEG, 12);
        expect(lengthOf(k, 'prev')).toBeCloseTo(5 * Math.SQRT2, 12);
        expect(lengthOf(k, 'next')).toBeCloseTo(4 * Math.SQRT2, 12);
        const p = vec2(k.tangentToPrev.x - k.end.x, k.tangentToPrev.y - k.end.y);
        const n = vec2(k.tangentToNext.x - k.end.x, k.tangentToNext.y - k.end.y);
        expect(p.x * n.y - p.y * n.x).toBeCloseTo(0, 12); // collinear …
        expect(p.x * n.x + p.y * n.y).toBeLessThan(0); // … and opposite
      }
    });

    it('turns both handles of a selected corner point by the same angle', () => {
      const s = spline(false);
      const before = s.knots[1]!;
      const k = rotateKnotTangent(s, 1, 'both', 30 * DEG).knots[1]!;
      for (const which of ['prev', 'next'] as const) {
        expect(turnBetween(angleOf(before, which), angleOf(k, which))).toBeCloseTo(30 * DEG, 12);
        expect(lengthOf(k, which)).toBeCloseTo(lengthOf(before, which), 12);
      }
    });

    it('never turns a locked handle: the lock fixes its angle', () => {
      const corner = setKnotLock(spline(false), 1, true);
      expect(rotateKnotTangent(corner, 1, 'next', 5 * DEG)).toBe(corner);
      expect(rotateKnotTangent(corner, 1, 'both', 5 * DEG)).toBe(corner);
      // On a smooth point the handles turn together, so a lock on either holds both.
      const smooth = setKnotLock(spline(true), 1, true);
      for (const which of ['prev', 'next', 'both'] as const)
        expect(rotateKnotTangent(smooth, 1, which, 5 * DEG)).toBe(smooth);
    });

    it("a corner's free handle still turns beside a locked one, and the lock is kept", () => {
      const lock = { next: vec2(Math.SQRT1_2, Math.SQRT1_2) };
      const s = splineFromKnots([
        knot(vec2(0, 0), vec2(-5, 0), vec2(5, 5), true),
        knot(vec2(50, 10), vec2(45, 15), vec2(54, 14), false, false, lock),
        knot(vec2(100, 0), vec2(95, 0), vec2(105, 0), true),
      ]);
      const before = s.knots[1]!;
      const k = rotateKnotTangent(s, 1, 'both', 20 * DEG).knots[1]!;
      expect(k.tangentToNext).toBe(before.tangentToNext);
      expect(k.lock).toBe(lock);
      expect(turnBetween(angleOf(before, 'prev'), angleOf(k, 'prev'))).toBeCloseTo(20 * DEG, 12);
      expect(lengthOf(k, 'prev')).toBeCloseTo(5 * Math.SQRT2, 12);
    });

    it("a point's handles leave the end knots' unused ones alone", () => {
      const s = splineFromKnots([
        knot(vec2(0, 0), vec2(0, -3), vec2(0, 5), false),
        knot(vec2(50, 10), vec2(45, 15), vec2(54, 14), false),
        knot(vec2(100, 0), vec2(95, 0), vec2(103, 2), true),
      ]);
      const tail = rotateKnotTangent(s, 0, 'both', -10 * DEG).knots[0]!;
      expect(tail.tangentToPrev).toBe(s.knots[0]!.tangentToPrev);
      expect(angleOf(tail, 'next')).toBeCloseTo(80 * DEG, 12);
      // A smooth end point turns its used handle, the unused one along with it.
      const nose = rotateKnotTangent(s, 2, 'both', 10 * DEG).knots[2]!;
      expect(angleOf(nose, 'prev')).toBeCloseTo(-170 * DEG, 12);
      // Only the unused handle has a direction: nothing to turn, smooth or not.
      for (const continuous of [true, false]) {
        const flat = splineFromKnots([
          knot(vec2(0, 0), vec2(0, -3), vec2(0, 0), continuous),
          knot(vec2(50, 10), vec2(45, 15), vec2(54, 14), false),
        ]);
        expect(rotateKnotTangent(flat, 0, 'both', 10 * DEG)).toBe(flat);
      }
    });

    it('returns the spline itself when there is nothing to turn', () => {
      const s = spline(false);
      expect(rotateKnotTangent(s, 1, 'next', 0)).toBe(s);
      expect(rotateKnotTangent(s, 1, 'next', Number.NaN)).toBe(s);
      expect(rotateKnotTangent(s, 7, 'next', 1)).toBe(s);
      const collapsed = zeroKnotTangent(s, 1, 'next');
      expect(rotateKnotTangent(collapsed, 1, 'next', 1)).toBe(collapsed);
    });
  });

  describe('stepKnotTangentLength', () => {
    /** The middle knot after a length step. */
    const stepped = (s: Spline, which: KnotHandles, d: number) =>
      stepKnotTangentLength(s, 1, which, d).knots[1]!;

    it('lengthens and shortens a handle along its own direction', () => {
      const longer = stepped(spline(false), 'next', 2);
      expect(longer.tangentToNext.x).toBeCloseTo(50 + (4 * Math.SQRT2 + 2) * R, 12);
      expect(longer.tangentToNext.y).toBeCloseTo(10 + (4 * Math.SQRT2 + 2) * R, 12);
      const shorter = stepped(spline(false), 'next', -2);
      expect(lengthOf(shorter, 'next')).toBeCloseTo(4 * Math.SQRT2 - 2, 12);
      expect(shorter.tangentToPrev).toEqual(vec2(45, 15));
    });

    it('never shortens below zero', () => {
      const k = stepped(spline(true), 'next', -100);
      expect(k.tangentToNext).toEqual(k.end);
    });

    it('never collapses a handle whose direction would be lost', () => {
      // A free corner handle would have no way back: it stops at its last step.
      const corner = spline(false);
      expect(stepKnotTangentLength(corner, 1, 'next', -100)).toBe(corner);
      const short = stepped(corner, 'next', -5); // 4√2 - 5 ≈ 0.66 left
      expect(lengthOf(short, 'next')).toBeCloseTo(4 * Math.SQRT2 - 5, 12);
      // A smooth point's handles, shortened together: one collapses (it grows back
      // opposite the other), the last one keeps the tangent.
      const smooth = spline(true);
      let s = smooth;
      for (let i = 0; i < 4; i++) s = stepKnotTangentLength(s, 1, 'both', -3);
      const k = s.knots[1]!;
      expect(lengthOf(k, 'next')).toBe(0);
      expect(lengthOf(k, 'prev')).toBeCloseTo(5 * Math.SQRT2 - 6, 12);
      // Grown back out, the tangent points exactly where it did.
      for (let i = 0; i < 4; i++) s = stepKnotTangentLength(s, 1, 'both', 3);
      const back = s.knots[1]!;
      expect(angleOf(back, 'next')).toBeCloseTo(angleOf(smooth.knots[1]!, 'next'), 12);
      expect(angleOf(back, 'prev')).toBeCloseTo(angleOf(smooth.knots[1]!, 'prev'), 12);
    });

    it("a point's handles leave the end knots' unused ones alone", () => {
      const s = spline(true);
      const tail = stepKnotTangentLength(s, 0, 'both', 2).knots[0]!;
      expect(lengthOf(tail, 'prev')).toBeCloseTo(5, 12);
      expect(lengthOf(tail, 'next')).toBeCloseTo(5 * Math.SQRT2 + 2, 12);
      const nose = stepKnotTangentLength(s, 2, 'both', 2).knots[2]!;
      expect(lengthOf(nose, 'next')).toBeCloseTo(5, 12);
      expect(lengthOf(nose, 'prev')).toBeCloseTo(7, 12);
    });

    it("changes both of a point's handles by the same amount", () => {
      const k = stepped(spline(true), 'both', 1);
      expect(lengthOf(k, 'prev')).toBeCloseTo(5 * Math.SQRT2 + 1, 12);
      expect(lengthOf(k, 'next')).toBeCloseTo(4 * Math.SQRT2 + 1, 12);
      // Still smooth: opposite directions.
      expect(k.tangentToPrev.x - k.end.x).toBeCloseTo(-(5 * Math.SQRT2 + 1) * R, 12);
      expect(k.tangentToPrev.y - k.end.y).toBeCloseTo(-(5 * Math.SQRT2 + 1) * R, 12);
    });

    it('changes a locked handle along its lock: length is not locked', () => {
      const k = stepKnotTangentLength(setKnotLock(spline(false), 1, true), 1, 'next', 3).knots[1]!;
      expect(k.tangentToNext.x).toBeCloseTo(50 + (4 * Math.SQRT2 + 3) * R, 12);
      expect(k.tangentToNext.y).toBeCloseTo(10 + (4 * Math.SQRT2 + 3) * R, 12);
    });

    it('grows a handle shortened to nothing back out the way it pointed', () => {
      // Smooth: opposite its other handle, which is where it was.
      const smooth = stepKnotTangentLength(spline(true), 1, 'prev', -100);
      expect(lengthOf(smooth.knots[1]!, 'prev')).toBe(0);
      const back = stepKnotTangentLength(smooth, 1, 'prev', 2).knots[1]!;
      expect(back.tangentToPrev.x).toBeCloseTo(50 - 2 * R, 12);
      expect(back.tangentToPrev.y).toBeCloseTo(10 - 2 * R, 12);
      // Locked: along its lock.
      const locked = stepKnotTangentLength(setKnotLock(spline(false), 1, true), 1, 'prev', -100);
      const lockedBack = stepKnotTangentLength(locked, 1, 'prev', 2).knots[1]!;
      expect(lockedBack.tangentToPrev.x).toBeCloseTo(50 - 2 * R, 12);
      expect(lockedBack.tangentToPrev.y).toBeCloseTo(10 + 2 * R, 12);
      // A free corner handle collapsed some other way has lost its direction: it grows
      // toward the neighbouring point.
      const corner = zeroKnotTangent(spline(false), 1, 'prev');
      const toward = stepKnotTangentLength(corner, 1, 'prev', 2).knots[1]!;
      const d = Math.hypot(50, 10);
      expect(toward.tangentToPrev.x).toBeCloseTo(50 - (2 * 50) / d, 12);
      expect(toward.tangentToPrev.y).toBeCloseTo(10 - (2 * 10) / d, 12);
    });

    it('returns the spline itself when nothing changes', () => {
      const s = spline(false);
      expect(stepKnotTangentLength(s, 1, 'next', 0)).toBe(s);
      expect(stepKnotTangentLength(s, 9, 'next', 1)).toBe(s);
      const collapsed = zeroKnotTangent(s, 1, 'next');
      expect(stepKnotTangentLength(collapsed, 1, 'next', -1)).toBe(collapsed);
    });
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
        knot(vec2(0, 12), vec2(-5, 12), vec2(5, 12)), // tail (x=0) carries legitimate width
        knot(vec2(100, 4), vec2(95, 4), vec2(105, 4)), // nose (x=length) pulled off centerline
      ]),
    );
    const fixed = enforceJunctions(drifted, { kind: 'outline' });
    expect(fixed.outline.knots[1]!.end.y).toBeCloseTo(0, 9); // nose snapped to centerline
    expect(fixed.outline.knots[0]!.end.y).toBeCloseTo(12, 9); // tail untouched
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

describe('moveCrossSectionPosition', () => {
  it('moves a real station without changing its index or spline', () => {
    const b = insertCrossSection(makeBoard(), 25)!.board; // 0,25,50,100
    const spline = b.crossSections[1]!.spline;
    const moved = moveCrossSectionPosition(b, 1, 40);

    expect(moved.crossSections.map((section) => section.position)).toEqual([0, 40, 50, 100]);
    expect(moved.crossSections[1]!.spline).toBe(spline);
  });

  it('keeps a dragged station between its neighbours and ignores dummy endpoints', () => {
    const b = insertCrossSection(makeBoard(), 25)!.board;
    const moved = moveCrossSectionPosition(b, 1, 90);

    expect(moved.crossSections[1]!.position).toBeCloseTo(50 - 1e-3, 9);
    expect(moveCrossSectionPosition(b, 0, 10)).toBe(b);
    expect(moveCrossSectionPosition(b, b.crossSections.length - 1, 90)).toBe(b);
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

// ---------------------------------------------------------------------------
// Slices refine the blank: constrainSectionToBlank and the apex
// ---------------------------------------------------------------------------

/**
 * A slice's half-profile, bottom centre → deck centre, inside the apex line x = 20: a
 * corner tuck, an apex whose handles stand upright (so the curve's widest point is the
 * apex itself), a smooth deck-side rail point and the two centre points.
 */
const slice = (tuckNext = vec2(19.5, 1)): Spline =>
  splineFromKnots([
    knot(vec2(0, 0), vec2(-6, 0), vec2(6, 0)),
    knot(vec2(18, 0.5), vec2(15, 0.2), tuckNext, false),
    knot(vec2(20, 2), vec2(20, 1.2), vec2(20, 3)),
    knot(vec2(14, 5), vec2(18, 4.5), vec2(10, 5.5)),
    knot(vec2(0, 6), vec2(6, 6), vec2(-6, 6)),
  ]);
const APEX_X = 20;
const SLICE: SplineTarget = { kind: 'crossSection', index: 1 };

/** Every control point of `s`: each knot's end and both handles. */
const controlPoints = (s: Spline) =>
  s.knots.flatMap((k) => [k.end, k.tangentToPrev, k.tangentToNext]);

/** Whether no control point of `s` reaches further from the stringer than the apex line. */
const insideApex = (s: Spline) => controlPoints(s).every((p) => p.x <= APEX_X);

describe('sectionApexIndex, blankLocks and canDeleteKnot', () => {
  it('finds the widest interior knot, the first from the bottom on a tie', () => {
    expect(sectionApexIndex(slice())).toBe(2);
    expect(sectionApexIndex(moveKnotEnd(slice(), 1, vec2(20, 0.5)))).toBe(1);
    expect(sectionApexIndex(moveKnotEnd(slice(), 3, vec2(20, 5)))).toBe(2);
  });

  it('has no apex without an interior knot', () => {
    const bare = splineFromKnots([
      knot(vec2(0, 0), vec2(0, 0), vec2(10, 0)),
      knot(vec2(0, 6), vec2(10, 6), vec2(0, 6)),
    ]);
    expect(sectionApexIndex(bare)).toBe(-1);
    expect(sectionApexIndex(splineFromKnots([knot(vec2(0, 0), vec2(0, 0), vec2(0, 0))]))).toBe(-1);
  });

  it('fixes both centre points of a slice and the x of its apex, and nothing on the curves', () => {
    const fixed = { x: true, y: true };
    const free = { x: false, y: false };
    expect(blankLocks(SLICE, slice())).toEqual([fixed, free, { x: true, y: false }, free, fixed]);
    for (const kind of ['outline', 'deck', 'bottom'] as const) {
      expect(blankLocks({ kind }, slice())).toBeNull();
    }
  });

  it("refuses to delete a slice's apex, and only a slice's", () => {
    const s = slice();
    expect([0, 1, 2, 3, 4].map((i) => canDeleteKnot(s, i, SLICE))).toEqual([
      false,
      true,
      false,
      true,
      false,
    ]);
    // The same point on a board curve, or with no target given, is an ordinary point.
    expect(canDeleteKnot(s, 2, { kind: 'outline' })).toBe(true);
    expect(canDeleteKnot(s, 2)).toBe(true);
  });

  it('singles out no point when two are tied for widest: either may go, the other holds', () => {
    const boxy = moveKnotEnd(slice(), 1, vec2(APEX_X, 0.5));
    const free = { x: false, y: false };
    expect(blankLocks(SLICE, boxy)!.slice(1, 4)).toEqual([free, free, free]);
    expect([1, 2, 3].map((i) => canDeleteKnot(boxy, i, SLICE))).toEqual([true, true, true]);
    // Once one of them is gone, the other is the apex and stays.
    const left = deleteKnot(boxy, 1);
    expect(canDeleteKnot(left, 1, SLICE)).toBe(false);
    expect(blankLocks(SLICE, left)![1]).toEqual({ x: true, y: false });
  });
});

describe('constrainSectionToBlank', () => {
  it('returns the edit itself when it already sits inside the blank', () => {
    const prev = slice();
    for (const next of [
      moveKnotEnd(prev, 1, vec2(16, 0.4)), // a rail point moved inward
      moveKnotEnd(prev, 2, vec2(20, 2.7)), // the apex moved straight up
      moveKnotTangent(prev, 2, 'next', vec2(20, 4)), // an apex handle lengthened upright
      moveKnotTangent(prev, 0, 'next', vec2(8, 0.4)), // a centre point's handle
      setKnotContinuous(prev, 2, false),
      setKnotLock(prev, 3, true),
      fairKnot(prev, 3),
    ]) {
      expect(constrainSectionToBlank(prev, next)).toBe(next);
    }
  });

  describe('rule 1: the centre points stay put', () => {
    it.each([0, 4])('takes back a move of point %i, handles and all, exactly', (i) => {
      const prev = slice();
      // Decimals that do not survive a round trip through floating point.
      const next = moveKnotEnd(prev, i, vec2(0.1, prev.knots[i]!.end.y + 0.7));
      expect(constrainSectionToBlank(prev, next)).toBe(prev);
    });

    it('keeps the point where it is while its handle moves', () => {
      const prev = slice();
      const next = moveKnotTangent(prev, 4, 'prev', vec2(9, 6.5));
      const out = constrainSectionToBlank(prev, next);
      expect(out.knots[4]!.end).toEqual(prev.knots[4]!.end);
      expect(out.knots[4]!.tangentToPrev).toEqual(vec2(9, 6.5));
    });
  });

  describe('rule 2: the apex moves vertically only', () => {
    it.each([
      ['outward', vec2(26, 2.5)],
      ['inward', vec2(15, 1.5)],
    ])('keeps the height and not the width of a move %s', (_, to) => {
      const prev = slice();
      const out = constrainSectionToBlank(prev, moveKnotEnd(prev, 2, to));
      const apex = out.knots[2]!;
      expect(apex.end).toEqual(vec2(APEX_X, to.y));
      // Its handles come back with it, still upright.
      expect(apex.tangentToPrev.x).toBe(APEX_X);
      expect(apex.tangentToNext.x).toBe(APEX_X);
      expect(apex.tangentToPrev.y).toBeCloseTo(to.y - 0.8, 12);
      expect(apex.tangentToNext.y).toBeCloseTo(to.y + 1, 12);
      // Nothing else moved.
      for (const i of [0, 1, 3, 4]) expect(out.knots[i]).toBe(prev.knots[i]);
    });

    it('treats a purely sideways move as no edit at all', () => {
      const prev = slice();
      expect(constrainSectionToBlank(prev, moveKnotEnd(prev, 2, vec2(23.3, 2)))).toBe(prev);
      expect(constrainSectionToBlank(prev, moveKnotEnd(prev, 2, vec2(17.1, 2)))).toBe(prev);
    });

    describe('with two points tied for widest (a boxy rail)', () => {
      const boxy = () => moveKnotEnd(slice(), 1, vec2(APEX_X, 0.5));

      it.each([1, 2])('lets point %i move in while the other holds the width', (i) => {
        const prev = boxy();
        const next = moveKnotEnd(prev, i, vec2(16, 1.2));
        expect(constrainSectionToBlank(prev, next)).toBe(next);
      });

      it('holds the first from the bottom when an edit moves them both in', () => {
        const prev = boxy();
        const next = moveKnotEnd(moveKnotEnd(prev, 1, vec2(16, 0.6)), 2, vec2(17, 2.1));
        const out = constrainSectionToBlank(prev, next);
        expect(out.knots[1]!.end).toEqual(vec2(APEX_X, 0.6));
        expect(out.knots[2]).toBe(next.knots[2]);
      });
    });
  });

  describe('rule 3: nothing the edit changed reaches past the apex', () => {
    it('stops a point dragged past the apex on the apex line, its handles inside', () => {
      const prev = slice();
      const out = constrainSectionToBlank(prev, moveKnotEnd(prev, 1, vec2(23, 0.8)));
      const tuck = out.knots[1]!;
      expect(tuck.end).toEqual(vec2(APEX_X, 0.8));
      expect(tuck.tangentToPrev.x).toBeCloseTo(17, 12);
      // The outward handle slides back onto the apex line at its own height.
      expect(tuck.tangentToNext).toEqual(vec2(APEX_X, tuck.tangentToNext.y));
      expect(tuck.tangentToNext.y).toBeCloseTo(1.3, 12);
      expect(insideApex(out)).toBe(true);
      expect(sectionApexIndex(out)).toBe(1); // a tie: the first from the bottom

      // The next move of the same drag brings it back in: the apex still holds the width.
      const back = moveKnotEnd(out, 1, vec2(17, 0.6));
      expect(constrainSectionToBlank(out, back)).toBe(back);
    });

    it('slides a free handle onto the apex line and keeps a smooth point smooth', () => {
      const prev = slice();
      const out = constrainSectionToBlank(prev, moveKnotTangent(prev, 3, 'prev', vec2(26, 4)));
      const k = out.knots[3]!;
      expect(k.tangentToPrev).toEqual(vec2(APEX_X, 4));
      const a = vec2(k.tangentToPrev.x - k.end.x, k.tangentToPrev.y - k.end.y);
      const b = vec2(k.tangentToNext.x - k.end.x, k.tangentToNext.y - k.end.y);
      expect(a.x * b.y - a.y * b.x).toBeCloseTo(0, 12); // collinear …
      expect(a.x * b.x + a.y * b.y).toBeLessThan(0); // … and opposite
      expect(Math.hypot(b.x, b.y)).toBeCloseTo(Math.hypot(4, 0.5), 12); // its own length
      expect(insideApex(out)).toBe(true);
    });

    it('shortens a locked handle along its lock to the apex line', () => {
      const prev = setKnotLock(slice(), 3, true);
      const out = constrainSectionToBlank(prev, setKnotTangentLength(prev, 3, 'prev', 10));
      const k = out.knots[3]!;
      expect(k.tangentToPrev.x).toBeCloseTo(APEX_X, 12);
      const lock = k.lock!.prev!;
      const dx = k.tangentToPrev.x - k.end.x;
      const dy = k.tangentToPrev.y - k.end.y;
      expect(dx * lock.y - dy * lock.x).toBeCloseTo(0, 12);
      expect(dx * lock.x + dy * lock.y).toBeGreaterThan(0);
    });

    it('stands the apex handles back upright when they are turned outward', () => {
      const DEG = Math.PI / 180;
      const prev = slice();
      const out = constrainSectionToBlank(prev, rotateKnotTangent(prev, 2, 'both', 10 * DEG));
      const apex = out.knots[2]!;
      expect(apex.end).toEqual(vec2(APEX_X, 2));
      expect(apex.tangentToPrev.x).toBe(APEX_X);
      expect(apex.tangentToNext.x).toBe(APEX_X);
      expect(apex.tangentToNext.y).toBeCloseTo(3, 12); // the inward handle kept its length
    });

    it('takes back an outward push on a smooth apex handle exactly, turning nothing', () => {
      // The pushed handle stands back upright, and its partner turns back to within
      // rounding of where it was: it must land exactly there, or the push would record.
      const prev = slice();
      const next = moveKnotTangent(prev, 2, 'next', vec2(25, 3));
      expect(next.knots[2]!.tangentToPrev).not.toEqual(prev.knots[2]!.tangentToPrev);
      expect(constrainSectionToBlank(prev, next)).toBe(prev);
    });

    describe('an apex locked a fraction past upright', () => {
      // Imported data: the apex's upper handle leans out 0.1 mm, and the point is locked.
      const leaning = () =>
        setKnotLock(
          splineFromKnots([
            ...slice().knots.slice(0, 2),
            knot(vec2(20, 2), vec2(20, 1.2), vec2(20.01, 3), false),
            ...slice().knots.slice(3),
          ]),
          2,
          true,
        );

      it('keeps its handle when it is raised, rather than collapsing it onto the point', () => {
        const prev = leaning();
        const next = moveKnotEnd(prev, 2, vec2(20, 2.5));
        const out = constrainSectionToBlank(prev, next);
        expect(out.knots[2]!.tangentToNext).toEqual(next.knots[2]!.tangentToNext);
        expect(out.knots[2]!.end).toEqual(vec2(APEX_X, 2.5));
      });

      it('lets that handle reach no further out than it did', () => {
        const prev = leaning();
        const out = constrainSectionToBlank(prev, setKnotTangentLength(prev, 2, 'next', 3));
        const h = out.knots[2]!.tangentToNext;
        expect(h.x).toBeCloseTo(20.01, 12);
        expect(h.y).toBeCloseTo(3, 9); // its old length along the same lock
      });
    });

    it('leaves points the edit did not change alone, even ones already past the apex', () => {
      // An imported profile whose tuck handle pokes 5 mm past the apex.
      const prev = slice(vec2(20.5, 1));
      const elsewhere = moveKnotEnd(prev, 3, vec2(13, 5.2));
      expect(constrainSectionToBlank(prev, elsewhere)).toBe(elsewhere);
      expect(elsewhere.knots[1]).toBe(prev.knots[1]);

      // Moving the tuck itself changes that handle, which is then brought in.
      const out = constrainSectionToBlank(prev, moveKnotEnd(prev, 1, vec2(18, 0.7)));
      expect(out.knots[1]!.tangentToNext.x).toBe(APEX_X);
      expect(out.knots[1]!.tangentToNext.y).toBeCloseTo(1.2, 12);
      expect(out.knots[1]!.end).toEqual(vec2(18, 0.7));
    });
  });

  describe('inserts and deletes', () => {
    it('lets a shape-preserving insert inside the apex through untouched', () => {
      const prev = slice();
      const ins = insertKnotAt(prev, value(prev.coeffs[3]!, 0.5))!;
      expect(constrainSectionToBlank(prev, ins.spline)).toBe(ins.spline);
    });

    it('brings an inserted point that would sit past the apex inside it', () => {
      // The tuck handle reaches to x = 23, so the curve bulges past the apex before it.
      const prev = slice(vec2(23, 1));
      const ins = insertKnotAt(prev, value(prev.coeffs[1]!, 0.5))!;
      expect(ins.index).toBe(2);
      expect(ins.spline.knots[2]!.end.x).toBeGreaterThan(APEX_X);
      const out = constrainSectionToBlank(prev, ins.spline);
      expect(out.knots).toHaveLength(6);
      expect(insideApex(out)).toBe(true);
      // The points the insert did not touch are left exactly as they were.
      expect(out.knots[0]).toBe(prev.knots[0]);
      expect(out.knots[4]).toBe(prev.knots[3]);
      expect(out.knots[5]).toBe(prev.knots[4]);
      expect(out.knots[3]!.end).toEqual(prev.knots[2]!.end);
    });

    it('still holds the apex once an insert before it has moved it along', () => {
      const prev = slice();
      const ins = insertKnotAt(prev, value(prev.coeffs[1]!, 0.5))!;
      const out = constrainSectionToBlank(prev, moveKnotEnd(ins.spline, 3, vec2(24, 2.4)));
      expect(out.knots[3]!.end).toEqual(vec2(APEX_X, 2.4));
    });

    it('still holds the apex once a delete before it has moved it back', () => {
      const prev = slice();
      const del = deleteKnot(prev, 1);
      const out = constrainSectionToBlank(prev, moveKnotEnd(del, 1, vec2(25, 2.2)));
      expect(out.knots[1]!.end).toEqual(vec2(APEX_X, 2.2));
      expect(out.knots[0]).toBe(del.knots[0]);
    });

    it('lets a delete inside the apex through untouched', () => {
      const prev = slice();
      const del = deleteKnot(prev, 3);
      expect(insideApex(del)).toBe(true);
      expect(constrainSectionToBlank(prev, del)).toBe(del);
    });
  });
});

// ---------------------------------------------------------------------------
// Junction-constraint spec (legacy parity pinning)
//
// Pins the CURRENT behavior of `enforceJunctions` against the legacy
// BezierBoard.setLocks() constraints documented in
// docs/specs/junction-constraints.md (JC-1..JC-9). Geometry convention: TAIL at
// x=0, NOSE at x=length. These tests assert what the web port DOES; the legacy
// constraints it does NOT yet model are recorded as documented gaps in the spec
// doc, expressed here as the opposite (the port leaves them free), never as
// failing assertions.
// ---------------------------------------------------------------------------
describe('junction-constraint spec (legacy parity pinning)', () => {
  // A board whose junctions are deliberately OPEN so enforceJunctions has work
  // to do: deck/bottom tips disagree, the outline tail sits off the centreline,
  // and the cross-sections start/end off the stringer (x != 0).
  function openBoard(): BezierBoard {
    const outline = splineFromKnots([
      knot(vec2(0, 2), vec2(-5, 2), vec2(5, 2)), // tail at x=0, y=2 (off centreline)
      knot(vec2(100, 3), vec2(95, 3), vec2(105, 3)), // nose at x=100, y=3 (off centreline)
    ]);
    const bottom = splineFromKnots([
      knot(vec2(0, 5), vec2(-5, 5), vec2(5, 5)),
      knot(vec2(100, 6), vec2(95, 6), vec2(105, 6)),
    ]);
    const deck = splineFromKnots([
      knot(vec2(0, 11), vec2(-5, 11), vec2(5, 11)),
      knot(vec2(100, 12), vec2(95, 12), vec2(105, 12)),
    ]);
    // Sections whose first/last endpoints are off the stringer (x = 3 / x = 2).
    const prof = splineFromKnots([
      knot(vec2(3, 5), vec2(3, 5), vec2(10, 5)),
      knot(vec2(2, 8), vec2(10, 6), vec2(2, 8)),
    ]);
    const cs = [crossSection(0, prof), crossSection(50, prof), crossSection(100, prof)];
    return board(outline, bottom, deck, cs);
  }

  // --- JC-5: deck <-> bottom share tail + nose tips (REPRODUCED) -----------
  it('JC-5: deck wins the tip join by default — bottom adopts deck tail+nose endpoints', () => {
    const b = openBoard();
    const out = enforceJunctions(b);
    const last = out.deck.knots.length - 1;
    // bottom endpoints snapped onto the deck's endpoints (deck is the master).
    expect(out.bottom.knots[0]!.end).toEqual(out.deck.knots[0]!.end);
    expect(out.bottom.knots[last]!.end).toEqual(out.deck.knots[last]!.end);
    // deck itself is left untouched when it is the master.
    expect(out.deck.knots[0]!.end).toEqual(b.deck.knots[0]!.end);
    expect(out.deck.knots[last]!.end).toEqual(b.deck.knots[last]!.end);
  });

  it("JC-5: when 'bottom' is the changed curve, bottom wins and deck adopts its tips", () => {
    const b = openBoard();
    const out = enforceJunctions(b, { kind: 'bottom' });
    const last = out.bottom.knots.length - 1;
    expect(out.deck.knots[0]!.end).toEqual(out.bottom.knots[0]!.end);
    expect(out.deck.knots[last]!.end).toEqual(out.bottom.knots[last]!.end);
    expect(out.bottom.knots[0]!.end).toEqual(b.bottom.knots[0]!.end);
  });

  it('JC-5: the tip join translates the adopted curve tangents rigidly (slave-like)', () => {
    const b = openBoard();
    const out = enforceJunctions(b);
    // bottom tail endpoint moved from y=5 to deck y=11 → delta (0, +6); both of
    // its tail handles must translate by the same delta (legacy updateSlave).
    const k0 = out.bottom.knots[0]!;
    expect(k0.tangentToPrev).toEqual(vec2(-5, 11));
    expect(k0.tangentToNext).toEqual(vec2(5, 11));
  });

  // --- JC-4 (x-lock): section centre endpoints snap to stringer (REPRODUCED) -
  it('JC-4 x: every cross-section first/last endpoint is snapped to x = 0', () => {
    const b = openBoard();
    const out = enforceJunctions(b);
    for (const cs of out.crossSections) {
      const last = cs.spline.knots.length - 1;
      expect(cs.spline.knots[0]!.end.x).toBe(0);
      expect(cs.spline.knots[last]!.end.x).toBe(0);
    }
  });

  it('JC-4 x: y of the section centre endpoints is preserved (only x is pinned)', () => {
    const b = openBoard();
    const out = enforceJunctions(b);
    const cs = out.crossSections[1]!.spline;
    const last = cs.knots.length - 1;
    expect(cs.knots[0]!.end.y).toBe(5); // unchanged from prof
    expect(cs.knots[last]!.end.y).toBe(8); // unchanged from prof
  });

  // --- Outline centreline pin: only knots[last] (the nose) is pinned -------
  it('outline: knots[last] (nose, x=length) endpoint is snapped to the centreline y = 0', () => {
    const b = openBoard();
    const out = enforceJunctions(b);
    const last = out.outline.knots.length - 1;
    expect(out.outline.knots[last]!.end).toEqual(vec2(100, 0));
  });

  it('outline: a wide-tail (fish/square) board keeps its tail width while the nose snaps to y=0', () => {
    // tail (x=0) at half-width 9 (a 18 cm-wide tail block); nose (x=length)
    // drifted off the centreline. Only the nose must be corrected.
    const outline = splineFromKnots([
      knot(vec2(0, 9), vec2(-5, 9), vec2(5, 9)),
      knot(vec2(100, 1.5), vec2(95, 1.5), vec2(105, 1.5)),
    ]);
    const b = withSpline(openBoard(), { kind: 'outline' }, outline);
    const out = enforceJunctions(b);
    expect(out.outline.knots[0]!.end).toEqual(vec2(0, 9)); // tail width preserved
    expect(out.outline.knots[1]!.end).toEqual(vec2(100, 0)); // nose on centreline
  });

  it('outline: a point dragged past the centre line is floored at y = 0 (half-width ≥ 0)', () => {
    // An interior outline point dragged to a negative half-width (across the stringer);
    // it must stop at the centre line, carrying its handles up with it.
    const outline = splineFromKnots([
      knot(vec2(0, 6), vec2(-5, 6), vec2(5, 6)),
      knot(vec2(50, -4), vec2(45, -6), vec2(55, -2)), // dragged across the centre line
      knot(vec2(100, 0), vec2(95, 0), vec2(105, 0)),
    ]);
    const b = withSpline(openBoard(), { kind: 'outline' }, outline);
    const out = enforceJunctions(b);
    const k = out.outline.knots[1]!;
    expect(k.end.y).toBe(0); // floored at the centre line
    expect(k.tangentToPrev.y).toBeCloseTo(-2, 9); // handles carried up by +4 (−6 → −2)
    expect(k.tangentToNext.y).toBeCloseTo(2, 9); // (−2 → +2)
  });

  // --- Documented GAPS: legacy constraints the port does NOT yet model -----
  // These assert the port leaves the value FREE (the opposite of the legacy
  // lock). They pin the current gap; see docs/specs/junction-constraints.md
  // "Divergences" for the legacy behavior that is intentionally not ported.

  it('GAP (JC-1): outline tail endpoint (knots[0]) is left free, not pinned to y=0', () => {
    const b = openBoard();
    const out = enforceJunctions(b);
    // legacy JC-1 fully locks BOTH outline tips; the port pins only the nose's y
    // and leaves the tail tip wherever the edit put it (here y = 2, legitimate
    // tail width) — see docs/specs/divergences.md.
    expect(out.outline.knots[0]!.end).toEqual(vec2(0, 2));
  });

  // --- JC-1 / JC-2 / JC-3: endpoint x-masks (REPRODUCED) -------------------
  it('JC-1: the outline tail station is re-locked to x = 0 (y / width preserved)', () => {
    const outline = splineFromKnots([
      knot(vec2(3, 9), vec2(-2, 9), vec2(8, 9)), // tail station drifted to x=3, width 9
      knot(vec2(100, 1), vec2(95, 1), vec2(105, 1)),
    ]);
    const b = withSpline(openBoard(), { kind: 'outline' }, outline);
    const out = enforceJunctions(b);
    expect(out.outline.knots[0]!.end).toEqual(vec2(0, 9)); // x pinned to 0, width kept
  });

  it('JC-2/JC-3: deck/bottom endpoints are x-locked to the board stations {0, length}', () => {
    // The deck nose endpoint drifted to x = 98; the outline (length reference) puts the
    // nose at x = 100, so enforceJunctions re-locks the deck (and, via JC-5, bottom) to 100.
    const outline = splineFromKnots([
      knot(vec2(0, 0), vec2(-5, 0), vec2(5, 0)),
      knot(vec2(100, 0), vec2(95, 0), vec2(105, 0)),
    ]);
    const bottom = splineFromKnots([
      knot(vec2(2, 5), vec2(-3, 5), vec2(7, 5)), // tail station drifted to x=2
      knot(vec2(100, 6), vec2(95, 6), vec2(105, 6)),
    ]);
    const deck = splineFromKnots([
      knot(vec2(0, 11), vec2(-5, 11), vec2(5, 11)),
      knot(vec2(98, 12), vec2(95, 12), vec2(101, 12)), // nose x drifted to 98
    ]);
    const prof = splineFromKnots([
      knot(vec2(0, 5), vec2(0, 5), vec2(10, 5)),
      knot(vec2(0, 8), vec2(10, 6), vec2(0, 8)),
    ]);
    const b = board(outline, bottom, deck, [
      crossSection(0, prof),
      crossSection(50, prof),
      crossSection(100, prof),
    ]);
    const out = enforceJunctions(b);
    const last = out.deck.knots.length - 1;
    // Nose stations re-locked to the board length (100); tail stations to 0.
    expect(out.deck.knots[last]!.end.x).toBe(100);
    expect(out.bottom.knots[last]!.end.x).toBe(100);
    expect(out.deck.knots[0]!.end.x).toBe(0);
    expect(out.bottom.knots[0]!.end.x).toBe(0); // drifted tail x=2 re-locked to 0
  });

  // --- JC-6 / JC-7 / JC-8: tangent-flow locks (REPRODUCED) -----------------
  it('JC-6: a folded outline tangent is clamped so the curve stays single-valued in x', () => {
    // outline knots[0] toNext handle folded to x = -5 (behind its endpoint x=0);
    // legacy JC-6 LOCK_X_MORE clamps it to x = 0 (the handle must point forward, +x).
    const outline = splineFromKnots([
      knot(vec2(0, 0), vec2(-5, 0), vec2(-5, 0)), // toNext folded behind x=0
      knot(vec2(100, 0), vec2(95, 0), vec2(105, 0)),
    ]);
    const b = withSpline(openBoard(), { kind: 'outline' }, outline);
    const out = enforceJunctions(b);
    expect(out.outline.knots[0]!.tangentToNext.x).toBe(0); // clamped forward to the endpoint x
  });

  it('JC-7: outline tip inward handles cannot drop below the tip y (depart outward only)', () => {
    // tail tip at (0,3); its toNext handle dragged below the tip (y=-1). LOCK_Y_MORE
    // raises it back to the tip y so the first segment leaves the tail outward (+y).
    const outline = splineFromKnots([
      knot(vec2(0, 3), vec2(-5, 3), vec2(5, -1)), // toNext.y below the tip
      knot(vec2(100, 0), vec2(95, 5), vec2(105, 0)),
    ]);
    const b = withSpline(openBoard(), { kind: 'outline' }, outline);
    const out = enforceJunctions(b);
    expect(out.outline.knots[0]!.tangentToNext.y).toBe(3); // raised to the tip y
  });

  it('JC-8: a section centre tip handle crossing the stringer is clamped to x ≥ 0', () => {
    // both centre-tip inward handles folded across the stringer (x = -4); LOCK_X_MORE
    // raises them to x = 0 so the rail leaves the centreline toward +x (no mirror cross).
    const prof = splineFromKnots([
      knot(vec2(0, 5), vec2(0, 5), vec2(-4, 5)), // toNext across the stringer
      knot(vec2(0, 8), vec2(-4, 6), vec2(0, 8)), // toPrev across the stringer
    ]);
    const b = withSpline(openBoard(), { kind: 'crossSection', index: 1 }, prof);
    const out = enforceJunctions(b, { kind: 'crossSection', index: 1 });
    const cs = out.crossSections[1]!.spline;
    const last = cs.knots.length - 1;
    expect(cs.knots[0]!.tangentToNext.x).toBe(0);
    expect(cs.knots[last]!.tangentToPrev.x).toBe(0);
  });

  // --- Idempotence: safe to run after every edit and on load --------------
  it('is idempotent — a second pass changes nothing', () => {
    const once = enforceJunctions(openBoard());
    const twice = enforceJunctions(once);
    expect(twice.outline.knots).toEqual(once.outline.knots);
    expect(twice.deck.knots).toEqual(once.deck.knots);
    expect(twice.bottom.knots).toEqual(once.bottom.knots);
    expect(twice.crossSections.map((c) => c.spline.knots)).toEqual(
      once.crossSections.map((c) => c.spline.knots),
    );
  });
});

// ---------------------------------------------------------------------------
// Concave tail (swallow / fish): the outline may fold back in x at the tail.
// enforceJunctions must PRESERVE that fold (not re-snap it single-valued) while
// pinning the rearmost tip — but only the tail region is exempt from JC-6.
// ---------------------------------------------------------------------------

describe('enforceJunctions: concave tail (swallow / fish)', () => {
  const third = (ax: number, ay: number, bx: number, by: number): [number, number] => [
    ax + (bx - ax) / 3,
    ay + (by - ay) / 3,
  ];
  // notch bottom (12,0) → tail tip (0,6, rearmost) → wide (50,15) → nose (100,0).
  const swallow = () =>
    splineFromKnots([
      knot(vec2(12, 0), vec2(12, 0), vec2(...third(12, 0, 0, 6))),
      knot(vec2(0, 6), vec2(...third(0, 6, 12, 0)), vec2(...third(0, 6, 50, 15))),
      knot(vec2(50, 15), vec2(...third(50, 15, 0, 6)), vec2(...third(50, 15, 100, 0))),
      knot(vec2(100, 0), vec2(...third(100, 0, 50, 15)), vec2(100, 0)),
    ]);
  const swallowBoard = () => {
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
    return board(swallow(), bottom, deck, cs);
  };

  it('preserves the tail fold (does not re-snap the outline single-valued)', () => {
    const out = enforceJunctions(swallowBoard());
    expect(hasTailCutout(out.outline)).toBe(true);
    const tipX = Math.min(...out.outline.knots.map((k) => k.end.x));
    const notchBottomX = out.outline.knots[0]!.end.x;
    expect(tipX).toBeLessThan(notchBottomX); // the wall still folds forward of the tip
  });

  it('pins the rearmost (min-x) tip to x=0, leaving the notch bottom forward', () => {
    const out = enforceJunctions(swallowBoard());
    expect(Math.min(...out.outline.knots.map((k) => k.end.x))).toBe(0);
    expect(out.outline.knots[0]!.end.x).toBeGreaterThan(5); // notch bottom keeps its x
  });

  it('is idempotent on a swallow board', () => {
    const once = enforceJunctions(swallowBoard());
    const twice = enforceJunctions(once);
    expect(twice.outline.knots).toEqual(once.outline.knots);
  });

  it('pins the notch bottom (knots[0]) to the centreline y = 0', () => {
    // Drift the notch bottom off the mirror line (y = 3); it must snap back to 0 so
    // the concave closes on the centreline. Its x (notch depth) is preserved.
    const drifted = withSpline(
      swallowBoard(),
      { kind: 'outline' },
      moveKnotEnd(swallow(), 0, vec2(12, 3)),
    );
    const out = enforceJunctions(drifted);
    expect(out.outline.knots[0]!.end.y).toBe(0);
    expect(out.outline.knots[0]!.end.x).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// alignTangentsHorizontal — port of BrdEditCommand.rotateControlPointToHorizontal
// ---------------------------------------------------------------------------

describe('alignTangentsHorizontal', () => {
  // Interior knot with both handles off-axis (not horizontal).
  // end=(50,10), prev=(45,5), next=(55,15) — both diagonal.
  const makeDiagSpline = () =>
    splineFromKnots([
      knot(vec2(0, 0), vec2(-5, 0), vec2(5, 0), true),
      knot(vec2(50, 10), vec2(45, 5), vec2(55, 15), false),
      knot(vec2(100, 0), vec2(95, 0), vec2(105, 0), true),
    ]);

  it('rotates both tangents to horizontal, preserving each handle length', () => {
    const s = makeDiagSpline();
    const k = s.knots[1]!;
    const prevLen = Math.hypot(k.tangentToPrev.x - k.end.x, k.tangentToPrev.y - k.end.y);
    const nextLen = Math.hypot(k.tangentToNext.x - k.end.x, k.tangentToNext.y - k.end.y);
    const out = alignTangentsHorizontal(s, 1);
    const ko = out.knots[1]!;
    // y-coordinates of both handles must equal the endpoint's y
    expect(ko.tangentToPrev.y).toBeCloseTo(k.end.y, 9);
    expect(ko.tangentToNext.y).toBeCloseTo(k.end.y, 9);
    // lengths are preserved
    expect(Math.hypot(ko.tangentToPrev.x - ko.end.x, ko.tangentToPrev.y - ko.end.y)).toBeCloseTo(
      prevLen,
      9,
    );
    expect(Math.hypot(ko.tangentToNext.x - ko.end.x, ko.tangentToNext.y - ko.end.y)).toBeCloseTo(
      nextLen,
      9,
    );
  });

  it('prev handle stays to the left (negative x direction relative to end)', () => {
    const s = makeDiagSpline();
    const out = alignTangentsHorizontal(s, 1);
    const ko = out.knots[1]!;
    // original tangentToPrev.x (45) < end.x (50): prev should stay to the left
    expect(ko.tangentToPrev.x).toBeLessThan(ko.end.x);
  });

  it('next handle stays to the right (positive x direction relative to end)', () => {
    const s = makeDiagSpline();
    const out = alignTangentsHorizontal(s, 1);
    const ko = out.knots[1]!;
    // original tangentToNext.x (55) > end.x (50): next should stay to the right
    expect(ko.tangentToNext.x).toBeGreaterThan(ko.end.x);
  });

  it('when continuous, both handles become collinear (horizontal) through the endpoint', () => {
    const s = splineFromKnots([
      knot(vec2(0, 0), vec2(-5, 0), vec2(5, 0), true),
      knot(vec2(50, 10), vec2(45, 5), vec2(55, 15), true), // continuous
      knot(vec2(100, 0), vec2(95, 0), vec2(105, 0), true),
    ]);
    const out = alignTangentsHorizontal(s, 1);
    const ko = out.knots[1]!;
    expect(ko.tangentToPrev.y).toBeCloseTo(ko.end.y, 9);
    expect(ko.tangentToNext.y).toBeCloseTo(ko.end.y, 9);
    // collinear: sum of x-offsets is 0 (they point in opposite x directions)
    expect(ko.tangentToPrev.x + ko.tangentToNext.x).toBeCloseTo(2 * ko.end.x, 9);
  });

  it('leaves other knots unchanged', () => {
    const s = makeDiagSpline();
    const out = alignTangentsHorizontal(s, 1);
    expect(out.knots[0]).toEqual(s.knots[0]);
    expect(out.knots[2]).toEqual(s.knots[2]);
  });

  it('returns a new spline instance (immutability)', () => {
    const s = makeDiagSpline();
    expect(alignTangentsHorizontal(s, 1)).not.toBe(s);
  });
});

// ---------------------------------------------------------------------------
// alignTangentsVertical — port of BrdEditCommand.rotateControlPointToVertical
// ---------------------------------------------------------------------------

describe('alignTangentsVertical', () => {
  // Interior knot with diagonal handles: end=(50,10), prev=(45,5), next=(55,15)
  const makeDiagSpline = () =>
    splineFromKnots([
      knot(vec2(0, 0), vec2(-5, 0), vec2(5, 0), true),
      knot(vec2(50, 10), vec2(45, 5), vec2(55, 15), false),
      knot(vec2(100, 0), vec2(95, 0), vec2(105, 0), true),
    ]);

  it('rotates both tangents to vertical, preserving each handle length', () => {
    const s = makeDiagSpline();
    const k = s.knots[1]!;
    const prevLen = Math.hypot(k.tangentToPrev.x - k.end.x, k.tangentToPrev.y - k.end.y);
    const nextLen = Math.hypot(k.tangentToNext.x - k.end.x, k.tangentToNext.y - k.end.y);
    const out = alignTangentsVertical(s, 1);
    const ko = out.knots[1]!;
    // x-coordinates of both handles must equal the endpoint's x
    expect(ko.tangentToPrev.x).toBeCloseTo(k.end.x, 9);
    expect(ko.tangentToNext.x).toBeCloseTo(k.end.x, 9);
    // lengths are preserved
    expect(Math.hypot(ko.tangentToPrev.x - ko.end.x, ko.tangentToPrev.y - ko.end.y)).toBeCloseTo(
      prevLen,
      9,
    );
    expect(Math.hypot(ko.tangentToNext.x - ko.end.x, ko.tangentToNext.y - ko.end.y)).toBeCloseTo(
      nextLen,
      9,
    );
  });

  it('prev handle direction on Y axis is preserved (sign)', () => {
    const s = makeDiagSpline();
    // tangentToPrev.y (5) < end.y (10): prev is below end, so aligned it points below
    const out = alignTangentsVertical(s, 1);
    const ko = out.knots[1]!;
    expect(ko.tangentToPrev.y).toBeLessThan(ko.end.y);
  });

  it('next handle direction on Y axis is preserved (sign)', () => {
    const s = makeDiagSpline();
    // tangentToNext.y (15) > end.y (10): next is above end, so aligned it points above
    const out = alignTangentsVertical(s, 1);
    const ko = out.knots[1]!;
    expect(ko.tangentToNext.y).toBeGreaterThan(ko.end.y);
  });

  it('when continuous, both handles become collinear (vertical) through the endpoint', () => {
    const s = splineFromKnots([
      knot(vec2(0, 0), vec2(-5, 0), vec2(5, 0), true),
      knot(vec2(50, 10), vec2(45, 5), vec2(55, 15), true), // continuous
      knot(vec2(100, 0), vec2(95, 0), vec2(105, 0), true),
    ]);
    const out = alignTangentsVertical(s, 1);
    const ko = out.knots[1]!;
    expect(ko.tangentToPrev.x).toBeCloseTo(ko.end.x, 9);
    expect(ko.tangentToNext.x).toBeCloseTo(ko.end.x, 9);
    // collinear vertical: sum of y-offsets is 0
    expect(ko.tangentToPrev.y + ko.tangentToNext.y).toBeCloseTo(2 * ko.end.y, 9);
  });

  it('leaves other knots unchanged', () => {
    const s = makeDiagSpline();
    const out = alignTangentsVertical(s, 1);
    expect(out.knots[0]).toEqual(s.knots[0]);
    expect(out.knots[2]).toEqual(s.knots[2]);
  });

  it('returns a new spline instance (immutability)', () => {
    const s = makeDiagSpline();
    expect(alignTangentsVertical(s, 1)).not.toBe(s);
  });
});

describe('setFinFromPlanPoint', () => {
  it('measures a dragged fin from the tail at x=0, even when the nose is the wider end', () => {
    // A longboard-style round nose, wider at its tip than the tail is at its own: the
    // shape that used to make the drag read its distance from the nose end instead.
    const wideNose = withSpline(
      makeBoard(),
      { kind: 'outline' },
      splineFromKnots([
        knot(vec2(0, 9), vec2(-5, 9), vec2(10, 10), true),
        knot(vec2(50, 16), vec2(35, 16), vec2(65, 16), true),
        knot(vec2(100, 10), vec2(90, 11), vec2(105, 10), true),
      ]),
    );
    expect(getWidthAtPos(wideNose, 5)).toBeLessThan(getWidthAtPos(wideNose, 95));
    const b = withFins(wideNose, defaultFinConfig('single', 'futures'));

    const moved = setFinFromPlanPoint(b, 0, vec2(30, 0));

    const spec = moved.fins.fins[0]!;
    expect(spec.trailingFromTail).toBeCloseTo(30 - spec.base / 2, 9);
    // The round trip a user sees: the fin resolves where it was dropped.
    expect(resolveFins(moved)[0]!.center.x).toBeCloseTo(30, 9);
  });
});
