// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Curvature-comb analysis for one or more splines: signed curvature samples, the side a
 * curve's comb stands on, a robust reference magnitude to scale quills by, and
 * inflection points. Pure; drawing lives in render2d. Sign convention: `curvature` is
 * positive where the curve turns left (counter-clockwise) in the direction of travel.
 *
 * Unlike a mechanical-CAD comb (Rhino's CurvatureGraph, SolidWorks), which follows the
 * sign and crosses the curve at every inflection, a board's comb stays on the outside
 * of the board for the whole curve: a deck comb that dived through the foam at the nose
 * kick reads as nonsense to a shaper. The sign change is marked as an inflection instead.
 */
import { curvature, value, xDeriv, yDeriv } from './bezier-curve';
import type { Spline } from './bezier-spline';
import type { Vec2 } from './vec2';

export interface CombSample {
  /** Point on the curve. */
  p: Vec2;
  /** Unit left normal: (-dy, dx) / |d| in the direction of travel. */
  normal: Vec2;
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
      run.push({ p: value(c, t), normal: { x: -dy / len, y: dx / len }, k, segment, t });
    }
  });
  if (run.length) runs.push(run);
  return runs;
};

/**
 * Which side of a curve its comb stands on, as a multiplier of `normal`: the side facing
 * away from the board, voted over the curve's length. `inside` are points known to lie
 * in or across the board from the curve; each sample stands away from the nearest one.
 * For a pane with several curves, pass the other curves' sample points — the deck's comb
 * stands away from the bottom and vice versa. (The pane's bounding-box centre is no
 * good there: a deck follows the rocker, so mid-board it sits *below* the centre of a
 * box whose top is the kicked nose.) For a lone curve, pass the centre of its bounds.
 *
 * One answer per curve, so the comb never swaps sides partway: the deck comb stays above
 * the deck through the nose kick, the bottom's below the bottom.
 */
export const curvatureCombSide = (
  runs: readonly (readonly CombSample[])[],
  inside: readonly Vec2[],
): 1 | -1 => {
  if (inside.length === 0) return 1;
  let vote = 0;
  for (const run of runs) {
    for (let i = 1; i < run.length; i++) {
      const a = run[i - 1]!,
        b = run[i]!;
      let near = inside[0]!;
      let best = Infinity;
      for (const q of inside) {
        const d = (q.x - b.p.x) ** 2 + (q.y - b.p.y) ** 2;
        if (d < best) {
          best = d;
          near = q;
        }
      }
      const ds = Math.hypot(b.p.x - a.p.x, b.p.y - a.p.y);
      vote += ds * Math.sign(b.normal.x * (b.p.x - near.x) + b.normal.y * (b.p.y - near.y));
    }
  }
  return vote < 0 ? -1 : 1;
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
