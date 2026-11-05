import { describe, expect, it } from 'vitest';
import {
  board,
  crossSection,
  knot,
  splineFromKnots,
  vec2,
  type BezierBoard,
  type RefPoint,
} from '@openshaper/kernel';
import { createBoardStore } from './board-store';
import {
  addRefPoint,
  deleteRefPoint,
  nextRefPointId,
  refPointDraftAt,
  refPointInPane,
  updateRefPoint,
} from './edits';

const makeBoard = (): BezierBoard => {
  const k = (ex: number, ey: number) => knot(vec2(ex, ey), vec2(ex - 5, ey), vec2(ex + 5, ey));
  const outline = splineFromKnots([k(0, 0), k(50, 20), k(100, 0)]);
  const bottom = splineFromKnots([k(0, 5), k(100, 5)]);
  const deck = splineFromKnots([k(0, 11), k(100, 11)]);
  const prof = splineFromKnots([
    knot(vec2(0, 5), vec2(0, 5), vec2(10, 5)),
    knot(vec2(10, 8), vec2(10, 6), vec2(10, 8)),
  ]);
  return board(
    outline,
    bottom,
    deck,
    [0, 50, 100].map((x) => crossSection(x, prof)),
  );
};

const outlinePoint = (id: string, x: number, y = 10): RefPoint => ({
  id,
  plane: 'outline',
  x,
  y,
});

const loaded = (refPoints: RefPoint[] = []) => {
  const store = createBoardStore();
  store.getState().load(makeBoard(), refPoints);
  return store;
};

describe('reference point edits (pure)', () => {
  it('adds with a fresh id, updates and deletes without touching other points', () => {
    const a = outlinePoint('r1', 10);
    const { points, id } = addRefPoint([a], { plane: 'rocker', curve: 'deck', x: 5, y: 11 });
    expect(id).toBe('r2');
    expect(points[0]).toBe(a);
    const moved = updateRefPoint(points, 'r2', { x: 6 });
    expect(moved[1]).toEqual({ id: 'r2', plane: 'rocker', curve: 'deck', x: 6, y: 11 });
    expect(moved[0]).toBe(a);
    expect(deleteRefPoint(moved, 'r1')).toEqual([moved[1]]);
  });

  it('returns the same array when nothing changes, so no empty undo step is recorded', () => {
    const points = [outlinePoint('r1', 10)];
    expect(updateRefPoint(points, 'r1', { x: 10, y: 10 })).toBe(points);
    expect(updateRefPoint(points, 'nope', { x: 1 })).toBe(points);
    expect(updateRefPoint(points, 'r1', { x: NaN })).toBe(points);
    expect(deleteRefPoint(points, 'nope')).toBe(points);
  });

  it('sets and clears a label; blank clears it', () => {
    const labelled = updateRefPoint([outlinePoint('r1', 10)], 'r1', { label: ' wide point ' });
    expect(labelled[0]!.label).toBe('wide point');
    expect(updateRefPoint(labelled, 'r1', { label: '  ' })[0]).toEqual(outlinePoint('r1', 10));
  });

  it('places a new point on the pane it was added in', () => {
    const b = makeBoard();
    expect(refPointDraftAt(b, [{ kind: 'outline' }], { x: 30, y: 12 })).toEqual({
      plane: 'outline',
      x: 30,
      y: 12,
    });
    // Rocker pane: the nearer of bottom (y = 5) and deck (y = 11).
    const rocker = [{ kind: 'deck' }, { kind: 'bottom' }] as const;
    expect(refPointDraftAt(b, [...rocker], { x: 30, y: 10 })).toMatchObject({ curve: 'deck' });
    expect(refPointDraftAt(b, [...rocker], { x: 30, y: 6 })).toMatchObject({ curve: 'bottom' });
    // A section pane records its station.
    expect(refPointDraftAt(b, [{ kind: 'crossSection', index: 1 }], { x: 4, y: 6 })).toEqual({
      plane: 'section',
      station: 50,
      x: 4,
      y: 6,
    });
  });

  it('shows each point only in its own pane; section points on the section at their station', () => {
    const b = makeBoard();
    const section: RefPoint = { id: 's', plane: 'section', station: 50.02, x: 4, y: 6 };
    expect(refPointInPane(b, section, [{ kind: 'crossSection', index: 1 }])).toBe(true);
    expect(refPointInPane(b, section, [{ kind: 'crossSection', index: 2 }])).toBe(false);
    expect(
      refPointInPane(b, { ...section, station: 51 }, [{ kind: 'crossSection', index: 1 }]),
    ).toBe(false);
    expect(refPointInPane(b, outlinePoint('o', 1), [{ kind: 'outline' }])).toBe(true);
    expect(refPointInPane(b, outlinePoint('o', 1), [{ kind: 'deck' }, { kind: 'bottom' }])).toBe(
      false,
    );
  });

  it('steps through the points of one pane in x order, wrapping', () => {
    const points: RefPoint[] = [
      outlinePoint('c', 30),
      outlinePoint('a', 10),
      { id: 'r', plane: 'rocker', curve: 'bottom', x: 20, y: 5 },
      outlinePoint('b', 20),
    ];
    expect(nextRefPointId(points, 'a', 1)).toBe('b');
    expect(nextRefPointId(points, 'c', 1)).toBe('a');
    expect(nextRefPointId(points, 'a', -1)).toBe('c');
    expect(nextRefPointId(points, 'r', 1)).toBe('r');
    expect(nextRefPointId(points, 'zz', 1)).toBeNull();
  });
});

describe('board store: reference points', () => {
  it('loads points with the board, and load without points clears them', () => {
    const store = loaded([outlinePoint('r1', 10)]);
    expect(store.getState().refPoints).toHaveLength(1);
    store.getState().load(makeBoard());
    expect(store.getState().refPoints).toEqual([]);
  });

  it('adds and selects a point, clearing the control-point selection', () => {
    const store = loaded();
    store.getState().select({ target: { kind: 'outline' }, index: 1 });
    const id = store.getState().addRefPoint({ plane: 'outline', x: 30, y: 15 });
    expect(store.getState()).toMatchObject({ selectedRef: id, selection: null });
    expect(store.getState().past.at(-1)!.label).toBe('Add reference point');
  });

  it('keeps board and point edits on one undo timeline, in order', () => {
    const store = loaded();
    const s = store.getState;
    const original = s().board;
    const id = s().addRefPoint({ plane: 'outline', x: 30, y: 15 });
    s().moveControlPoint({ kind: 'outline' }, 1, { x: 50, y: 22 });
    const shaped = s().board;
    s().updateRefPoint(id, { y: 16 });
    expect(s().past.map((e) => e.label)).toEqual([
      'Add reference point',
      'Move control point',
      'Edit reference point',
    ]);

    s().undo();
    expect(s().refPoints[0]!.y).toBe(15);
    expect(s().board).toBe(shaped);
    s().undo();
    expect(s().board).toBe(original);
    expect(s().refPoints).toHaveLength(1);
    s().undo();
    expect(s().refPoints).toEqual([]);

    s().redo();
    s().redo();
    s().redo();
    expect(s().board).toBe(shaped);
    expect(s().refPoints[0]).toMatchObject({ id, y: 16 });
  });

  it('a point edit leaves the board object untouched', () => {
    const store = loaded([outlinePoint('r1', 10)]);
    const before = store.getState().board;
    store.getState().updateRefPoint('r1', { x: 12 });
    store.getState().deleteRefPoint('r1');
    expect(store.getState().board).toBe(before);
  });

  it('records nothing when an edit changes nothing', () => {
    const store = loaded([outlinePoint('r1', 10)]);
    store.getState().updateRefPoint('r1', { x: 10 });
    store.getState().deleteRefPoint('nope');
    expect(store.getState().past).toEqual([]);
  });

  it('coalesces a drag into one step', () => {
    const store = loaded([outlinePoint('r1', 10)]);
    const s = store.getState;
    s().beginEdit();
    s().moveRefPoint('r1', { x: 11, y: 10 });
    s().moveRefPoint('r1', { x: 12, y: 11 });
    s().endEdit();
    expect(s().past.map((e) => e.label)).toEqual(['Move reference point']);
    s().undo();
    expect(s().refPoints[0]).toEqual(outlinePoint('r1', 10));
  });

  it('keeps the selected point through undo while it exists, and drops it when it does not', () => {
    const store = loaded();
    const s = store.getState;
    const id = s().addRefPoint({ plane: 'outline', x: 30, y: 15 });
    s().updateRefPoint(id, { x: 31 });
    s().undo();
    expect(s().selectedRef).toBe(id);
    s().undo();
    expect(s().selectedRef).toBeNull();
  });

  it('deleting the selected point clears the selection; undo restores the point', () => {
    const store = loaded([outlinePoint('r1', 10)]);
    store.getState().selectRef('r1');
    store.getState().deleteRefPoint('r1');
    expect(store.getState()).toMatchObject({ selectedRef: null, refPoints: [] });
    store.getState().undo();
    expect(store.getState().refPoints).toEqual([outlinePoint('r1', 10)]);
  });

  it('selecting a control point or a fin clears the point selection, and the reverse', () => {
    const store = loaded([outlinePoint('r1', 10)]);
    const s = store.getState;
    s().selectRef('r1');
    s().select({ target: { kind: 'outline' }, index: 0 });
    expect(s().selectedRef).toBeNull();
    s().selectRef('r1');
    expect(s().selection).toBeNull();
    s().selectFin(0);
    expect(s().selectedRef).toBeNull();
  });

  it('jumpTo restores the points of the step it jumps to', () => {
    const store = loaded();
    const s = store.getState;
    s().addRefPoint({ plane: 'outline', x: 30, y: 15 });
    s().addRefPoint({ plane: 'outline', x: 40, y: 15 });
    s().jumpTo(1);
    expect(s().refPoints).toHaveLength(1);
    s().redo();
    expect(s().refPoints).toHaveLength(2);
  });
});

describe('board store: adding many reference points', () => {
  it('adds a batch as one undo step, keeping order, and an empty batch records nothing', () => {
    const store = loaded([outlinePoint('r1', 10)]);
    const ids = store.getState().addRefPoints(
      [
        { plane: 'outline', x: 20, y: 10 },
        { plane: 'rocker', curve: 'bottom', x: 20, y: 5 },
      ],
      'Paste reference points',
    );
    expect(ids).toEqual(['r2', 'r3']);
    expect(store.getState().refPoints.map((p) => p.id)).toEqual(['r1', 'r2', 'r3']);
    expect(store.getState().past.map((e) => e.label)).toEqual(['Paste reference points']);
    store.getState().addRefPoints([], 'Nothing');
    expect(store.getState().past).toHaveLength(1);
    store.getState().undo();
    expect(store.getState().refPoints).toEqual([outlinePoint('r1', 10)]);
  });
});
