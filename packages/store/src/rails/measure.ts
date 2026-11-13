// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The half width and the thickness of a rails board at a station, read from its chains to full
 * precision. These are the numbers a station's curves are scaled by: a station curve is stored in
 * (u, v), and shown and edited as `(u w(x), v T(x))`, so the store must read `w` and `T` exactly
 * as the engine does or an edit would be written back into a different frame than it was drawn in.
 *
 * The engine's definitions (board2's `trim/outline.ts` `filledOutline` and `halfWidthOf`, and its
 * `chain.ts` `chainParamAtX` and `funcEval`) are repeated here, because the store may not import
 * engine code. A test holds them to the engine's own values. The kernel's `valueAt` is not used:
 * it stops its root search at 0.03 mm.
 */
import type { Chain, ChainKnot, Outline } from '@openshaper/board2';

/** Newton steps (each safeguarded by bisection) before the root search stops: as the engine's. */
const SOLVE_MAX_ITER = 80;
/** The root search stops when a step moves the parameter by less than this share of it: as the engine's. */
const SOLVE_PARAM_REL = 1e-15;

/** The control points of segment `k` of `chain`, along one axis (0 = x, 1 = y). */
function controls(chain: Chain, k: number, axis: 0 | 1): readonly [number, number, number, number] {
  const a = chain.knots[k]!;
  const b = chain.knots[k + 1]!;
  return [a.p[axis], a.out[axis], b.in[axis], b.p[axis]];
}

/** A cubic Bézier coordinate at `t`, in the engine's Bernstein form. */
function bez(c: readonly [number, number, number, number], t: number): number {
  const u = 1 - t;
  return u * u * u * c[0] + 3 * u * u * t * c[1] + 3 * u * t * t * c[2] + t * t * t * c[3];
}

/** Its derivative in `t`. */
function dbez(c: readonly [number, number, number, number], t: number): number {
  const u = 1 - t;
  return 3 * (u * u * (c[1] - c[0]) + 2 * u * t * (c[2] - c[1]) + t * t * (c[3] - c[2]));
}

/**
 * The y of `chain` at `x`, on the part of the chain from segment `from` on, where x does not
 * decrease (the caller's guarantee). Past either end, the end's y. The same search as the
 * engine's: the first segment whose end reaches x, then safeguarded Newton.
 */
function yAtX(chain: Chain, x: number, from: number): number {
  const segments = chain.knots.length - 1;
  let k = Math.max(from, 0);
  while (k < segments - 1 && chain.knots[k + 1]!.p[0] < x) k++;
  const cx = controls(chain, k, 0);
  const cy = controls(chain, k, 1);
  if (bez(cx, 0) >= x) return bez(cy, 0);
  if (bez(cx, 1) <= x) return bez(cy, 1);
  let t = (x - bez(cx, 0)) / (bez(cx, 1) - bez(cx, 0));
  let lo = 0;
  let hi = 1;
  for (let it = 0; it < SOLVE_MAX_ITER; it++) {
    const f = bez(cx, t) - x;
    if (f === 0) break;
    if (f > 0) hi = t;
    else lo = t;
    const d = dbez(cx, t);
    let next = t - f / d;
    if (!(d > 0) || !(next > lo && next < hi)) next = 0.5 * (lo + hi);
    const done = Math.abs(next - t) <= SOLVE_PARAM_REL * Math.max(1, Math.abs(next)) || !(hi > lo);
    t = next;
    if (done) break;
  }
  return bez(cy, t);
}

/** The height of a function chain (the rocker, the deck line) at `x`; past an end, the end's. */
export const chainHeightAt = (chain: Chain, x: number): number => yAtX(chain, x, 0);

/** Whether an outline is notched: the tail is at x = 0, so its first knot lies past it. */
export const isNotched = (outline: Outline): boolean => outline.plus.knots[0]!.p[0] > 0;

/** A notched outline chain with the notch filled: a straight tail end from (0, 0) to the tip. */
function filledChain(chain: Chain): Chain {
  const [, tip, ...rest] = chain.knots;
  if (tip === undefined) return chain;
  const end: ChainKnot = { p: [0, 0], in: [0, 0], out: [0, 0], smooth: false };
  return { knots: [end, { ...tip, in: tip.p }, ...rest] };
}

/**
 * The first segment of the forward branch: a blunt (or filled) tail starts with straight runs at
 * the tail's x, and the half width is read from the first segment after them. Exact equality: the
 * document holds the tail at x = 0 exactly.
 */
function forwardFrom(chain: Chain): number {
  const x0 = chain.knots[0]!.p[0];
  const segments = chain.knots.length - 1;
  let from = 0;
  while (from < segments - 1 && [...controls(chain, from, 0)].every((x) => x === x0)) from++;
  return from;
}

const halfWidths = new WeakMap<Chain, (x: number) => number>();

/**
 * The half width of one side of an outline at x, with a notch filled in: the width a station's
 * curves are scaled by. One function per chain object.
 */
export function halfWidthFn(outline: Outline, side?: 'minus'): (x: number) => number {
  const chain = side === 'minus' ? (outline.minus ?? outline.plus) : outline.plus;
  let fn = halfWidths.get(chain);
  if (fn === undefined) {
    const filled = chain.knots[0]!.p[0] > 0 ? filledChain(chain) : chain;
    const from = forwardFrom(filled);
    fn = (x) => Math.abs(yAtX(filled, x, from));
    halfWidths.set(chain, fn);
  }
  return fn;
}

/** The thickness at x: the deck line's height over the rocker's. */
export const thicknessAt = (rocker: Chain, deck: Chain, x: number): number =>
  chainHeightAt(deck, x) - chainHeightAt(rocker, x);
