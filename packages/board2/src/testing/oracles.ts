// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Independent oracles for the board2 tests: tiny, slow, obviously correct
 * re-implementations that share no code with the evaluator.
 */
import type { Chain } from '../types';

type P2 = readonly [number, number];

/** Cubic Bézier point of segment `k` of a chain at local `t`. */
export function chainPoint(c: Chain, k: number, t: number): P2 {
  const a = c.knots[k]!;
  const b = c.knots[k + 1]!;
  const u = 1 - t;
  const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  const px = [a.p[0], a.out[0], b.in[0], b.p[0]];
  const py = [a.p[1], a.out[1], b.in[1], b.p[1]];
  return [w.reduce((s, wi, i) => s + wi * px[i]!, 0), w.reduce((s, wi, i) => s + wi * py[i]!, 0)];
}

/** A chain sampled densely: `per` points per segment (the last included). */
export function sampleChain(c: Chain, per: number): P2[] {
  const out: P2[] = [];
  for (let k = 0; k < c.knots.length - 1; k++) {
    for (let i = 0; i < per; i++) out.push(chainPoint(c, k, i / per));
  }
  out.push(c.knots[c.knots.length - 1]!.p);
  return out;
}

/** z of a function chain (x increasing along it) at x, by bisection on each segment. */
export function chainZ(c: Chain, x: number): number {
  const n = c.knots.length - 1;
  let k = 0;
  while (k < n - 1 && c.knots[k + 1]!.p[0] < x) k++;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    if (chainPoint(c, k, mid)[0] < x) lo = mid;
    else hi = mid;
  }
  return chainPoint(c, k, 0.5 * (lo + hi))[1];
}

/** Distance from (x, y) to the polyline through `pts`. */
export function distanceToPolyline(
  pts: readonly (readonly number[])[],
  p: readonly number[],
): number {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const d = b.map((v, j) => v - a[j]!);
    const w = p.map((v, j) => v - a[j]!);
    const len2 = d.reduce((s, v) => s + v * v, 0);
    const t =
      len2 > 0 ? Math.min(Math.max(w.reduce((s, v, j) => s + v * d[j]!, 0) / len2, 0), 1) : 0;
    const dist = Math.hypot(...p.map((v, j) => v - (a[j]! + t * d[j]!)));
    if (dist < best) best = dist;
  }
  return best;
}

/** Distance from (x, y) to a plan chain: dense sampling, then golden-section refinement. */
export function distanceToChain(c: Chain, x: number, y: number): number {
  let best = Infinity;
  for (let k = 0; k < c.knots.length - 1; k++) {
    const n = 400;
    const d = (t: number): number => {
      const q = chainPoint(c, k, t);
      return Math.hypot(q[0] - x, q[1] - y);
    };
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i <= n; i++) {
      const v = d(i / n);
      if (v < bd) {
        bd = v;
        bi = i;
      }
    }
    let lo = Math.max(0, (bi - 1) / n);
    let hi = Math.min(1, (bi + 1) / n);
    const g = (Math.sqrt(5) - 1) / 2;
    for (let i = 0; i < 80; i++) {
      const m1 = hi - g * (hi - lo);
      const m2 = lo + g * (hi - lo);
      if (d(m1) < d(m2)) hi = m2;
      else lo = m1;
    }
    best = Math.min(best, d(0.5 * (lo + hi)), bd);
  }
  return best;
}
