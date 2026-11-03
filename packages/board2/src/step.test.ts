// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The STEP solid (docs/design/m3-exports.md, step 2) on seven boards: the three goldens, a swallow, a fish,
 * an asymmetric board and a swallow with every kind of bottom feature. Each solid passes geom's `checkBrep`
 * and its surfaces are within 0.5 mm of the evaluator at an independent dense grid (offsets the fit never
 * sampled); the sides share their stringer exactly; the file starts with the Part 21 header.
 */
import { checkBrep, surfaceEvalGridInto, createScratch } from '@openshaper/geom';
import { describe, expect, it } from 'vitest';
import { STEP_TOLERANCE } from './params';
import { boardSolid, boardStep } from './step';
import type { BoardSolid } from './step';
import { createEvaluator } from './surface';
import type { BuiltBoard } from './surface';
import { asymmetricBoard, swallowBoard } from './testing';
import { boardSet, buildOrThrow } from './test-support/board-set';
import type { BoardDoc } from './types';

/** The swallow with the asymmetric board's channels added: vee, double concave and channels in one. */
const everyFeature = (): BoardDoc => {
  const swallow = swallowBoard();
  const channels = asymmetricBoard().features.filter((f) => f.kind === 'channels');
  return { ...swallow, features: [...swallow.features, ...channels] };
};

const BOARDS: readonly { name: string; doc: BoardDoc }[] = [
  ...boardSet().filter((b) => !b.name.startsWith('classic')),
  { name: 'every feature', doc: everyFeature() },
];

/** The largest distance from a solid's sides to the evaluator on a grid offset from the fit's and the check's. */
function independentDeviation(built: BuiltBoard, solid: BoardSolid): number {
  const ev = createEvaluator(built);
  const [lo, hi] = solid.report.range;
  const sc = createScratch({ maxDegree: 3 });
  const out = new Float64Array(3);
  let worst = 0;
  const grid = (b: Float64Array, per: number): number[] => {
    const breaks = [...new Set(b)];
    const pts: number[] = [];
    for (let i = 0; i + 1 < breaks.length; i++) {
      for (let k = 0; k < per; k++) {
        pts.push(breaks[i]! + ((k + 0.37) / per) * (breaks[i + 1]! - breaks[i]!));
      }
    }
    return pts;
  };
  const mirror = built.doc.symmetry === 'mirror';
  for (const side of mirror ? ([0] as const) : ([0, 1] as const)) {
    const surf = side === 0 ? solid.plus : solid.minus;
    const us = grid(surf.u.knots as Float64Array, 7);
    const vs = grid(surf.v.knots as Float64Array, 7);
    const F = new Float64Array(us.length * vs.length * 3);
    surfaceEvalGridInto(surf, Float64Array.from(us), Float64Array.from(vs), 0, F, sc);
    for (let i = 0; i < us.length; i++) {
      ev.row(side, lo + us[i]! * (hi - lo), 0);
      for (let j = 0; j < vs.length; j++) {
        ev.eval(vs[j]!, 0, out, 0);
        const o = (i * vs.length + j) * 3;
        worst = Math.max(
          worst,
          Math.hypot(out[0]! - F[o]!, out[1]! - F[o + 1]!, out[2]! - F[o + 2]!),
        );
      }
    }
  }
  return worst;
}

describe('the STEP solid of a built board', () => {
  for (const { name, doc } of BOARDS) {
    it(`${name}: a valid closed solid within 0.5 mm of the surface`, () => {
      const built = buildOrThrow(doc);
      const solid = boardSolid(built);
      const check = checkBrep(solid.brep);
      expect(check.issues).toEqual([]);
      expect(check.ok).toBe(true);
      expect(check.signedVolume).toBeGreaterThan(0);
      expect(solid.report.withinTolerance).toBe(true);
      expect(independentDeviation(built, solid)).toBeLessThanOrEqual(STEP_TOLERANCE);
      // the sides share their ξ and t knots and their stringer rows exactly
      const { plus, minus } = solid;
      expect(Array.from(minus.u.knots)).toEqual(Array.from(plus.u.knots));
      expect(Array.from(minus.v.knots)).toEqual(Array.from(plus.v.knots));
      const nv = plus.v.count;
      for (let i = 0; i < plus.u.count; i++) {
        for (const j of [0, nv - 1]) {
          for (let c = 0; c < 4; c++) {
            expect(minus.cw[(i * nv + j) * 4 + c]).toBe(plus.cw[(i * nv + j) * 4 + c]);
          }
          expect(plus.cw[(i * nv + j) * 4 + 1]).toBe(0);
        }
      }
      // a symmetric board's minus side is the plus side mirrored
      if (doc.symmetry === 'mirror') {
        for (let k = 0; k < plus.cw.length; k += 4) {
          expect(minus.cw[k]).toBe(plus.cw[k]);
          expect(minus.cw[k + 1]).toBe(0 - plus.cw[k + 1]!);
          expect(minus.cw[k + 2]).toBe(plus.cw[k + 2]);
        }
      }
      // the shell: a notched tail ends in one shared edge (no cap), every other end in a cap
      expect(solid.brep.faces.length).toBe(solid.report.tail === 'edge' ? 3 : 4);
    }, 60_000);
  }

  it('writes a Part 21 file in the requested unit', () => {
    const built = buildOrThrow(swallowBoard());
    const out = boardStep(built, { name: 'swallow', unit: 'cm', timestamp: '2026-01-01T00:00:00' });
    expect(out.text.startsWith('ISO-10303-21;')).toBe(true);
    expect(out.text).toContain('END-ISO-10303-21;');
    expect(out.text).toContain('.CENTI.');
    expect(out.text).toContain('MANIFOLD_SOLID_BREP');
  }, 60_000);
});
