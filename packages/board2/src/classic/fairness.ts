// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Fairness weights by the discrepancy principle (docs/design/board2.md §9.8).
 *
 * A fit that needs fairness uses the **largest** weight whose fit still meets
 * its data tolerance. The weight is searched as a ratio of the two terms'
 * sizes, `ratio = β · tr(G₂) / tr(AᵀWA)` (so β = ratio · tr(AᵀWA) / tr(G₂)),
 * by bisection in log scale over `fairnessRatioBracket`, `fairnessSearchSteps`
 * halvings. No weight is a constant in the code (principle 3).
 *
 * The traces are exact. The fits use geom's thin-plate energy in the
 * **parametric** metric on the height field's unit square
 * (`G₂ = ∫∫ R_uu R_uuᵀ + 2 R_uv R_uvᵀ + R_vv R_vvᵀ`), whose trace is separable:
 * with `g_k = Σ_i ∫ (N_i^(k))²` per direction,
 * `tr(G₂) = g₂(u) g₀(v) + 2 g₁(u) g₁(v) + g₀(u) g₂(v)`; each `g_k` is
 * integrated per knot span by `p + 1` Gauss–Legendre points (exact: the
 * integrand has degree at most 2p). The data term's trace is
 * `Σ_k w_k Σ_ij (N_i(u_k) M_j(v_k))² = Σ_k w_k (Σ_i N_i²)(Σ_j M_j²)`.
 */
import {
  basisDersInto,
  basisFunsInto,
  createScratch,
  findSpan,
  gaussLegendre,
} from '@openshaper/geom';
import type { Basis } from '@openshaper/geom';

/** `[g₀, g₁, g₂]`: the sums over the basis of `∫ (N_i^(k))²` on its domain. */
export function gramDiagonalSums(b: Basis): readonly [number, number, number] {
  const p = b.degree;
  const rule = gaussLegendre(p + 1);
  const sc = createScratch({ maxDegree: p, maxDerivs: 2 });
  const d = new Float64Array(3 * (p + 1));
  const g: [number, number, number] = [0, 0, 0];
  const U = b.knots;
  const [lo, hi] = b.domain;
  for (let s = 0; s + 1 < U.length; s++) {
    const a = Math.max(U[s]!, lo);
    const e = Math.min(U[s + 1]!, hi);
    if (!(e > a)) continue;
    const span = findSpan(b, 0.5 * (a + e));
    const h = 0.5 * (e - a);
    for (let q = 0; q < rule.nodes.length; q++) {
      const t = a + h * (rule.nodes[q]! + 1);
      basisDersInto(b, span, t, 2, d, 0, sc);
      for (let k = 0; k < 3; k++) {
        let sum = 0;
        for (let j = 0; j <= p; j++) sum += d[k * (p + 1) + j]! ** 2;
        g[k] = g[k]! + rule.weights[q]! * h * sum;
      }
    }
  }
  return g;
}

/** tr(G₂) of the parametric thin plate on the tensor basis `u × v`. */
export function thinPlateTrace(u: Basis, v: Basis): number {
  const gu = gramDiagonalSums(u);
  const gv = gramDiagonalSums(v);
  return gu[2] * gv[0] + 2 * gu[1] * gv[1] + gu[0] * gv[2];
}

/** tr(AᵀWA) of tensor-basis collocation at `uv` (interleaved), unit weights. */
export function dataTrace(u: Basis, v: Basis, uv: ArrayLike<number>): number {
  const sc = createScratch({ maxDegree: Math.max(u.degree, v.degree), maxDerivs: 0 });
  const nu = new Float64Array(u.degree + 1);
  const nv = new Float64Array(v.degree + 1);
  let tr = 0;
  for (let k = 0; 2 * k < uv.length; k++) {
    const a = uv[2 * k]!;
    const b = uv[2 * k + 1]!;
    basisFunsInto(u, findSpan(u, a), a, nu, 0, sc);
    basisFunsInto(v, findSpan(v, b), b, nv, 0, sc);
    let su = 0;
    let sv = 0;
    for (const x of nu) su += x * x;
    for (const x of nv) sv += x * x;
    tr += su * sv;
  }
  return tr;
}

/** The outcome of a search: the chosen ratio, the fit there, and whether it meets the tolerance. */
export interface DiscrepancyChoice<T> {
  readonly ratio: number;
  readonly fit: T;
  readonly meets: boolean;
  /** Fits made. */
  readonly evaluations: number;
}

/** A trial fit: `null` when the fit does not exist at that ratio (the data do not determine it). */
export type Trial<T> = { readonly fit: T; readonly meets: boolean } | null;

/**
 * The largest ratio in `[r0, r1]` whose fit meets the tolerance (§9.8), by
 * bisection in log scale with `steps` halvings. `r0` must give a fit. A trial
 * has three outcomes, ordered along the ratio: too little fairness to
 * determine every control point (no fit: move up), a fit that meets the
 * tolerance (keep it, move up), a fit that misses it (move down). When the
 * largest ratio meets it is taken; when no trial meets, the fit at `r0` is
 * returned with `meets: false` (the caller refines or reports).
 */
export function discrepancySearch<T>(
  fitAt: (ratio: number) => Trial<T>,
  r0: number,
  r1: number,
  first: { readonly fit: T; readonly meets: boolean },
  steps: number,
): DiscrepancyChoice<T> {
  let evaluations = 0;
  const top = fitAt(r1);
  evaluations++;
  if (top !== null && top.meets) return { ratio: r1, fit: top.fit, meets: true, evaluations };
  let lo = Math.log(r0);
  let hi = Math.log(r1);
  let best: { ratio: number; fit: T } | null = first.meets ? { ratio: r0, fit: first.fit } : null;
  for (let s = 0; s < steps; s++) {
    const mid = 0.5 * (lo + hi);
    const r = Math.exp(mid);
    const t = fitAt(r);
    evaluations++;
    if (t === null) lo = mid;
    else if (t.meets) {
      lo = mid;
      best = { ratio: r, fit: t.fit };
    } else hi = mid;
  }
  return best === null
    ? { ratio: r0, fit: first.fit, meets: false, evaluations }
    : { ...best, meets: true, evaluations };
}

/**
 * The smallest point of the uniform log grid of `steps` intervals over
 * `[r0, r1]` at which a fit exists (thin-plate fairness has to determine the
 * control points no datum reaches, and too small a ratio leaves the normal
 * equations singular to geom's `pivotRel`), with its fit; `null` when none does.
 */
export function smallestFeasible<T>(
  fitAt: (ratio: number) => Trial<T>,
  r0: number,
  r1: number,
  steps: number,
): {
  readonly ratio: number;
  readonly trial: NonNullable<Trial<T>>;
  readonly evaluations: number;
} | null {
  for (let k = 0; k <= steps; k++) {
    const r = k === 0 ? r0 : k === steps ? r1 : r0 * Math.pow(r1 / r0, k / steps);
    const t = fitAt(r);
    if (t !== null) return { ratio: r, trial: t, evaluations: k + 1 };
  }
  return null;
}
