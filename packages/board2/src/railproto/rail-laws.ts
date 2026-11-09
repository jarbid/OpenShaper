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
    if (Math.abs(d) < 1e-14) continue;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r]![c]! / d;
      for (let j = c; j <= n; j++) m[r]![j]! -= f * m[c]![j]!;
    }
  }
  return m.map((row, i) => (Math.abs(row[i]!) < 1e-14 ? 0 : row[n]! / row[i]!));
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
