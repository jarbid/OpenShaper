// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { board, getRockerAtPos, getThicknessAtPos, type BezierBoard } from './board';
import { crossSection } from './cross-section';
import { crossSectionRing, stringerLoop } from './guides';
import { tessellateBoard } from './tessellate';
import { parseBrdGeometry } from './test-support/brd-geometry';
import { polylineSpline } from './test-support/synthetic-boards';

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = resolve(here, '../../../docs/specs/golden');

const loadBoard = (name: string) =>
  parseBrdGeometry(readFileSync(resolve(goldenDir, `${name}.brd`), 'utf8'));

const LENGTH_STEPS = 40;
const RING_STEPS = 24;
// A ring walks half = max(2, floor(24 / 2)) = 12 points up the +Y rail, then
// mirrors indices 10..1 back down the -Y rail — the two centreline points are
// shared, not duplicated. 12 + 10 = 22.
const RING_LEN = 22;

/** A board with no length at all — every guide query on it must return null. */
const zeroLengthBoard = (): BezierBoard => {
  const flat = polylineSpline([
    [0, 0],
    [0, 0],
  ]);
  return board(flat, flat, flat, [crossSection(0, flat), crossSection(0, flat)], 'controlPoint');
};

describe('crossSectionRing', () => {
  const b = loadBoard('shortboard');

  /**
   * The no-drift pin.
   *
   * `guides.ts` deliberately does NOT share code with the tessellator — the loft
   * surface is continuous, so a ring computed at any x lies on it. What the two
   * must share is the arc-length sampling convention, and this is what asserts
   * they still do. The station is read straight out of the mesh (every vertex in
   * one ring carries that ring's x), so the test never duplicates the
   * tessellator's station formula.
   */
  it('lands on the tessellated mesh at a station read from the mesh itself', () => {
    const mesh = tessellateBoard(b, { lengthSteps: LENGTH_STEPS, ringSteps: RING_STEPS });
    expect(mesh.positions.length / 3).toBe(LENGTH_STEPS * RING_LEN + 2); // +2 tip caps

    const x = mesh.positions[0]!; // ring 0's station
    const ring = crossSectionRing(b, x, RING_STEPS);
    expect(ring).not.toBeNull();
    expect(ring!).toHaveLength(RING_LEN);

    for (let i = 0; i < RING_LEN; i++) {
      const base = i * 3;
      // 4 decimal places = 1 micron. Not bit-exact only because `x` itself is a
      // float32 round-trip out of the mesh buffer.
      expect(ring![i]!.x).toBeCloseTo(mesh.positions[base]!, 4);
      expect(ring![i]!.y).toBeCloseTo(mesh.positions[base + 1]!, 4);
      expect(ring![i]!.z).toBeCloseTo(mesh.positions[base + 2]!, 4);
    }
  });

  it('closes around the hull: both rails, no duplicate centreline points', () => {
    const ring = crossSectionRing(b, 100, RING_STEPS)!;
    expect(ring.some((p) => p.y > 0)).toBe(true);
    expect(ring.some((p) => p.y < 0)).toBe(true);
    // Exactly two points sit on the centreline: the bottom and the deck.
    // 1e-6 cm (10 nm), not 0: the profile spline's fitted endpoint isn't bit-exact
    // zero (measured residual on this fixture is ~2.7e-9 cm), matching the
    // ADJUST_EPS convention in board.ts and the tolerance used below.
    expect(ring.filter((p) => Math.abs(p.y) < 1e-6)).toHaveLength(2);
  });

  it('returns null for a degenerate board instead of throwing', () => {
    expect(crossSectionRing(zeroLengthBoard(), 0, RING_STEPS)).toBeNull();
  });
});

describe('stringerLoop', () => {
  const b = loadBoard('shortboard');

  it('returns two points per station — deck out, bottom back', () => {
    const loop = stringerLoop(b, LENGTH_STEPS, RING_STEPS);
    expect(loop).not.toBeNull();
    expect(loop!).toHaveLength(LENGTH_STEPS * 2);
  });

  it('stays on the centreline', () => {
    // 1e-6 cm, not 0 — see the matching note in the crossSectionRing test above.
    for (const v of stringerLoop(b, LENGTH_STEPS, RING_STEPS)!) {
      expect(Math.abs(v.y)).toBeLessThan(1e-6);
    }
  });

  it('is bounded by the rocker and the deck', () => {
    for (const v of stringerLoop(b, LENGTH_STEPS, RING_STEPS)!) {
      const rocker = getRockerAtPos(b, v.x);
      expect(v.z).toBeGreaterThanOrEqual(rocker - 1e-6);
      expect(v.z).toBeLessThanOrEqual(rocker + getThicknessAtPos(b, v.x) + 1e-6);
    }
  });

  it('visits both surfaces rather than tracing one of them twice', () => {
    const loop = stringerLoop(b, LENGTH_STEPS, RING_STEPS)!;
    const heightAbove = (i: number) => loop[i]!.z - getRockerAtPos(b, loop[i]!.x);
    const mid = LENGTH_STEPS >> 1;
    expect(heightAbove(mid)).toBeGreaterThan(2); // deck half
    expect(heightAbove(loop.length - 1 - mid)).toBeLessThan(0.5); // bottom half
  });

  it('returns null for a degenerate board instead of throwing', () => {
    expect(stringerLoop(zeroLengthBoard(), LENGTH_STEPS, RING_STEPS)).toBeNull();
  });
});
