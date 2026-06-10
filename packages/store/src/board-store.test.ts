import { describe, expect, it } from 'vitest';
import {
  board,
  crossSection,
  csCenterThickness,
  csWidth,
  getDeckAtPos,
  getLength,
  getLengthOverCurve,
  getRockerAtPos,
  getThicknessAtPos,
  getWidthAtPos,
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

describe('board store: history labels + jumpTo', () => {
  it('labels each committed action', () => {
    const store = createBoardStore();
    store.getState().load(makeBoard());

    store.getState().moveControlPoint({ kind: 'outline' }, 1, vec2(50, 30));
    store.getState().scaleBoard(1.1, 1, 1);

    expect(store.getState().past.map((e) => e.label)).toEqual([
      'Move control point',
      'Resize board',
    ]);
  });

  it('a coalesced drag is one entry labelled by its edit', () => {
    const store = createBoardStore();
    store.getState().load(makeBoard());

    store.getState().beginEdit();
    store.getState().moveControlPoint({ kind: 'outline' }, 1, vec2(50, 25));
    store.getState().moveControlPoint({ kind: 'outline' }, 1, vec2(50, 31));
    store.getState().endEdit();

    expect(store.getState().past).toHaveLength(1);
    expect(store.getState().past[0]!.label).toBe('Move control point');
  });

  it('undo carries the label onto the redo stack', () => {
    const store = createBoardStore();
    store.getState().load(makeBoard());

    store.getState().moveControlPoint({ kind: 'outline' }, 1, vec2(50, 30));
    store.getState().undo();

    expect(store.getState().past).toHaveLength(0);
    expect(store.getState().future[0]!.label).toBe('Move control point');
  });

  it('jumpTo restores a past state and fills the redo stack in order', () => {
    const store = createBoardStore();
    store.getState().load(makeBoard());
    const s0 = store.getState().board!;

    store.getState().moveControlPoint({ kind: 'outline' }, 1, vec2(50, 30));
    const b1 = store.getState().board!;
    store.getState().scaleBoard(1.1, 1, 1);
    const b2 = store.getState().board!;
    store.getState().setInterpolationType('sLinear');
    const b3 = store.getState().board!;

    store.getState().jumpTo(0);

    expect(store.getState().board).toBe(s0);
    expect(store.getState().past).toHaveLength(0);
    expect(store.getState().future.map((e) => e.board)).toEqual([b1, b2, b3]);
    expect(store.getState().future.map((e) => e.label)).toEqual([
      'Move control point',
      'Resize board',
      'Change interpolation',
    ]);

    // Redo walks forward through exactly the jumped-over states.
    store.getState().redo();
    store.getState().redo();
    store.getState().redo();
    expect(store.getState().board).toBe(b3);
    expect(store.getState().past.map((e) => e.label)).toEqual([
      'Move control point',
      'Resize board',
      'Change interpolation',
    ]);
  });

  it('jumpTo out of range is a no-op', () => {
    const store = createBoardStore();
    store.getState().load(makeBoard());
    store.getState().moveControlPoint({ kind: 'outline' }, 1, vec2(50, 30));
    const cur = store.getState().board;

    store.getState().jumpTo(5);
    store.getState().jumpTo(-1);

    expect(store.getState().board).toBe(cur);
    expect(store.getState().past).toHaveLength(1);
  });
});

describe('board store: curve coupling (rocker/outline → cross-sections)', () => {
  // 3-knot bottom/deck so the mid station can be driven without nose/tail tip joins
  // interfering. Mid: width 40 (outline y=20), thickness 6 (deck 9 − bottom 3).
  const makeCoupledBoard = (): BezierBoard => {
    const k = (ex: number, ey: number) => knot(vec2(ex, ey), vec2(ex - 5, ey), vec2(ex + 5, ey));
    const outline = splineFromKnots([k(0, 0), k(50, 20), k(100, 0)]);
    const bottom = splineFromKnots([k(0, 2), k(50, 3), k(100, 2)]);
    const deck = splineFromKnots([k(0, 8), k(50, 9), k(100, 8)]);
    // profile thickness 3 (5→8), width 20 (maxX 10) — deliberately off, so slaving resizes it.
    const prof = splineFromKnots([
      knot(vec2(0, 5), vec2(0, 5), vec2(10, 5)),
      knot(vec2(10, 8), vec2(10, 6), vec2(10, 8)),
    ]);
    const cs = [crossSection(0, prof), crossSection(50, prof), crossSection(100, prof)];
    return board(outline, bottom, deck, cs);
  };

  it('slaves the interior station to thickness & width on load', () => {
    const store = createBoardStore();
    store.getState().load(makeCoupledBoard());
    const b = store.getState().board!;
    const mid = b.crossSections[1]!;
    expect(csCenterThickness(mid)).toBeCloseTo(getThicknessAtPos(b, 50), 6);
    expect(csWidth(mid)).toBeCloseTo(getWidthAtPos(b, 50), 6);
  });

  it('grows the interior station when the deck is raised in the rocker editor', () => {
    const store = createBoardStore();
    store.getState().load(makeCoupledBoard());
    const before = csCenterThickness(store.getState().board!.crossSections[1]!);

    // Raise the deck's middle control point (rocker editor edits the deck spline).
    store.getState().moveControlPoint({ kind: 'deck' }, 1, vec2(50, 15));

    const b = store.getState().board!;
    const mid = b.crossSections[1]!;
    expect(csCenterThickness(mid)).toBeCloseTo(getThicknessAtPos(b, 50), 6);
    expect(csCenterThickness(mid)).toBeGreaterThan(before);
  });

  it('widens the interior station when the outline is widened', () => {
    const store = createBoardStore();
    store.getState().load(makeCoupledBoard());
    const before = csWidth(store.getState().board!.crossSections[1]!);

    store.getState().moveControlPoint({ kind: 'outline' }, 1, vec2(50, 30));

    const b = store.getState().board!;
    const mid = b.crossSections[1]!;
    expect(csWidth(mid)).toBeCloseTo(getWidthAtPos(b, 50), 6);
    expect(csWidth(mid)).toBeGreaterThan(before);
  });

  it('drives the deck two-way when the section centerline is dragged (no snap-back)', () => {
    const store = createBoardStore();
    store.getState().load(makeCoupledBoard());
    const target = { kind: 'crossSection', index: 1 } as const;
    const beforeThk = getThicknessAtPos(store.getState().board!, 50);
    const knots = store.getState().board!.crossSections[1]!.spline.knots;
    const last = knots.length - 1; // last knot = deck-center driver
    const deckCenter = knots[last]!.end;

    // Drag the deck-center up (keep its x so width is unaffected).
    store.getState().moveControlPoint(target, last, vec2(deckCenter.x, deckCenter.y + 3));

    const b = store.getState().board!;
    // The deck rose: thickness increased (propagated) instead of snapping back, and the
    // section stays consistent with the curve.
    expect(getThicknessAtPos(b, 50)).toBeGreaterThan(beforeThk + 2);
    expect(csCenterThickness(b.crossSections[1]!)).toBeCloseTo(getThicknessAtPos(b, 50), 4);
  });

  it('undoes a section-driven deck change in one step', () => {
    const store = createBoardStore();
    store.getState().load(makeCoupledBoard());
    const original = store.getState().board!;
    const beforeDeck = getDeckAtPos(original, 50);
    const knots = original.crossSections[1]!.spline.knots;
    const last = knots.length - 1;
    const dc = knots[last]!.end;

    store
      .getState()
      .moveControlPoint({ kind: 'crossSection', index: 1 }, last, vec2(dc.x, dc.y + 3));
    expect(getDeckAtPos(store.getState().board!, 50)).toBeGreaterThan(beforeDeck + 2);

    // One undo restores the whole board — section AND the propagated deck together.
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

// Pins the nose/tail station readouts to the legacy BoardSpec convention: the
// axis runs tail (x=0) → nose (x=length), measurements are taken one/two feet in
// from each tip (FOOT = 30.48 cm), and the kernel getters (golden-pinned in the
// kernel package) are wired to the right end. Guards against the easy regressions:
// swapped nose/tail, wrong foot constant, baseline subtraction creeping in.
describe('selectors: nose/tail station readouts', () => {
  const FOOT = 30.48;

  it('wires every station field to the correct end and offset', () => {
    const b = makeBoard(); // length 100 → 24" stations (60.96 cm) are in range
    const len = getLength(b);
    const specs = selectSpecs(b);

    expect(specs.noseWidth).toBeCloseTo(getWidthAtPos(b, len - FOOT), 6);
    expect(specs.tailWidth).toBeCloseTo(getWidthAtPos(b, FOOT), 6);
    expect(specs.noseThickness).toBeCloseTo(getThicknessAtPos(b, len - FOOT), 6);
    expect(specs.tailThickness).toBeCloseTo(getThicknessAtPos(b, FOOT), 6);

    // Rocker tips are sampled a hair inside the end (legacy 0.005 / 0.001 epsilons).
    expect(specs.noseRocker).toBeCloseTo(getRockerAtPos(b, len - 0.005), 6);
    expect(specs.tailRocker).toBeCloseTo(getRockerAtPos(b, 0.001), 6);
    expect(specs.noseRocker1).toBeCloseTo(getRockerAtPos(b, len - FOOT), 6);
    expect(specs.tailRocker1).toBeCloseTo(getRockerAtPos(b, FOOT), 6);
    expect(specs.noseRocker2).toBeCloseTo(getRockerAtPos(b, len - 2 * FOOT), 6);
    expect(specs.tailRocker2).toBeCloseTo(getRockerAtPos(b, 2 * FOOT), 6);

    expect(specs.lengthOverCurve).toBeCloseTo(getLengthOverCurve(b), 6);
  });

  it('memoizes by board identity (station reads are O(1) but ride the cache)', () => {
    const b = makeBoard();
    expect(selectSpecs(b)).toBe(selectSpecs(b));
  });
});
