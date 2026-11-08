// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { coonsGrid, gridFolds, spline1, spline2, winslowGrid, type Sides } from './smooth-map';

describe('the smooth blade’s splines', () => {
  it('follow any cubic exactly, between the samples too', () => {
    const f = (x: number) => 0.3 * x ** 3 - 2 * x ** 2 + x - 4;
    const s = spline1(Array.from({ length: 9 }, (_, i) => f(i)));
    for (let x = 0; x <= 8; x += 0.37) {
      expect(s.at(x)).toBeCloseTo(f(x), 9);
      expect(s.slope(x)).toBeCloseTo(0.9 * x ** 2 - 4 * x + 1, 8);
    }
  });

  it('pass through every sample, and follow a smooth curve closely between them', () => {
    const s = spline1(Array.from({ length: 21 }, (_, i) => Math.sin(i / 3)));
    for (let i = 0; i <= 20; i++) expect(s.at(i)).toBeCloseTo(Math.sin(i / 3), 12);
    for (let x = 0.5; x < 20; x += 1)
      expect(Math.abs(s.at(x) - Math.sin(x / 3))).toBeLessThan(2e-4);
  });

  it('over a grid, follow any bicubic exactly', () => {
    const f = (r: number, c: number) => (r ** 3 - 2 * r) * (0.5 * c ** 3 + c ** 2 - 1) + r * c;
    const rows = 6;
    const cols = 8;
    const v = Array.from({ length: (rows + 1) * (cols + 1) }, (_, k) =>
      f(Math.floor(k / (cols + 1)), k % (cols + 1)),
    );
    const s = spline2(v, rows, cols);
    for (let r = 0; r <= rows; r += 0.41) {
      for (let c = 0; c <= cols; c += 0.53) expect(s.at(r, c)).toBeCloseTo(f(r, c), 7);
    }
  });
});

describe('the elliptic grid', () => {
  /** A quadratic Bézier from a through b to c. */
  const q = (a: readonly number[], b: readonly number[], c: readonly number[]) => (t: number) => ({
    x: (1 - t) ** 2 * a[0]! + 2 * t * (1 - t) * b[0]! + t * t * c[0]!,
    y: (1 - t) ** 2 * a[1]! + 2 * t * (1 - t) * b[1]! + t * t * c[1]!,
  });
  // A hook: the leading edge up from (0, 0) and over to the left, the tip edge round a
  // half circle, and the trailing edge up from (−6, 0) under the curl, concave.
  const hook: Sides = {
    bottom: (t) => ({ x: -6 * t, y: 0 }),
    left: q([0, 0], [1, 12], [-10, 14]),
    right: q([-6, 0], [-5, 6], [-10, 8]),
    top: (t) => {
      const th = Math.PI / 2 + Math.PI * t;
      return { x: -10 + 3 * Math.cos(th), y: 11 + 3 * Math.sin(th) };
    },
  };

  it('keeps the sides where they are', () => {
    const g = winslowGrid(hook, 24, 16);
    const w = 17;
    for (let i = 0; i <= 24; i++) {
      const l = hook.left(i / 24);
      expect(g.x[i * w]).toBeCloseTo(l.x, 12);
      expect(g.y[i * w]).toBeCloseTo(l.y, 12);
    }
  });

  it('lays out a hooked region without folding, where plain averaging starts folded', () => {
    expect(gridFolds(coonsGrid(hook, 24, 16))).toBe(true);
    expect(gridFolds(winslowGrid(hook, 24, 16))).toBe(false);
    expect(gridFolds(winslowGrid(hook, 64, 40))).toBe(false);
  });
});
