// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  closedPath,
  fitSlices,
  halfPath,
  measureSlice,
  toScreen,
  wantedPlaces,
} from './rail-slice';

/** A half section: bottom centre, out over a widest point at (10, 1.2), up to the deck centre at height 2.5. */
const HALF = [0, 0, 4, 0.1, 8, 0.6, 10, 1.2, 8.5, 2, 4, 2.4, 0, 2.5];

describe('measuring a half section', () => {
  it('finds the half width and the apex at the widest point, and the thickness at the stringer', () => {
    expect(measureSlice(HALF)).toEqual({
      halfWidth: 10,
      thickness: 2.5,
      apex: { y: 10, z: 1.2 },
      zMin: 0,
      zMax: 2.5,
    });
  });

  it('takes the first of two equally wide points as the apex', () => {
    expect(measureSlice([0, 0, 5, 1, 5, 2, 0, 3])!.apex).toEqual({ y: 5, z: 1 });
  });

  it('finds the thickness from the ends, whatever the heights between', () => {
    // a concave bottom dips below the bottom centre
    expect(measureSlice([0, 0, 3, -0.4, 9, 1, 0, 2.2])).toMatchObject({
      thickness: 2.2,
      zMin: -0.4,
      zMax: 2.2,
    });
  });

  it('is nothing for fewer than two points, or a number that is not one', () => {
    expect(measureSlice([])).toBeNull();
    expect(measureSlice([1, 2])).toBeNull();
    expect(measureSlice([0, 0, Number.NaN, 1])).toBeNull();
  });
});

describe('fitting sections in a box', () => {
  const m = measureSlice(HALF)!;

  it('takes the largest scale at which the width and the height fit, one scale for both axes', () => {
    // 360 px across for 20 cm, 160 px up for 2.5 cm: the width decides
    const f = fitSlices([m], { width: 400, height: 200 }, { x: 20, top: 20, bottom: 20 })!;
    expect(f.scale).toBe(18);
    expect(f.cx).toBe(200);
    expect(f.zMid).toBe(1.25);
    // a box so low that the height decides
    const flat = fitSlices([m], { width: 400, height: 60 }, { x: 20, top: 10, bottom: 10 })!;
    expect(flat.scale).toBe(16);
  });

  it('fits the widest of several, so they are drawn to one scale', () => {
    const wide = measureSlice([0, 0, 20, 1, 0, 2])!;
    const f = fitSlices([m, wide], { width: 440, height: 200 }, { x: 20, top: 20, bottom: 20 })!;
    expect(f.scale).toBe(10);
  });

  it('is nothing with nothing to fit or no room', () => {
    expect(fitSlices([], { width: 400, height: 200 }, { x: 0, top: 0, bottom: 0 })).toBeNull();
    expect(fitSlices([m], { width: 30, height: 200 }, { x: 20, top: 20, bottom: 20 })).toBeNull();
    expect(
      fitSlices(
        [measureSlice([0, 0, 0, 1])!],
        { width: 400, height: 200 },
        { x: 0, top: 0, bottom: 0 },
      ),
    ).toBeNull();
  });
});

describe('drawing it', () => {
  const frame = { scale: 10, cx: 100, cy: 50, zMid: 1.25 };

  it('puts the left half left of the stringer, the right right of it, and up as up', () => {
    expect(toScreen(frame, 4, 1.25, 'left')).toEqual({ x: 60, y: 50 });
    expect(toScreen(frame, 4, 1.25, 'right')).toEqual({ x: 140, y: 50 });
    expect(toScreen(frame, 0, 2.5, 'right').y).toBeLessThan(toScreen(frame, 0, 0, 'right').y);
  });

  it('writes a half as an open path from the bottom centre', () => {
    const d = halfPath([0, 0, 4, 1.25, 0, 2.5], frame, 'right');
    expect(d).toBe('M100 62.5 L140 50 L100 37.5');
  });

  it('closes the two halves into one outline: left up, right back down', () => {
    const d = closedPath(HALF, HALF, frame);
    expect(d.startsWith('M100 62.5')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
    // the left half's widest point and the right half's
    expect(d).toContain('L0 ');
    expect(d).toContain('L200 ');
  });
});

describe('the places asked of the engine', () => {
  it('are the cursor and the two ends of the chosen zone, none twice', () => {
    expect(wantedPlaces(50, null)).toEqual([50]);
    expect(wantedPlaces(50, { from: 20, to: 60 })).toEqual([50, 20, 60]);
    expect(wantedPlaces(20, { from: 20, to: 20 })).toEqual([20]);
  });
});
