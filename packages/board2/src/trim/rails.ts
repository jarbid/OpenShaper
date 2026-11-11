// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A rail, and the rail at every point of a loop (docs/design/trim-blend-workflow.md).
 *
 * A rail is two blends that meet on the outline at the apex: one from the deck down to it,
 * one from the bottom up to it. Each is a conic that starts on its panel a set distance in
 * from the outline and ends vertical at the apex. Seven numbers say which rail it is, and
 * they are the numbers a shaper already has words for.
 */
import { TRIM } from '../params';
import { smoothAlong } from './loop';
import type { Loop } from './loop';

export interface RailRecipe {
  /** How far in from the outline the deck starts to turn, cm. */
  readonly band: number;
  /** How square the deck blend's shoulder is: the conic's rho, 0 to 1. Half is a parabola. */
  readonly hardness: number;
  /** How far in from the outline the bottom starts to turn, cm. */
  readonly tuck: number;
  /** The tuck's rho. Low is a flat bevel, high hugs the corner. */
  readonly tuckShape: number;
  /** The angle the tuck leaves the bottom at, degrees. 0 is tangent: no edge. */
  readonly bottomEdge: number;
  /** The angle the deck blend leaves the deck at, degrees. 0 is tangent. */
  readonly deckEdge: number;
  /** Where the apex sits between the bottom and the deck at the outline, 0 to 1. */
  readonly apex: number;
}

/** A rail's numbers at every sample of a loop, limited so the bands stay valid. */
export interface RailLaws {
  /** Deck band and tuck widths, cm. */
  readonly deckWidth: Float64Array;
  readonly tuckWidth: Float64Array;
  readonly deckRho: Float64Array;
  readonly tuckRho: Float64Array;
  readonly apex: Float64Array;
  /** Tangents of the two edge angles. */
  readonly deckEdge: Float64Array;
  readonly bottomEdge: Float64Array;
}

/** `(a^-p + b^-p)^(-1/p)`: a smooth value just under the smaller of two positive numbers. */
const softMin = (a: number, b: number): number =>
  Math.pow(Math.pow(a, -TRIM.bandSoftmin) + Math.pow(b, -TRIM.bandSoftmin), -1 / TRIM.bandSoftmin);

/**
 * The rail at every sample of `loop`, from the recipe the caller gives for each.
 *
 * A band or tuck is held to a share of the local feature size, so the bands that run down
 * opposite edges of a pin, a nose or a notch wall cannot meet: there the board becomes all
 * rail, by itself, without the designer narrowing anything.
 */
export function railLaws(loop: Loop, recipeAt: (i: number) => RailRecipe): RailLaws {
  const n = loop.n;
  const limit = smoothAlong(loop, loop.lfs, TRIM.bandSmooth);
  const laws: RailLaws = {
    deckWidth: new Float64Array(n),
    tuckWidth: new Float64Array(n),
    deckRho: new Float64Array(n),
    tuckRho: new Float64Array(n),
    apex: new Float64Array(n),
    deckEdge: new Float64Array(n),
    bottomEdge: new Float64Array(n),
  };
  const rad = Math.PI / 180;
  for (let i = 0; i < n; i++) {
    const r = recipeAt(i);
    const soft = TRIM.bandShare * limit[i]!;
    const hard = TRIM.bandHard * loop.lfs[i]!;
    laws.deckWidth[i] = Math.min(softMin(r.band, soft), hard);
    laws.tuckWidth[i] = Math.min(softMin(r.tuck, soft), hard);
    laws.deckRho[i] = r.hardness;
    laws.tuckRho[i] = r.tuckShape;
    laws.apex[i] = r.apex;
    laws.deckEdge[i] = Math.tan(r.deckEdge * rad);
    laws.bottomEdge[i] = Math.tan(r.bottomEdge * rad);
  }
  return laws;
}
