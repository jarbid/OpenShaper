import { describe, expect, it } from 'vitest';
import {
  board,
  crossSection,
  csCenterThickness,
  csWidth,
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
  type Vec2,
} from '@openshaper/kernel';
import { createBoardStore } from './board-store';
import { canDeleteKnot, moveKnotTangent, sectionApexIndex } from './edits';
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
  it('keeps the same history array across the moves of one drag', () => {
    const store = createBoardStore();
    store.getState().load(makeBoard());
    store.getState().beginEdit();
    store.getState().moveControlPoint({ kind: 'outline' }, 1, vec2(50, 21));
    const past = store.getState().past;
    expect(past.map((h) => h.label)).toEqual(['Move control point']);
    store.getState().moveControlPoint({ kind: 'outline' }, 1, vec2(50, 22));
    store.getState().moveControlPoint({ kind: 'outline' }, 1, vec2(50, 23));
    expect(store.getState().past).toBe(past);
    store.getState().endEdit();
  });

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
  it('coalesces a cross-section drag into one undoable move', () => {
    const store = createBoardStore();
    store.getState().load(makeBoard());

    store.getState().beginEdit('Move cross-section');
    store.getState().moveCrossSection(1, 40);
    store.getState().moveCrossSection(1, 35);
    store.getState().endEdit();

    expect(store.getState().board!.crossSections[1]!.position).toBe(35);
    expect(store.getState().past).toHaveLength(1);
    expect(store.getState().past[0]!.label).toBe('Move cross-section');
    store.getState().undo();
    expect(store.getState().board!.crossSections[1]!.position).toBe(50);
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
});

describe('board store: slices refine the blank', () => {
  // Mid station x = 50: outline half-width 20 (width 40), bottom 3, deck 9 (thickness 6).
  // The slice already matches them — apex at x = 20 with upright handles, centre points 6
  // apart — so the commit-time rescale has nothing to correct and every change below is
  // the blank rule's own doing.
  const blankBoard = (): BezierBoard => {
    const k = (ex: number, ey: number) => knot(vec2(ex, ey), vec2(ex - 5, ey), vec2(ex + 5, ey));
    const outline = splineFromKnots([k(0, 0), k(50, 20), k(100, 0)]);
    const bottom = splineFromKnots([k(0, 2), k(50, 3), k(100, 2)]);
    const deck = splineFromKnots([k(0, 8), k(50, 9), k(100, 8)]);
    const prof = splineFromKnots([
      knot(vec2(0, 0), vec2(-6, 0), vec2(6, 0)),
      knot(vec2(18, 0.5), vec2(15, 0.2), vec2(19.5, 1), false),
      knot(vec2(20, 2), vec2(20, 1.2), vec2(20, 3)),
      knot(vec2(14, 5), vec2(18, 4.5), vec2(10, 5.5)),
      knot(vec2(0, 6), vec2(6, 6), vec2(-6, 6)),
    ]);
    const cs = [crossSection(0, prof), crossSection(50, prof), crossSection(100, prof)];
    return board(outline, bottom, deck, cs);
  };
  const SLICE = { kind: 'crossSection', index: 1 } as const;
  const DEG = Math.PI / 180;

  type Store = ReturnType<typeof createBoardStore>;
  const slice = (store: Store) => store.getState().board!.crossSections[1]!.spline;

  describe.each([true, false])('with "Resize cross-sections" %s', (adjust) => {
    const setup = () => {
      const store = createBoardStore();
      store.getState().setAdjustThickness(adjust);
      store.getState().load(blankBoard());
      return store;
    };

    /** Run `edit` as one drag; the outline, rocker and deck must come out untouched. */
    const expectBlankKept = (edit: (store: Store) => void) => {
      const store = setup();
      const before = store.getState().board!;
      const width = csWidth(before.crossSections[1]!);
      store.getState().beginEdit();
      edit(store);
      store.getState().endEdit();
      const after = store.getState().board!;
      expect(after.outline).toBe(before.outline);
      expect(after.bottom).toBe(before.bottom);
      expect(after.deck).toBe(before.deck);
      expect(csWidth(after.crossSections[1]!)).toBe(width);
      return store;
    };

    it('loads the slice as it is: it already fits the blank', () => {
      const store = setup();
      expect(slice(store).knots).toEqual(blankBoard().crossSections[1]!.spline.knots);
      expect(csWidth(store.getState().board!.crossSections[1]!)).toBe(40);
    });

    it.each([
      ['outward', [vec2(23, 2.2), vec2(27, 2.5)]],
      ['inward', [vec2(17, 2.2), vec2(12, 3)]],
    ])('drags the apex %s: it only rises or falls', (_, moves) => {
      const store = expectBlankKept((s) => {
        for (const to of moves) s.getState().moveControlPoint(SLICE, 2, to);
      });
      expect(slice(store).knots[2]!.end).toEqual(vec2(20, moves.at(-1)!.y));
    });

    it.each([0, 4])('will not drag centre point %i, and records no step for trying', (i) => {
      const store = setup();
      const before = store.getState().board;
      const at = slice(store).knots[i]!.end;
      store.getState().moveControlPoint(SLICE, i, vec2(at.x + 1, at.y - 2));
      expect(store.getState().board).toBe(before);
      expect(store.getState().past).toHaveLength(0);
      expectBlankKept((s) => s.getState().moveControlPoint(SLICE, i, vec2(3, at.y + 1.5)));
    });

    it('leaves no undo step, and keeps redo, after a drag the blank refused throughout', () => {
      const store = setup();
      store.getState().moveControlPoint(SLICE, 3, vec2(13, 5));
      store.getState().undo();
      const before = store.getState().board;
      store.getState().beginEdit();
      for (const y of [6.5, 7, 8]) store.getState().moveControlPoint(SLICE, 4, vec2(0, y));
      store.getState().endEdit();
      expect(store.getState().board).toBe(before);
      expect(store.getState().past).toHaveLength(0);
      expect(store.getState().future.map((h) => h.label)).toEqual(['Move control point']);
    });

    it('pushes a rail point out against the apex and brings it back in, in one drag', () => {
      const store = expectBlankKept((s) => {
        s.getState().moveControlPoint(SLICE, 1, vec2(23, 0.8));
        expect(slice(s).knots[1]!.end).toEqual(vec2(20, 0.8));
        s.getState().moveControlPoint(SLICE, 1, vec2(16, 0.6));
      });
      expect(slice(store).knots[1]!.end).toEqual(vec2(16, 0.6));
      expect(slice(store).knots[2]!.end).toEqual(vec2(20, 2));
      expect(store.getState().past).toHaveLength(1);
    });

    it('keeps a dragged handle inside the apex', () => {
      const store = expectBlankKept((s) => {
        s.getState().moveTangent(SLICE, 3, 'prev', vec2(22, 4.2));
        s.getState().moveTangent(SLICE, 3, 'prev', vec2(26, 4));
      });
      expect(slice(store).knots[3]!.tangentToPrev).toEqual(vec2(20, 4));
    });

    it('takes a Tunni drag on the rail', () => {
      const store = expectBlankKept((s) => {
        // Both handles of the apex → rail segment, pulled out half again along themselves.
        const rail = slice(s).knots[3]!.tangentToPrev;
        const out = vec2(14 + (rail.x - 14) * 1.5, 5 + (rail.y - 5) * 1.5);
        s.getState().moveSegmentTangents(SLICE, 2, vec2(20, 3.5), out);
      });
      expect(slice(store).knots[2]!.end).toEqual(vec2(20, 2));
      expect(slice(store).knots[2]!.tangentToNext).toEqual(vec2(20, 3.5));
      expect(slice(store).knots[3]!.tangentToPrev).toEqual(vec2(20, 4.25));
    });

    it('fairs the apex and its neighbours without moving the blank', () => {
      const store = expectBlankKept((s) => {
        s.getState().fairControlPoint(SLICE, 1);
        s.getState().fairControlPoint(SLICE, 2);
        s.getState().fairControlPoint(SLICE, 3);
      });
      const apex = slice(store).knots[2]!;
      expect(apex.end).toEqual(vec2(20, 2));
      expect(apex.tangentToPrev.x).toBe(20);
      expect(apex.tangentToNext.x).toBe(20);
    });

    it('will not turn the upright handles of a smooth apex', () => {
      const store = setup();
      const before = store.getState().board;
      store.getState().rotateTangent(SLICE, 2, 'both', 5 * DEG);
      store.getState().rotateTangent(SLICE, 2, 'next', -5 * DEG);
      expect(store.getState().board).toBe(before);
      expect(store.getState().past).toHaveLength(0);
    });

    it('records nothing for a push straight out on a smooth apex handle', () => {
      // ArrowRight on the apex's upper handle: the blank takes all of it back.
      const store = setup();
      const before = store.getState().board;
      for (let i = 0; i < 3; i++) store.getState().moveTangent(SLICE, 2, 'next', vec2(25, 3));
      expect(store.getState().board).toBe(before);
      expect(store.getState().past).toHaveLength(0);
    });

    describe("a handle length edit keeps the handle's angle", () => {
      const angle = (h: Vec2, at: Vec2) => Math.atan2(h.y - at.y, h.x - at.x);

      it('stops a typed length where the handle meets the apex line', () => {
        const store = setup();
        const was = slice(store).knots[3]!;
        store.getState().setTangentLength(SLICE, 3, 'prev', 10);
        const k = slice(store).knots[3]!;
        expect(k.tangentToPrev.x).toBe(20);
        expect(angle(k.tangentToPrev, k.end)).toBeCloseTo(angle(was.tangentToPrev, was.end), 12);
        expect(angle(k.tangentToNext, k.end)).toBeCloseTo(angle(was.tangentToNext, was.end), 12);
        expect(store.getState().past.map((h) => h.label)).toEqual(['Set handle length']);
      });

      it('stops hold-T nudges on the line, and then records nothing', () => {
        const store = setup();
        const was = slice(store).knots[1]!; // the tuck: (18, 0.5) → (19.5, 1)
        // It reaches the line, 2.11 long, on the second press …
        for (let i = 0; i < 2; i++) store.getState().stepTangentLength(SLICE, 1, 'next', 0.5);
        const k = slice(store).knots[1]!;
        expect(k.tangentToNext.x).toBe(20);
        expect(angle(k.tangentToNext, k.end)).toBeCloseTo(angle(was.tangentToNext, was.end), 12);
        // … and stays there, without a step per press.
        const at = store.getState().board;
        for (let i = 0; i < 4; i++) store.getState().stepTangentLength(SLICE, 1, 'next', 0.5);
        expect(store.getState().board).toBe(at);
        expect(store.getState().past).toHaveLength(2);
      });
    });

    it('will not lay the apex handles flat, which would collapse one, but aligns others', () => {
      const store = setup();
      const before = store.getState().board;
      store.getState().alignTangentsHorizontal(SLICE, 2);
      expect(store.getState().board).toBe(before);
      expect(store.getState().past).toHaveLength(0);
      store.getState().alignTangentsHorizontal(SLICE, 3);
      expect(slice(store).knots[3]!.tangentToPrev.y).toBe(5);
    });

    it('will not delete the apex, but deletes another rail point', () => {
      const store = setup();
      const before = store.getState().board;
      store.getState().deleteControlPoint(SLICE, 2);
      expect(store.getState().board).toBe(before);
      expect(store.getState().past).toHaveLength(0);
      expectBlankKept((s) => s.getState().deleteControlPoint(SLICE, 3));
    });

    it.each(['60-40-tucked', '80-20-hard', 'egg'] as const)(
      'restyles the rail with %s inside the blank, and then holds the new apex',
      (preset) => {
        const before = slice(setup());
        const store = expectBlankKept((s) => s.getState().applyRailPreset(1, preset));
        const after = slice(store);
        expect(after).not.toBe(before);
        // The preset keeps the centre points and puts its apex on the old one's line …
        expect(after.knots[0]!.end).toEqual(before.knots[0]!.end);
        expect(after.knots.at(-1)!.end).toEqual(before.knots.at(-1)!.end);
        const apex = sectionApexIndex(after);
        expect(after.knots[apex]!.end.x).toBe(20);
        for (const k of after.knots) {
          for (const p of [k.end, k.tangentToPrev, k.tangentToNext])
            expect(p.x).toBeLessThanOrEqual(20);
        }
        // … which then moves only up and down like any other.
        const y = after.knots[apex]!.end.y;
        store.getState().moveControlPoint(SLICE, apex, vec2(25, y + 0.3));
        expect(slice(store).knots[apex]!.end).toEqual(vec2(20, y + 0.3));
      },
    );

    it('pastes a wider, thicker profile as a shape, fitted into the station', () => {
      // A mid-board profile 60 wide and 10 thick, pasted onto this 40 × 6 station.
      const wide = splineFromKnots([
        knot(vec2(0, 0), vec2(-6, 0), vec2(6, 0)),
        knot(vec2(30, 3), vec2(30, 1), vec2(30, 5)),
        knot(vec2(0, 10), vec2(10, 10), vec2(-10, 10)),
      ]);
      const store = expectBlankKept((s) => s.getState().pasteCrossSection(1, wide));
      const k = slice(store).knots;
      expect(k).toHaveLength(3);
      expect(k[0]!.end).toEqual(vec2(0, 0));
      expect(k[2]!.end).toEqual(vec2(0, 6));
      expect(k[1]!.end.x).toBe(20); // on the apex line exactly
      expect(k[1]!.end.y).toBeCloseTo(1.8, 12); // 3 of 10 up, as 1.8 of 6
      expect(store.getState().past.map((h) => h.label)).toEqual(['Paste cross-section']);
    });

    it('adds a point to the slice without moving the blank', () => {
      const store = expectBlankKept((s) => s.getState().addControlPoint(SLICE, vec2(8, 5.9)));
      expect(slice(store).knots).toHaveLength(6);
    });
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

// ---------------------------------------------------------------------------
// board store: alignTangents actions
// ---------------------------------------------------------------------------

describe('board store: alignTangents horizontal/vertical actions', () => {
  // Interior knot at index 1: end=(50,10), prev=(45,5), next=(55,15) — diagonal
  const makeBoardWithDiagKnot = (): BezierBoard => {
    const outline = splineFromKnots([
      knot(vec2(0, 0), vec2(-5, 0), vec2(5, 0), true),
      knot(vec2(50, 10), vec2(45, 5), vec2(55, 15), false),
      knot(vec2(100, 0), vec2(95, 0), vec2(105, 0), true),
    ]);
    const bottom = splineFromKnots([
      knot(vec2(0, 2), vec2(-5, 2), vec2(5, 2)),
      knot(vec2(100, 2), vec2(95, 2), vec2(105, 2)),
    ]);
    const deck = splineFromKnots([
      knot(vec2(0, 8), vec2(-5, 8), vec2(5, 8)),
      knot(vec2(100, 8), vec2(95, 8), vec2(105, 8)),
    ]);
    const prof = splineFromKnots([
      knot(vec2(0, 2), vec2(0, 2), vec2(10, 2)),
      knot(vec2(10, 5), vec2(10, 3), vec2(10, 5)),
    ]);
    return board(outline, bottom, deck, [
      crossSection(0, prof),
      crossSection(50, prof),
      crossSection(100, prof),
    ]);
  };

  it('alignTangentsHorizontal aligns the outline interior knot tangents to horizontal', () => {
    const store = createBoardStore();
    store.getState().load(makeBoardWithDiagKnot());
    store.getState().alignTangentsHorizontal({ kind: 'outline' }, 1);
    const ko = store.getState().board!.outline.knots[1]!;
    expect(ko.tangentToPrev.y).toBeCloseTo(ko.end.y, 6);
    expect(ko.tangentToNext.y).toBeCloseTo(ko.end.y, 6);
  });

  it('alignTangentsHorizontal records a labelled undo step', () => {
    const store = createBoardStore();
    store.getState().load(makeBoardWithDiagKnot());
    const before = store.getState().board;
    store.getState().alignTangentsHorizontal({ kind: 'outline' }, 1);
    expect(store.getState().canUndo()).toBe(true);
    expect(store.getState().past[0]!.label).toBe('Align tangents');
    store.getState().undo();
    expect(store.getState().board).toBe(before);
  });

  it('alignTangentsVertical aligns the outline interior knot tangents to vertical', () => {
    const store = createBoardStore();
    store.getState().load(makeBoardWithDiagKnot());
    store.getState().alignTangentsVertical({ kind: 'outline' }, 1);
    const ko = store.getState().board!.outline.knots[1]!;
    expect(ko.tangentToPrev.x).toBeCloseTo(ko.end.x, 6);
    expect(ko.tangentToNext.x).toBeCloseTo(ko.end.x, 6);
  });

  it('alignTangentsVertical records a labelled undo step', () => {
    const store = createBoardStore();
    store.getState().load(makeBoardWithDiagKnot());
    const before = store.getState().board;
    store.getState().alignTangentsVertical({ kind: 'outline' }, 1);
    expect(store.getState().canUndo()).toBe(true);
    expect(store.getState().past[0]!.label).toBe('Align tangents');
    store.getState().undo();
    expect(store.getState().board).toBe(before);
  });

  it('junction knot: alignTangentsHorizontal does not violate the junction constraint', () => {
    // Align the outline's nose tip (index 2 = last, x = length) — a junction
    // endpoint; the centerline pin must win and keep the nose on y = 0.
    const store = createBoardStore();
    store.getState().load(makeBoardWithDiagKnot());
    store.getState().alignTangentsHorizontal({ kind: 'outline' }, 2);
    const b = store.getState().board!;
    // The outline nose y must still be 0 (junction constraint: nose on centerline).
    expect(b.outline.knots[2]!.end.y).toBeCloseTo(0, 6);
  });

  it('junction knot: alignTangentsVertical does not violate the junction constraint', () => {
    const store = createBoardStore();
    store.getState().load(makeBoardWithDiagKnot());
    store.getState().alignTangentsVertical({ kind: 'deck' }, 0);
    const b = store.getState().board!;
    // Deck/bottom tips must still be joined after enforceJunctions.
    expect(b.bottom.knots[0]!.end).toEqual(b.deck.knots[0]!.end);
  });
});

describe('board store: adjustThickness gate (JC-4-y)', () => {
  // A board with real thickness: deck & bottom share their tips (thickness → 0 at nose/tail,
  // so JC-5 doesn't collapse them) and the deck bulges to 6 cm in the middle. The interior
  // station is a bottom-centre → rail → deck-centre profile with both ends on the stringer.
  const thicknessBoard = (): BezierBoard => {
    const k3 = (ex: number, ey: number) => knot(vec2(ex, ey), vec2(ex - 5, ey), vec2(ex + 5, ey));
    const outline = splineFromKnots([k3(0, 0), k3(50, 20), k3(100, 0)]);
    const bottom = splineFromKnots([k3(0, 0), k3(50, 0), k3(100, 0)]);
    const deck = splineFromKnots([k3(0, 0), k3(50, 6), k3(100, 0)]);
    const prof = splineFromKnots([
      knot(vec2(0, 0), vec2(0, 0), vec2(4, 1)),
      knot(vec2(8, 3), vec2(6, 2), vec2(6, 4)),
      knot(vec2(0, 6), vec2(4, 5), vec2(0, 6)),
    ]);
    return board(outline, bottom, deck, [
      crossSection(0, prof),
      crossSection(50, prof),
      crossSection(100, prof),
    ]);
  };

  it('defaults to true and re-slaves interior sections when a global curve is edited', () => {
    const store = createBoardStore();
    store.getState().load(thicknessBoard());
    expect(store.getState().adjustThickness).toBe(true);
    const before = store.getState().board!.crossSections[1]!.spline;
    // Thicken the board mid (deck 6 → 12); the interior section must resize to match.
    store.getState().moveControlPoint({ kind: 'deck' }, 1, vec2(50, 12));
    const after = store.getState().board!.crossSections[1]!.spline;
    expect(after).not.toBe(before);
  });

  it('leaves interior sections untouched when adjustThickness is off', () => {
    const store = createBoardStore();
    store.getState().load(thicknessBoard());
    store.getState().setAdjustThickness(false);
    const before = store.getState().board!.crossSections[1]!.spline;
    store.getState().moveControlPoint({ kind: 'deck' }, 1, vec2(50, 12));
    const after = store.getState().board!.crossSections[1]!.spline;
    expect(after).toBe(before); // section profile preserved (no re-slaving)
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

// ---------------------------------------------------------------------------
// board store: fin actions
// ---------------------------------------------------------------------------

describe('board store: fins', () => {
  it('starts with no fins and sets a setup (undoable, re-seeded from defaults)', () => {
    const store = createBoardStore();
    store.getState().load(makeBoard());
    expect(store.getState().board!.fins.setup).toBe('none');

    store.getState().setFinSetup('thruster');
    expect(store.getState().board!.fins.setup).toBe('thruster');
    expect(store.getState().board!.fins.fins).toHaveLength(3);
    expect(store.getState().past[0]!.label).toBe('Change fin setup');

    store.getState().undo();
    expect(store.getState().board!.fins.setup).toBe('none');
  });

  it('changes the fin system while keeping placement', () => {
    const store = createBoardStore();
    store.getState().load(makeBoard());
    store.getState().setFinSetup('quad');
    const placedBefore = store.getState().board!.fins.fins;

    store.getState().setFinSystem('futures');
    expect(store.getState().board!.fins.system).toBe('futures');
    expect(store.getState().board!.fins.fins).toEqual(placedBefore);
  });

  it('updateFin patches a single fin spec and is undoable', () => {
    const store = createBoardStore();
    store.getState().load(makeBoard());
    store.getState().setFinSetup('single');

    const before = store.getState().board!.fins.fins[0]!.depth;
    store.getState().updateFin(0, { depth: before + 5, toe: 2 });
    const fin = store.getState().board!.fins.fins[0]!;
    expect(fin.depth).toBe(before + 5);
    expect(fin.toe).toBe(2);

    store.getState().undo();
    expect(store.getState().board!.fins.fins[0]!.depth).toBe(before);
  });

  it('moveFin re-derives placement from a plan point, keeping the fin side', () => {
    const store = createBoardStore();
    store.getState().load(makeBoard()); // length 100, tail at x=0
    store.getState().setFinSetup('thruster');
    const side = store.getState().board!.fins.fins[0]!.side; // a side fin
    expect(side).not.toBe(0);

    // Drop it near the tail at x=25.
    store.getState().moveFin(0, vec2(25, 8));
    const fin = store.getState().board!.fins.fins[0]!;
    expect(fin.side).toBe(side); // side preserved
    // trailing edge = 25 − base/2 from the tail (x=0).
    expect(fin.trailingFromTail).toBeCloseTo(25 - fin.base / 2, 6);
  });

  it('symmetrical (default): editing a side fin mirrors to its pair, keeping side', () => {
    const store = createBoardStore();
    store.getState().load(makeBoard());
    store.getState().setFinSetup('thruster'); // [port, starboard, center]
    expect(store.getState().board!.fins.symmetrical).toBe(true);

    store.getState().updateFin(0, { depth: 18, insetFromRail: 5 }); // edit the port fin
    const fins = store.getState().board!.fins.fins;
    expect(fins[0]!.depth).toBe(18);
    expect(fins[1]!.depth).toBe(18); // starboard mirrored
    expect(fins[1]!.insetFromRail).toBe(5);
    expect(fins[0]!.side).toBe(-1); // sides preserved
    expect(fins[1]!.side).toBe(1);
    expect(fins[2]!.depth).not.toBe(18); // center untouched
  });

  it('symmetry off: editing one side fin leaves its pair alone', () => {
    const store = createBoardStore();
    store.getState().load(makeBoard());
    store.getState().setFinSetup('twin');
    store.getState().setFinSymmetrical(false);

    store.getState().updateFin(0, { depth: 18 });
    const fins = store.getState().board!.fins.fins;
    expect(fins[0]!.depth).toBe(18);
    expect(fins[1]!.depth).not.toBe(18);
  });

  it('symmetrical drag mirrors placement across the stringer', () => {
    const store = createBoardStore();
    store.getState().load(makeBoard()); // length 100, tail at x=0
    store.getState().setFinSetup('twin');
    store.getState().moveFin(0, vec2(28, 10)); // drag port fin
    const fins = store.getState().board!.fins.fins;
    expect(fins[0]!.trailingFromTail).toBeCloseTo(fins[1]!.trailingFromTail, 6);
    expect(fins[0]!.insetFromRail).toBeCloseTo(fins[1]!.insetFromRail, 6);
  });

  it('selecting a fin clears the control-point selection and vice versa', () => {
    const store = createBoardStore();
    store.getState().load(makeBoard());
    store.getState().select({ target: { kind: 'outline' }, index: 1 });
    store.getState().selectFin(2);
    expect(store.getState().selection).toBeNull();
    expect(store.getState().selectedFin).toBe(2);
    store.getState().select({ target: { kind: 'outline' }, index: 1 });
    expect(store.getState().selectedFin).toBeNull();
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

describe('board store: applyRailPreset', () => {
  const load = () => {
    const store = createBoardStore();
    store.getState().load(makeBoard());
    return store;
  };

  it('restyles the section in one undoable step', () => {
    const store = load();
    const before = store.getState().board!.crossSections[1]!.spline;
    const history = store.getState().past.length;

    store.getState().applyRailPreset(1, 'boxy');

    const after = store.getState().board!.crossSections[1]!.spline;
    expect(after).not.toBe(before);
    expect(after.knots).toHaveLength(5);
    expect(store.getState().past).toHaveLength(history + 1);
    expect(store.getState().past.at(-1)!.label).toBe('Rail preset: Boxy');

    store.getState().undo();
    expect(store.getState().board!.crossSections[1]!.spline).toBe(before);
  });

  /**
   * The load-bearing one. A preset restyles the rail and nothing else: it must not move
   * the board curves, and it must not be quietly resized by the commit-time
   * `adjustCrossSectionsToThicknessAndWidth` pass, which would happen if it changed the
   * station's width or centre thickness. Both show up here as the curve splines keeping
   * their identity and the station keeping its dimensions.
   */
  it('leaves the outline, deck and rocker untouched', () => {
    const store = load();
    const before = store.getState().board!;
    const width = getWidthAtPos(before, 50);
    const thickness = getThicknessAtPos(before, 50);
    const csBefore = before.crossSections[1]!;

    store.getState().applyRailPreset(1, '80-20-hard');

    const after = store.getState().board!;
    expect(after.outline).toBe(before.outline);
    expect(after.deck).toBe(before.deck);
    expect(after.bottom).toBe(before.bottom);
    expect(getWidthAtPos(after, 50)).toBeCloseTo(width, 9);
    expect(getThicknessAtPos(after, 50)).toBeCloseTo(thickness, 9);
    // The station keeps the dimensions it had, so the commit-time rescale has nothing
    // to correct and the profile the shaper picked is the profile they get.
    const csAfter = after.crossSections[1]!;
    expect(csWidth(csAfter)).toBeCloseTo(csWidth(csBefore), 6);
    expect(csCenterThickness(csAfter)).toBeCloseTo(csCenterThickness(csBefore), 6);
  });

  it('survives the commit pipeline unchanged when applied twice', () => {
    const store = load();
    store.getState().applyRailPreset(1, '60-40-tucked');
    const once = store.getState().board!.crossSections[1]!.spline.knots;
    store.getState().applyRailPreset(1, '60-40-tucked');
    expect(store.getState().board!.crossSections[1]!.spline.knots).toEqual(once);
  });

  it('clears a stale control-point selection', () => {
    const store = load();
    store.getState().select({ target: { kind: 'crossSection', index: 1 }, index: 1 });
    store.getState().applyRailPreset(1, 'egg');
    expect(store.getState().selection).toBeNull();
  });

  it('ignores the nose and tail dummies and unknown presets', () => {
    const store = load();
    const before = store.getState().board!;
    const history = store.getState().past.length;
    store.getState().applyRailPreset(0, 'egg');
    store.getState().applyRailPreset(before.crossSections.length - 1, 'egg');
    // @ts-expect-error — an id the kernel does not define.
    store.getState().applyRailPreset(1, 'not-a-preset');
    expect(store.getState().board).toBe(before);
    expect(store.getState().past).toHaveLength(history);
  });
});

describe('selection across undo/redo (P1)', () => {
  const setup = () => {
    const store = createBoardStore();
    store.getState().load(makeBoard());
    return store;
  };

  it('clears a selection on a station that undo removes, instead of crashing', () => {
    const store = setup();
    const s = store.getState;
    const a = s().addCrossSection(70);
    const b = s().addCrossSection(85);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    s().select({ target: { kind: 'crossSection', index: b }, index: 1 });
    s().undo();
    s().undo();
    expect(s().selection).toBeNull();
    // What used to throw in the inspector: resolving the selection against the board.
    expect(s().board!.crossSections.length).toBe(3);
  });

  it('keeps the selection when undo leaves the spline with the same knots (undoing a drag)', () => {
    const store = setup();
    const s = store.getState;
    const sel = { target: { kind: 'outline' as const }, index: 1 };
    s().select(sel);
    s().moveControlPoint({ kind: 'outline' }, 1, vec2(50, 22));
    s().undo();
    expect(s().selection).toEqual(sel);
    s().redo();
    expect(s().selection).toEqual(sel);
  });

  it('clears the selection when undo changes the knot count (it would name another knot)', () => {
    const store = setup();
    const s = store.getState;
    s().addControlPoint({ kind: 'outline' }, vec2(75, 12));
    expect(s().selection?.target.kind).toBe('outline');
    s().undo();
    expect(s().selection).toBeNull();
  });

  it('clears a fin selection that undo leaves pointing past the last fin, and on jumpTo', () => {
    const store = setup();
    const s = store.getState;
    s().setFinSetup('single');
    s().setFinSetup('quad');
    s().selectFin(3);
    s().undo();
    expect(s().board!.fins.fins.length).toBe(1);
    expect(s().selectedFin).toBeNull();

    s().redo();
    s().selectFin(0);
    s().jumpTo(0);
    expect(s().board!.fins.fins.length).toBe(0);
    expect(s().selectedFin).toBeNull();
  });
});

describe('board store: handle-angle locks', () => {
  const OUTLINE = { kind: 'outline' } as const;
  const withBoard = () => {
    const store = createBoardStore();
    store.getState().load(makeBoard());
    return store;
  };
  const outlineKnot = (store: ReturnType<typeof createBoardStore>, i: number) =>
    store.getState().board!.outline.knots[i]!;
  const angleOf = (k: { end: Vec2; tangentToNext: Vec2 }) =>
    Math.atan2(k.tangentToNext.y - k.end.y, k.tangentToNext.x - k.end.x);

  it('locks in one undoable step, and a repeat click adds no empty step', () => {
    const store = withBoard();
    store.getState().setLocked(OUTLINE, 1, true);
    expect(outlineKnot(store, 1).lock).toEqual({ prev: vec2(-1, 0), next: vec2(1, 0) });
    expect(store.getState().past.map((h) => h.label)).toEqual(['Lock handle angles']);

    store.getState().setLocked(OUTLINE, 1, true);
    expect(store.getState().past).toHaveLength(1);

    store.getState().undo();
    expect(outlineKnot(store, 1)).not.toHaveProperty('lock');
    store.getState().redo();
    expect(outlineKnot(store, 1).lock).toBeDefined();

    store.getState().setLocked(OUTLINE, 1, false);
    expect(outlineKnot(store, 1)).not.toHaveProperty('lock');
    expect(store.getState().past.at(-1)!.label).toBe('Unlock handle angles');
  });

  it('undoing an insert before a locked point leaves the lock on that point', () => {
    const store = withBoard();
    store.getState().setLocked(OUTLINE, 1, true);
    const outline = store.getState().board!.outline;
    store.getState().addControlPoint(OUTLINE, vec2(25, valueAt(outline, 25)));
    expect(outlineKnot(store, 2).lock).toBeDefined(); // the locked point moved up one
    expect(outlineKnot(store, 1)).not.toHaveProperty('lock'); // the new point is free

    store.getState().undo();
    const knots = store.getState().board!.outline.knots;
    expect(knots).toHaveLength(3);
    expect(knots[1]!.lock).toBeDefined();
    expect(knots[2]!).not.toHaveProperty('lock');
  });

  it('deleting a locked point and undoing brings its lock back', () => {
    const store = withBoard();
    store.getState().setLocked(OUTLINE, 1, true);
    store.getState().deleteControlPoint(OUTLINE, 1);
    expect(store.getState().board!.outline.knots).toHaveLength(2);
    store.getState().undo();
    expect(outlineKnot(store, 1).lock).toBeDefined();
  });

  it('a dragged locked handle keeps its angle', () => {
    const store = withBoard();
    store.getState().moveTangent(OUTLINE, 1, 'next', vec2(55, 23));
    store.getState().setLocked(OUTLINE, 1, true);
    store.getState().moveTangent(OUTLINE, 1, 'next', vec2(60, 40));
    expect(angleOf(outlineKnot(store, 1))).toBeCloseTo(Math.atan2(3, 5), 12);
  });

  it('a non-uniform resize turns each lock with its handle, and a later drag keeps the new angle', () => {
    const store = withBoard();
    store.getState().moveTangent(OUTLINE, 1, 'next', vec2(55, 23));
    store.getState().setLocked(OUTLINE, 1, true);
    store.getState().scaleBoard(1, 1.5, 1);

    const k = outlineKnot(store, 1);
    for (const [h, d] of [
      [k.tangentToPrev, k.lock!.prev!],
      [k.tangentToNext, k.lock!.next!],
    ] as const) {
      const hx = h.x - k.end.x;
      const hy = h.y - k.end.y;
      expect(hx * d.y - hy * d.x).toBeCloseTo(0, 9);
      expect(hx * d.x + hy * d.y).toBeGreaterThan(0);
    }

    store.getState().moveTangent(OUTLINE, 1, 'next', vec2(70, 60));
    expect(angleOf(outlineKnot(store, 1))).toBeCloseTo(Math.atan2(3 * 1.5, 5), 9);
  });

  it('sets a locked handle length in one undo step, along its lock', () => {
    const store = withBoard();
    store.getState().setLocked(OUTLINE, 1, true);
    store.getState().setTangentLength(OUTLINE, 1, 'next', 12);
    const k = outlineKnot(store, 1);
    expect(k.tangentToNext.x).toBeCloseTo(62, 12);
    expect(k.tangentToNext.y).toBeCloseTo(20, 12);
    expect(store.getState().past.at(-1)!.label).toBe('Set handle length');
  });
});

describe('board store: keyboard handle rotation and length', () => {
  const OUTLINE = { kind: 'outline' } as const;
  const DEG = Math.PI / 180;
  const withBoard = () => {
    const store = createBoardStore();
    store.getState().load(makeBoard());
    return store;
  };
  const middle = (store: ReturnType<typeof createBoardStore>) =>
    store.getState().board!.outline.knots[1]!;

  it('turns a handle in one labelled undo step per call, keeping its length', () => {
    const store = withBoard();
    store.getState().rotateTangent(OUTLINE, 1, 'next', 30 * DEG);
    store.getState().rotateTangent(OUTLINE, 1, 'both', 10 * DEG);
    const k = middle(store);
    expect(k.tangentToNext.x).toBeCloseTo(50 + 5 * Math.cos(40 * DEG), 12);
    expect(k.tangentToNext.y).toBeCloseTo(20 + 5 * Math.sin(40 * DEG), 12);
    // Smooth: the other handle turned with it.
    expect(k.tangentToPrev.x).toBeCloseTo(50 - 5 * Math.cos(40 * DEG), 12);
    expect(k.tangentToPrev.y).toBeCloseTo(20 - 5 * Math.sin(40 * DEG), 12);
    expect(store.getState().past.map((h) => h.label)).toEqual(['Rotate handle', 'Rotate handles']);

    store.getState().undo();
    store.getState().undo();
    expect(middle(store).tangentToNext).toEqual(vec2(55, 20));
  });

  it('records nothing for a locked handle', () => {
    const store = withBoard();
    store.getState().setLocked(OUTLINE, 1, true);
    const before = store.getState().board;
    store.getState().rotateTangent(OUTLINE, 1, 'next', 5 * DEG);
    expect(store.getState().board).toBe(before);
    expect(store.getState().past.map((h) => h.label)).toEqual(['Lock handle angles']);
  });

  it('refuses a turn the junction pass would bend back and shorten', () => {
    // An outline handle may turn up to vertical, never past it: the curve would fold
    // back on itself, so the junction pass would squash the handle onto the vertical.
    const store = withBoard();
    store.getState().rotateTangent(OUTLINE, 1, 'next', 85 * DEG);
    expect(store.getState().past).toHaveLength(1);
    const before = store.getState().board;
    store.getState().rotateTangent(OUTLINE, 1, 'next', 10 * DEG);
    expect(store.getState().board).toBe(before);
    expect(store.getState().past).toHaveLength(1);
    expect(
      Math.hypot(middle(store).tangentToNext.x - 50, middle(store).tangentToNext.y - 20),
    ).toBeCloseTo(5, 12);
  });

  it('steps both handles of a point in one undo step, never below zero', () => {
    const store = withBoard();
    store.getState().stepTangentLength(OUTLINE, 1, 'both', 2);
    expect(middle(store).tangentToPrev).toEqual(vec2(43, 20));
    expect(middle(store).tangentToNext).toEqual(vec2(57, 20));
    expect(store.getState().past.map((h) => h.label)).toEqual(['Set handle length']);

    store.getState().stepTangentLength(OUTLINE, 1, 'next', -100);
    expect(middle(store).tangentToNext).toEqual(vec2(50, 20));
    // Already collapsed: shortening further records nothing.
    store.getState().stepTangentLength(OUTLINE, 1, 'next', -1);
    expect(store.getState().past).toHaveLength(2);
  });
});
