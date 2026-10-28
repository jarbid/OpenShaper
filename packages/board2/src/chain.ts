// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Bézier chains compiled for evaluation (docs/design/m1-model.md §2).
 *
 * A chain is a list of cubic Bézier segments through consecutive knots; its
 * parameter `s` runs 0 to the segment count, segment `k` covering `[k, k + 1]`,
 * so a derivative with respect to `s` is a derivative with respect to the local
 * parameter. Evaluation writes into caller buffers and allocates nothing. At a
 * knot the derivatives are the right-hand ones (the last segment's at the end).
 *
 * Function chains (rocker, deck: z against x) add the inverse solve of
 * x(s) = x, with the derivatives of z with respect to x.
 */
import { CHAIN_ARC_SAMPLES, SOLVE_MAX_ITER, SOLVE_PARAM_REL } from './params';
import type { Chain } from './types';

/** Segment `k` holds `c[8k … 8k + 7]` = x0 y0 x1 y1 x2 y2 x3 y3 (the Bézier control polygon). */
export interface CompiledChain {
  readonly segments: number;
  readonly c: Float64Array;
}

export function compileChain(chain: Chain): CompiledChain {
  const k = chain.knots;
  const segments = k.length - 1;
  const c = new Float64Array(8 * segments);
  for (let i = 0; i < segments; i++) {
    const a = k[i]!;
    const b = k[i + 1]!;
    c[8 * i] = a.p[0];
    c[8 * i + 1] = a.p[1];
    c[8 * i + 2] = a.out[0];
    c[8 * i + 3] = a.out[1];
    c[8 * i + 4] = b.in[0];
    c[8 * i + 5] = b.in[1];
    c[8 * i + 6] = b.p[0];
    c[8 * i + 7] = b.p[1];
  }
  return Object.freeze({ segments, c });
}

/**
 * Whether x(t) of a Bézier segment with x control values `c0 … c3` does not decrease on [0, 1],
 * to within `slack` (cm per unit t). A test of the *curve*, exact (the minimum of x′/3, a quadratic,
 * at the ends and at its stationary point), not of the control polygon: handles may overlap in x
 * (the first one beyond the second) and the curve still be a function of x.
 */
export function segmentXIncreasing(
  c0: number,
  c1: number,
  c2: number,
  c3: number,
  slack: number,
): boolean {
  // x′(t) / 3 = d0 (1-t)² + 2 d1 (1-t) t + d2 t², the Bernstein form of the Bézier differences
  const d0 = c1 - c0;
  const d1 = c2 - c1;
  const d2 = c3 - c2;
  const floor = -slack / 3;
  if (d0 < floor || d2 < floor) return false;
  const a = d0 - 2 * d1 + d2;
  if (a > 0) {
    const t = (d0 - d1) / a;
    if (t > 0 && t < 1 && (d0 * d2 - d1 * d1) / a < floor) return false;
  }
  return true;
}

/**
 * The point, and for `order ≥ 1, 2` the first and second derivatives, at chain
 * parameter `s` into `out[o … o + 2·(order + 1))` as x y x′ y′ x″ y″.
 */
export function chainEval(
  ch: CompiledChain,
  s: number,
  order: 0 | 1 | 2,
  out: Float64Array,
  o: number,
): void {
  let k = Math.floor(s);
  if (k < 0) k = 0;
  else if (k > ch.segments - 1) k = ch.segments - 1;
  segEval(ch.c, 8 * k, Math.min(Math.max(s - k, 0), 1), order, out, o);
}

/** The same on one segment `c[b … b + 7]` at local parameter `t` in [0, 1]. */
export function segEval(
  c: Float64Array,
  b: number,
  t: number,
  order: 0 | 1 | 2,
  out: Float64Array,
  o: number,
): void {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  for (let d = 0; d < 2; d++) {
    const p0 = c[b + d]!;
    const p1 = c[b + 2 + d]!;
    const p2 = c[b + 4 + d]!;
    const p3 = c[b + 6 + d]!;
    out[o + d] = w0 * p0 + w1 * p1 + w2 * p2 + w3 * p3;
    if (order >= 1) {
      out[o + 2 + d] = 3 * (u * u * (p1 - p0) + 2 * u * t * (p2 - p1) + t * t * (p3 - p2));
    }
    if (order >= 2) {
      out[o + 4 + d] = 6 * (u * (p2 - 2 * p1 + p0) + t * (p3 - 2 * p2 + p1));
    }
  }
}

const dx = (c: Float64Array, b: number, t: number): number => {
  const u = 1 - t;
  return (
    3 *
    (u * u * (c[b + 2]! - c[b]!) +
      2 * u * t * (c[b + 4]! - c[b + 2]!) +
      t * t * (c[b + 6]! - c[b + 4]!))
  );
};
const px = (c: Float64Array, b: number, t: number): number => {
  const u = 1 - t;
  return (
    u * u * u * c[b]! +
    3 * u * u * t * c[b + 2]! +
    3 * u * t * t * c[b + 4]! +
    t * t * t * c[b + 6]!
  );
};

/**
 * The parameter `s ∈ [sLo, sHi]` with x(s) = `x`, where x is non-decreasing on
 * that interval (the caller guarantees it; the validator checks it). An `x`
 * outside the interval's range gives the nearer end. Safeguarded Newton, then
 * bisection: it always terminates.
 */
export function chainParamAtX(ch: CompiledChain, x: number, sLo: number, sHi: number): number {
  const c = ch.c;
  // The segment holding x: the first whose end reaches x.
  let k = Math.max(Math.floor(sLo), 0);
  const last = Math.min(Math.ceil(sHi), ch.segments) - 1;
  while (k < last && px(c, 8 * k, 1) < x) k++;
  let tlo = k === Math.floor(sLo) ? sLo - k : 0;
  let thi = k + 1 >= sHi ? sHi - k : 1;
  tlo = Math.min(Math.max(tlo, 0), 1);
  thi = Math.min(Math.max(thi, tlo), 1);
  const b = 8 * k;
  if (px(c, b, tlo) >= x) return k + tlo;
  if (px(c, b, thi) <= x) return k + thi;
  let t = tlo + ((x - px(c, b, tlo)) / (px(c, b, thi) - px(c, b, tlo))) * (thi - tlo);
  let lo = tlo;
  let hi = thi;
  for (let it = 0; it < SOLVE_MAX_ITER; it++) {
    const f = px(c, b, t) - x;
    if (f === 0) break;
    if (f > 0) hi = t;
    else lo = t;
    const d = dx(c, b, t);
    let next = t - f / d;
    if (!(d > 0) || !(next > lo && next < hi)) next = 0.5 * (lo + hi);
    const done = Math.abs(next - t) <= SOLVE_PARAM_REL * Math.max(1, Math.abs(next)) || !(hi > lo);
    t = next;
    if (done) break;
  }
  return k + t;
}

/**
 * z, dz/dx, d²z/dx² of a function chain (x increasing along it) at `x` into
 * `out[o … o + 3)`. Outside the chain's x-range the end value is held (slopes 0).
 */
export function funcEval(ch: CompiledChain, x: number, out: Float64Array, o: number): void {
  const s = chainParamAtX(ch, x, 0, ch.segments);
  const tmp = TMP;
  chainEval(ch, s, 2, tmp, 0);
  const xs = tmp[2]!;
  const xss = tmp[4]!;
  out[o] = tmp[1]!;
  if (!(xs > 0)) {
    out[o + 1] = 0;
    out[o + 2] = 0;
    return;
  }
  out[o + 1] = tmp[3]! / xs;
  out[o + 2] = (tmp[5]! * xs - tmp[3]! * xss) / (xs * xs * xs);
}
// Scratch of `funcEval`: single-threaded use, written and read within the call.
const TMP = new Float64Array(6);

/** x range of a chain: its first and last knot. */
export function chainXRange(ch: CompiledChain): readonly [number, number] {
  return [ch.c[0]!, ch.c[8 * ch.segments - 2]!];
}

/** The chain parameters at which the cumulative arc length of `[s0, s1]` reaches each of the sorted `fractions` ∈ [0, 1]. */
export function arcFractionParams(
  ch: CompiledChain,
  s0: number,
  s1: number,
  fractions: ArrayLike<number>,
): Float64Array {
  const n = Math.max(1, Math.ceil(s1 - s0)) * CHAIN_ARC_SAMPLES;
  const ss = new Float64Array(n + 1);
  const len = new Float64Array(n + 1);
  const p = new Float64Array(2);
  let px0 = 0;
  let py0 = 0;
  for (let i = 0; i <= n; i++) {
    const s = s0 + ((s1 - s0) * i) / n;
    chainEval(ch, s, 0, p, 0);
    ss[i] = s;
    len[i] = i === 0 ? 0 : len[i - 1]! + Math.hypot(p[0]! - px0, p[1]! - py0);
    px0 = p[0]!;
    py0 = p[1]!;
  }
  const total = len[n]!;
  const out = new Float64Array(fractions.length);
  let i = 1;
  for (let j = 0; j < fractions.length; j++) {
    const target = fractions[j]! * total;
    while (i < n && len[i]! < target) i++;
    const a = len[i - 1]!;
    const w = len[i]! - a;
    const f = w > 0 ? (target - a) / w : 0;
    out[j] = ss[i - 1]! + f * (ss[i]! - ss[i - 1]!);
  }
  if (fractions.length > 0) {
    if (fractions[0] === 0) out[0] = s0;
    if (fractions[fractions.length - 1] === 1) out[fractions.length - 1] = s1;
  }
  return out;
}

/**
 * Every parameter at which x is a local minimum of the chain or the chain starts or ends:
 * the candidates for the notch tip. Returns the one with the smallest x
 * (the first on a tie) and its x.
 */
export function chainMinX(ch: CompiledChain): { readonly s: number; readonly x: number } {
  let bestS = 0;
  let bestX = ch.c[0]!;
  const consider = (s: number, x: number): void => {
    if (x < bestX) {
      bestX = x;
      bestS = s;
    }
  };
  for (let k = 0; k < ch.segments; k++) {
    const b = 8 * k;
    consider(k + 1, ch.c[b + 6]!);
    // x′(t) is the quadratic a t² + b t + c with the Bézier differences.
    const d0 = ch.c[b + 2]! - ch.c[b]!;
    const d1 = ch.c[b + 4]! - ch.c[b + 2]!;
    const d2 = ch.c[b + 6]! - ch.c[b + 4]!;
    const a = d0 - 2 * d1 + d2;
    const bb = 2 * (d1 - d0);
    const roots: number[] = [];
    if (a === 0) {
      if (bb !== 0) roots.push(-d0 / bb);
    } else {
      const disc = bb * bb - 4 * a * d0;
      if (disc >= 0) {
        const r = Math.sqrt(disc);
        roots.push((-bb - r) / (2 * a), (-bb + r) / (2 * a));
      }
    }
    for (const t of roots) if (t > 0 && t < 1) consider(k + t, px(ch.c, b, t));
  }
  return { s: bestS, x: bestX };
}
