// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Continuity along a B-rep edge (design §6.18, B4): the two coedges of the edge
 * are the two sides of `edgeContinuity` (`continuity.ts`).
 *
 * A coedge's pcurve is parameterised like the edge curve. Looking along
 * increasing `t` in (u, v) the face lies on the **left** of the pcurve when the
 * face's (u, v) loop (material on the left, `faces.ts`) runs along `t`, which is
 * when the coedge's `sense` equals the face's `sameSense` (both true: the loop
 * is the face-orientation loop, along `t`; both false: reversed twice), and on
 * the right otherwise. That is `EdgeSide.interior`, which picks the one-sided
 * surface limit where the pcurve runs along a knot line.
 */
import { edgeContinuity } from '../continuity';
import type { ContinuityProfile, ContinuitySampling, EdgeSide } from '../continuity';
import { fail } from '../errors';
import type { Brep } from '../types';

/** Gap, normal angle and curvature mismatch along `edge`, between the faces on its two sides. */
export function brepEdgeContinuity(
  b: Brep,
  edge: number,
  opts?: ContinuitySampling,
): ContinuityProfile {
  const e = b.edges[edge];
  if (e === undefined) fail('brep-reference', `no edge ${edge}`, { edge });
  const sides: EdgeSide[] = [];
  b.faces.forEach((f) => {
    for (const loop of [f.outer, ...f.holes]) {
      for (const c of loop.coedges) {
        if (c.edge !== edge) continue;
        sides.push({
          surface: f.surface,
          pcurve: c.pcurve,
          sameSense: f.sameSense,
          interior: c.sense === f.sameSense ? 'left' : 'right',
        });
      }
    }
  });
  if (sides.length !== 2) {
    fail('brep-invalid', `edge ${edge} has ${sides.length} uses; continuity needs two`, { edge });
  }
  return edgeContinuity(e.curve, sides[0]!, sides[1]!, opts);
}
