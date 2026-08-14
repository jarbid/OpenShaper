// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * How the mesh closes the two ends.
 *
 * `capEnd` used to fan every end ring to a single off-plane apex on the centerline.
 * For a board that really tapers to a point that is right; for one with a blunt end —
 * a squash, square or wide round tail — it collapsed a full-width transom to a single
 * vertex, so the STL a shaper cuts was missing the flat the design has. The cap is now
 * chosen per end from the board's UNfloored width there.
 *
 * The distinction matters because `loftSection` floors width and thickness at MIN_DIM,
 * so an end ring never reports zero size and the mesh cannot tell a real tip from a
 * blunt end by looking at the ring alone.
 */
import { describe, expect, it } from 'vitest';
import { getLength, getWidthAtPos } from './board';
import { MIN_DIM } from './loft';
import { tessellateBoard, type BoardMesh } from './tessellate';
import { boxBoard, curvyBoard } from './test-support/synthetic-boards';

/** Vertices within `tol` of the given x, as [y, z] pairs. */
const vertsAtX = (mesh: BoardMesh, x: number, tol = 1e-4): [number, number][] => {
  const out: [number, number][] = [];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    if (Math.abs(mesh.positions[i]! - x) <= tol) {
      out.push([mesh.positions[i + 1]!, mesh.positions[i + 2]!]);
    }
  }
  return out;
};

const xRange = (mesh: BoardMesh): [number, number] => {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = mesh.positions[i]!;
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  return [lo, hi];
};

describe('tessellateBoard: blunt ends get a flat cap', () => {
  const HALF_WIDTH = 20;
  const LENGTH = 100;
  const board = boxBoard({ length: LENGTH, halfWidth: HALF_WIDTH, thickness: 5 });
  const mesh = tessellateBoard(board, { lengthSteps: 40, ringSteps: 24 });

  it('the fixture really is blunt at both ends', () => {
    expect(getWidthAtPos(board, 0)).toBeGreaterThan(MIN_DIM);
    expect(getWidthAtPos(board, LENGTH)).toBeGreaterThan(MIN_DIM);
  });

  it('puts a full ring — not a lone apex — on each end plane', () => {
    // The old off-plane apex left exactly ONE vertex on the end plane. A flat cap
    // puts the whole ring there, plus its hub.
    expect(vertsAtX(mesh, 0).length).toBeGreaterThan(3);
    expect(vertsAtX(mesh, LENGTH).length).toBeGreaterThan(3);
  });

  it('spans the full transom width at each end', () => {
    for (const x of [0, LENGTH]) {
      const spread = Math.max(...vertsAtX(mesh, x).map(([y]) => Math.abs(y)));
      // Rail sampling lands a point at the widest place on a rectangular section.
      expect(Math.abs(spread - HALF_WIDTH)).toBeLessThan(0.05);
    }
  });

  it('keeps the cap planar', () => {
    // Every capped vertex shares the end plane exactly; nothing juts fore or aft.
    const [lo, hi] = xRange(mesh);
    expect(lo).toBe(0);
    expect(hi).toBe(LENGTH);
  });
});

describe('tessellateBoard: pointed ends still come to a point', () => {
  const board = curvyBoard();
  const length = getLength(board);
  const mesh = tessellateBoard(board, { lengthSteps: 40, ringSteps: 24 });

  it('the fixture really is pointed at both ends', () => {
    expect(getWidthAtPos(board, 0)).toBeLessThan(MIN_DIM);
    expect(getWidthAtPos(board, length)).toBeLessThan(MIN_DIM);
  });

  it('closes each tip with a single apex on the centerline', () => {
    for (const x of [0, length]) {
      const tip = vertsAtX(mesh, x);
      expect(tip).toHaveLength(1);
      expect(tip[0]![0]).toBe(0); // y — on the stringer
    }
  });

  it('still spans the full length', () => {
    // The apex sits at the true tip, so insetting the last station costs no length.
    const [lo, hi] = xRange(mesh);
    expect(lo).toBe(0);
    expect(Math.abs(hi - length)).toBeLessThan(1e-4);
  });
});
