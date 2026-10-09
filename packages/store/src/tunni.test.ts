import {
  board,
  crossSection,
  knot,
  moveTunniLine,
  moveTunniPoint,
  splineFromKnots,
  tunniGeometry,
  type Vec2,
} from '@openshaper/kernel';
import { expect, it } from 'vitest';
import { moveSegmentTangents, setKnotLock } from './edits';
import { createBoardStore } from './board-store';

const p = (x: number, y: number): Vec2 => ({ x, y });
const curve = (c1 = p(2, 4), c2 = p(8, 4)) =>
  splineFromKnots([knot(p(0, 0), p(-2, -4), c1), knot(p(10, 0), c2, p(12, -4))]);
const near = (actual: Vec2, expected: Vec2) => {
  expect(actual.x).toBeCloseTo(expected.x, 10);
  expect(actual.y).toBeCloseTo(expected.y, 10);
};

it('applies a Tunni point move without touching anchors or outer handles', () => {
  const result = moveTunniPoint(tunniGeometry(curve(), 0)!, p(6, 8))!;
  const updated = moveSegmentTangents(curve(), 0, ...result);
  near(tunniGeometry(updated, 0)!.point!, p(6, 8));
  expect(updated.knots.map((k) => k.end)).toEqual(curve().knots.map((k) => k.end));
  near(updated.knots[0]!.tangentToPrev, p(-2, -4));
  near(updated.knots[1]!.tangentToNext, p(12, -4));
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
