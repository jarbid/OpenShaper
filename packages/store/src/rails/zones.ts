// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Rail zones: one side's rail keys read as zones and blends, and the pure edits of them.
 *
 * A rails board stores a rail (seven numbers) at each of a list of places along each side. The
 * engine runs every number between keys as a monotone cubic and holds it flat outside the first
 * and last, so two equal keys hold the rail between them and ease into the neighbours. Nothing
 * is stored beyond the keys; a **zone** is how they are read:
 *
 * - a zone is a run of consecutive keys that hold one rail, or a single key that equals neither
 *   neighbour (a zone of no length);
 * - a **blend** is the interval between two consecutive zones;
 * - a zone is named by its index in `railZones(keys)` at tolerance 0, and an index changes
 *   when an edit merges, splits or removes zones (`zoneIndexAt` finds one again by place).
 *
 * Every edit takes the keys and returns new keys, never changing its argument and returning the
 * same array when nothing changes. The keys of a side are always strictly increasing, at least
 * {@link ZONE_MIN_GAP} apart and inside `[0, length]`; no edit breaks that, and an edit that
 * cannot be done as asked does the nearest legal thing and never throws.
 *
 * This module reads no engine code: it takes the engine's types and its code-free `defaults`
 * (plain data, the ranges above), and nothing else of it.
 */
import type { RailsBoard } from '@openshaper/board2';
import { RAIL_LIMITS as ENGINE_RAIL_LIMITS } from '@openshaper/board2/defaults';
import type { RailKey, RailRecipe } from './types';

/** A rail's seven numbers, in the order the engine and the file list them. */
export const RAIL_NUMBERS = [
  'band',
  'hardness',
  'tuck',
  'tuckShape',
  'bottomEdge',
  'deckEdge',
  'apex',
] as const;

/** One of a rail's seven numbers. */
export type RailNumber = (typeof RAIL_NUMBERS)[number];

/**
 * The least distance (cm) between two rail keys: the outline loop is sampled every 0.035 to
 * 0.55 cm, so a blend under about half a centimetre meshes as a step whatever its width, and at
 * 1 cm the harshest pair of built-in rails is resolved into a blend.
 */
export const ZONE_MIN_GAP = 1;

/**
 * The unit each number is measured in when two rails are compared with a tolerance: cm for the
 * band and the tuck, degrees for the two edges, a fraction of the wall's height for the apex and
 * a unit interval for the two rho; a tolerance of 0.1 then reads 1 mm, 0.1 degree, 0.1.
 */
export const ZONE_SCALES: Readonly<Record<RailNumber, number>> = {
  band: 1,
  hardness: 1,
  tuck: 1,
  tuckShape: 1,
  bottomEdge: 1,
  deckEdge: 1,
  apex: 1,
};

/**
 * The range each number may take, as the engine holds it as it builds (board2's `RAIL_LIMITS`,
 * defined once in its code-free `defaults` module): the band and the tuck from 0.05 cm (the
 * narrowest blend ever built) to 54 cm, both rho from 0.05 to 0.95, the apex from 0.02 to 0.98,
 * and each edge from 0 (tangent: no edge) to 89 degrees. An edited number is held to it.
 */
export const RAIL_LIMITS: Readonly<Record<RailNumber, readonly [number, number]>> =
  ENGINE_RAIL_LIMITS;

/** A run of consecutive keys that hold one rail. */
export interface Zone {
  /** Index of the zone's first key, and of its last (the same for a zone of no length). */
  readonly first: number;
  readonly last: number;
  /** The places (cm along the board) of those two keys. */
  readonly from: number;
  readonly to: number;
  /** The rail: the first key's own rail when the keys all hold one, else the mean of theirs. */
  readonly rail: RailRecipe;
}

/** The interval between two consecutive zones. */
export interface Blend {
  /** Indices of the zone before and the zone after. */
  readonly before: number;
  readonly after: number;
  /** The place of the last key of the zone before, and of the first key of the zone after. */
  readonly from: number;
  readonly to: number;
}

/** Which side or sides of a board an edit reaches. */
export type RailSide = 'plus' | 'minus' | 'both';

/**
 * The tolerance Tidy rails joins neighbouring keys within unless it is given one: 0.1 of each
 * number's unit, which is 1 mm of band or tuck, a tenth of a ratio or of a degree. On the converted
 * test boards it joins the mid-board stations, whose rails differ by a hundredth or so.
 */
export const TIDY_TOLERANCE = 0.1;

/** A rail of zeros: what a list with no key reads as. The engine refuses a side with no key. */
const NO_RAIL: RailRecipe = Object.freeze({
  band: 0,
  hardness: 0,
  tuck: 0,
  tuckShape: 0,
  bottomEdge: 0,
  deckEdge: 0,
  apex: 0,
});

/** A tolerance as a usable number: finite and above 0, else 0 (exact equality). */
export const usableTolerance = (tolerance: number): number =>
  Number.isFinite(tolerance) && tolerance > 0 ? tolerance : 0;

/**
 * How far apart two rails are, in tolerance units: the largest difference of a number, divided
 * by that number's entry of {@link ZONE_SCALES}. Two rails are equal within a tolerance when it is
 * at most that.
 */
export function railDistance(a: RailRecipe, b: RailRecipe): number {
  let far = 0;
  for (const name of RAIL_NUMBERS) {
    far = Math.max(far, Math.abs(a[name] - b[name]) / ZONE_SCALES[name]);
  }
  return far;
}

const sameRail = (a: RailRecipe, b: RailRecipe): boolean =>
  a === b || RAIL_NUMBERS.every((name) => a[name] === b[name]);

/** The mean of some rails, number by number. */
function meanRail(rails: readonly RailRecipe[]): RailRecipe {
  const out = { ...NO_RAIL } as { -readonly [K in RailNumber]: number };
  for (const name of RAIL_NUMBERS) {
    let sum = 0;
    for (const r of rails) sum += r[name];
    out[name] = sum / rails.length;
  }
  return out;
}

/**
 * The runs of consecutive keys that hold one rail within `tolerance`, as inclusive index pairs.
 * A run grows from the tail while every number's spread over it stays within the tolerance of
 * that number, so no key of a run is further than the tolerance from any other. A number that
 * is not finite never joins a run.
 */
function runsOf(keys: readonly RailKey[], tolerance: number): [number, number][] {
  const tol = usableTolerance(tolerance);
  const runs: [number, number][] = [];
  const lo = new Array<number>(RAIL_NUMBERS.length).fill(0);
  const hi = new Array<number>(RAIL_NUMBERS.length).fill(0);
  let start = 0;
  for (let i = 0; i < keys.length; i++) {
    const rail = keys[i]!.rail;
    if (i > start) {
      const fits = RAIL_NUMBERS.every((name, d) => {
        const v = rail[name];
        return Math.max(hi[d]!, v) - Math.min(lo[d]!, v) <= tol * ZONE_SCALES[name];
      });
      if (!fits) {
        runs.push([start, i - 1]);
        start = i;
      }
    }
    RAIL_NUMBERS.forEach((name, d) => {
      const v = rail[name];
      lo[d] = i === start ? v : Math.min(lo[d]!, v);
      hi[d] = i === start ? v : Math.max(hi[d]!, v);
    });
  }
  if (keys.length > 0) runs.push([start, keys.length - 1]);
  return runs;
}

/** The rail a run of keys holds: its first key's own rail when they all hold it, else their mean. */
function runRail(keys: readonly RailKey[], first: number, last: number): RailRecipe {
  const head = keys[first]!.rail;
  let equal = true;
  for (let i = first + 1; i <= last && equal; i++) equal = sameRail(keys[i]!.rail, head);
  if (equal) return head;
  return meanRail(keys.slice(first, last + 1).map((k) => k.rail));
}

/**
 * The zones of one side's keys, and the blends between them. At `tolerance` 0 (the default) a zone
 * is a run of keys whose seven numbers are all equal; with a tolerance, a run whose numbers all
 * lie within `tolerance` times their {@link ZONE_SCALES} of one another. Every key is in exactly
 * one zone, and the zones run tail to nose.
 */
export function railZones(
  keys: readonly RailKey[],
  tolerance = 0,
): { zones: Zone[]; blends: Blend[] } {
  const zones = runsOf(keys, tolerance).map(
    ([first, last]): Zone => ({
      first,
      last,
      from: keys[first]!.x,
      to: keys[last]!.x,
      rail: runRail(keys, first, last),
    }),
  );
  const blends = zones
    .slice(1)
    .map((zone, i): Blend => ({ before: i, after: i + 1, from: zones[i]!.to, to: zone.from }));
  return { zones, blends };
}

/**
 * The index of the zone at `x`: the one whose keys span it, else the nearest by distance from `x`
 * to its keys (the earlier on a tie). -1 when there is no key. After an edit that can merge or
 * split zones, this finds the zone that was chosen again by its place.
 */
export function zoneIndexAt(keys: readonly RailKey[], x: number, tolerance = 0): number {
  const { zones } = railZones(keys, tolerance);
  let best = -1;
  let nearest = Infinity;
  zones.forEach((zone, i) => {
    const away = x < zone.from ? zone.from - x : x > zone.to ? x - zone.to : 0;
    if (away < nearest) {
      nearest = away;
      best = i;
    }
  });
  return best;
}

/**
 * One number at `x` along keys sorted by x: the engine's monotone cubic through them, held flat
 * outside. It is the engine's own arithmetic, operation for operation: slopes are the mean of the
 * two neighbouring chords (zero where they disagree in sign or where one is flat), then each
 * segment's pair of slopes is held inside the circle of radius 3 times its chord, which keeps every
 * blend monotone and a flat run flat. The one difference: between two equal numbers the engine's
 * Hermite form can be an ulp off, and this returns the number itself, so a number that does not
 * change across a blend reads exactly the same at every place in it.
 */
function monotoneAt(xs: readonly number[], ys: readonly number[], x: number): number {
  const n = xs.length;
  if (n === 1) return ys[0]!;
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
  if (x <= xs[0]!) return ys[0]!;
  if (x >= xs[n - 1]!) return ys[n - 1]!;
  let i = 0;
  while (i + 2 < n && xs[i + 1]! < x) i++;
  if (ys[i] === ys[i + 1]) return ys[i]!;
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
}

/**
 * The rail the engine reads at `x` from these keys: each number a monotone cubic through the keys,
 * held flat outside them (a rail of zeros for a list with no key). Between two equal keys it is
 * that rail at every place; between two different ones every number runs from one to the other
 * without overshoot.
 */
export function railAt(keys: readonly RailKey[], x: number): RailRecipe {
  if (keys.length === 0) return NO_RAIL;
  const xs = keys.map((k) => k.x);
  const out = { ...NO_RAIL } as { -readonly [K in RailNumber]: number };
  for (const name of RAIL_NUMBERS) {
    out[name] = monotoneAt(
      xs,
      keys.map((k) => k.rail[name]),
      x,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Placing keys
// ---------------------------------------------------------------------------

/** One side's rail keys, or a list of them. */
type Keys = readonly RailKey[];

/** A board's rail keys: the plus side's, and the minus side's where the board has its own. */
type Rails = RailsBoard['rails'];

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Whether `length` is a board length: a number above 0. */
const usableLength = (length: number): boolean => Number.isFinite(length) && length > 0;

/**
 * The least place at least {@link ZONE_MIN_GAP} after `a`. `a + gap` is rounded, so it can fall an
 * ulp short of the gap; it is nudged up until the difference, as it is computed, is not.
 */
function above(a: number): number {
  let x = a + ZONE_MIN_GAP;
  for (let n = 0; n < 8 && x - a < ZONE_MIN_GAP; n++)
    x += Math.max(Math.abs(x), 1) * Number.EPSILON;
  return x;
}

/** The greatest place at least {@link ZONE_MIN_GAP} before `b`. */
function below(b: number): number {
  let x = b - ZONE_MIN_GAP;
  for (let n = 0; n < 8 && b - x < ZONE_MIN_GAP; n++)
    x -= Math.max(Math.abs(x), 1) * Number.EPSILON;
  return x;
}

/** The places a key between `prev` and `next` (either may be missing) can take on a board of `length`. */
function room(
  prev: RailKey | undefined,
  next: RailKey | undefined,
  length: number,
): [number, number] {
  return [
    prev === undefined ? 0 : Math.max(0, above(prev.x)),
    next === undefined ? length : Math.min(length, below(next.x)),
  ];
}

/** The zone at index `zone` of `keys` (at tolerance 0), or undefined for an index that is not one. */
function zoneOf(keys: Keys, zone: number): Zone | undefined {
  return Number.isInteger(zone) ? railZones(keys).zones[zone] : undefined;
}

/** `keys` with keys `first` to `last` given `rail`. */
const withRail = (keys: Keys, first: number, last: number, rail: RailRecipe): Keys =>
  keys.map((k, i) => (i >= first && i <= last ? { x: k.x, rail } : k));

/** Whether two lists of keys are the same by value. */
export function sameRailKeys(a: Keys, b: Keys): boolean {
  if (a === b) return true;
  return (
    a.length === b.length && a.every((k, i) => k.x === b[i]!.x && sameRail(k.rail, b[i]!.rail))
  );
}

/**
 * A number set to `wanted`. A number that changes is held to its range; one left as it is stays,
 * even outside the range (a converted rail keeps its own numbers until they are changed); one that
 * is not a number is not set.
 */
function settle(name: RailNumber, wanted: unknown, current: number): number {
  if (wanted === current) return current;
  if (typeof wanted !== 'number' || !Number.isFinite(wanted)) return current;
  const [lo, hi] = RAIL_LIMITS[name];
  return clamp(wanted, lo, hi);
}

/** `rail` as it may be written over `current`: each number settled. */
function settledRail(rail: unknown, current: RailRecipe): RailRecipe {
  const given = (typeof rail === 'object' && rail !== null ? rail : {}) as Partial<RailRecipe>;
  const out = { ...current } as { -readonly [K in RailNumber]: number };
  for (const name of RAIL_NUMBERS) out[name] = settle(name, given[name], current[name]);
  return out;
}

// ---------------------------------------------------------------------------
// The edits
// ---------------------------------------------------------------------------

/**
 * Zone `zone` given `rail`: every one of its keys takes it, each number held to {@link RAIL_LIMITS}
 * where it changes. A zone given the rail of its neighbour is one zone with it afterwards.
 */
export function setZoneRail(keys: Keys, zone: number, rail: RailRecipe): Keys {
  const z = zoneOf(keys, zone);
  if (z === undefined) return keys;
  const next = settledRail(rail, z.rail);
  return sameRail(next, z.rail) ? keys : withRail(keys, z.first, z.last, next);
}

/** One number of zone `zone` set on every one of its keys, held to its range in {@link RAIL_LIMITS}. */
export function setZoneNumber(keys: Keys, zone: number, name: RailNumber, value: number): Keys {
  const z = zoneOf(keys, zone);
  if (z === undefined || !RAIL_NUMBERS.includes(name)) return keys;
  const next = { ...z.rail, [name]: settle(name, value, z.rail[name]) };
  return sameRail(next, z.rail) ? keys : withRail(keys, z.first, z.last, next);
}

/**
 * The first (`from`) or last (`to`) key of zone `zone` moved to `x`, held at least
 * {@link ZONE_MIN_GAP} from the keys either side of it (the zone's own keys, and the neighbouring
 * zones') and inside `[0, length]`. A zone of no length has one key: `from` moves it, and `to` draws
 * out a second key of the same rail, which makes it a zone.
 */
export function moveZoneEnd(
  keys: Keys,
  zone: number,
  end: 'from' | 'to',
  x: number,
  length: number,
): Keys {
  const z = zoneOf(keys, zone);
  if (z === undefined || (end !== 'from' && end !== 'to')) return keys;
  if (!Number.isFinite(x) || !usableLength(length)) return keys;
  if (end === 'to' && z.first === z.last) {
    const own = keys[z.last]!;
    const [lo, hi] = room(own, keys[z.last + 1], length);
    if (lo > hi) return keys;
    const drawn: RailKey = { x: clamp(x, lo, hi), rail: own.rail };
    return [...keys.slice(0, z.last + 1), drawn, ...keys.slice(z.last + 1)];
  }
  const m = end === 'from' ? z.first : z.last;
  const [lo, hi] = room(keys[m - 1], keys[m + 1], length);
  if (lo > hi) return keys;
  const placed = clamp(x, lo, hi);
  if (placed === keys[m]!.x) return keys;
  return keys.map((k, i) => (i === m ? { x: placed, rail: k.rail } : k));
}

/**
 * Zone `zone` slid by `dx`, its length unchanged, held at least {@link ZONE_MIN_GAP} from the
 * neighbouring zones' keys and inside `[0, length]`.
 */
export function moveZone(keys: Keys, zone: number, dx: number, length: number): Keys {
  const z = zoneOf(keys, zone);
  if (z === undefined || !Number.isFinite(dx) || !usableLength(length)) return keys;
  const [lo, hi] = room(keys[z.first - 1], keys[z.last + 1], length);
  const lowest = lo - z.from;
  const highest = hi - z.to;
  if (lowest > highest) return keys;
  const slide = clamp(dx, lowest, highest);
  if (slide === 0) return keys;
  // each key moves by the slide; rounding can shorten a gap by an ulp, which the next key makes up
  const moved: RailKey[] = [];
  for (let i = z.first; i <= z.last; i++) {
    const k = keys[i]!;
    const prev = moved[moved.length - 1];
    moved.push({ x: Math.max(k.x + slide, prev === undefined ? lo : above(prev.x)), rail: k.rail });
  }
  if (moved[moved.length - 1]!.x > hi) return keys;
  if (moved.every((k, i) => k.x === keys[z.first + i]!.x)) return keys;
  return [...keys.slice(0, z.first), ...moved, ...keys.slice(z.last + 1)];
}

/**
 * A zone added at `x`, held inside `[0, length]` and at least {@link ZONE_MIN_GAP} from the keys
 * round it.
 *
 * - Inside a zone of length, the zone splits in two with a blend of `ZONE_MIN_GAP` between the
 *   parts: keys half a gap either side of `x`, kept inside the zone (the zone's own keys between
 *   them are redundant, since equal keys hold flat, and go). Both parts hold the zone's rail,
 *   which `railZones` reads as one zone until a rail differs; with `rail`, the part after `x`
 *   takes it and so is a zone of its own.
 * - In a blend, or beyond the first or last key, a zone of no length is added at `x`, holding
 *   `rail` or else the rail the engine reads there (`railAt`).
 * - On a zone of no length, nothing changes.
 */
export function splitZoneAt(keys: Keys, x: number, length: number, rail?: RailRecipe): Keys {
  if (keys.length === 0 || !Number.isFinite(x) || !usableLength(length)) return keys;
  const at = clamp(x, 0, length);
  const { zones } = railZones(keys);
  const inside = zones.find((z) => z.from <= at && at <= z.to);
  if (inside !== undefined) {
    return inside.first === inside.last ? keys : splitInside(keys, inside, at, rail);
  }
  const after = zones.findIndex((z) => z.from > at);
  const before = after < 0 ? zones.length - 1 : after - 1;
  const [lo, hi] = room(
    before < 0 ? undefined : keys[zones[before]!.last],
    after < 0 ? undefined : keys[zones[after]!.first],
    length,
  );
  if (lo > hi) return keys;
  const placed = clamp(at, lo, hi);
  const at0 = after < 0 ? keys.length : zones[after]!.first;
  const laws = railAt(keys, placed);
  const added: RailKey = { x: placed, rail: settledRail(rail ?? laws, laws) };
  return [...keys.slice(0, at0), added, ...keys.slice(at0)];
}

/** `splitZoneAt` inside zone `z`, which has length. */
function splitInside(keys: Keys, z: Zone, at: number, rail: RailRecipe | undefined): Keys {
  const gap = ZONE_MIN_GAP;
  if (z.to - z.from < gap) return keys;
  const lowest = above(z.from);
  const highest = below(z.to);
  const centre = clamp(at, z.from + gap / 2, z.to - gap / 2);
  // a key within a gap of the zone's end would break the gap: the end key itself stands in for it
  let left = centre - gap / 2;
  if (left < lowest) left = z.from;
  let right = above(left);
  if (right > highest) {
    right = z.to;
    left = Math.min(left, below(z.to));
    if (left < lowest) left = z.from;
  }
  const after = rail === undefined ? z.rail : settledRail(rail, z.rail);
  const rebuilt: RailKey[] = [{ x: z.from, rail: z.rail }];
  if (left !== z.from) rebuilt.push({ x: left, rail: z.rail });
  if (right !== z.to) rebuilt.push({ x: right, rail: after });
  rebuilt.push({ x: z.to, rail: after });
  const was = keys.slice(z.first, z.last + 1);
  if (sameRailKeys(rebuilt, was)) return keys;
  return [...keys.slice(0, z.first), ...rebuilt, ...keys.slice(z.last + 1)];
}

/**
 * Zone `zone` removed: its keys go and its neighbours blend across the gap (or, at an end, the
 * neighbour's rail runs on flat). The last zone left is never removed.
 */
export function removeZone(keys: Keys, zone: number): Keys {
  const { zones } = railZones(keys);
  const z = Number.isInteger(zone) ? zones[zone] : undefined;
  if (z === undefined || zones.length < 2) return keys;
  return keys.filter((_, i) => i < z.first || i > z.last);
}

/** Whether `keys` obey the invariants on a board of `length`. */
function legal(keys: Keys, length: number): boolean {
  return keys.every((k, i) => {
    const sound = Number.isFinite(k.x) && RAIL_NUMBERS.every((n) => Number.isFinite(k.rail[n]));
    return sound && k.x >= 0 && k.x <= length && (i === 0 || k.x - keys[i - 1]!.x >= ZONE_MIN_GAP);
  });
}

/**
 * `keys` made to obey the invariants on a board of `length`: a key that is not a number is dropped,
 * the rest are held inside the board and sorted, and keys closer than {@link ZONE_MIN_GAP} become one
 * at the earlier place holding the mean of their rails. The list itself when it already does.
 */
function repaired(keys: Keys, length: number): Keys {
  if (!usableLength(length) || legal(keys, length)) return keys;
  const sound = keys.filter(
    (k) => Number.isFinite(k.x) && RAIL_NUMBERS.every((n) => Number.isFinite(k.rail[n])),
  );
  if (sound.length === 0) return keys;
  const sorted = sound.map((k) => ({ x: clamp(k.x, 0, length), rail: k.rail }));
  sorted.sort((a, b) => a.x - b.x);
  const out: RailKey[] = [];
  for (const k of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && k.x - last.x < ZONE_MIN_GAP) {
      out[out.length - 1] = { x: last.x, rail: meanRail([last.rail, k.rail]) };
    } else {
      out.push(k);
    }
  }
  return out;
}

/** One pass of {@link tidyRails}: each run of keys within `tolerance` becomes a flat pair. The list itself if none changes. */
function tidyPass(keys: Keys, tolerance: number): Keys {
  const out: RailKey[] = [];
  let changed = false;
  for (const [first, last] of runsOf(keys, tolerance)) {
    const head = keys[first]!;
    const tail = keys[last]!;
    if (first === last) {
      out.push(head);
      continue;
    }
    const rail = runRail(keys, first, last);
    if (last - first === 1 && sameRail(head.rail, tail.rail)) {
      out.push(head, tail);
      continue;
    }
    changed = true;
    out.push({ x: head.x, rail }, { x: tail.x, rail });
  }
  return changed ? out : keys;
}

/**
 * The keys tidied: neighbouring keys whose rails are within `tolerance` of one another (as
 * `railZones` reads it) are given one rail, the mean of theirs, and the interior keys of a flat run
 * are dropped, keeping its first and last. With tolerance 0 that is only the dropping, which changes
 * no rail anywhere. Replacing a run by its mean can bring it within tolerance of its neighbour, so the
 * pass is repeated until it changes nothing, which also makes tidying a tidied list a no-op. A list
 * that breaks the invariants on a board of `length` (a key outside the board, out of order or
 * closer than the gap to another) is first made to obey them.
 */
export function tidyRails(keys: Keys, tolerance: number, length: number): Keys {
  let current = repaired(keys, length);
  // each pass that changes something lowers the number of keys plus the number of runs of equal keys
  const passes = 2 * current.length + 2;
  for (let pass = 0; pass < passes; pass++) {
    const next = tidyPass(current, tolerance);
    if (next === current) break;
    current = next;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Both sides
// ---------------------------------------------------------------------------

/** Whether the two sides of a board hold the same keys, which is also the case when there is one side. */
export function sidesLinked(rails: Rails): boolean {
  return rails.minus === undefined || sameRailKeys(rails.plus, rails.minus);
}

/** Whether two boards' rails are the same by value, a minus side present in both or in neither. */
export function sameRailSides(a: Rails, b: Rails): boolean {
  if (a === b) return true;
  if ((a.minus === undefined) !== (b.minus === undefined)) return false;
  return (
    sameRailKeys(a.plus, b.plus) &&
    (a.minus === undefined || sameRailKeys(a.minus, b.minus ?? a.minus))
  );
}

/** The minus side made its own: it starts as the plus keys, sharing the same list. The rails themselves when it has one. */
export function unlockSide(rails: Rails): Rails {
  return rails.minus === undefined ? { plus: rails.plus, minus: rails.plus } : rails;
}

/**
 * The two sides made one: the minus side is dropped, the plus side taking the minus keys when
 * `keep` is `'minus'`. On an `asymmetric` board, whose engine needs both sides' keys, the kept keys are
 * shared by both sides instead. The rails themselves when the sides are already one.
 */
export function linkSides(rails: Rails, keep: 'plus' | 'minus', asymmetric: boolean): Rails {
  if (rails.minus === undefined) return rails;
  const kept = keep === 'minus' ? rails.minus : rails.plus;
  if (!asymmetric) return { plus: kept };
  return sameRailKeys(rails.plus, rails.minus) ? rails : { plus: kept, minus: kept };
}

/**
 * `fn` applied to the keys of one side or of both. On a board with no minus side `plus` and
 * `both` are the same edit, and `minus` first unlocks it. Both sides held in one list stay in one
 * list. The rails themselves when no side's keys change.
 */
export function editSides(rails: Rails, side: RailSide, fn: (keys: Keys) => Keys): Rails {
  if (side === 'minus') {
    const own = rails.minus ?? rails.plus;
    const minus = fn(own);
    return minus === own ? rails : { plus: rails.plus, minus };
  }
  if (side === 'plus') {
    const plus = fn(rails.plus);
    if (plus === rails.plus) return rails;
    return rails.minus === undefined ? { plus } : { plus, minus: rails.minus };
  }
  if (rails.minus === undefined || rails.minus === rails.plus) {
    const both = fn(rails.plus);
    if (both === rails.plus) return rails;
    return rails.minus === undefined ? { plus: both } : { plus: both, minus: both };
  }
  const plus = fn(rails.plus);
  const minus = fn(rails.minus);
  return plus === rails.plus && minus === rails.minus ? rails : { plus, minus };
}
