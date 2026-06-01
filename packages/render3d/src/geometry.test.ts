/**
 * Tests for geometry.ts — boardGeometry and boardSpan.
 *
 * boardGeometry wraps tessellateBoard with Three.js BufferGeometry. We test the
 * pure numeric output (vertex / index / normal counts, centering, span) by
 * calling tessellateBoard directly and verifying the invariants that
 * boardGeometry enforces. Three.js BufferGeometry is imported from 'three' which
 * is a dev dependency of this package, so it is available in Vitest without needing
 * a real WebGL context (Three.js geometry objects are plain JS — no GPU required).
 */
import {
  board,
  crossSection,
  knot,
  splineFromKnots,
  tessellateBoard,
  vec2,
  type BezierBoard,
} from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import { boardGeometry, boardSpan } from './geometry';

// ---------------------------------------------------------------------------
// Shared test board — same shape used in board-store.test.ts so the tessellator
// has at least 3 cross-sections and can produce a valid mesh.
// ---------------------------------------------------------------------------
function makeBoard(): BezierBoard {
  const k = (ex: number, ey: number) => knot(vec2(ex, ey), vec2(ex - 5, ey), vec2(ex + 5, ey));
  const outline = splineFromKnots([k(0, 0), k(50, 20), k(100, 0)]);
  const bottom = splineFromKnots([k(0, 5), k(100, 5)]);
  const deck = splineFromKnots([k(0, 11), k(100, 11)]);
  const prof = splineFromKnots([
    knot(vec2(0, 5), vec2(0, 5), vec2(10, 5)),
    knot(vec2(10, 8), vec2(10, 6), vec2(10, 8)),
  ]);
  const cs = [crossSection(0, prof), crossSection(50, prof), crossSection(100, prof)];
  return board(outline, bottom, deck, cs);
}

// ---------------------------------------------------------------------------
// tessellateBoard — pure kernel function, no Three.js dependency.
// ---------------------------------------------------------------------------
describe('tessellateBoard (kernel)', () => {
  it('produces non-empty typed arrays for a valid board', () => {
    const mesh = tessellateBoard(makeBoard());
    expect(mesh.positions.length).toBeGreaterThan(0);
    expect(mesh.indices.length).toBeGreaterThan(0);
    expect(mesh.normals.length).toBeGreaterThan(0);
  });

  it('positions array length is a multiple of 3 (xyz triples)', () => {
    const mesh = tessellateBoard(makeBoard());
    expect(mesh.positions.length % 3).toBe(0);
  });

  it('normals array is same length as positions', () => {
    const mesh = tessellateBoard(makeBoard());
    expect(mesh.normals.length).toBe(mesh.positions.length);
  });

  it('indices array length is a multiple of 3 (triangle list)', () => {
    const mesh = tessellateBoard(makeBoard());
    expect(mesh.indices.length % 3).toBe(0);
  });

  it('all vertex indices are in-range for the positions array', () => {
    const mesh = tessellateBoard(makeBoard());
    const vertCount = mesh.positions.length / 3;
    for (let i = 0; i < mesh.indices.length; i++) {
      expect(mesh.indices[i]).toBeGreaterThanOrEqual(0);
      expect(mesh.indices[i]).toBeLessThan(vertCount);
    }
  });

  it('all normals are unit length (±1e-4)', () => {
    const mesh = tessellateBoard(makeBoard());
    for (let v = 0; v < mesh.positions.length / 3; v++) {
      const nx = mesh.normals[v * 3]!;
      const ny = mesh.normals[v * 3 + 1]!;
      const nz = mesh.normals[v * 3 + 2]!;
      const len = Math.hypot(nx, ny, nz);
      expect(len).toBeCloseTo(1, 4);
    }
  });

  it('produces fewer vertices with smaller lengthSteps', () => {
    const b = makeBoard();
    const coarse = tessellateBoard(b, { lengthSteps: 8 });
    const fine = tessellateBoard(b, { lengthSteps: 40 });
    expect(coarse.positions.length).toBeLessThan(fine.positions.length);
  });

  it('returns empty arrays for a board with too few cross-sections', () => {
    // No cross-sections → volume computations degenerate; tessellator should return empty.
    const outline = splineFromKnots([
      knot(vec2(0, 0), vec2(0, 0), vec2(10, 0)),
      knot(vec2(100, 0), vec2(90, 0), vec2(100, 0)),
    ]);
    const flat = splineFromKnots([
      knot(vec2(0, 5), vec2(0, 5), vec2(10, 5)),
      knot(vec2(100, 5), vec2(90, 5), vec2(100, 5)),
    ]);
    const b = board(outline, flat, flat, []); // no cross-sections
    const mesh = tessellateBoard(b);
    // With no cross-sections every ring returns null → empty mesh
    expect(mesh.positions.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// boardSpan — pure numeric, uses tessellateBoard internally.
// ---------------------------------------------------------------------------
describe('boardSpan', () => {
  it('returns a positive finite span for a valid board', () => {
    const span = boardSpan(makeBoard());
    expect(Number.isFinite(span)).toBe(true);
    expect(span).toBeGreaterThan(0);
  });

  it('span is close to the board length (within a factor of 2)', () => {
    // The board outline runs 0..100 cm, so span should be roughly 100 cm.
    const span = boardSpan(makeBoard());
    expect(span).toBeGreaterThan(50);
    expect(span).toBeLessThan(200);
  });

  it('falls back to 200 when the board produces no geometry', () => {
    const outline = splineFromKnots([
      knot(vec2(0, 0), vec2(0, 0), vec2(10, 0)),
      knot(vec2(100, 0), vec2(90, 0), vec2(100, 0)),
    ]);
    const flat = splineFromKnots([
      knot(vec2(0, 5), vec2(0, 5), vec2(10, 5)),
      knot(vec2(100, 5), vec2(90, 5), vec2(100, 5)),
    ]);
    const b = board(outline, flat, flat, []);
    expect(boardSpan(b)).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// boardGeometry — Three.js wrapper (no WebGL needed; BufferGeometry is pure JS).
// ---------------------------------------------------------------------------
describe('boardGeometry (Three.js wrapper)', () => {
  it('returns a BufferGeometry with position, normal and index attributes', () => {
    const g = boardGeometry(makeBoard());
    expect(g.attributes['position']).toBeTruthy();
    expect(g.attributes['normal']).toBeTruthy();
    expect(g.index).toBeTruthy();
  });

  it('position attribute item size is 3', () => {
    const g = boardGeometry(makeBoard());
    expect(g.attributes['position']!.itemSize).toBe(3);
  });

  it('normal attribute item size is 3', () => {
    const g = boardGeometry(makeBoard());
    expect(g.attributes['normal']!.itemSize).toBe(3);
  });

  it('vertex count matches tessellation', () => {
    const b = makeBoard();
    const mesh = tessellateBoard(b);
    const g = boardGeometry(b);
    // After center() the vertex count is unchanged
    expect(g.attributes['position']!.count).toBe(mesh.positions.length / 3);
  });

  it('is centered (bounding box min+max ≈ 0) after boardGeometry call', () => {
    const g = boardGeometry(makeBoard());
    g.computeBoundingBox();
    const bb = g.boundingBox!;
    // center() shifts so midpoint is at origin; allow small float error
    expect((bb.min.x + bb.max.x) / 2).toBeCloseTo(0, 3);
    expect((bb.min.y + bb.max.y) / 2).toBeCloseTo(0, 3);
    expect((bb.min.z + bb.max.z) / 2).toBeCloseTo(0, 3);
  });
});
