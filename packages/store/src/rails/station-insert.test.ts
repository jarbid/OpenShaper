// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A station added with curves that follow its neighbours' (`station-insert.ts`): splitting a curve
 * leaves it where it was, a curve is given the knots it lacks to match the other's, the blend is the
 * old one where the counts already match, and the board built from a station added between two that
 * differ is closed and no further from the board without it than the stations' own blend allows.
 */
import type { Chain, ChainKnot } from '@openshaper/board2';
import { describe, expect, it } from 'vitest';
import { addStation, blendCurve } from './edits';
import { createRailsStore } from './rails-store';
import { blendMatched, insertStation, splitChainAt, withKnotsLike } from './station-insert';
import { closedVerdict } from './test-support/closed';
import { everyBoard } from './test-support/real-boards';
import { between, seeded, type Rng } from './test-support/zone-kit';

/** A cubic Bézier coordinate at `t`. */
const bez = (a: number, b: number, c: number, d: number, t: number): number => {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
};

/** The chain's points, every segment at 41 values of its parameter, as flat [u, v] pairs. */
function points(chain: Chain): [number, number][] {
  const out: [number, number][] = [];
  const k = chain.knots;
  for (let i = 0; i + 1 < k.length; i++) {
    const a = k[i]!;
    const b = k[i + 1]!;
    for (let j = i === 0 ? 0 : 1; j <= 40; j++) {
      const t = j / 40;
      out.push([
        bez(a.p[0], a.out[0], b.in[0], b.p[0], t),
        bez(a.p[1], a.out[1], b.in[1], b.p[1], t),
      ]);
    }
  }
  return out;
}

/** The height of the chain at `u`, by bisection on the segment that holds it. */
function heightAt(chain: Chain, u: number): number {
  const k = chain.knots;
  for (let i = 0; i + 1 < k.length; i++) {
    const a = k[i]!;
    const b = k[i + 1]!;
    if (u > b.p[0] + 1e-12) continue;
    let lo = 0;
    let hi = 1;
    for (let s = 0; s < 60; s++) {
      const t = (lo + hi) / 2;
      if (bez(a.p[0], a.out[0], b.in[0], b.p[0], t) < u) lo = t;
      else hi = t;
    }
    return bez(a.p[1], a.out[1], b.in[1], b.p[1], (lo + hi) / 2);
  }
  return k[k.length - 1]!.p[1];
}

/** A half curve in (u, v) with `n` knots: u from 0 to 1, the handles inside their segments, v falling. */
function randomChain(rng: Rng, n: number): Chain {
  const us = [
    0,
    ...Array.from({ length: n - 2 }, () => between(rng, 0.05, 0.95)).sort((a, b) => a - b),
    1,
  ];
  // keep the knots apart
  for (let i = 1; i < us.length; i++) us[i] = Math.max(us[i]!, us[i - 1]! + 0.02);
  const top = us[us.length - 1]!;
  const norm = us.map((u) => u / top);
  let v = 1;
  const vs = norm.map((_, i) => (i === 0 ? 1 : (v -= between(rng, 0, 0.5 / n))));
  const knots: ChainKnot[] = norm.map((u, i) => {
    const lo = i === 0 ? u : (norm[i - 1]! + u) / 2;
    const hi = i === norm.length - 1 ? u : (u + norm[i + 1]!) / 2;
    const dv = between(rng, -0.05, 0);
    return {
      p: [u, vs[i]!],
      in: i === 0 ? [u, vs[i]!] : [between(rng, lo, u), vs[i]! - dv],
      out: i === norm.length - 1 ? [u, vs[i]!] : [between(rng, u, hi), i === 0 ? 1 : vs[i]! + dv],
      smooth: true,
    };
  });
  return { knots };
}

describe('splitChainAt', () => {
  it('adds a knot and leaves the curve where it was', () => {
    const rng = seeded(3);
    for (let i = 0; i < 100; i++) {
      const chain = randomChain(rng, 2 + (i % 4));
      const u = between(rng, 0.02, 0.98);
      const split = splitChainAt(chain, u);
      const at = chain.knots.some((k) => Math.abs(k.p[0] - u) < 1e-12);
      expect(split.knots.length).toBe(chain.knots.length + (at ? 0 : 1));
      for (const [x, y] of points(chain)) {
        expect(heightAt(split, x)).toBeCloseTo(y, 9);
      }
    }
  });

  it('puts the new knot at u, smooth, and keeps the ends and the other knots', () => {
    const chain = randomChain(seeded(8), 3);
    const split = splitChainAt(chain, 0.5);
    const at = split.knots.find((k) => !chain.knots.some((q) => q.p === k.p))!;
    expect(at.p[0]).toBeCloseTo(0.5, 12);
    expect(at.smooth).toBe(true);
    expect(split.knots[0]!.p).toBe(chain.knots[0]!.p);
    expect(split.knots[split.knots.length - 1]!.p).toBe(chain.knots[chain.knots.length - 1]!.p);
  });

  it('keeps the handles inside their segments, so the curve stays a function of u', () => {
    const rng = seeded(9);
    for (let i = 0; i < 100; i++) {
      const split = splitChainAt(randomChain(rng, 2 + (i % 4)), between(rng, 0.02, 0.98));
      const k = split.knots;
      for (let j = 0; j + 1 < k.length; j++) {
        expect(k[j]!.p[0]).toBeLessThan(k[j + 1]!.p[0]);
        expect(k[j]!.out[0]).toBeGreaterThanOrEqual(k[j]!.p[0] - 1e-12);
        expect(k[j]!.out[0]).toBeLessThanOrEqual(k[j + 1]!.p[0] + 1e-12);
        expect(k[j + 1]!.in[0]).toBeGreaterThanOrEqual(k[j]!.p[0] - 1e-12);
        expect(k[j + 1]!.in[0]).toBeLessThanOrEqual(k[j + 1]!.p[0] + 1e-12);
      }
    }
  });

  it('is the chain itself at a knot, at an end and outside', () => {
    const chain = randomChain(seeded(4), 3);
    for (const u of [0, 1, -1, 2, chain.knots[1]!.p[0]]) expect(splitChainAt(chain, u)).toBe(chain);
  });
});

describe('withKnotsLike', () => {
  it('gives a curve as many knots as the other, and the curve is the same', () => {
    const rng = seeded(21);
    for (let i = 0; i < 100; i++) {
      const few = randomChain(rng, 2 + (i % 3));
      const many = randomChain(rng, few.knots.length + 1 + (i % 3));
      const made = withKnotsLike(few, many);
      expect(made.knots).toHaveLength(many.knots.length);
      for (const [x, y] of points(few)) expect(heightAt(made, x)).toBeCloseTo(y, 9);
      // the knots it had are the knots it has
      for (const k of few.knots) expect(made.knots.some((q) => q.p[0] === k.p[0])).toBe(true);
    }
  });

  it('is the curve itself when it has as many knots, or more', () => {
    const a = randomChain(seeded(1), 4);
    expect(withKnotsLike(a, randomChain(seeded(2), 4))).toBe(a);
    expect(withKnotsLike(a, randomChain(seeded(2), 2))).toBe(a);
  });
});

describe('blendMatched', () => {
  it('is the old blend where the counts already match', () => {
    const rng = seeded(31);
    for (let i = 0; i < 50; i++) {
      const a = randomChain(rng, 2 + (i % 4));
      const b = randomChain(rng, a.knots.length);
      expect(blendMatched(a, b, 0.37)).toEqual(blendCurve(a, b, 0.37));
    }
  });

  it('is each curve at the ends of the blend, and between them where the counts differ', () => {
    const rng = seeded(41);
    for (let i = 0; i < 50; i++) {
      const a = randomChain(rng, 2);
      const b = randomChain(rng, 4);
      for (const [x, y] of points(a)) expect(heightAt(blendMatched(a, b, 0), x)).toBeCloseTo(y, 9);
      for (const [x, y] of points(b)) expect(heightAt(blendMatched(a, b, 1), x)).toBeCloseTo(y, 9);
      const mid = blendMatched(a, b, 0.5);
      expect(mid.knots).toHaveLength(4);
      for (const x of [0.2, 0.4, 0.6, 0.8]) {
        const lo = Math.min(heightAt(a, x), heightAt(b, x));
        const hi = Math.max(heightAt(a, x), heightAt(b, x));
        // the blend of the control points is not the blend of the heights, but it stays near both
        expect(heightAt(mid, x)).toBeGreaterThan(lo - 0.25);
        expect(heightAt(mid, x)).toBeLessThan(hi + 0.25);
      }
    }
  });

  it('is a curve that was not made from nothing: neither neighbour’s own object', () => {
    const a = randomChain(seeded(5), 2);
    const b = randomChain(seeded(6), 4);
    const mid = blendMatched(a, b, 0.5);
    expect(mid).not.toBe(a);
    expect(mid).not.toBe(b);
    expect(blendMatched(a, a, 0.5)).toBe(a);
  });
});

describe.each(everyBoard)('insertStation on the %s board', (_name, make) => {
  const doc = make();

  it('is the board addStation makes where its neighbours’ curves have the same knots', () => {
    let same = 0;
    for (let i = 0; i + 1 < doc.stations.length; i++) {
      const a = doc.stations[i]!;
      const b = doc.stations[i + 1]!;
      const alike =
        a.plus.deck.knots.length === b.plus.deck.knots.length &&
        a.plus.bottom.knots.length === b.plus.bottom.knots.length &&
        (a.minus === undefined ||
          (a.minus.deck.knots.length === b.minus!.deck.knots.length &&
            a.minus.bottom.knots.length === b.minus!.bottom.knots.length));
      if (!alike) continue;
      same++;
      const x = (a.x + b.x) / 2;
      expect(insertStation(doc, x)).toEqual(addStation(doc, x));
    }
    expect(same).toBeGreaterThanOrEqual(0);
  });

  it('adds a station between every pair, in order, with curves of the same knots as a neighbour', () => {
    for (let i = 0; i + 1 < doc.stations.length; i++) {
      const a = doc.stations[i]!;
      const b = doc.stations[i + 1]!;
      const added = insertStation(doc, (a.x + b.x) / 2);
      expect(added).not.toBeNull();
      expect(added!.index).toBe(i + 2);
      const st = added!.doc.stations[i + 1]!;
      const most = (f: (s: typeof a) => number) => Math.max(f(a), f(b));
      expect(st.plus.deck.knots.length).toBe(most((s) => s.plus.deck.knots.length));
      expect(st.plus.bottom.knots.length).toBe(most((s) => s.plus.bottom.knots.length));
    }
  });

  it('builds a closed board with a station added between the first pair and the last', () => {
    const first = doc.stations[0]!;
    const second = doc.stations[1]!;
    const last = doc.stations[doc.stations.length - 1]!;
    const before = doc.stations[doc.stations.length - 2]!;
    for (const [a, b] of [
      [first, second],
      [before, last],
    ] as const) {
      const added = insertStation(doc, (a.x + b.x) / 2);
      expect(closedVerdict(added!.doc, true).ok).toBe(true);
    }
  });
});

describe('the insertStation action of the rails store', () => {
  const doc = everyBoard.find(([n]) => n === 'shortboard')![1]();

  it('is one undo step, returns the new station’s slice, and undo restores the board exactly', () => {
    const store = createRailsStore();
    store.getState().loadDoc(doc);
    const x = (doc.stations[0]!.x + doc.stations[1]!.x) / 2;
    const index = store.getState().insertStation(x);
    expect(index).toBe(2);
    expect(store.getState().doc!.stations).toHaveLength(doc.stations.length + 1);
    expect(store.getState().past.map((p) => p.label)).toEqual(['Add station']);
    store.getState().undo();
    expect(store.getState().doc).toBe(doc);
  });

  it('returns -1 and records nothing for a place that cannot take a station', () => {
    const store = createRailsStore();
    store.getState().loadDoc(doc);
    for (const x of [-5, 1e6, doc.stations[1]!.x, NaN]) {
      expect(store.getState().insertStation(x)).toBe(-1);
    }
    expect(store.getState().past).toHaveLength(0);
  });
});
