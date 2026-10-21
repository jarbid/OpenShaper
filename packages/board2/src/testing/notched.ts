// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A smooth notched (swallow-like) plan loop (docs/design/board2.md §3.8, §11.2
 * `notchedLoopFixture`). Test-only: it **bypasses the validator**, which refuses
 * it with `tail-not-standard`; step S4 builds the band and B-rep on it directly
 * to show that nothing below the validator slices by x.
 *
 * A uniform periodic cubic (knots `i / 22`), symmetric bitwise, counter-clockwise,
 * with the notch bottom (the tail centre, u = 0) at the origin as plan invariant
 * 1 asks: from there the −y half first runs **backwards** (x′ < 0) round a
 * swallow tip near (−6.5, −9) and only then forward to the nose at (180, 0).
 * The tightest radius of curvature is about 0.75 cm, at the notch bottom (so the
 * minimum band of §4, 0.2 cm, fits), and the loop is simple.
 *
 * As {@link stadiumPlan}, control point `i` sits at Greville u = (i + 2)/n; the
 * points are listed here in Greville order from the tail and rotated on output.
 */
import type { PlanLoopJSON } from '../types';

/** The −y half, Greville order, tail centre (Q_0) to nose (Q_11). */
const HALF: readonly (readonly [number, number])[] = [
  // (Q₋₁ + 4 Q₀ + Q₁)/6 = (0, 0): Q₀.x = −Q₁.x / 2.
  [2, 0],
  [-4, -3],
  [-8, -8],
  [-6, -14],
  [2, -18],
  [20, -22],
  [60, -25],
  [100, -25],
  [140, -22],
  [165, -15],
  [178, -6],
  // (2 · 178 + 4 x)/6 = 180.
  [181, 0],
];

/** The notched loop (see the module comment); a fresh copy on each call. */
export function notchedLoopFixture(): PlanLoopJSON {
  const half = HALF.length - 1;
  const n = 2 * half;
  const q: [number, number][] = HALF.map(([x, y]) => [x, y]);
  for (let k = half + 1; k < n; k++) {
    const [x, y] = HALF[n - k]!;
    q.push([x, -y]);
  }
  const points: number[] = [];
  for (let i = 0; i < n; i++) points.push(...q[(i + 2) % n]!);
  return { degree: 3, knots: Array.from({ length: n }, (_, i) => i / n), points };
}
