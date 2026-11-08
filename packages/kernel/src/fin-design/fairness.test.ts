// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { fairness, type BladeSampler } from './fairness';

/** A face y = f(x, z) over a 10 × 10 cm square, sampled evenly; the inside face flat. */
const faceOf =
  (f: (x: number, z: number) => number): BladeSampler =>
  (rows, cols) => {
    const grid = (g: (x: number, z: number) => number) =>
      Array.from({ length: rows + 1 }, (_, i) =>
        Array.from({ length: cols + 1 }, (_, j) => {
          const x = (10 * j) / cols;
          const z = (10 * i) / rows;
          return { x, y: g(x, z), z };
        }),
      );
    return { outside: grid(f), inside: grid(() => 0) };
  };

describe('the smoothness gate', () => {
  it('passes a smooth face, however curved', () => {
    const dome = fairness(faceOf((x, z) => 3 - 0.04 * ((x - 5) ** 2 + (z - 5) ** 2)));
    expect(dome.smooth).toBe(true);
    // Strongly curved but smooth: turns a lot, and halves when sampled finer.
    const wave = fairness(faceOf((x, z) => Math.sin(x) * Math.cos(z * 0.7)));
    expect(wave.worst.deg).toBeGreaterThan(2);
    expect(wave.smooth).toBe(true);
  });

  it('finds a crease, and where it is', () => {
    // A ridge: the slope jumps by 2.3° across x = 4.3, a line between the grid's columns.
    const ridge = fairness(faceOf((x) => 0.02 * Math.abs(x - 4.3)));
    expect(ridge.smooth).toBe(false);
    for (const c of ridge.creases) expect(Math.abs(c.at.x - 4.3)).toBeLessThan(0.6);
  });

  it('finds a crease too slight to see by eye but not a fold below its floor', () => {
    // 0.5° across a line: a soft groove the zebra stripes show.
    const groove = fairness(faceOf((x, z) => 0.0044 * Math.abs(z - 6.1) + 0.01 * x));
    expect(groove.smooth).toBe(false);
    // 0.1°: under the floor.
    expect(fairness(faceOf((_x, z) => 0.0009 * Math.abs(z - 6.1))).smooth).toBe(true);
  });
});
