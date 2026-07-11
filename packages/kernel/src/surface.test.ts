// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { splineFromKnots, valueAt } from './bezier-spline';
import { board, getDeckAtPos, getRockerAtPos, getWidthAtPos } from './board';
import { hasTailCutout, yInOut, cachedOutlineSegments } from './outline-cutout';
import { knotFromArray } from './knot';
import { bottomZAt, deckZAt, outlineInsetHalfWidthAt, outlineInsetPointAt } from './surface';
import { boxBoard, curvyBoard } from './test-support/synthetic-boards';

const third = (ax: number, ay: number, bx: number, by: number): [number, number] => [
  ax + (bx - ax) / 3,
  ay + (by - ay) / 3,
];

/** Curvy board body with a swallow-tail outline (notch bottom at x=18). */
const swallowBoard = () => {
  const base = curvyBoard();
  const outline = splineFromKnots([
    knotFromArray([18, 0, 18, 0, ...third(18, 0, 0, 9)], false, false),
    knotFromArray([0, 9, ...third(0, 9, 18, 0), ...third(0, 9, 50, 25)], false, false),
    knotFromArray([50, 25, ...third(50, 25, 0, 9), ...third(50, 25, 100, 0)], false, false),
    knotFromArray([100, 0, ...third(100, 0, 50, 25), 100, 0], false, false),
  ]);
  return board(outline, base.bottom, base.deck, base.crossSections, base.interpolationType);
};

describe('deckZAt / bottomZAt', () => {
  it('box board: deck = thickness, bottom = 0, everywhere on the surface', () => {
    const b = boxBoard({ length: 100, halfWidth: 20, thickness: 5 });
    for (const x of [10, 50, 90]) {
      for (const y of [0, 5, 15, 19.5]) {
        expect(bottomZAt(b, x, y)).toBeCloseTo(0, 6);
        expect(deckZAt(b, x, y)).toBeCloseTo(5, 6);
      }
    }
  });

  it('box board with linear rocker: z follows slope·x exactly', () => {
    const k = 0.08;
    const b = boxBoard({ length: 100, halfWidth: 20, thickness: 5, rockerSlope: k });
    for (const x of [10, 50, 90]) {
      for (const y of [0, 10, 18]) {
        expect(bottomZAt(b, x, y)).toBeCloseTo(k * x, 4);
        expect(deckZAt(b, x, y)).toBeCloseTo(k * x + 5, 4);
      }
    }
  });

  it('centreline identities on a curvy board', () => {
    const b = curvyBoard();
    for (const x of [20, 50, 80]) {
      expect(bottomZAt(b, x, 0)).toBeCloseTo(getRockerAtPos(b, x), 4);
      expect(deckZAt(b, x, 0)).toBeCloseTo(getDeckAtPos(b, x), 4);
    }
  });

  it('clamps lateral overshoot instead of returning garbage', () => {
    const b = curvyBoard();
    const half = getWidthAtPos(b, 50) / 2;
    const dOver = deckZAt(b, 50, half * 2);
    const bOver = bottomZAt(b, 50, half * 2);
    expect(Number.isFinite(dOver)).toBe(true);
    expect(Number.isFinite(bOver)).toBe(true);
    expect(dOver).toBeGreaterThanOrEqual(bOver);
  });

  it('returns NaN outside the board length', () => {
    const b = curvyBoard();
    expect(Number.isNaN(deckZAt(b, -5, 0))).toBe(true);
    expect(Number.isNaN(bottomZAt(b, 105, 0))).toBe(true);
  });

  it('swallow tail: agrees with the cutout lateral remap', () => {
    const b = swallowBoard();
    expect(hasTailCutout(b.outline)).toBe(true);
    const x = 9; // inside the notch
    const { yIn, yOut } = yInOut(cachedOutlineSegments(b.outline), x);
    expect(yIn).toBeGreaterThan(0.5);
    // The inner wall welds to the section start: bottom of the wall = rocker.
    expect(bottomZAt(b, x, yIn)).toBeCloseTo(getRockerAtPos(b, x), 3);
    // Mid-band: a real surface span.
    const yMid = (yIn + yOut) / 2;
    expect(deckZAt(b, x, yMid)).toBeGreaterThan(bottomZAt(b, x, yMid));
  });
});

describe('outlineInsetPointAt', () => {
  it('box board: inset by d is exactly (x, halfWidth − d)', () => {
    const b = boxBoard({ length: 100, halfWidth: 20 });
    for (const x of [10, 50, 90]) {
      const p = outlineInsetPointAt(b, x, 3);
      expect(p.x).toBeCloseTo(x, 6);
      expect(p.y).toBeCloseTo(17, 6);
    }
  });

  it('curvy outline: the inset point sits at distance d, inward', () => {
    const b = curvyBoard();
    for (const x of [30, 50, 70]) {
      const d = 2.5;
      const p = outlineInsetPointAt(b, x, d);
      const oy = valueAt(b.outline, x);
      // Distance from the outline point at the same station is >= the true
      // (perpendicular) distance d, and close to it where the outline is shallow.
      const dist = Math.hypot(p.x - x, p.y - oy);
      expect(dist).toBeGreaterThan(d * 0.99);
      expect(dist).toBeLessThan(d * 1.5);
      expect(p.y).toBeLessThan(oy);
    }
  });
});

describe('outlineInsetHalfWidthAt', () => {
  it('box board: constant halfWidth − d at every station', () => {
    const b = boxBoard({ length: 100, halfWidth: 20 });
    for (const x of [15, 50, 85]) {
      expect(outlineInsetHalfWidthAt(b, x, 3)).toBeCloseTo(17, 4);
    }
  });

  it('curvy outline: at max width the offset curve is d inside the outline', () => {
    const b = curvyBoard();
    // Max width is at x=50 where the outline tangent is longitudinal, so the
    // normal is purely lateral: offset half-width = outline − d exactly.
    expect(outlineInsetHalfWidthAt(b, 50, 2)).toBeCloseTo(valueAt(b.outline, 50) - 2, 3);
  });

  it('never exceeds the outline half-width', () => {
    const b = curvyBoard();
    for (const x of [20, 35, 65, 80]) {
      expect(outlineInsetHalfWidthAt(b, x, 2)).toBeLessThan(valueAt(b.outline, x));
    }
  });
});
