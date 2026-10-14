// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Seeded random geometry for property tests (design §16). Test-only.
 *
 * Knot vectors are built from breakpoints whose spacing is at least
 * `minSpacing × domain` (default 1/20), so the derivative scale of the
 * resulting curves is bounded and tests can state their tolerances from it.
 */
import { clampedBasis, knotsFromBreaks, periodicBasis } from '../basis';
import { makeCurve } from '../curve';
import type { ClampedBasis, Dim, NurbsCurve, PeriodicBasis } from '../types';

export interface RandomBasisOptions {
  /** Parameter domain (default `[0, 1]`); a periodic basis uses `[a, b)`. */
  readonly domain?: readonly [number, number];
  /** Highest interior multiplicity (default 1; at most the degree). */
  readonly maxMult?: number;
  /** Smallest spacing between distinct knots as a fraction of the domain (default 1/20). */
  readonly minSpacing?: number;
}

/** `count` sorted breakpoints strictly inside `(a, b)`, at least `gap` apart and from the ends. */
function interiorBreaks(
  rng: () => number,
  count: number,
  a: number,
  b: number,
  gap: number,
): number[] {
  // Spread the free length (b − a − (count + 1)·gap) randomly over count + 1 gaps.
  const free = b - a - (count + 1) * gap;
  if (free < 0) throw new Error(`cannot place ${count} knots ${gap} apart in [${a}, ${b}]`);
  const cuts = Array.from({ length: count }, () => rng() * free).sort((x, y) => x - y);
  return cuts.map((c, i) => a + c + (i + 1) * gap);
}

/** Interior multiplicities summing to exactly `slots`, each in [1, maxMult]. */
function multiplicities(rng: () => number, slots: number, maxMult: number): number[] {
  const mults: number[] = [];
  let left = slots;
  while (left > 0) {
    const m = Math.min(left, 1 + Math.floor(rng() * maxMult));
    mults.push(m);
    left -= m;
  }
  return mults;
}

/** A random clamped basis of `degree` with `count` control points. */
export function randomClampedBasis(
  rng: () => number,
  degree: number,
  count: number,
  opts: RandomBasisOptions = {},
): ClampedBasis {
  const [a, b] = opts.domain ?? [0, 1];
  const maxMult = Math.min(opts.maxMult ?? 1, degree);
  const mults = multiplicities(rng, count - degree - 1, maxMult);
  const breaks = interiorBreaks(rng, mults.length, a, b, (opts.minSpacing ?? 1 / 20) * (b - a));
  return clampedBasis(
    degree,
    knotsFromBreaks([a, ...breaks, b], [degree + 1, ...mults, degree + 1]),
  );
}

/** A random periodic basis of `degree` with `count` unique control points, period `b − a`. */
export function randomPeriodicBasis(
  rng: () => number,
  degree: number,
  count: number,
  opts: RandomBasisOptions = {},
): PeriodicBasis {
  const [a, b] = opts.domain ?? [0, 1];
  const maxMult = Math.min(opts.maxMult ?? 1, degree);
  const mults = multiplicities(rng, count, maxMult);
  const gap = (opts.minSpacing ?? 1 / 20) * (b - a);
  // The first knot is the domain start; the rest lie in (a, b − gap).
  const breaks = [a, ...interiorBreaks(rng, mults.length - 1, a, b, gap)];
  return periodicBasis(degree, knotsFromBreaks(breaks, mults), b - a);
}

export interface RandomCurveOptions extends RandomBasisOptions {
  readonly dim: Dim;
  readonly degree: number;
  readonly count: number;
  readonly kind?: 'clamped' | 'periodic';
  /** Random weights in `[weightRange[0], weightRange[1]]` (default: polynomial, all 1). */
  readonly weightRange?: readonly [number, number];
  /** Control coordinates uniform in `[-extent, extent]` (default 1). */
  readonly extent?: number;
}

/** A random curve: control coordinates uniform in `[-extent, extent]`, optional random weights. */
export function randomCurve(rng: () => number, opts: RandomCurveOptions): NurbsCurve {
  const basis =
    opts.kind === 'periodic'
      ? randomPeriodicBasis(rng, opts.degree, opts.count, opts)
      : randomClampedBasis(rng, opts.degree, opts.count, opts);
  const ext = opts.extent ?? 1;
  const points = Array.from({ length: basis.count * opts.dim }, () => (2 * rng() - 1) * ext);
  const wr = opts.weightRange;
  const weights = wr
    ? Array.from({ length: basis.count }, () => wr[0] + rng() * (wr[1] - wr[0]))
    : undefined;
  return makeCurve({ dim: opts.dim, basis, points, weights });
}
