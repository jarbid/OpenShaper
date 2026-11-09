// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Law curves for the rail-law study (`docs/design/rail-laws-test.md` §Law smoothness).
 * Scratch module: the engine never imports it.
 *
 * A law is one fitted parameter as a function of position along the board. The study fits
 * each parameter with `k` degrees of freedom — `k = 3` a quadratic, `k = 4` one cubic span,
 * `k ≥ 5` a clamped cubic B-spline with `k` control points and evenly spaced interior knots
 * — by least squares over the stations, then puts the law's values back through the model to
 * see what the smoothing costs in millimetres on the reconstructed section. The parameter
 * residual is interesting; the millimetres are the answer.
 */
import { basisDers, spanOfKnots } from '../bspline';
import { LAW_PIVOT } from './rail-params';

/** Basis values of a `k`-degree-of-freedom law at normalised position `t` in [0, 1]. */
export function lawBasis(k: number, t: number): Float64Array {
  const out = new Float64Array(k);
  if (k <= 3) {
    // quadratic Bernstein
    const u = 1 - t;
    out[0] = u * u;
    out[1] = 2 * u * t;
    out[2] = t * t;
    return out;
  }
  const knots = new Float64Array(k + 4);
  for (let i = 0; i < 4; i++) knots[i] = 0;
  for (let i = 0; i < k - 4; i++) knots[4 + i] = (i + 1) / (k - 3);
  for (let i = 0; i < 4; i++) knots[k + i] = 1;
  const span = spanOfKnots(knots, k, t, false);
  const b = new Float64Array(4);
  basisDers(knots, span, t, 0, b);
  for (let j = 0; j < 4; j++) out[span - 3 + j] = b[j]!;
  return out;
}

/** Least-squares solve of a small symmetric positive system by Gaussian elimination. */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[piv]![c]!)) piv = r;
    [m[c], m[piv]] = [m[piv]!, m[c]!];
    const d = m[c]![c]!;
    if (Math.abs(d) < LAW_PIVOT) continue;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r]![c]! / d;
      for (let j = c; j <= n; j++) m[r]![j]! -= f * m[c]![j]!;
    }
  }
  return m.map((row, i) => (Math.abs(row[i]!) < LAW_PIVOT ? 0 : row[n]! / row[i]!));
}

export interface Law {
  readonly k: number;
  readonly coef: readonly number[];
  /** Root-mean-square residual in the parameter's own units. */
  readonly rms: number;
  /** Largest residual in the parameter's own units. */
  readonly max: number;
}

/** Least-squares law of `k` degrees of freedom through `(t, y)`, t normalised to [0, 1]. */
export function fitLaw(ts: readonly number[], ys: readonly number[], k: number): Law {
  const n = ts.length;
  const d = Math.min(k, n);
  const ata = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  const atb = new Array<number>(d).fill(0);
  const rows = ts.map((t) => lawBasis(d, t));
  for (let i = 0; i < n; i++) {
    const r = rows[i]!;
    for (let a = 0; a < d; a++) {
      atb[a]! += r[a]! * ys[i]!;
      for (let b = 0; b < d; b++) ata[a]![b]! += r[a]! * r[b]!;
    }
  }
  const coef = solve(ata, atb);
  let sum = 0;
  let max = 0;
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let a = 0; a < d; a++) v += rows[i]![a]! * coef[a]!;
    const e = Math.abs(v - ys[i]!);
    sum += e * e;
    max = Math.max(max, e);
  }
  return { k: d, coef, rms: Math.sqrt(sum / n), max };
}

export function lawAt(law: Law, t: number): number {
  const b = lawBasis(law.k, t);
  let v = 0;
  for (let a = 0; a < law.k; a++) v += b[a]! * law.coef[a]!;
  return v;
}

/**
 * How jagged a sampled parameter is: the mean absolute second difference over consecutive
 * stations, divided by the parameter's own range. Near 0 is a smooth trend; near or above 1
 * means neighbouring stations disagree as much as the whole board does.
 */
export function roughness(ys: readonly number[]): number {
  if (ys.length < 3) return 0;
  const range = Math.max(...ys) - Math.min(...ys);
  if (range <= 0) return 0;
  let sum = 0;
  for (let i = 1; i + 1 < ys.length; i++) sum += Math.abs(ys[i + 1]! - 2 * ys[i]! + ys[i - 1]!);
  return sum / (ys.length - 2) / range;
}

// ---------------------------------------------------------------------------
// Laws fitted to the sections, not to the per-station parameters
// ---------------------------------------------------------------------------

/**
 * Cost of a law when the blend it asks for does not exist at some station, cm. Far above any
 * real deviation, so the search leaves those regions, and finite rather than infinite so a
 * line search still has a gradient to follow out of them.
 */
export const LAW_PENALTY = 1;

/**
 * Law coefficients optimised against the sections themselves: a coordinate descent over the
 * two laws' coefficients, minimising the worst station's deviation.
 *
 * Fitting a law through the per-station parameters, as {@link fitLaw} does, fits it through
 * noise: the per-station cost is nearly flat in the tangent point, so the fitted turn angles
 * scatter across the whole allowed band and a law chasing them is chasing nothing. This asks
 * the question the engine would ask — what is the best a law of `k` degrees of freedom can
 * do? — and so bounds the law's cost from the right side.
 */
export function optimiseLaws(
  ts: readonly number[],
  start: { turn: Law; rho: Law },
  cost: (turns: readonly number[], rhos: readonly number[]) => number,
  sweeps: number,
  iters: number,
  turnScale: number,
): { turn: Law; rho: Law; cost: number } {
  const coef = [...start.turn.coef, ...start.rho.coef];
  const k = start.turn.k;
  const bases = ts.map((t) => lawBasis(k, t));
  const evalAt = (c: readonly number[]): number => {
    const turns: number[] = [];
    const rhos: number[] = [];
    for (let i = 0; i < ts.length; i++) {
      let a = 0;
      let b = 0;
      for (let j = 0; j < k; j++) {
        a += bases[i]![j]! * c[j]!;
        b += bases[i]![j]! * c[k + j]!;
      }
      turns.push(a);
      rhos.push(b);
    }
    return cost(turns, rhos);
  };
  let best = evalAt(coef);
  for (let sweep = 0; sweep < sweeps; sweep++) {
    const width = sweep === 0 ? 1 : 0.4;
    for (let j = 0; j < coef.length; j++) {
      const span = (j < k ? turnScale : 0.25) * width;
      const c0 = coef[j]!;
      const g = (Math.sqrt(5) - 1) / 2;
      let lo = c0 - span;
      let hi = c0 + span;
      const probe = (v: number): number => {
        const save = coef[j]!;
        coef[j] = v;
        const r = evalAt(coef);
        coef[j] = save;
        return r;
      };
      let p = hi - g * (hi - lo);
      let q = lo + g * (hi - lo);
      let fp = probe(p);
      let fq = probe(q);
      for (let i = 0; i < iters; i++) {
        if (fp < fq) {
          hi = q;
          q = p;
          fq = fp;
          p = hi - g * (hi - lo);
          fp = probe(p);
        } else {
          lo = p;
          p = q;
          fp = fq;
          q = lo + g * (hi - lo);
          fq = probe(q);
        }
      }
      const v = fp < fq ? p : q;
      const f = Math.min(fp, fq);
      if (f < best) {
        best = f;
        coef[j] = v;
      }
    }
  }
  return {
    turn: { ...start.turn, coef: coef.slice(0, k) },
    rho: { ...start.rho, coef: coef.slice(k) },
    cost: best,
  };
}
