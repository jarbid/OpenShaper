// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The analytic stadium board (docs/design/board2.md §8.1 item 2, §11.2
 * `testing/`): a plan loop with exactly straight sides and round ends, a flat
 * deck and bottom, constant laws. Test-only.
 *
 * **Plan.** A uniform periodic cubic (knots `i / n`). Control point `i` sits at
 * the Greville abscissa `(i + 2)/n`, so the points are laid out in "Greville
 * order" `Q_0 … Q_{n−1}` from the tail centre (`Q_k` at u = k/n) and stored
 * rotated by two (`P_i = Q_{(i+2) mod n}`). The −y half, tail to nose:
 *
 * - tail arc: `Q_j = (x_c − ρ cos jθ, −ρ sin jθ)`, `j = 0 … K`, θ = π/(2K);
 * - straight side: `Q_{K+i} = (x_c + i h, −ρ)`, `i = 1 … s`;
 * - nose arc: the tail arc mirrored about the middle, ending at `Q_{n/2}`;
 *
 * and the +y half is its exact mirror (`Q_{n−k} = (x_k, −y_k)`, bitwise), so
 * `n = 2(2K + s)`. A uniform cubic's point at a knot is `(Q₋ + 4Q + Q₊)/6`, so
 * with `x_c = ρ(2 + cos θ)/3` the tail lies at x = 0 and the nose at
 * `L = 2ρ(2 + cos θ)/3 + s h`; the sides are exactly the lines y = ±ρ for
 * `x ∈ [x_c + h, x_c + (s − 1) h]` (every span there has four collinear,
 * equally spaced control points), so the width is exactly 2ρ (the arcs' control
 * points have |y| ≤ ρ). Two stadiums that differ only in `s` have congruent
 * ends: the nose half is translated by `Δs · h` (§8.1.2's Δ-length identity).
 *
 * **Surfaces.** Flat height fields, deck at z = `thickness`, bottom at z = 0,
 * over the loop's box grown by the default `planMargin`, with `spansX × spansY`
 * uniform bicubic spans (symmetric in v).
 */
import { DEFAULT_BUILD_PARAMS } from '../params';
import type { BoardDoc, HeightFieldJSON, PlanLoopJSON } from '../types';
import { defaultLaws } from './sample-doc';

export interface StadiumOptions {
  /** ρ: half-width of the straight part and radius of the end arcs' control polygon (cm). */
  readonly halfWidth?: number;
  /** h: control-point spacing along the straight sides (cm). */
  readonly spacing?: number;
  /** s ≥ 3: straight-side control points per side (s − 2 exactly straight spans). */
  readonly straightPoints?: number;
  /** K ≥ 2: arc steps per quarter turn (θ = π/(2K)). */
  readonly arcSteps?: number;
  /** Deck height above the flat bottom (cm). */
  readonly thickness?: number;
  /** Height-field spans along x and across y. */
  readonly spansX?: number;
  readonly spansY?: number;
}

const DEFAULTS: Required<StadiumOptions> = {
  halfWidth: 25,
  spacing: 10,
  straightPoints: 14,
  arcSteps: 4,
  thickness: 6,
  spansX: 8,
  spansY: 4,
};

/** Closed-form facts about a stadium's plan (for oracles). */
export interface StadiumFacts {
  /** Tail at x = 0, nose at x = `length`, on y = 0. */
  readonly length: number;
  /** Exactly 2ρ. */
  readonly width: number;
  /** x-range over which both sides are exactly the lines y = ±ρ. */
  readonly straight: readonly [number, number];
  /** Control points; the tail and nose control points are `n − 2` and `n/2 − 2`. */
  readonly count: number;
}

function resolve(opts: StadiumOptions): Required<StadiumOptions> {
  const o = { ...DEFAULTS, ...opts };
  if (!(o.straightPoints >= 3 && Number.isInteger(o.straightPoints))) {
    throw new Error('stadium: straightPoints must be an integer >= 3');
  }
  if (!(o.arcSteps >= 2 && Number.isInteger(o.arcSteps))) {
    throw new Error('stadium: arcSteps must be an integer >= 2');
  }
  return o;
}

/** Closed-form length, width and straight range of {@link stadiumPlan}. */
export function stadiumFacts(opts: StadiumOptions = {}): StadiumFacts {
  const o = resolve(opts);
  const theta = Math.PI / (2 * o.arcSteps);
  const xc = (o.halfWidth * (2 + Math.cos(theta))) / 3;
  return {
    length: 2 * xc + o.straightPoints * o.spacing,
    width: 2 * o.halfWidth,
    straight: [xc + o.spacing, xc + (o.straightPoints - 1) * o.spacing],
    count: 2 * (2 * o.arcSteps + o.straightPoints),
  };
}

/** The stadium plan loop (see the module comment). */
export function stadiumPlan(opts: StadiumOptions = {}): PlanLoopJSON {
  const o = resolve(opts);
  const K = o.arcSteps;
  const s = o.straightPoints;
  const rho = o.halfWidth;
  const h = o.spacing;
  const theta = Math.PI / (2 * K);
  const xc = (rho * (2 + Math.cos(theta))) / 3;
  const xn = xc + s * h;
  const half = 2 * K + s;
  const n = 2 * half;
  // The −y half in Greville order, Q_0 (tail) … Q_half (nose).
  const qx: number[] = [];
  const qy: number[] = [];
  for (let j = 0; j <= K; j++) {
    // Exact values at the ends of the quarter arc: (−ρ, 0) and (0, −ρ) from the centre.
    qx.push(j === 0 ? xc - rho : j === K ? xc : xc - rho * Math.cos(j * theta));
    qy.push(j === 0 ? 0 : j === K ? -rho : -rho * Math.sin(j * theta));
  }
  for (let i = 1; i <= s; i++) {
    qx.push(xc + i * h);
    qy.push(-rho);
  }
  for (let j = K - 1; j >= 0; j--) {
    qx.push(j === 0 ? xn + rho : xn + rho * Math.cos(j * theta));
    qy.push(j === 0 ? 0 : -rho * Math.sin(j * theta));
  }
  // The +y half: exact mirrors.
  for (let k = half + 1; k < n; k++) {
    qx.push(qx[n - k]!);
    qy.push(-qy[n - k]!);
  }
  const points: number[] = [];
  for (let i = 0; i < n; i++) {
    const k = (i + 2) % n;
    points.push(qx[k]!, qy[k]!);
  }
  return { degree: 3, knots: Array.from({ length: n }, (_, i) => i / n), points };
}

/** A flat clamped bicubic height field at height `z` over the given extent. */
export function flatField(
  x: readonly [number, number],
  y: readonly [number, number],
  z: number,
  spansX: number,
  spansY: number,
): HeightFieldJSON {
  const knots = (spans: number): number[] => [
    0,
    0,
    0,
    ...Array.from({ length: spans + 1 }, (_, i) => i / spans),
    1,
    1,
    1,
  ];
  const nu = spansX + 3;
  const nv = spansY + 3;
  return {
    degreeU: 3,
    degreeV: 3,
    knotsU: knots(spansX),
    knotsV: knots(spansY),
    x: [x[0], x[1]],
    y: [y[0], y[1]],
    z: Array.from({ length: nu * nv }, () => z),
  };
}

/** The stadium board document (valid: `validateBoard` returns no issue). */
export function stadiumBoard(opts: StadiumOptions = {}): BoardDoc {
  const o = resolve(opts);
  const f = stadiumFacts(o);
  const m = DEFAULT_BUILD_PARAMS.planMargin;
  const x: [number, number] = [-m, f.length + m];
  const y: [number, number] = [-(o.halfWidth + m), o.halfWidth + m];
  return {
    format: 'openshaper.board2',
    version: 1,
    meta: { name: 'Stadium', source: 'board2' },
    symmetry: 'mirror-y',
    tail: { kind: 'standard' },
    plan: stadiumPlan(o),
    deck: flatField(x, y, o.thickness, o.spansX, o.spansY),
    bottom: flatField(x, y, 0, o.spansX, o.spansY),
    laws: defaultLaws(),
    offsets: { basis: null, rows: [] },
    features: [],
    build: JSON.parse(JSON.stringify(DEFAULT_BUILD_PARAMS)) as BoardDoc['build'],
  };
}
