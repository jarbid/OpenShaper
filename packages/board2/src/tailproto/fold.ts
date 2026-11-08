// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `step.test.ts`'s fold measure, lifted out so the tail-model study can call it without
 * importing a test file: the angle between the plus face's cross tangent and the reversed
 * minus face's along a stringer row, minus the evaluator's own fold at the same s (a designed
 * crease is not counted). Worst over s, and where.
 */
import { surfaceDerivatives } from '@openshaper/geom';
import type { BoardSolid } from '../step';
import { createEvaluator } from '../surface';
import type { BuiltBoard } from '../surface';
import { FOLD_SAMPLES, FOLD_STEP } from './proto-params';

const angleDeg = (a: readonly [number, number, number], b: readonly [number, number, number]): number => {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const c = dot / (Math.hypot(a[0], a[1], a[2]) * Math.hypot(b[0], b[1], b[2]));
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
};

export function foldAt(
  built: BuiltBoard,
  solid: BoardSolid,
  v: 0 | 1,
  from: number,
  to: number,
  /** Take the evaluator's own cross direction as the exact derivative rather than `step.test.ts`'s 1e-6 step in t. */
  exactDerivative = false,
): { worst: number; at: number } {
  const ev = createEvaluator(built);
  const mirror = built.doc.symmetry === 'mirror';
  const a = new Float64Array(3);
  const b = new Float64Array(3);
  const der = new Float64Array(9);
  const evDir = (side: 0 | 1, s: number): [number, number, number] => {
    const k = v === 0 ? 1 : -1;
    if (exactDerivative) {
      ev.row(side, solid.xiOf(s), 1);
      ev.eval(v, 1, der, 0, v === 1);
      return [k * der[6]!, k * der[7]!, k * der[8]!];
    }
    ev.row(side, solid.xiOf(s), 0);
    ev.eval(v, 0, a);
    ev.eval(v === 0 ? FOLD_STEP : 1 - FOLD_STEP, 0, b);
    return [k * (b[0]! - a[0]!), k * (b[1]! - a[1]!), k * (b[2]! - a[2]!)];
  };
  let worst = 0;
  let at = 0;
  for (let k = 0; k <= FOLD_SAMPLES; k++) {
    const s = from + ((to - from) * k) / FOLD_SAMPLES;
    const p = surfaceDerivatives(solid.plus, s, v, 1).Sv;
    const m = surfaceDerivatives(solid.minus, s, v, 1).Sv;
    const got = angleDeg([p.x, p.y, p.z], [-m.x, -m.y, -m.z]);
    const ep = evDir(0, s);
    const em = evDir(mirror ? 0 : 1, s);
    const emm: [number, number, number] = mirror ? [em[0], -em[1], em[2]] : em;
    const exact = angleDeg(ep, [-emm[0], -emm[1], -emm[2]]);
    if (Math.abs(got - exact) > worst) {
      worst = Math.abs(got - exact);
      at = s;
    }
  }
  return { worst, at };
}
