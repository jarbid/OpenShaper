// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Which classic samples lie inside a plan loop (docs/design/board2.md §9.6).
 *
 * The loft samples come in rows of constant x, so membership is decided per
 * row: the loop's crossings with the line x = const are found exactly on its
 * Bézier pieces (each piece's x is monotone between the closed-form roots of
 * x′, and the crossing is bisected to the last bit there), and a point of the
 * row is inside when an odd number of crossings lies above it. That is the
 * ray-crossing (winding) rule of geom's `classifyUV`, with the ray along the
 * row, so a row costs one root solve per piece rather than one classification
 * per sample (`classifyUV` decomposes the loop on every call). Crossings are
 * counted half-open in x (`xa ≤ x < xb`), so a piece end on the line counts
 * once. The loop need not be a graph over x (an inset loop where the
 * curvature cap shrinks the inset quickly is not). A row through the loop's
 * extreme x touches it (a tangency): degenerate for any ray rule; the
 * converter's rows start inside the classic's solid span, past the tips.
 */
import type { PeriodicCurve, Tolerances } from '@openshaper/geom';
import { planPieces, quadraticRoots } from '../plan';
import type { PlanPiece } from '../plan';

function bez(p: Float64Array, k: number, s: number): number {
  const r = 1 - s;
  return (
    r * r * r * p[k]! +
    3 * r * r * s * p[2 + k]! +
    3 * r * s * s * p[4 + k]! +
    s * s * s * p[6 + k]!
  );
}

/** A loop prepared for row tests. */
export interface RowClassifier {
  /** The y of every crossing of the loop with the line at `x`, ascending. */
  readonly crossings: (x: number) => Float64Array;
  /** Inside test against crossings from {@link RowClassifier.crossings}: an odd count above `y`. */
  readonly inside: (ys: Float64Array, y: number) => boolean;
}

export function rowClassifier(loop: PeriodicCurve<2>, tol?: Partial<Tolerances>): RowClassifier {
  const pieces: readonly PlanPiece[] = planPieces(loop, tol);
  // Monotone sub-intervals of every piece in x.
  const monos: { p: Float64Array; s0: number; s1: number; x0: number; x1: number }[] = [];
  for (const pc of pieces) {
    const p = pc.p;
    const cuts = [0, ...quadraticRoots([p[2]! - p[0]!, p[4]! - p[2]!, p[6]! - p[4]!]), 1];
    for (let k = 0; k + 1 < cuts.length; k++) {
      const s0 = cuts[k]!;
      const s1 = cuts[k + 1]!;
      monos.push({ p, s0, s1, x0: bez(p, 0, s0), x1: bez(p, 0, s1) });
    }
  }
  return {
    crossings: (x: number): Float64Array => {
      const ys: number[] = [];
      for (const m of monos) {
        const up = m.x0 <= x && x < m.x1;
        const down = m.x1 <= x && x < m.x0;
        if (!up && !down) continue;
        // Bisect for x(s) = x on the monotone interval.
        let lo = m.s0;
        let hi = m.s1;
        for (;;) {
          const mid = 0.5 * (lo + hi);
          if (!(mid > lo && mid < hi)) break;
          const below = bez(m.p, 0, mid) < x;
          if (below === up) lo = mid;
          else hi = mid;
        }
        ys.push(bez(m.p, 1, 0.5 * (lo + hi)));
      }
      return Float64Array.from(ys).sort();
    },
    inside: (ys: Float64Array, y: number): boolean => {
      let above = 0;
      for (const c of ys) if (c > y) above++;
      return above % 2 === 1;
    },
  };
}
