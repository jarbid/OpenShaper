// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The test fixtures themselves (docs/design/board2.md §11.2 `testing/`): the
 * stadium board is a valid, JSON-round-tripping document whose plan has the
 * closed-form facts its module states, and the notched loop is the symmetric,
 * counter-clockwise, standard-tail-violating loop step S4 builds on.
 */
import { curvePoint } from '@openshaper/geom';
import { describe, expect, it } from 'vitest';
import { reviveBoardDoc } from '../doc';
import { planCurve, planPieces, planSignedArea } from '../plan';
import { checkPlanSymmetry } from '../symmetry';
import { validateBoard } from '../validate';
import { notchedLoopFixture, stadiumBoard, stadiumFacts, stadiumPlan } from './index';

describe('stadium fixture', () => {
  it('is a valid document and round-trips through JSON and revive', () => {
    for (const opts of [{}, { straightPoints: 3, arcSteps: 2 }, { halfWidth: 30, spacing: 7 }]) {
      const d = stadiumBoard(opts);
      expect(validateBoard(d)).toEqual([]);
      const text = JSON.stringify(d);
      expect(JSON.parse(text)).toEqual(d);
      const r = reviveBoardDoc(JSON.parse(text));
      expect(r.ok).toBe(true);
      expect(r.ok && validateBoard(r.value)).toEqual([]);
    }
  });

  it('tail at the origin, nose at (L, 0), exactly straight sides at y = ±ρ', () => {
    const f = stadiumFacts();
    const c = planCurve(stadiumPlan());
    const tail = curvePoint(c, 0);
    const nose = curvePoint(c, 0.5);
    // Uniform-cubic knot points: rounding of a three-term sum at board scale.
    expect(Math.hypot(tail.x, tail.y)).toBeLessThanOrEqual(1e-13 * f.length);
    expect(Math.hypot(nose.x - f.length, nose.y)).toBeLessThanOrEqual(1e-13 * f.length);
    for (let k = 0; k <= 100; k++) {
      const x = f.straight[0] + ((f.straight[1] - f.straight[0]) * k) / 100;
      // Find u on the −y side with that x (x is monotone there), then check y.
      let lo = 0.01;
      let hi = 0.49;
      for (let i = 0; i < 80; i++) {
        const m = 0.5 * (lo + hi);
        if (curvePoint(c, m).x < x) lo = m;
        else hi = m;
      }
      expect(Math.abs(curvePoint(c, lo).y + 25)).toBeLessThanOrEqual(1e-13 * f.length);
    }
    expect(stadiumFacts().count).toBe(c.basis.count);
    expect(() => stadiumPlan({ straightPoints: 2 })).toThrow();
  });
});

describe('notched loop fixture', () => {
  it('symmetric bitwise, counter-clockwise, tail centre at the origin', () => {
    const c = planCurve(notchedLoopFixture());
    expect(checkPlanSymmetry(c)).toEqual([]);
    expect(planSignedArea(planPieces(c))).toBeGreaterThan(0);
    const p = curvePoint(c, 0);
    expect(Math.hypot(p.x, p.y)).toBeLessThanOrEqual(1e-13 * 180);
    expect(Math.abs(curvePoint(c, 0.5).x - 180)).toBeLessThanOrEqual(1e-13 * 180);
    // A fresh copy each call.
    expect(notchedLoopFixture()).not.toBe(notchedLoopFixture());
  });
});
