import { describe, expect, it } from 'vitest';
import {
  board,
  crossSection,
  knot,
  splineFromKnots,
  valueAt,
  vec2,
  type BezierBoard,
} from '@openshaper/kernel';
import { createBoardStore } from './board-store';
import { canDeleteKnot, moveKnotTangent } from './edits';
import { selectSpecs } from './selectors';

// A small but valid board: outline (half-width), flat-ish bottom & deck.
const makeBoard = (): BezierBoard => {
  const k = (ex: number, ey: number) => knot(vec2(ex, ey), vec2(ex - 5, ey), vec2(ex + 5, ey));
  const outline = splineFromKnots([k(0, 0), k(50, 20), k(100, 0)]);
  const bottom = splineFromKnots([k(0, 5), k(100, 5)]);
  const deck = splineFromKnots([k(0, 11), k(100, 11)]);
  // three cross-sections (nose dummy, middle, tail dummy) so volume is computable
  const prof = splineFromKnots([
    knot(vec2(0, 5), vec2(0, 5), vec2(10, 5)),
    knot(vec2(10, 8), vec2(10, 6), vec2(10, 8)),
  ]);
  const cs = [crossSection(0, prof), crossSection(50, prof), crossSection(100, prof)];
  return board(outline, bottom, deck, cs);
};

describe('board store: editing + undo/redo', () => {
  it('moves a control point and records undo history', () => {
    const store = createBoardStore();
    const original = makeBoard();
    store.getState().load(original);

    const before = selectSpecs(store.getState().board!).maxWidth;
    store.getState().moveControlPoint({ kind: 'outline' }, 1, vec2(50, 30));
    const after = selectSpecs(store.getState().board!).maxWidth;

    expect(after).toBeGreaterThan(before);
    expect(store.getState().canUndo()).toBe(true);
    expect(store.getState().board).not.toBe(original);
  });

  it('undo restores the exact previous board, redo re-applies', () => {
    const store = createBoardStore();
    store.getState().load(makeBoard());
    // The canonical board is the junction-normalized one stored after load.
    const original = store.getState().board;

    store.getState().moveControlPoint({ kind: 'outline' }, 1, vec2(50, 30));
    const edited = store.getState().board;

    store.getState().undo();
    expect(store.getState().board).toBe(original);
    expect(store.getState().canRedo()).toBe(true);

    store.getState().redo();
    expect(store.getState().board).toBe(edited);
  });

  it('coalesces a drag (beginEdit..endEdit) into a single undo step', () => {
    const store = createBoardStore();
    store.getState().load(makeBoard());
    const original = store.getState().board;

    store.getState().beginEdit();
    store.getState().moveControlPoint({ kind: 'outline' }, 1, vec2(50, 25));
    store.getState().moveControlPoint({ kind: 'outline' }, 1, vec2(50, 28));
    store.getState().moveControlPoint({ kind: 'outline' }, 1, vec2(50, 31));
    store.getState().endEdit();

    expect(store.getState().past).toHaveLength(1);
    store.getState().undo();
    expect(store.getState().board).toBe(original);
  });
});

describe('board store: add / delete control points', () => {
  it('inserts a control point on the outline, preserving the curve shape', () => {
    const store = createBoardStore();
    store.getState().load(makeBoard());
    const outline = store.getState().board!.outline;
    const before = [10, 25, 40].map((x) => valueAt(outline, x));

    // Query a point sitting exactly on the outline near x=25.
    const onCurve = vec2(25, valueAt(outline, 25));
    store.getState().addControlPoint({ kind: 'outline' }, onCurve);

    const edited = store.getState().board!.outline;
    expect(edited.knots).toHaveLength(outline.knots.length + 1);
    // de Casteljau split is shape-preserving: sampled y must be unchanged.
    [10, 25, 40].forEach((x, i) => expect(valueAt(edited, x)).toBeCloseTo(before[i]!, 6));

    // The new knot is selected, and the edit is undoable back to the original.
    const sel = store.getState().selection!;
    expect(sel.target).toEqual({ kind: 'outline' });
    expect(sel.index).toBeGreaterThan(0);
    expect(store.getState().canUndo()).toBe(true);
  });

  it('deletes an interior control point and keeps the endpoints', () => {
    const store = createBoardStore();
    store.getState().load(makeBoard());
    const original = store.getState().board!;
    store.getState().select({ target: { kind: 'outline' }, index: 1 });

    store.getState().deleteControlPoint({ kind: 'outline' }, 1);
    const edited = store.getState().board!.outline;

    expect(edited.knots).toHaveLength(2);
    expect(edited.knots[0]!.end).toEqual(original.outline.knots[0]!.end);
    expect(edited.knots[1]!.end).toEqual(original.outline.knots[2]!.end);
    expect(store.getState().selection).toBeNull();

    store.getState().undo();
    expect(store.getState().board).toBe(original);
  });

  it('refuses to delete endpoints (no-op, no history)', () => {
    const store = createBoardStore();
    store.getState().load(makeBoard());
    const original = store.getState().board;

    store.getState().deleteControlPoint({ kind: 'outline' }, 0); // first
    store.getState().deleteControlPoint({ kind: 'outline' }, 2); // last

    expect(store.getState().board).toBe(original);
    expect(store.getState().canUndo()).toBe(false);
  });

  it('canDeleteKnot only allows interior points of a multi-segment spline', () => {
    const s = makeBoard().outline; // 3 knots
    expect(canDeleteKnot(s, 0)).toBe(false);
    expect(canDeleteKnot(s, 1)).toBe(true);
    expect(canDeleteKnot(s, 2)).toBe(false);
  });

  it('toggles a control point between smooth and corner (undoable)', () => {
    const store = createBoardStore();
    store.getState().load(makeBoard());
    expect(store.getState().board!.outline.knots[1]!.continuous).toBe(true);

    store.getState().setContinuous({ kind: 'outline' }, 1, false);
    expect(store.getState().board!.outline.knots[1]!.continuous).toBe(false);

    store.getState().undo();
    expect(store.getState().board!.outline.knots[1]!.continuous).toBe(true);
  });
});

describe('edits: continuous tangent mirroring', () => {
  it('keeps the opposite handle collinear through the endpoint', () => {
    const s = splineFromKnots([
      knot(vec2(0, 0), vec2(-1, 0), vec2(1, 0), true),
      knot(vec2(10, 0), vec2(9, 0), vec2(11, 0), true),
    ]);
    const moved = moveKnotTangent(s, 0, 'next', vec2(0, 2)); // pull next handle straight up
    const k = moved.knots[0]!;
    // prev should mirror to (0,-1): opposite direction, original length 1 preserved.
    expect(k.tangentToPrev.x).toBeCloseTo(0, 9);
    expect(k.tangentToPrev.y).toBeCloseTo(-1, 9);
  });
});
