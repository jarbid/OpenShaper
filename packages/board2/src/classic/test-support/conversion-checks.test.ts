// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The plan oracle of the S6 exit (`measurePlan`) is sensitive inside the
 * fillet zones (review of S6): a loop that leaves a fillet arc between the
 * corner and the tangency point, where the corner's own distance and the
 * checks outside the zones see nothing, is caught.
 *
 * The loop is the converter's plan fit of a knife-tip file (tip and side
 * fillets), then the control point nearest the middle of the tail fillet's arc
 * (t = 0.55; the zone reaches to the tangent point at t = 1) and its mirror
 * partner are moved 0.02 cm outwards. The control point's basis function peaks
 * at about 2/3, so the loop moves by about 0.013 cm there: well above
 * `lineTol`, and inside the zone (spans of a few millimetres there; at
 * t = 0.8 the bump already reaches past the zone and the outside check sees it).
 */
import { describe, expect, it } from 'vitest';
import { controlPointsInto, makeCurve, resolveTolerances } from '@openshaper/geom';
import type { PeriodicCurve } from '@openshaper/geom';
import { periodicPairing } from '../../symmetry';
import { fitPlanLoop, loopData } from '../lines';
import { filletOutline, piecePoint, samplePiece } from '../outline';
import { DEFAULT_CONVERT_OPTIONS as O } from '../params';
import { measurePlan } from './conversion-checks';
import { classicSample } from './samples';

const tol = resolveTolerances();
const MOVE = 0.02;

describe('measurePlan inside the fillet zones', () => {
  const board = classicSample('synthetic-clean-6x22x2-75.s3dx').load();
  const f = filletOutline(board.outline, O, tol);
  const pts: [number, number][] = [];
  const fz: number[] = [];
  f.pieces.forEach((p, i) => {
    const arc = f.arcs.find((a) => a.piece === i);
    samplePiece(p, O.lineSampleSpacing).forEach((q, k) => {
      if (pts.length > 0 && k === 0) return;
      pts.push([q[0], q[1]]);
      fz.push(arc ? arc.fillet : -1);
    });
  });
  const shift = pts[0]![0];
  for (const p of pts) p[0] -= shift;
  pts[0]![1] = 0;
  pts[pts.length - 1]![1] = 0;
  const fit = fitPlanLoop(loopData(pts, fz), O.lineTol, O.surfaceKnotSpacing.x, tol);
  if (!('curve' in fit)) throw new Error(fit.message);

  it('passes the converter’s own loop', () => {
    const m = measurePlan(board.outline, fit.curve, shift, O, tol);
    expect(m.arcToLoop).toBeLessThanOrEqual(O.lineTol);
    expect(m.zoneLoopToFilleted).toBeLessThanOrEqual(O.lineTol);
    expect(m.filletMiss).toBeLessThanOrEqual(O.lineTol);
  });

  it('catches a loop that leaves the arc between the tip and the tangent point', () => {
    // The tail fillet's arc runs from the tip centre (t = 0) to the side (t = 1).
    const tail = f.arcs.find(({ fillet }) => f.fillets[fillet]!.tip && f.fillets[fillet]!.x < 1)!;
    const arc = f.pieces[tail.piece]!;
    if (arc.kind !== 'arc') throw new Error('not an arc');
    const [px, py] = piecePoint(arc, 0.55);
    const out = [(px - arc.cx) / arc.r, (py - arc.cy) / arc.r] as const;
    // The loop runs over the −y half first: the control point nearest the arc's mirror there.
    const n = fit.curve.basis.count;
    const P = new Float64Array(2 * n);
    controlPointsInto(fit.curve, P, 0);
    let i = 0;
    for (let k = 1; k < n; k++) {
      const d = (j: number): number => Math.hypot(P[2 * j]! - (px - shift), P[2 * j + 1]! + py);
      if (d(k) < d(i)) i = k;
    }
    const pr = periodicPairing(fit.curve.basis, tol);
    if (!pr.ok) throw new Error(pr.message);
    const j = pr.pairing.partner[i]!;
    const Q = P.slice();
    Q[2 * i] = P[2 * i]! + MOVE * out[0];
    Q[2 * i + 1] = P[2 * i + 1]! - MOVE * out[1];
    Q[2 * j] = P[2 * j]! + MOVE * out[0];
    Q[2 * j + 1] = P[2 * j + 1]! + MOVE * out[1];
    const bent = makeCurve({ dim: 2, basis: fit.curve.basis, points: Q }) as PeriodicCurve<2>;
    const m = measurePlan(board.outline, bent, shift, O, tol);
    // What the exit checked before the review: blind to it.
    expect(m.planToLoop).toBeLessThanOrEqual(O.lineTol);
    expect(m.loopToPlan).toBeLessThanOrEqual(O.lineTol);
    expect(m.filletMiss).toBeLessThanOrEqual(O.lineTol);
    // The checks inside the zones see it, both ways.
    expect(m.arcToLoop).toBeGreaterThan(O.lineTol);
    expect(m.zoneLoopToFilleted).toBeGreaterThan(O.lineTol);
  });
});
