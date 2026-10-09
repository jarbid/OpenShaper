// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Curvature-comb analysis for one or more splines: signed curvature samples, a robust
 * reference magnitude to scale quills by, and inflection points. Pure; drawing lives in
 * render2d. Sign convention: `curvature` is positive where the curve turns left
 * (counter-clockwise) in the direction of travel, and the comb is drawn on the convex
 * side, i.e. opposite the centre of curvature — so it flips side at an inflection, the
 * way Rhino's CurvatureGraph and SolidWorks' combs do.
 */
import { curvature, value, xDeriv, yDeriv } from './bezier-curve';
import type { Spline } from './bezier-spline';
import type { Vec2 } from './vec2';

export interface CombSample {
  /** Point on the curve. */
  p: Vec2;
  /** Unit vector the quill grows along per unit of signed curvature (convex side). */
  dir: Vec2;
  /** Signed curvature (1 / radius, in 1 / world units). */
  k: number;
  segment: number;
  t: number;
}

/**
 * `samplesPerSegment + 1` samples per segment, grouped into runs the envelope may join.
 * A sample whose curvature is undefined — a zero-length segment such as the deck's
 * nose and tail dummies, or a collapsed handle at a segment's end — is dropped and
 * breaks the run, rather than poisoning everything drawn from it with NaN.
 */
export const curvatureCombRuns = (s: Spline, samplesPerSegment: number): CombSample[][] => {
  const runs: CombSample[][] = [];
  let run: CombSample[] = [];
  const n = Math.max(1, Math.floor(samplesPerSegment));
  s.coeffs.forEach((c, segment) => {
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const dx = xDeriv(c, t);
      const dy = yDeriv(c, t);
      const len = Math.hypot(dx, dy);
      const k = curvature(c, t);
      if (!(len > 0) || !Number.isFinite(k)) {
        if (run.length) runs.push(run);
        run = [];
        continue;
      }
      // Left normal is (-dy, dx)/len and the centre of curvature lies along it for k > 0,
      // so the convex side is its negation. The product dir·k is orientation-independent.
      run.push({ p: value(c, t), dir: { x: dy / len, y: -dx / len }, k, segment, t });
    }
  });
  if (run.length) runs.push(run);
  return runs;
};

/**
 * The curvature magnitude a "full-length" quill stands for: the arc-length-weighted
 * `quantile` of |k|. A quantile rather than the maximum, because one tight spot (a
 * nearly collapsed handle at the nose: κ ≈ 93 /cm on the bundled shortboard outline,
 * against ≈ 0.27 at the 95th percentile) would otherwise shrink every other quill to
 * nothing. Weighted by length because samples are spread evenly per segment, so a short
 * tight segment (the tail block of an outline, a rail apex) would otherwise claim as many
 * samples as a long gentle one. 0 when every sample is flat.
 */
export const curvatureCombReference = (
  runs: readonly (readonly CombSample[])[],
  quantile = 0.95,
): number => {
  const weighted: { k: number; w: number }[] = [];
  for (const run of runs) {
    run.forEach((s, i) => {
      const half = (a?: CombSample) => (a ? Math.hypot(a.p.x - s.p.x, a.p.y - s.p.y) / 2 : 0);
      // A lone sample (a run of one) still counts, with a token weight.
      weighted.push({ k: Math.abs(s.k), w: half(run[i - 1]) + half(run[i + 1]) || 1e-12 });
    });
  }
  if (weighted.length === 0) return 0;
  weighted.sort((a, b) => a.k - b.k);
  const total = weighted.reduce((sum, e) => sum + e.w, 0);
  let acc = 0;
  for (const e of weighted) {
    acc += e.w;
    if (acc >= quantile * total) return e.k;
  }
  return weighted[weighted.length - 1]!.k;
};

/**
 * Points where the curvature changes sign along a run (S-bends: a deck that turns from
 * convex to concave, a cross-section's concave bottom running into the rail). Samples
 * whose |k| is below `flat` are treated as straight and never start or end an
 * inflection, so numerical flicker along a near-straight run reports nothing. The point
 * is placed at the linear zero crossing between the two signed samples either side.
 */
export const curvatureInflections = (
  runs: readonly (readonly CombSample[])[],
  flat: number,
): Vec2[] => {
  const out: Vec2[] = [];
  for (const run of runs) {
    let last: CombSample | null = null;
    for (const s of run) {
      if (Math.abs(s.k) <= flat) continue;
      if (last && Math.sign(last.k) !== Math.sign(s.k)) {
        const f = last.k / (last.k - s.k);
        out.push({ x: last.p.x + (s.p.x - last.p.x) * f, y: last.p.y + (s.p.y - last.p.y) * f });
      }
      last = s;
    }
  }
  return out;
};
