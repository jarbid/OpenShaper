// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A station added between two others, with curves that follow theirs even when they are made of
 * different numbers of knots.
 *
 * `addStation` (`edits.ts`) blends the neighbours' curves knot by knot, which needs the same number
 * of knots on both, and copies the nearer neighbour's curve when they differ. A deck written as
 * a shape has two knots (`deck-shapes.ts`) beside a drawn deck of four, and a station at the tip of a
 * board keeps the curve it had when its neighbours' are rewritten, so that copy would move the built
 * surface by millimetres where the blend moves it by a tenth of one. Here the curve with fewer knots
 * first gets the knots it lacks, at the places the other curve has its own: a knot added to a Bézier curve
 * by splitting it (de Casteljau) leaves the curve exactly where it was. The two curves are then
 * blended as before.
 */
import type { Chain, ChainKnot, RailsBoard } from '@openshaper/board2';
import { addStation, blendCurve } from './edits';

type Pair = readonly [number, number];

const lerp = (a: Pair, b: Pair, t: number): Pair => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
];

/** Steps of the bisection that finds where a segment crosses a distance from the stringer. */
const BISECTION_STEPS = 60;

/**
 * `chain` with a knot added where it crosses `u`, by splitting its segment there: the curve is the same
 * curve. The new knot is smooth; the two handles the split shortens keep their directions. `chain`
 * itself for a `u` that is at or past a knot or an end.
 */
export function splitChainAt(chain: Chain, u: number): Chain {
  const k = chain.knots;
  const i = k.findIndex((q, j) => j + 1 < k.length && q.p[0] < u && u < k[j + 1]!.p[0]);
  if (i < 0) return chain;
  const a = k[i]!;
  const b = k[i + 1]!;
  const [p0, p1, p2, p3] = [a.p, a.out, b.in, b.p];
  // the parameter where the segment's x is u (a half curve's x increases along it)
  let lo = 0;
  let hi = 1;
  for (let step = 0; step < BISECTION_STEPS; step++) {
    const t = (lo + hi) / 2;
    const s = 1 - t;
    const x = s * s * s * p0[0] + 3 * s * s * t * p1[0] + 3 * s * t * t * p2[0] + t * t * t * p3[0];
    if (x < u) lo = t;
    else hi = t;
  }
  const t = (lo + hi) / 2;
  const q0 = lerp(p0, p1, t);
  const q1 = lerp(p1, p2, t);
  const q2 = lerp(p2, p3, t);
  const r0 = lerp(q0, q1, t);
  const r1 = lerp(q1, q2, t);
  const at = lerp(r0, r1, t);
  const added: ChainKnot = { p: at, in: r0, out: r1, smooth: true };
  return {
    knots: [...k.slice(0, i), { ...a, out: q0 }, added, { ...b, in: q2 }, ...k.slice(i + 2)],
  };
}

/** The distance from the stringer of each knot of a chain but its two ends. */
const interior = (c: Chain): number[] => c.knots.slice(1, -1).map((k) => k.p[0]);

/**
 * Which of the `from` places each of the `to` places is best paired with, keeping their order: the
 * choice of `to.length` of the `from` places that least moves them, as the indices into `from`.
 */
function pairing(from: readonly number[], to: readonly number[]): number[] {
  let best: number[] = [];
  let bestCost = Infinity;
  const walk = (j: number, start: number, chosen: number[], cost: number) => {
    if (cost >= bestCost) return;
    if (j === to.length) {
      best = [...chosen];
      bestCost = cost;
      return;
    }
    for (let i = start; i <= from.length - (to.length - j); i++) {
      chosen.push(i);
      walk(j + 1, i + 1, chosen, cost + Math.abs(from[i]! - to[j]!));
      chosen.pop();
    }
  };
  walk(0, 0, [], 0);
  return best;
}

/**
 * `chain` with the knots added that it lacks to have as many as `like`: the places of the knots of
 * `like` that no knot of `chain` is near are the places they are added at, so the two curves' knots stand
 * at nearly the same distances from the stringer and the pairs blend as the same part of each.
 * `chain` itself when it has as many knots, or more.
 */
export function withKnotsLike(chain: Chain, like: Chain): Chain {
  const lacking = like.knots.length - chain.knots.length;
  if (lacking <= 0) return chain;
  const wanted = interior(like);
  const kept = new Set(pairing(wanted, interior(chain)));
  let out = chain;
  wanted.forEach((u, i) => {
    if (!kept.has(i)) out = splitChainAt(out, u);
  });
  return out;
}

/**
 * The curve between `a` and `b`, `t` of the way from `a` to `b`: the knots of each paired with the
 * other's (after the one with fewer is given the knots it lacks) and blended point by point.
 */
export function blendMatched(a: Chain, b: Chain, t: number): Chain {
  if (a === b) return a;
  return blendCurve(withKnotsLike(a, b), withKnotsLike(b, a), t);
}

/**
 * A station added at `x` as `addStation` adds it, with its curves blended by {@link blendMatched}: the
 * same board where its neighbours' curves have the same number of knots, and curves that follow both
 * where they do not.
 */
export function insertStation(
  doc: RailsBoard,
  x: number,
): { readonly doc: RailsBoard; readonly index: number } | null {
  return addStation(doc, x, blendMatched);
}
