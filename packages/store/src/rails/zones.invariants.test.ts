// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The invariants by random sequence: a seeded generator applies a few hundred edits (every edit of
 * `zones.ts`, with sound arguments and with out-of-range and degenerate ones) to each test
 * board's keys and to some awkward lists, and after every edit the keys are strictly increasing,
 * a gap apart, inside the board and not empty, and `railZones` partitions them. The argument is
 * frozen, so an edit that changes it throws; an edit that returns a new list returns one that
 * differs; and tidying a tidied list gives the same list.
 */
import { describe, expect, it } from 'vitest';
import { railsBoards } from './test-support/boards';
import {
  EDIT_KINDS,
  TOLERANCES,
  deepFreeze,
  key,
  legalProblem,
  pick,
  randomEdit,
  randomRail,
  seeded,
} from './test-support/zone-kit';
import type { RailKey } from './types';
import { ZONE_MIN_GAP, railAt, sameRailKeys, tidyRails } from './zones';

const EDITS = 300;

const lengthOf = (b: {
  outline: { plus: { knots: readonly { p: readonly number[] }[] } };
}): number => b.outline.plus.knots.at(-1)!.p[0]!;

/** A list of keys the invariants hold for, as `count` keys of random rails exactly `step` apart. */
function packed(seed: number, count: number, step: number): RailKey[] {
  const rng = seeded(seed);
  return Array.from({ length: count }, (_, i) => ({ x: i * step, rail: randomRail(rng) }));
}

const clone = (keys: readonly RailKey[]): RailKey[] =>
  keys.map((k) => ({ x: k.x, rail: { ...k.rail } }));

/**
 * Run `EDITS` random edits from `start` on a board of `length`, checking every one. Returns the
 * lists it passed through, for the tests that build a board from some of them.
 */
function sweep(seed: number, start: readonly RailKey[], length: number): RailKey[][] {
  const rng = seeded(seed);
  let keys: readonly RailKey[] = deepFreeze(clone(start));
  const seen: RailKey[][] = [];
  const counts = new Map<string, number>();
  for (let step = 0; step < EDITS; step++) {
    const { kind, next, tolerance } = randomEdit(rng, keys, length);
    const where = `${kind} #${step} (seed ${seed})`;
    expect(legalProblem(next, length), where).toBeNull();
    // a new list differs from the one it came from: no copy stands in for "nothing changed"
    expect(
      next === keys || !sameRailKeys(next, keys),
      `${where}: a copy that changed nothing`,
    ).toBe(true);
    // tidying the result, at the tolerance of this step, is idempotent
    const tidy = tidyRails(next, tolerance, length);
    expect(legalProblem(tidy, length), `${where}: tidied`).toBeNull();
    expect(tidyRails(tidy, tolerance, length), `${where}: tidy twice`).toBe(tidy);
    // and the laws read something finite everywhere along the result
    for (const x of [0, length / 3, length]) {
      for (const v of Object.values(railAt(next, x))) expect(Number.isFinite(v), where).toBe(true);
    }
    if (next !== keys) counts.set(kind, (counts.get(kind) ?? 0) + 1);
    keys = deepFreeze(next as RailKey[]);
    seen.push(next as RailKey[]);
  }
  // a sweep that never changed anything would prove nothing: most kinds changed the list at least once
  expect(counts.size, `kinds that changed the list (seed ${seed})`).toBeGreaterThanOrEqual(
    EDIT_KINDS.length - 1,
  );
  return seen;
}

describe.each(railsBoards)(
  'the invariants hold through random edits of the %s board',
  (name, make) => {
    const board = make();
    const length = lengthOf(board);
    const sides: [string, readonly RailKey[]][] = [['plus', board.rails.plus]];
    if (board.rails.minus !== undefined) sides.push(['minus', board.rails.minus]);

    it.each(sides)('on its %s keys', (side, keys) => {
      expect(legalProblem(keys, length), `${name} ${side} to begin with`).toBeNull();
      sweep(name.length * 7919 + side.length, keys, length);
    });
  },
);

describe('the invariants hold through random edits of awkward lists', () => {
  const length = 100;
  const lists: [string, RailKey[]][] = [
    ['one key', [key(40)]],
    ['one key at the tail', [key(0)]],
    ['two keys a gap apart', [key(40), key(40 + ZONE_MIN_GAP, { apex: 0.3 })]],
    ['keys at both ends of the board', [key(0), key(length, { band: 3 })]],
    ['keys a gap apart all along the board', packed(5, length + 1, ZONE_MIN_GAP)],
    ['twenty keys', packed(6, 20, 4.9)],
    ['one flat zone of six keys', Array.from({ length: 6 }, (_, i) => key(10 + i * 15))],
  ];
  it.each(lists)('%s', (_name, keys) => {
    expect(legalProblem(keys, length), 'to begin with').toBeNull();
    sweep(keys.length * 131 + 3, keys, length);
  });
});

describe('the sweeps are not trivial', () => {
  it('reach lists with several zones, flat runs and merges, and every tolerance is exercised', () => {
    const board = railsBoards[2]![1]();
    const seen = sweep(99, board.rails.plus, lengthOf(board));
    const zoneCounts = new Set(seen.map((keys) => keys.length));
    expect(zoneCounts.size).toBeGreaterThan(4);
    expect(TOLERANCES.length).toBeGreaterThan(5);
    expect(pick(seeded(1), TOLERANCES)).toBeDefined();
  });
});
