// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Test-only: what the zone tests share. A seeded generator, rail and key builders, a deep freeze
 * (an edit that changes its argument then throws), and the invariants every list of keys must keep.
 */
import { expect } from 'vitest';
import type { RailKey, RailRecipe } from '../types';
import {
  RAIL_NUMBERS,
  ZONE_MIN_GAP,
  moveZone,
  moveZoneEnd,
  railZones,
  removeZone,
  setZoneNumber,
  setZoneRail,
  splitZoneAt,
  tidyRails,
} from '../zones';
import type { RailNumber } from '../zones';

/** A seeded generator of numbers in [0, 1) (mulberry32): the same seed, the same sequence. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rng = () => number;

export const between = (rng: Rng, lo: number, hi: number): number => lo + (hi - lo) * rng();

export const pick = <T>(rng: Rng, items: readonly T[]): T =>
  items[Math.min(items.length - 1, Math.floor(rng() * items.length))]!;

/** A rail: the mid-board round rail, with the numbers in `over` replaced. */
export const rail = (over: Partial<RailRecipe> = {}): RailRecipe => ({
  band: 2,
  hardness: 0.5,
  tuck: 1.4,
  tuckShape: 0.45,
  bottomEdge: 0,
  deckEdge: 0,
  apex: 0.5,
  ...over,
});

export const key = (x: number, over: Partial<RailRecipe> = {}): RailKey => ({
  x,
  rail: rail(over),
});

/** A rail with every number drawn inside the range the engine holds it to. */
export function randomRail(rng: Rng): RailRecipe {
  return {
    band: between(rng, 0.1, 4),
    hardness: between(rng, 0.1, 0.9),
    tuck: between(rng, 0.1, 4),
    tuckShape: between(rng, 0.1, 0.9),
    bottomEdge: rng() < 0.5 ? 0 : between(rng, 0, 50),
    deckEdge: rng() < 0.8 ? 0 : between(rng, 0, 30),
    apex: between(rng, 0.2, 0.7),
  };
}

/** `value` and everything inside it frozen, so a write to it throws. Returns `value`. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

/** The number of keys in each run of keys that hold one rail exactly, tail to nose. */
export const runLengths = (keys: readonly RailKey[]): number[] =>
  railZones(keys).zones.map((z) => z.last - z.first + 1);

/**
 * What every list of keys must keep, or the first thing it breaks (null if nothing): not empty,
 * every number finite, strictly increasing, at least `ZONE_MIN_GAP` apart, inside `[0, length]`,
 * and read by `railZones` as a partition of the keys into runs that hold one rail each, tail to
 * nose, with a blend between each pair of zones.
 */
export function legalProblem(keys: readonly RailKey[], length: number): string | null {
  if (keys.length === 0) return 'no keys';
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    if (!Number.isFinite(k.x)) return `x not finite at ${i}`;
    for (const name of RAIL_NUMBERS) {
      if (!Number.isFinite(k.rail[name])) return `${name} not finite at ${i}`;
    }
    if (k.x < 0 || k.x > length) return `key ${i} at ${k.x} is outside [0, ${length}]`;
    if (i > 0 && !(k.x - keys[i - 1]!.x >= ZONE_MIN_GAP)) {
      return `keys ${i - 1} and ${i} are ${k.x - keys[i - 1]!.x} apart`;
    }
  }
  const { zones, blends } = railZones(keys);
  if (zones[0]!.first !== 0) return 'zones do not start at the first key';
  if (zones[zones.length - 1]!.last !== keys.length - 1) return 'zones do not end at the last key';
  for (let i = 0; i < zones.length; i++) {
    const z = zones[i]!;
    if (i > 0 && z.first !== zones[i - 1]!.last + 1)
      return `zones ${i - 1} and ${i} are not contiguous`;
    for (let k = z.first; k <= z.last; k++) {
      for (const name of RAIL_NUMBERS) {
        if (keys[k]!.rail[name] !== keys[z.first]!.rail[name]) return `zone ${i} holds two rails`;
      }
    }
  }
  if (blends.length !== zones.length - 1) return 'a blend is missing between zones';
  return null;
}

/** `legalProblem` as an expectation, so a failure names what broke and where. */
export function expectLegalKeys(keys: readonly RailKey[], length: number, context = ''): void {
  expect(legalProblem(keys, length), context).toBeNull();
}

// ---------------------------------------------------------------------------
// Random edits
// ---------------------------------------------------------------------------

/** The edits of `zones.ts`, by name. */
export const EDIT_KINDS = [
  'setZoneRail',
  'setZoneNumber',
  'moveZoneEnd',
  'moveZone',
  'splitZoneAt',
  'removeZone',
  'tidyRails',
] as const;

export type EditKind = (typeof EDIT_KINDS)[number];

const notNumbers = [Number.NaN, Infinity, -Infinity];

/** A number in `[lo, hi]` most of the time, and otherwise one an edit must cope with. */
const oddNumber = (rng: Rng, lo: number, hi: number): number =>
  rng() < 0.7
    ? between(rng, lo, hi)
    : pick(rng, [...notNumbers, 0, -0, 1e9, -1e9, lo - 50, hi + 50, 1e-9]);

/** A zone index: usually one the list has, otherwise one it has not. */
function randomZone(rng: Rng, keys: readonly RailKey[]): number {
  const n = railZones(keys).zones.length;
  return rng() < 0.85 ? Math.floor(rng() * n) : pick(rng, [-1, n, n + 5, 0.5, ...notNumbers]);
}

/** A place: along the board, at or near a key, or not a place at all. */
function randomPlace(rng: Rng, keys: readonly RailKey[], length: number): number {
  const r = rng();
  if (r < 0.45) return between(rng, -0.1 * length, 1.1 * length);
  if (r < 0.75) {
    const k = pick(rng, keys);
    return (
      k.x + pick(rng, [0, ZONE_MIN_GAP / 3, -ZONE_MIN_GAP / 3, ZONE_MIN_GAP, -ZONE_MIN_GAP, 1e-9])
    );
  }
  return pick(rng, [...notNumbers, 0, length, length + 1, -1, 1e9, -1e9]);
}

/** A rail: in range, one the list already holds (which can merge zones), out of range, or damaged. */
function randomRailArg(rng: Rng, keys: readonly RailKey[]): RailRecipe {
  const r = rng();
  if (r < 0.5) return randomRail(rng);
  if (r < 0.7) return pick(rng, keys).rail;
  if (r < 0.85) {
    return {
      band: oddNumber(rng, -3, 80),
      hardness: oddNumber(rng, -1, 2),
      tuck: oddNumber(rng, -3, 80),
      tuckShape: oddNumber(rng, -1, 2),
      bottomEdge: oddNumber(rng, -20, 200),
      deckEdge: oddNumber(rng, -20, 200),
      apex: oddNumber(rng, -1, 2),
    };
  }
  return { ...randomRail(rng), band: Number.NaN, apex: undefined as unknown as number };
}

/** The tolerances an edit is tried with, usable or not. */
export const TOLERANCES = [0, 0, 0.01, 0.1, 0.5, 2, 1e9, Number.NaN, -1, Infinity];

/**
 * A random edit of `keys` on a board of `length`: its kind (`kind`, or one drawn), and what it
 * returns. Its arguments are mostly sound and often not: a zone the list does not have, a place
 * that is not a number or is far outside the board, a rail with numbers out of range or missing,
 * a tolerance below 0 or infinite, a board with no length.
 */
export function randomEdit(
  rng: Rng,
  keys: readonly RailKey[],
  length: number,
  kind: EditKind = pick(rng, EDIT_KINDS),
): { kind: EditKind; next: readonly RailKey[]; tolerance: number } {
  const len = rng() < 0.95 ? length : pick(rng, [0, -1, ...notNumbers]);
  const zone = randomZone(rng, keys);
  const tolerance = pick(rng, TOLERANCES);
  const names: (RailNumber | 'colour')[] = [...RAIL_NUMBERS, 'colour'];
  switch (kind) {
    case 'setZoneRail':
      return { kind, next: setZoneRail(keys, zone, randomRailArg(rng, keys)), tolerance };
    case 'setZoneNumber': {
      const value = oddNumber(rng, -1, 6);
      return {
        kind,
        next: setZoneNumber(keys, zone, pick(rng, names) as RailNumber, value),
        tolerance,
      };
    }
    case 'moveZoneEnd': {
      const end = pick(rng, ['from', 'to', 'to', 'from', 'middle']) as 'from' | 'to';
      return {
        kind,
        next: moveZoneEnd(keys, zone, end, randomPlace(rng, keys, length), len),
        tolerance,
      };
    }
    case 'moveZone':
      return {
        kind,
        next: moveZone(keys, zone, oddNumber(rng, -0.6 * length, 0.6 * length), len),
        tolerance,
      };
    case 'splitZoneAt': {
      const rail = rng() < 0.4 ? randomRailArg(rng, keys) : undefined;
      return {
        kind,
        next: splitZoneAt(keys, randomPlace(rng, keys, length), len, rail),
        tolerance,
      };
    }
    case 'removeZone':
      return { kind, next: removeZone(keys, zone), tolerance };
    case 'tidyRails':
      return { kind, next: tidyRails(keys, tolerance, len), tolerance };
  }
}
