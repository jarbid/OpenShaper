// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Bottom features as a relief (docs/design/trim-blend-engine.md, "Bottom features"): the summed
 * depth r(x, y) of a board's enabled features at a plan point, and its gradient, to be added to
 * the bottom panel. Each feature is read through features.ts's own closed forms at
 * (ξ, u) = (x, |y| / w(x)), w the half width of the side y is on, with the half width standing
 * in for the chord length a channel is measured along. There is no fade towards the rail here:
 * the mesh fades the relief along the tuck, and `railFade` is not read.
 *
 * The gradient is analytic through `featureTerm` (d_ξ and d_u, the depth's own slope from its
 * keyed curve) and the chain rule through u: du/dx = −u w'/w, du/dy = sign(y)/w. The half
 * width is read from a table over the features' extent in x (`TRIM.reliefStep` apart, cubic
 * Hermites with central-difference node slopes), because a half-width call costs more than
 * the rest of a relief call; w' is that interpolant's own derivative.
 */
import { featureTerm, keyedEvaluator } from '../features';
import type { KeyedEval } from '../features';
import { TRIM } from '../params';
import type { BottomFeature } from '../types';

/** The relief and its gradient at (x, y) into `out[0 … 3)`: r, dr/dx, dr/dy. */
export type Relief = (x: number, y: number, out: Float64Array) => void;

interface Compiled {
  readonly feature: BottomFeature;
  readonly depth: KeyedEval;
  /** The depth's keys' extent in x: the feature is zero outside it. */
  readonly from: number;
  readonly to: number;
}

/** A half width over [lo, hi] as a table: per node w and Δ·w' (Δ the node spacing). */
function widthTable(w: (x: number) => number, lo: number, n: number, step: number): Float64Array {
  const t = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) t[2 * i] = w(lo + i * step);
  for (let i = 0; i < n; i++) {
    const a = Math.max(i - 1, 0);
    const b = Math.min(i + 1, n - 1);
    t[2 * i + 1] = (t[2 * b]! - t[2 * a]!) / (b - a);
  }
  return t;
}

/**
 * The relief of `features` (the enabled ones), or `null` when none is enabled. `halfWidth` is
 * the plus side's half width and the minus side's (the same function twice on a mirror board).
 */
export function compileRelief(
  features: readonly BottomFeature[],
  halfWidth: readonly [(x: number) => number, (x: number) => number],
): Relief | null {
  const list: Compiled[] = features
    .filter((f) => f.enabled)
    .map((feature) => {
      const keys = feature.depth.keys;
      return {
        feature,
        depth: keyedEvaluator(feature.depth),
        from: keys[0]!.s,
        to: keys[keys.length - 1]!.s,
      };
    });
  if (list.length === 0) return null;
  const nf = list.length;
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of list) {
    lo = Math.min(lo, c.from);
    hi = Math.max(hi, c.to);
  }
  const n = Math.max(2, Math.ceil((hi - lo) / TRIM.reliefStep) + 1);
  const step = (hi - lo) / (n - 1);
  const inv = 1 / step;
  const plus = widthTable(halfWidth[0], lo, n, step);
  const minus = halfWidth[1] === halfWidth[0] ? plus : widthTable(halfWidth[1], lo, n, step);
  const depth = new Float64Array(3);
  const term = new Float64Array(6);
  const tip = TRIM.loftTipWidth;
  return (x, y, out) => {
    let r = 0;
    let rx = 0;
    let ry = 0;
    let w = -1;
    let w1 = 0;
    let u = 0;
    for (let i = 0; i < nf; i++) {
      const c = list[i]!;
      if (!(x > c.from && x < c.to)) continue;
      if (w < 0) {
        const tb = y >= 0 ? plus : minus;
        const g = (x - lo) * inv;
        const k = Math.min(Math.max(Math.floor(g), 0), n - 2);
        const t = g - k;
        const t2 = t * t;
        const t3 = t2 * t;
        const b = 2 * k;
        const e = b + 2;
        w =
          (2 * t3 - 3 * t2 + 1) * tb[b]! +
          (t3 - 2 * t2 + t) * tb[b + 1]! +
          (-2 * t3 + 3 * t2) * tb[e]! +
          (t3 - t2) * tb[e + 1]!;
        w1 =
          ((6 * t2 - 6 * t) * (tb[b]! - tb[e]!) +
            (3 * t2 - 4 * t + 1) * tb[b + 1]! +
            (3 * t2 - 2 * t) * tb[e + 1]!) *
          inv;
        if (!(w > tip)) w = 0;
        u = w > 0 ? Math.abs(y) / w : 0;
      }
      c.depth(x, depth, 0);
      featureTerm(c.feature, depth[0]!, depth[1]!, depth[2]!, u, w, w1, 0, term);
      r += term[0]!;
      if (w > 0) {
        rx += term[1]! - (term[2]! * u * w1) / w;
        ry += (term[2]! * (y >= 0 ? 1 : -1)) / w;
      } else {
        rx += term[1]!;
      }
    }
    out[0] = r;
    out[1] = rx;
    out[2] = ry;
  };
}
