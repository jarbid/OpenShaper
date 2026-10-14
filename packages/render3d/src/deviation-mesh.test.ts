// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The deviation analysis mesh: the hull's own mesh with each vertex's signed distance
 * to the ghost, its end-cap hubs left as no data.
 */
import {
  board,
  crossSection,
  getLength,
  scaleSpline,
  tessellateBoard,
  type BezierBoard,
} from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import { BAND_VALENCE, boardDeviationMesh, fanHubs } from './deviation-mesh';
import { stationBoard, swallowBoard } from './test-support/boards';

const valences = (indices: Uint32Array, vertexCount: number): Uint32Array => {
  const v = new Uint32Array(vertexCount);
  for (const i of indices) v[i]!++;
  return v;
};

/** The board stretched along its length by `f` (the tail stays at x = 0). */
const stretched = (b: BezierBoard, f: number): BezierBoard =>
  board(
    scaleSpline(b.outline, 1, f),
    scaleSpline(b.bottom, 1, f),
    scaleSpline(b.deck, 1, f),
    b.crossSections.map((cs) => crossSection(cs.position * f, cs.spline)),
    b.interpolationType,
    b.fins,
  );

describe('fanHubs', () => {
  // The viewport's three mesh qualities, and a coarse one.
  const FACE_SIZES = [0.5, 0.9, 1.5, 3];

  it('finds the two end-cap hubs of an ordinary board, which the mesh appends last', () => {
    for (const face of FACE_SIZES) {
      const m = tessellateBoard(stationBoard(), { targetFaceSize: face });
      const n = m.positions.length / 3;
      expect(fanHubs(m.indices, n)).toEqual([n - 2, n - 1]);
    }
  });

  it('finds the four hubs that close a swallow tail’s two pods', () => {
    for (const face of FACE_SIZES) {
      const m = tessellateBoard(swallowBoard(), { targetFaceSize: face });
      const n = m.positions.length / 3;
      expect(fanHubs(m.indices, n)).toEqual([n - 4, n - 3, n - 2, n - 1]);
    }
  });

  it('rests on no band vertex belonging to more than BAND_VALENCE triangles', () => {
    for (const b of [stationBoard(), swallowBoard()]) {
      const m = tessellateBoard(b, { targetFaceSize: 0.9 });
      const n = m.positions.length / 3;
      const hubs = new Set(fanHubs(m.indices, n));
      const v = valences(m.indices, n);
      let most = 0;
      for (let i = 0; i < n; i++) if (!hubs.has(i)) most = Math.max(most, v[i]!);
      expect(most).toBe(BAND_VALENCE);
    }
  });
});

describe('boardDeviationMesh', () => {
  it('is the hull’s own mesh, so the map lands on the triangles the hull draws', () => {
    const b = stationBoard();
    const hull = tessellateBoard(b, { targetFaceSize: 1.5 });
    const m = boardDeviationMesh(b, b, 1.5);
    expect(m.positions).toEqual(hull.positions);
    expect(m.indices).toEqual(hull.indices);
    expect(m.deviation).toHaveLength(hull.positions.length / 3);
  });

  it('reads zero against the board itself, with no data only at the hubs', () => {
    for (const b of [stationBoard(), swallowBoard()]) {
      const m = boardDeviationMesh(b, b, 1.5);
      const n = m.positions.length / 3;
      const hubs = fanHubs(m.indices, n);
      expect(m.noData).toBe(hubs.length);
      for (const h of hubs) expect(m.deviation[h]).toBeNaN();
      const [lo, hi] = m.range!;
      expect(lo).toBeGreaterThan(-0.01);
      expect(hi).toBeLessThan(0.01);
    }
  });

  it('marks everything past a shorter ghost’s nose as no data, and measures the rest', () => {
    const b = stationBoard();
    const ghost = stretched(b, 0.9);
    const m = boardDeviationMesh(b, ghost, 1.5);
    const n = m.positions.length / 3;
    const hubs = new Set(fanHubs(m.indices, n));
    let beyond = 0;
    for (let i = 0; i < n; i++) {
      const x = m.positions[i * 3]!;
      if (x > getLength(ghost) + 1e-3) {
        beyond++;
        expect(m.deviation[i]).toBeNaN();
      } else if (!hubs.has(i)) {
        expect(Number.isFinite(m.deviation[i])).toBe(true);
      }
    }
    expect(beyond).toBeGreaterThan(0);
    // The tail hub is measured nowhere either, the nose hub is past the ghost anyway.
    expect(m.noData).toBe(beyond + 1);
  });

  it('reports the range of a narrower ghost as mostly more foam', () => {
    const b = stationBoard();
    const ghost = board(
      scaleSpline(b.outline, 0.95, 1),
      b.bottom,
      b.deck,
      b.crossSections,
      b.interpolationType,
      b.fins,
    );
    const { range } = boardDeviationMesh(b, ghost, 1.5);
    // 5% of the 25 cm half-width at the widest point: about 12 mm more foam.
    expect(range![1]).toBeGreaterThan(1.1);
    expect(range![1]).toBeLessThan(1.3);
  });

  it('has no range when nothing could be measured', () => {
    const b = stationBoard();
    const m = boardDeviationMesh(b, { ...b, crossSections: [] }, 3);
    expect(m.range).toBeNull();
    expect(m.noData).toBe(m.positions.length / 3);
  });
});
