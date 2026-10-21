// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Random symmetric plan loops on **non-uniform** symmetric knot sets that need
 * not have a knot at the tail (u = 0) or the nose (u = ½). Test-only.
 *
 * Every other fixture (the stadium, the sample, the notched loop) has uniform
 * knots `i / n` with `n` even, so u = 0 and ½ are always knots; this one makes
 * the paths for a tail that is not a knot (`toClamped` inserting it) and a
 * Bézier piece straddling ½ run.
 *
 * Knots: `m` distinct values in (0.03, 0.47) and their mirrors `1 − t`, plus 0
 * and ½ only when asked. Control point i is placed from its Greville abscissa g
 * on an ellipse-like outline, `x = (L/2)(1 − cos 2πg)`, `y = −W sin 2πg`
 * (so (0, ½) is the −y side), optionally perturbed, then made bitwise
 * symmetric by the mirror overwrite and translated in x so plan(0) is the
 * origin (a translation keeps the pairs equal). With `noise` and `crossing` at 0
 * the loop passes `validateBoard` inside the default stadium's height fields.
 */
import { controlPointsInto, curvePoint, periodicBasis } from '@openshaper/geom';
import { grevilleAbscissae } from '../height-field';
import { planCurve } from '../plan';
import { mirrorOverwriteCurve, periodicPairing } from '../symmetry';
import type { PlanLoopJSON } from '../types';

export interface OffKnotLoopOptions {
  /** Include a knot at u = 0. Default false. */
  readonly tailKnot?: boolean;
  /** Include a knot at u = ½. Default false. */
  readonly noseKnot?: boolean;
  /** Amplitude (cm) of a random x offset on every control point. Default 0. */
  readonly noise?: number;
  /** In [0, 1]: how far a control point's |y| may be scaled through zero to the wrong side. Default 0. */
  readonly crossing?: number;
}

/** Length L and half-width W of the outline (cm): inside the default stadium's height fields. */
const LENGTH = 180;
const HALF_WIDTH = 22;

/** A random symmetric loop; `rng` returns uniform numbers in [0, 1). */
export function offKnotLoop(rng: () => number, opts: OffKnotLoopOptions = {}): PlanLoopJSON {
  const { tailKnot = false, noseKnot = false, noise = 0, crossing = 0 } = opts;
  const m = 3 + Math.floor(rng() * 8);
  const inner = new Set<number>();
  while (inner.size < m) inner.add(0.03 + 0.44 * rng());
  const ks = [...inner];
  const knots = [...ks, ...ks.map((t) => 1 - t)];
  if (tailKnot) knots.push(0);
  if (noseKnot) knots.push(0.5);
  knots.sort((a, b) => a - b);
  const basis = periodicBasis(3, knots, 1);
  const g = grevilleAbscissae(basis);
  const points: number[] = [];
  for (let i = 0; i < g.length; i++) {
    const a = 2 * Math.PI * g[i]!;
    const x = 0.5 * LENGTH * (1 - Math.cos(a)) + noise * (2 * rng() - 1);
    const y = -HALF_WIDTH * Math.sin(a) * (1 - 1.4 * crossing * rng());
    points.push(x, y);
  }
  const pairing = periodicPairing(basis);
  if (!pairing.ok) throw new Error(`offKnotLoop: ${pairing.message}`);
  const raw = planCurve({ degree: 3, knots, points });
  const sym = mirrorOverwriteCurve(raw, pairing.pairing);
  const x0 = curvePoint(sym, 0).x;
  const pts = new Float64Array(2 * g.length);
  controlPointsInto(sym, pts, 0);
  return { degree: 3, knots, points: Array.from(pts, (v, k) => (k % 2 === 0 ? v - x0 : v)) };
}
