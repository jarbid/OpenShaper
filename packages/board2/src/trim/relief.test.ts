// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Bottom features as a relief (`relief.ts`) on the made boards' features: none for no enabled
 * feature, zero outside a feature's span along the board, features.ts's own depth at
 * (ξ, u) = (x, |y| / w(x)), and a gradient that matches finite differences of the value.
 */
import { describe, expect, it } from 'vitest';
import { featureDisplacement, keyedEvaluator } from '../features';
import { asymmetricBoard, fishBoard, swallowBoard } from '../testing';
import type { BoardDoc } from '../types';
import { halfWidthOf } from './outline';
import { compileRelief } from './relief';

const BOARDS: { readonly [name: string]: () => BoardDoc } = {
  swallow: swallowBoard,
  fish: fishBoard,
  asymmetric: asymmetricBoard,
};

/** The relief against features.ts's depth, cm: the half width is read from a table. */
const DEPTH_TOL = 1e-6;
/** Finite-difference step (cm) and the gradient's tolerance against it. */
const FD_STEP = 1e-4;
const GRAD_TOL = 1e-4;

const widths = (doc: BoardDoc): readonly [(x: number) => number, (x: number) => number] => {
  const plus = halfWidthOf(doc.outline);
  return [plus, doc.outline.minus === undefined ? plus : halfWidthOf(doc.outline, 'minus')];
};

describe('compileRelief', () => {
  it('is null with no enabled feature', () => {
    const doc = fishBoard();
    expect(compileRelief([], widths(doc))).toBeNull();
    const off = doc.features.map((f) => ({ ...f, enabled: false }));
    expect(compileRelief(off, widths(doc))).toBeNull();
  });

  describe.each(Object.keys(BOARDS))('%s', (name) => {
    const doc = BOARDS[name]!();
    const hw = widths(doc);
    const relief = compileRelief(doc.features, hw)!;
    const out = new Float64Array(3);
    const spans = doc.features.map((f) => [f.depth.keys[0]!.s, f.depth.keys.at(-1)!.s] as const);
    const lo = Math.min(...spans.map((s) => s[0]));
    const hi = Math.max(...spans.map((s) => s[1]));
    /** Plan points across the features' span, both sides, out a little past the outline. */
    const points: [number, number][] = [];
    for (let i = 1; i < 40; i++) {
      const x = lo + ((hi - lo) * i) / 40;
      for (const side of [1, -1]) {
        const w = hw[side > 0 ? 0 : 1](x);
        for (let j = 0; j <= 10; j++) points.push([x, side * w * (j / 10) * 1.02]);
      }
    }

    it('is zero outside every feature span', () => {
      for (const x of [lo - 5, lo - 0.01, hi + 0.01, hi + 5]) {
        for (const y of [0, 3, -7]) {
          relief(x, y, out);
          expect([...out]).toEqual([0, 0, 0]);
        }
      }
    });

    it("equals features.ts's depth at (x, |y| / w)", () => {
      const depths = doc.features.map((f) => keyedEvaluator(f.depth));
      const d = new Float64Array(3);
      let worst = 0;
      for (const [x, y] of points) {
        const w = hw[y >= 0 ? 0 : 1](x);
        let want = 0;
        doc.features.forEach((f, k) => {
          depths[k]!(x, d, 0);
          want += featureDisplacement(f, d[0]!, Math.abs(y) / w, w);
        });
        relief(x, y, out);
        worst = Math.max(worst, Math.abs(out[0]! - want));
      }
      expect(worst).toBeLessThan(DEPTH_TOL);
    });

    it('has a gradient that matches finite differences', () => {
      const a = new Float64Array(3);
      const b = new Float64Array(3);
      let worst = 0;
      let scale = 0;
      for (const [x, y] of points) {
        // keep the difference on one side of the stringer, where |y| has its kink
        if (Math.abs(y) < 2 * FD_STEP) continue;
        relief(x, y, out);
        relief(x + FD_STEP, y, a);
        relief(x - FD_STEP, y, b);
        const dx = (a[0]! - b[0]!) / (2 * FD_STEP);
        relief(x, y + FD_STEP, a);
        relief(x, y - FD_STEP, b);
        const dy = (a[0]! - b[0]!) / (2 * FD_STEP);
        worst = Math.max(worst, Math.abs(out[1]! - dx), Math.abs(out[2]! - dy));
        scale = Math.max(scale, Math.abs(out[1]!), Math.abs(out[2]!));
      }
      expect(scale).toBeGreaterThan(0);
      expect(worst).toBeLessThan(GRAD_TOL);
    });
  });
});
