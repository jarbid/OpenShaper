// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The plan-loop and stringer-line fits (docs/design/board2.md §9.3, §9.4).
 *
 * Oracles:
 * - **Two-sided distance**: the fitted loop against the filleted outline's
 *   exact samples both ways through dense polylines (`test-support/oracles`),
 *   ≤ `lineTol` plus the polylines' chord error (1e-5 cm, stated there); the
 *   lines against the classic curves evaluated from their control points.
 * - **Symmetry**: the loop's control net pairs bitwise (geom's pairing, S2's
 *   `checkPlanSymmetry`), its knots are mirror-symmetric.
 * - **Constraints**: plan(0) = (0, 0) and plan(½) = (nose, 0) within geom's
 *   `constraint`, tangents ∥ ŷ there (x′ within `constraint` × |C′|).
 * - **Every span holds data** (the line knots come from the data).
 */
import { describe, expect, it } from 'vitest';
import { createScratch, curveEvalInto, resolveTolerances } from '@openshaper/geom';
import { getLength } from '@openshaper/kernel';
import type { BezierBoard } from '@openshaper/kernel';
import { periodicKnotsSymmetric, checkPlanSymmetry } from '../symmetry';
import { fitPlanLoop, fitStringerLine, loopData } from './lines';
import { filletLine, filletOutline, samplePiece } from './outline';
import type { FilletedOutline } from './outline';
import { DEFAULT_CONVERT_OPTIONS as O } from './params';
import { polylineDistance, splinePoints } from './test-support/oracles';
import { classicSample } from './test-support/samples';

const tol = resolveTolerances();
const CHORD = 1e-5;

function halfSamples(f: FilletedOutline, h: number): { pts: [number, number][]; fz: number[] } {
  const pts: [number, number][] = [];
  const fz: number[] = [];
  f.pieces.forEach((p, i) => {
    const arc = f.arcs.find((a) => a.piece === i);
    samplePiece(p, h).forEach((q, k) => {
      if (pts.length > 0 && k === 0) return;
      pts.push([q[0], q[1]]);
      fz.push(arc ? arc.fillet : -1);
    });
  });
  const shift = pts[0]![0];
  for (const p of pts) p[0] -= shift;
  pts[0]![1] = 0;
  pts[pts.length - 1]![1] = 0;
  return { pts, fz };
}

function planCase(board: BezierBoard) {
  const f = filletOutline(board.outline, O);
  const { pts, fz } = halfSamples(f, O.lineSampleSpacing);
  const data = loopData(pts, fz);
  const r = fitPlanLoop(data, O.lineTol, O.surfaceKnotSpacing.x);
  if (!('curve' in r)) throw new Error(r.message);
  return { f, data, fit: r, dense: halfSamples(f, 0.005).pts };
}

describe('plan loop', () => {
  for (const name of ['golden/funboard.brd', 'synthetic-clean-6x22x2-75.s3dx']) {
    it(`${name}: within lineTol of the filleted outline both ways, symmetric, constrained`, () => {
      const { data, fit, dense } = planCase(classicSample(name).load());
      // The filleted outline, mirrored into a closed polyline.
      const m = dense.length;
      const outline = new Float64Array(4 * m);
      dense.forEach(([x, y], k) => {
        outline.set([x, y], 2 * k);
        outline.set([x, -y], 2 * (2 * m - 1 - k));
      });
      const sc = createScratch({ maxDegree: 3, maxDerivs: 1 });
      const q = new Float64Array(4);
      const N = 100000;
      const loop = new Float64Array(2 * (N + 1));
      for (let k = 0; k <= N; k++) {
        curveEvalInto(fit.curve, k / N, 0, q, 0, sc);
        loop.set([q[0]!, q[1]!], 2 * k);
      }
      const toLoop = polylineDistance(loop, 0.05);
      const toOutline = polylineDistance(outline, 0.05);
      let a = 0;
      for (let k = 0; k < outline.length / 2; k++)
        a = Math.max(a, toLoop(outline[2 * k]!, outline[2 * k + 1]!));
      let b = 0;
      for (let k = 0; k <= N; k++) b = Math.max(b, toOutline(loop[2 * k]!, loop[2 * k + 1]!));
      expect(a - CHORD).toBeLessThanOrEqual(O.lineTol);
      expect(b - CHORD).toBeLessThanOrEqual(O.lineTol);
      expect(fit.maxError).toBeLessThanOrEqual(O.lineTol);

      expect(checkPlanSymmetry(fit.curve)).toEqual([]);
      expect(fit.curve.basis.kind === 'periodic' && periodicKnotsSymmetric(fit.curve.basis)).toBe(
        true,
      );
      curveEvalInto(fit.curve, 0, 1, q, 0, sc);
      expect(Math.hypot(q[0]!, q[1]!)).toBeLessThanOrEqual(tol.constraint);
      expect(Math.abs(q[2]!)).toBeLessThanOrEqual(tol.constraint * Math.hypot(q[2]!, q[3]!));
      curveEvalInto(fit.curve, 0.5, 1, q, 0, sc);
      expect(Math.hypot(q[0]! - data.nose, q[1]!)).toBeLessThanOrEqual(tol.constraint);
      expect(Math.abs(q[2]!)).toBeLessThanOrEqual(tol.constraint * Math.hypot(q[2]!, q[3]!));
    });
  }
});

describe('stringer lines', () => {
  for (const name of ['golden/longboard.brd', 'synthetic-clean-6x22x2-75.s3dx']) {
    it(`${name}: rocker and deck line within lineTol of the classic curves (outside line fillets)`, () => {
      const board = classicSample(name).load();
      const L = getLength(board);
      for (const s of [board.bottom, board.deck]) {
        const f = filletLine(s, [O.endGap, L - O.endGap], O);
        const { pts } = (() => {
          const out: [number, number][] = [];
          f.pieces.forEach((p) =>
            samplePiece(p, O.lineSampleSpacing).forEach((q, k) => {
              if (out.length > 0 && k === 0) return;
              out.push([q[0], q[1]]);
            }),
          );
          return { pts: out.filter(([x]) => x >= O.endGap && x <= L - O.endGap) };
        })();
        const xs = Float64Array.from(pts.map((p) => p[0]));
        const zs = Float64Array.from(pts.map((p) => p[1]));
        const extent = [-2, L + 2] as const;
        const r = fitStringerLine(xs, zs, extent, O.lineTol, O.surfaceKnotSpacing.x);
        if (!('curve' in r)) throw new Error(r.message);
        // Every span holds data: the knots lie strictly inside the data's range.
        const lo = (xs[0]! - extent[0]) / (extent[1] - extent[0]);
        const hi = (xs.at(-1)! - extent[0]) / (extent[1] - extent[0]);
        for (const k of r.knots) expect(k > lo && k < hi).toBe(true);
        // Independent: the classic curve's own points (not the fit's samples), outside the fillets.
        const sc = createScratch({ maxDegree: 3, maxDerivs: 0 });
        const q = new Float64Array(1);
        const exact = splinePoints(s, 2000);
        let worst = 0;
        for (let k = 0; k < exact.length / 2; k++) {
          const x = exact[2 * k]!;
          if (!(x >= O.endGap && x <= L - O.endGap)) continue;
          const nearFillet = f.fillets.some((fl) => Math.abs(x - fl.x) < 2 * fl.radius);
          if (nearFillet) continue;
          curveEvalInto(r.curve, (x - extent[0]) / (extent[1] - extent[0]), 0, q, 0, sc);
          worst = Math.max(worst, Math.abs(q[0]! - exact[2 * k + 1]!));
        }
        expect(worst).toBeLessThanOrEqual(O.lineTol);
      }
    });
  }
});

describe('refinement passes (review of S6)', () => {
  it('a line fit stops after maxPasses and reports the error it reached', () => {
    // The filleted polygonal deck: the ridge fillet needs several passes.
    const board = classicSample('synthetic-clean-6x22x2-75.s3dx').load();
    const L = getLength(board);
    const f = filletLine(board.deck, [O.endGap, L - O.endGap], O);
    const pts = f.pieces
      .flatMap((p) => samplePiece(p, O.lineSampleSpacing))
      .filter(([x]) => x >= O.endGap && x <= L - O.endGap);
    const xs = Float64Array.from(pts.map((p) => p[0]));
    const zs = Float64Array.from(pts.map((p) => p[1]));
    const extent = [-2, L + 2] as const;
    const full = fitStringerLine(xs, zs, extent, O.lineTol, O.surfaceKnotSpacing.x);
    const capped = fitStringerLine(xs, zs, extent, O.lineTol, O.surfaceKnotSpacing.x, tol, 1);
    if (!('curve' in full) || !('curve' in capped)) throw new Error('fit failed');
    expect(full.maxError).toBeLessThanOrEqual(O.lineTol);
    expect(full.passes).toBeGreaterThan(1);
    expect(capped.passes).toBe(1);
    expect(capped.maxError).toBeGreaterThan(O.lineTol);
    expect(capped.maxError).toBe(Math.max(...capped.errors));
  });

  it('the plan loop fit stops after maxPasses', () => {
    const f = filletOutline(classicSample('golden/funboard.brd').load().outline, O);
    const { pts, fz } = halfSamples(f, O.lineSampleSpacing);
    const r = fitPlanLoop(loopData(pts, fz), O.lineTol, O.surfaceKnotSpacing.x, tol, 0);
    if (!('curve' in r)) throw new Error(r.message);
    expect(r.passes).toBe(0);
    expect(r.maxError).toBeGreaterThan(O.lineTol);
  });
});
