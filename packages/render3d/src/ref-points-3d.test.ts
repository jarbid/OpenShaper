import { describe, expect, it } from 'vitest';
import {
  board as makeBoard,
  crossSection,
  knot,
  refPoint3D,
  splineFromKnots,
  vec2,
  type RefPoint,
} from '@openshaper/kernel';
import { refPointMarks } from './RefPoints3D';

const flat = (y: number) =>
  splineFromKnots([
    knot(vec2(0, y), vec2(0, y), vec2(30, y)),
    knot(vec2(100, y), vec2(70, y), vec2(100, y)),
  ]);
const profile = splineFromKnots([
  knot(vec2(0, 0), vec2(0, 0), vec2(5, 0)),
  knot(vec2(10, 4), vec2(10, 2), vec2(10, 4)),
]);
const board = makeBoard(flat(10), flat(0), flat(8), [
  crossSection(0, profile),
  crossSection(50, profile),
  crossSection(100, profile),
]);

const deck: RefPoint = { id: 'd', plane: 'rocker', curve: 'deck', x: 40, y: 8 };
const offBoard: RefPoint = { id: 'o', plane: 'outline', x: 500, y: 1 };

describe('refPointMarks', () => {
  it('centres a three-axis crosshair on the point', () => {
    const [mark] = refPointMarks(board, [deck], null);
    const centre = refPoint3D(board, deck)!;
    expect(mark!.arms).toHaveLength(3);
    for (const [a, b] of mark!.arms) {
      expect([(a![0] + b![0]) / 2, (a![1] + b![1]) / 2, (a![2] + b![2]) / 2]).toEqual([
        centre.x,
        centre.y,
        centre.z,
      ]);
    }
  });

  it('skips points with no place on the hull', () => {
    expect(refPointMarks(board, [offBoard, deck], null).map((m) => m.id)).toEqual(['d']);
  });

  it('colours like the 2D view: plain, judged, selected', () => {
    const plain = refPointMarks(board, [deck], null)[0]!.color;
    const judged = refPointMarks(board, [deck], null, 100)[0]!.color;
    const tight = refPointMarks(board, [{ ...deck, y: 50 }], null, 0.01)[0]!.color;
    const selected = refPointMarks(board, [deck], 'd', 100)[0]!;
    expect([plain, judged, tight, selected.color]).toEqual([
      '#FACC15',
      '#22C55E',
      '#EF4444',
      '#F97316',
    ]);
    expect(selected.width).toBeGreaterThan(refPointMarks(board, [deck], null)[0]!.width);
  });
});
