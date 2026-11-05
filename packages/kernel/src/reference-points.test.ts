import { describe, expect, it } from 'vitest';
import { board } from './board';
import { crossSection } from './cross-section';
import { splineFromKnots } from './bezier-spline';
import { knot } from './knot';
import {
  refIdAllocator,
  refPointBoardValue,
  refPointSectionIndex,
  reviveRefPoints,
  type SectionRefPoint,
} from './reference-points';
import { vec2 } from './vec2';

const line = splineFromKnots([
  knot(vec2(0, 0), vec2(0, 0), vec2(1, 0)),
  knot(vec2(3, 0), vec2(2, 0), vec2(3, 0)),
]);
const withStations = (...positions: number[]) =>
  board(
    line,
    line,
    line,
    positions.map((p) => crossSection(p, line)),
  );
const sectionPoint = (station: number): SectionRefPoint => ({
  id: 'r1',
  plane: 'section',
  station,
  x: 10,
  y: 1,
});

describe('reviveRefPoints', () => {
  it('keeps every valid kind exactly and ignores unknown fields', () => {
    const json = [
      { id: 'a', plane: 'outline', x: 30, y: 21.5, label: 'nose 12in', future: true },
      { id: 'b', plane: 'outline', x: 30, y: 21.25, side: 'minus' },
      { id: 'c', plane: 'rocker', x: 0.1, y: 11.43, curve: 'bottom' },
      { id: 'd', plane: 'section', x: -0, y: 6.2, station: 92.71 },
    ];
    expect(reviveRefPoints(json)).toEqual({
      points: [
        { id: 'a', plane: 'outline', x: 30, y: 21.5, label: 'nose 12in' },
        { id: 'b', plane: 'outline', x: 30, y: 21.25, side: 'minus' },
        { id: 'c', plane: 'rocker', x: 0.1, y: 11.43, curve: 'bottom' },
        { id: 'd', plane: 'section', x: -0, y: 6.2, station: 92.71 },
      ],
      dropped: 0,
    });
    expect(Object.is(reviveRefPoints(json).points[3]!.x, -0)).toBe(true);
  });

  it('drops malformed points instead of throwing, and counts them', () => {
    const { points, dropped } = reviveRefPoints([
      { plane: 'outline', x: 1, y: 2 },
      { plane: 'outline', x: '1', y: 2 },
      { plane: 'outline', x: 1, y: Infinity },
      { plane: 'rocker', x: 1, y: 2 },
      { plane: 'rocker', x: 1, y: 2, curve: 'rail' },
      { plane: 'section', x: 1, y: 2 },
      { plane: 'deck', x: 1, y: 2 },
      null,
      [1, 2],
    ]);
    expect(points).toEqual([{ id: 'r1', plane: 'outline', x: 1, y: 2 }]);
    expect(dropped).toBe(8);
  });

  it('treats a non-array as one dropped entry and absence as nothing', () => {
    expect(reviveRefPoints({ outline: [] })).toEqual({ points: [], dropped: 1 });
    expect(reviveRefPoints(undefined)).toEqual({ points: [], dropped: 0 });
    expect(reviveRefPoints(null)).toEqual({ points: [], dropped: 0 });
  });

  it('replaces missing and repeated ids without reusing a kept one', () => {
    const { points } = reviveRefPoints([
      { id: 'r1', plane: 'outline', x: 1, y: 1 },
      { id: 'r1', plane: 'outline', x: 2, y: 2 },
      { plane: 'outline', x: 3, y: 3 },
      { id: '', plane: 'outline', x: 4, y: 4 },
    ]);
    expect(points.map((p) => p.id)).toEqual(['r1', 'r2', 'r3', 'r4']);
  });

  it('drops a side other than minus and an empty label', () => {
    const { points } = reviveRefPoints([
      { id: 'a', plane: 'outline', x: 1, y: 1, side: 'plus', label: '  ' },
    ]);
    expect(points).toEqual([{ id: 'a', plane: 'outline', x: 1, y: 1 }]);
  });
});

describe('refIdAllocator', () => {
  it('skips taken ids and never repeats', () => {
    const next = refIdAllocator(['r1', 'r3']);
    expect([next(), next(), next()]).toEqual(['r2', 'r4', 'r5']);
  });
});

describe('refPointSectionIndex', () => {
  it('finds the section within 0.5 mm of the station, nearest first', () => {
    const b = withStations(0, 30.48, 92.7, 92.74, 187.96);
    expect(refPointSectionIndex(b, sectionPoint(92.71))).toBe(2);
    expect(refPointSectionIndex(b, sectionPoint(92.73))).toBe(3);
    expect(refPointSectionIndex(b, sectionPoint(30.52))).toBe(1);
  });

  it('is -1 when no section is within tolerance', () => {
    const b = withStations(0, 30.48, 187.96);
    expect(refPointSectionIndex(b, sectionPoint(30.54))).toBe(-1);
    expect(refPointSectionIndex(b, sectionPoint(100))).toBe(-1);
  });
});

describe('refPointBoardValue', () => {
  const b = board(
    splineFromKnots([
      knot(vec2(0, 0), vec2(0, 0), vec2(10, 20)),
      knot(vec2(100, 20), vec2(90, 20), vec2(100, 20)),
    ]),
    line,
    splineFromKnots([
      knot(vec2(0, 8), vec2(0, 8), vec2(1, 8)),
      knot(vec2(3, 8), vec2(2, 8), vec2(3, 8)),
    ]),
    [crossSection(0, line)],
  );

  it('reads the outline half-width and the chosen rocker curve at the point', () => {
    expect(refPointBoardValue(b, { id: 'a', plane: 'outline', x: 100, y: 0 })).toBeCloseTo(20, 9);
    expect(
      refPointBoardValue(b, { id: 'b', plane: 'rocker', curve: 'bottom', x: 2, y: 5 }),
    ).toBeCloseTo(0, 9);
    expect(
      refPointBoardValue(b, { id: 'c', plane: 'rocker', curve: 'deck', x: 2, y: 5 }),
    ).toBeCloseTo(8, 9);
  });

  it('is null outside the board and for section points', () => {
    expect(refPointBoardValue(b, { id: 'a', plane: 'outline', x: 101, y: 1 })).toBeNull();
    expect(refPointBoardValue(b, { id: 'a', plane: 'outline', x: -1, y: 1 })).toBeNull();
    expect(refPointBoardValue(b, sectionPoint(0))).toBeNull();
  });
});
