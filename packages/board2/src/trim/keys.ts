// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Rail keys to laws: each of a rail's seven numbers interpolated along one side of the board
 * between its keys, and the rail at every sample of an outline loop read off those curves.
 */
import type { RailKey } from './board';
import type { Loop } from './loop';
import { railLaws } from './rails';
import type { RailLaws } from './rails';

const RECIPE_KEYS = [
  'band',
  'hardness',
  'tuck',
  'tuckShape',
  'bottomEdge',
  'deckEdge',
  'apex',
] as const;

/** How the rail's numbers run along one side of the board. */
export type RailLawsAlong = Record<(typeof RECIPE_KEYS)[number], (x: number) => number>;

/** Monotone cubic through `(xs, ys)`, held flat outside. */
function monotone(xs: readonly number[], ys: readonly number[]): (x: number) => number {
  const n = xs.length;
  if (n === 1) return () => ys[0]!;
  const d: number[] = [];
  for (let i = 0; i + 1 < n; i++) d.push((ys[i + 1]! - ys[i]!) / (xs[i + 1]! - xs[i]!));
  const m: number[] = [d[0]!];
  for (let i = 1; i + 1 < n; i++) m.push(d[i - 1]! * d[i]! <= 0 ? 0 : (d[i - 1]! + d[i]!) / 2);
  m.push(d[n - 2]!);
  for (let i = 0; i + 1 < n; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i]! / d[i]!;
    const b = m[i + 1]! / d[i]!;
    const h = Math.hypot(a, b);
    if (h > 3) {
      m[i] = (3 * a * d[i]!) / h;
      m[i + 1] = (3 * b * d[i]!) / h;
    }
  }
  return (x) => {
    if (x <= xs[0]!) return ys[0]!;
    if (x >= xs[n - 1]!) return ys[n - 1]!;
    let i = 0;
    while (i + 2 < n && xs[i + 1]! < x) i++;
    const h = xs[i + 1]! - xs[i]!;
    const t = (x - xs[i]!) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i]! +
      (t3 - 2 * t2 + t) * h * m[i]! +
      (-2 * t3 + 3 * t2) * ys[i + 1]! +
      (t3 - t2) * h * m[i + 1]!
    );
  };
}

/** Each of a rail's numbers interpolated along the board between the keys, which are sorted by x. */
export function railsAlong(keys: readonly RailKey[]): RailLawsAlong {
  const xs = keys.map((k) => k.x);
  const out = {} as RailLawsAlong;
  for (const name of RECIPE_KEYS) {
    out[name] = monotone(
      xs,
      keys.map((k) => k.rail[name]),
    );
  }
  return out;
}

/** The rail at every sample of the loop: the plus side's laws where y >= 0, the minus side's elsewhere. */
export function lawsFromKeys(loop: Loop, plus: RailLawsAlong, minus: RailLawsAlong): RailLaws {
  return railLaws(loop, (i) => {
    const l = loop.y[i]! >= 0 ? plus : minus;
    const x = loop.x[i]!;
    return {
      band: l.band(x),
      hardness: l.hardness(x),
      tuck: l.tuck(x),
      tuckShape: l.tuckShape(x),
      bottomEdge: l.bottomEdge(x),
      deckEdge: l.deckEdge(x),
      apex: l.apex(x),
    };
  });
}
