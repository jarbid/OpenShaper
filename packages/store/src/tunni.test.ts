import { board, crossSection, knot, splineFromKnots, type Vec2 } from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import { balanceTunni, moveTunniLine, moveTunniPoint, tunniGeometry } from './tunni';
import { moveSegmentTangents, setKnotLock } from './edits';
import { createBoardStore } from './board-store';

const p = (x: number, y: number): Vec2 => ({ x, y });
const curve = (c1 = p(2, 4), c2 = p(8, 4)) =>
  splineFromKnots([knot(p(0, 0), p(-2, -4), c1), knot(p(10, 0), c2, p(12, -4))]);
const near = (actual: Vec2, expected: Vec2) => {
  expect(actual.x).toBeCloseTo(expected.x, 10);
  expect(actual.y).toBeCloseTo(expected.y, 10);
};

describe('Tunni geometry (analytic cubics, tolerance 1e-10)', () => {
  it('locates the point and preserves the original handles for a zero move', () => {
    const g = tunniGeometry(curve(), 0)!;
    near(g.point!, p(5, 6));
    expect(moveTunniPoint(g, g.point!)).toEqual([g.c1, g.c2]);
    expect(moveTunniLine(g, p(0, 0))).toEqual([g.c1, g.c2]);
  });
  it('moves the point while keeping both handles on their original rays', () => {
    const g = tunniGeometry(curve(), 0)!;
    const result = moveTunniPoint(g, p(6, 8))!;
    near(result[0], p(2.5, 5));
    near(result[1], p(8, 4));
    const updated = moveSegmentTangents(curve(), 0, ...result);
    near(tunniGeometry(updated, 0)!.point!, p(6, 8));
    expect(updated.knots.map((k) => k.end)).toEqual(curve().knots.map((k) => k.end));
    near(updated.knots[0]!.tangentToPrev, p(-2, -4));
    near(updated.knots[1]!.tangentToNext, p(12, -4));
  });
  it('translates the line normally and ignores motion along it', () => {
    const g = tunniGeometry(curve(), 0)!;
    const result = moveTunniLine(g, p(100, 1))!;
    near(result[0], p(2.5, 5));
    near(result[1], p(7.5, 5));
    expect(moveTunniLine(g, p(100, 0))).toEqual([g.c1, g.c2]);
  });
  it('balances unequal handles into a line parallel to the endpoint chord', () => {
    const g = tunniGeometry(curve(p(1, 2), p(8, 4)), 0)!;
    const result = balanceTunni(g)!;
    near(result[0], p(1.5, 3));
    near(result[1], p(8.5, 3));
  });
  it('allows a line for parallel tangent rays but hides the undefined point', () => {
    const g = tunniGeometry(curve(p(2, 4), p(12, 4)), 0)!;
    expect(g.point).toBeNull();
    expect(moveTunniLine(g, p(0, 1))).not.toBeNull();
    expect(moveTunniPoint(g, p(5, 5))).toBeNull();
    expect(balanceTunni(g)).toBeNull();
  });
  it('rejects straight, collapsed and nearly singular handles', () => {
    expect(tunniGeometry(curve(p(2, 0), p(8, 0)), 0)).toBeNull();
    expect(tunniGeometry(curve(p(0, 0)), 0)).toBeNull();
    expect(tunniGeometry(curve(), 10)).toBeNull();
    expect(tunniGeometry(curve(p(2, 4), p(8, -4)), 0)?.point).toBeNull();
  });
  it('rejects handle reversal and non-finite updates', () => {
    const g = tunniGeometry(curve(), 0)!;
    expect(moveTunniLine(g, p(0, -5))).toBeNull();
    expect(moveTunniPoint(g, p(5, -20))).toBeNull();
    expect(moveTunniPoint(g, p(Infinity, 5))).toBeNull();
  });
  it('is invariant under translation and scaling', () => {
    const s = curve();
    const transform = (v: Vec2) => p(v.x * 100 + 20, v.y * 100 - 30);
    const scaled = splineFromKnots(
      s.knots.map((k) =>
        knot(transform(k.end), transform(k.tangentToPrev), transform(k.tangentToNext)),
      ),
    );
    near(tunniGeometry(scaled, 0)!.point!, transform(tunniGeometry(s, 0)!.point!));
  });
});

it('groups two-handle updates into one undo step and restores with redo', () => {
  const s = curve();
  const store = createBoardStore();
  store.getState().load(board(s, s, s, [crossSection(0, s), crossSection(10, s)]));
  const original = store.getState().board!;
  store.getState().beginEdit();
  store.getState().moveSegmentTangents({ kind: 'outline' }, 0, p(2.5, 5), p(7.5, 5));
  store.getState().moveSegmentTangents({ kind: 'outline' }, 0, p(3, 6), p(7, 6));
  store.getState().endEdit();
  const edited = store.getState().board!;
  expect(store.getState().past).toHaveLength(1);
  near(edited.outline.knots[0]!.tangentToNext, p(3, 6));
  near(edited.outline.knots[1]!.tangentToPrev, p(7, 6));
  store.getState().undo();
  expect(store.getState().board).toBe(original);
  store.getState().redo();
  expect(store.getState().board).toBe(edited);
});

it('preserves upstream handle-angle locks while adjusting both segment handles', () => {
  const locked = setKnotLock(setKnotLock(curve(), 0, true), 1, true);
  const g = tunniGeometry(locked, 0)!;
  const result = moveTunniLine(g, p(0, 1))!;
  const edited = moveSegmentTangents(locked, 0, ...result);
  expect(edited.knots[0]!.lock).toEqual(locked.knots[0]!.lock);
  expect(edited.knots[1]!.lock).toEqual(locked.knots[1]!.lock);
  near(edited.knots[0]!.tangentToNext, p(2.5, 5));
  near(edited.knots[1]!.tangentToPrev, p(7.5, 5));
  near(edited.knots[0]!.tangentToPrev, locked.knots[0]!.tangentToPrev);
  near(edited.knots[1]!.tangentToNext, locked.knots[1]!.tangentToNext);
});

it('ignores an unchanged or invalid paired-handle edit without adding history', () => {
  const s = curve();
  const store = createBoardStore();
  store.getState().load(board(s, s, s, [crossSection(0, s), crossSection(10, s)]));
  const original = store.getState().board!;
  const first = original.outline.knots[0]!.tangentToNext;
  const last = original.outline.knots[1]!.tangentToPrev;
  store.getState().moveSegmentTangents({ kind: 'outline' }, 0, first, last);
  store.getState().moveSegmentTangents({ kind: 'outline' }, 9, first, last);
  expect(store.getState().board).toBe(original);
  expect(store.getState().past).toHaveLength(0);
});
