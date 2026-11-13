// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Equality by value of the inputs the rails engine caches on (`native.ts`, `convert.ts`): the
 * documents the app sends are fresh objects on every request, so a cache cannot key on identity.
 */
import type { Chain, Pair } from '../types';

export const samePair = (a: Pair, b: Pair): boolean => a[0] === b[0] && a[1] === b[1];

/** Whether two chains have the same geometry: each knot's place and handles. */
export function sameShape(a: Chain, b: Chain): boolean {
  if (a === b) return true;
  if (a.knots.length !== b.knots.length) return false;
  for (let i = 0; i < a.knots.length; i++) {
    const p = a.knots[i]!;
    const q = b.knots[i]!;
    if (!samePair(p.p, q.p) || !samePair(p.in, q.in) || !samePair(p.out, q.out)) return false;
  }
  return true;
}

/** Whether two chains have the same knots: their geometry and smoothness (the editor's lock is not geometry). */
export function sameChain(a: Chain | undefined, b: Chain | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || !sameShape(a, b)) return false;
  return a.knots.every((k, i) => k.smooth === b.knots[i]!.smooth);
}

/** Whether two lists of numbers are equal, both absent counting as equal. */
export const sameNumbers = (
  a: readonly number[] | undefined,
  b: readonly number[] | undefined,
): boolean =>
  a === b ||
  (a !== undefined && b !== undefined && a.length === b.length && a.every((v, i) => v === b[i]));
