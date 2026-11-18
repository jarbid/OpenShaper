// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The edits of `zones.ts` on small lists whose every number can be checked by eye: what each one
 * does, where it stops, and that a call that cannot be honoured, or changes nothing, returns the
 * list itself.
 */
import type { RailsBoard } from '@openshaper/board2';
import { describe, expect, it } from 'vitest';
import { deepFreeze, expectLegalKeys, key, rail } from './test-support/zone-kit';
import type { RailKey } from './types';
import {
  RAIL_LIMITS,
  ZONE_MIN_GAP as G,
  editSides,
  linkSides,
  moveZone,
  moveZoneEnd,
  railAt,
  railZones,
  removeZone,
  sameRailKeys,
  sameRailSides,
  setZoneNumber,
  setZoneRail,
  sidesLinked,
  splitZoneAt,
  tidyRails,
  unlockSide,
} from './zones';

/** The length of the board the lists below sit on. */
const L = 100;
const R1 = { band: 1, apex: 0.4 };
const R2 = { band: 2, apex: 0.5 };
const R3 = { band: 3, apex: 0.6, bottomEdge: 20 };

/** Three zones: R1 from 10 to 30, R2 at 60 alone, R3 from 80 to 90. */
const three = (): RailKey[] =>
  deepFreeze([key(10, R1), key(30, R1), key(60, R2), key(80, R3), key(90, R3)]);

const xs = (keys: readonly RailKey[]): number[] => keys.map((k) => k.x);
const shape = (keys: readonly RailKey[]): number[][] =>
  railZones(keys).zones.map((z) => [z.first, z.last]);

describe('setZoneRail', () => {
  it('gives every key of the zone the rail, and leaves the other keys the objects they were', () => {
    const keys = three();
    const next = setZoneRail(keys, 0, rail(R2));
    expect(next.map((k) => k.rail.band)).toEqual([2, 2, 2, 3, 3]);
    expect(next[0]!.rail).toBe(next[1]!.rail);
    expect(next[2]).toBe(keys[2]);
    expect(next[3]).toBe(keys[3]);
    expect(xs(next)).toEqual(xs(keys));
  });

  it('sets a zone of no length', () => {
    const next = setZoneRail(three(), 1, rail(R3));
    expect(next[2]!.rail).toEqual(rail(R3));
  });

  it('holds each number that changes to its range, and leaves a number that does not change alone', () => {
    const outside = [key(10, { apex: 0.756, band: 0.03 }), key(50, R2)];
    // re-applying a converted rail is no change at all
    expect(setZoneRail(outside, 0, rail({ apex: 0.756, band: 0.03 }))).toBe(outside);
    const wild = setZoneRail(
      three(),
      1,
      rail({
        band: -5,
        hardness: 7,
        tuck: 1e9,
        tuckShape: -1,
        bottomEdge: 400,
        deckEdge: -3,
        apex: 2,
      }),
    )[2]!.rail;
    expect(wild).toEqual({
      band: RAIL_LIMITS.band[0],
      hardness: RAIL_LIMITS.hardness[1],
      tuck: RAIL_LIMITS.tuck[1],
      tuckShape: RAIL_LIMITS.tuckShape[0],
      bottomEdge: RAIL_LIMITS.bottomEdge[1],
      deckEdge: RAIL_LIMITS.deckEdge[0],
      apex: RAIL_LIMITS.apex[1],
    });
    // moving one number of an out-of-range rail moves that number into range and the rest stay
    const moved = setZoneRail(outside, 0, rail({ apex: 0.9, band: 0.03 }))[0]!.rail;
    expect(moved.apex).toBe(0.9);
    expect(moved.band).toBe(0.03);
  });

  it('never writes a number that is not one: the current value stays', () => {
    const keys = three();
    const next = setZoneRail(keys, 1, {
      ...rail(R3),
      band: Number.NaN,
      tuck: Infinity,
      apex: undefined as unknown as number,
    })[2]!.rail;
    expect(next.band).toBe(R2.band);
    expect(next.tuck).toBe(keys[2]!.rail.tuck);
    expect(next.apex).toBe(R2.apex);
    expect(next.bottomEdge).toBe(R3.bottomEdge);
    expect(setZoneRail(keys, 1, null as unknown as ReturnType<typeof rail>)).toBe(keys);
  });

  it('returns the list itself for a rail equal by value to the zone, and for a zone that is not one', () => {
    const keys = three();
    expect(setZoneRail(keys, 0, { ...keys[0]!.rail })).toBe(keys);
    for (const zone of [-1, 3, 99, 0.5, Number.NaN, Infinity]) {
      expect(setZoneRail(keys, zone, rail(R3)), String(zone)).toBe(keys);
    }
    expect(setZoneRail([], 0, rail())).toEqual([]);
  });

  it('merges a zone with its neighbour when it is given the neighbour rail', () => {
    const keys = three();
    const next = setZoneRail(keys, 1, rail(R1));
    expect(shape(next)).toEqual([
      [0, 2],
      [3, 4],
    ]);
    expectLegalKeys(next, L);
  });
});

describe('setZoneNumber', () => {
  it('sets one number on every key of the zone, held to its range, and no other', () => {
    const keys = three();
    const next = setZoneNumber(keys, 0, 'apex', 0.33);
    expect(next.map((k) => k.rail.apex)).toEqual([0.33, 0.33, 0.5, 0.6, 0.6]);
    expect(next[0]!.rail.band).toBe(1);
    expect(setZoneNumber(keys, 0, 'apex', 5)[0]!.rail.apex).toBe(RAIL_LIMITS.apex[1]);
    expect(setZoneNumber(keys, 0, 'band', -1)[0]!.rail.band).toBe(RAIL_LIMITS.band[0]);
    expect(setZoneNumber(keys, 2, 'bottomEdge', 500)[3]!.rail.bottomEdge).toBe(
      RAIL_LIMITS.bottomEdge[1],
    );
  });

  it('returns the list itself for no change, a value that is not a number, a name that is not one', () => {
    const keys = three();
    expect(setZoneNumber(keys, 0, 'apex', 0.4)).toBe(keys);
    for (const v of [Number.NaN, Infinity, -Infinity]) {
      expect(setZoneNumber(keys, 0, 'apex', v)).toBe(keys);
    }
    expect(setZoneNumber(keys, 0, 'colour' as 'apex', 1)).toBe(keys);
    expect(setZoneNumber(keys, 7, 'apex', 0.3)).toBe(keys);
  });
});

describe('moveZoneEnd', () => {
  it('moves the first or last key of a zone of length, leaving its other keys', () => {
    const keys = three();
    const to = moveZoneEnd(keys, 0, 'to', 40, L);
    expect(xs(to)).toEqual([10, 40, 60, 80, 90]);
    expect(to[0]).toBe(keys[0]);
    expect(to[1]!.rail).toBe(keys[1]!.rail);
    expect(xs(moveZoneEnd(keys, 0, 'from', 3, L))).toEqual([3, 30, 60, 80, 90]);
    expect(xs(moveZoneEnd(keys, 2, 'to', 95, L))).toEqual([10, 30, 60, 80, 95]);
    expect(xs(moveZoneEnd(keys, 2, 'from', 70, L))).toEqual([10, 30, 60, 70, 90]);
  });

  it('holds a key a gap from the keys either side, own zone included, and inside the board', () => {
    const keys = three();
    expect(moveZoneEnd(keys, 0, 'to', 59.5, L)[1]!.x).toBe(60 - G);
    expect(moveZoneEnd(keys, 0, 'to', 5, L)[1]!.x).toBe(10 + G);
    expect(moveZoneEnd(keys, 0, 'from', 29.5, L)[0]!.x).toBe(30 - G);
    expect(moveZoneEnd(keys, 0, 'from', -50, L)[0]!.x).toBe(0);
    expect(moveZoneEnd(keys, 2, 'to', 500, L)[4]!.x).toBe(L);
    expect(moveZoneEnd(keys, 2, 'from', 60.5, L)[3]!.x).toBe(60 + G);
    expect(moveZoneEnd(keys, 2, 'from', 89.5, L)[3]!.x).toBe(90 - G);
    for (const x of [-1e9, -1, 0, 20, 59, 60, 61, 1e9]) {
      for (const z of [0, 1, 2]) {
        for (const end of ['from', 'to'] as const) {
          expectLegalKeys(moveZoneEnd(keys, z, end, x, L), L, `${z} ${end} ${x}`);
        }
      }
    }
  });

  it('on a zone of no length, from moves its key and to draws out a second key of the same rail', () => {
    const keys = three();
    expect(xs(moveZoneEnd(keys, 1, 'from', 70, L))).toEqual([10, 30, 70, 80, 90]);
    expect(moveZoneEnd(keys, 1, 'from', 70, L)[2]!.rail).toBe(keys[2]!.rail);
    const drawn = moveZoneEnd(keys, 1, 'to', 70, L);
    expect(xs(drawn)).toEqual([10, 30, 60, 70, 80, 90]);
    expect(drawn[3]!.rail).toBe(keys[2]!.rail);
    expect(shape(drawn)).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
    ]);
    // it cannot be drawn back or to the neighbour closer than a gap
    expect(moveZoneEnd(keys, 1, 'to', 10, L)[3]!.x).toBe(60 + G);
    expect(moveZoneEnd(keys, 1, 'to', 500, L)[3]!.x).toBe(80 - G);
    expect(moveZoneEnd(keys, 1, 'from', 79.9, L)[2]!.x).toBe(80 - G);
  });

  it('does the nearest legal thing when there is no room: the list itself', () => {
    const tight = [key(10, R1), key(20, R2), key(20 + G, R3)];
    expect(moveZoneEnd(tight, 1, 'to', 20.5, 40)).toBe(tight);
    expect(moveZoneEnd(tight, 1, 'from', 20.5, 40)).toBe(tight);
    const pair = [key(10, R1), key(10 + G, R1)];
    expect(moveZoneEnd(pair, 0, 'from', 10.5, 40)).toBe(pair);
    expect(moveZoneEnd(pair, 0, 'to', 10.5, 40)).toBe(pair);
  });

  it('returns the list itself for a place that is not a number, a board with no length, a bad end or zone', () => {
    const keys = three();
    for (const x of [Number.NaN, Infinity, -Infinity]) {
      expect(moveZoneEnd(keys, 0, 'to', x, L)).toBe(keys);
    }
    for (const len of [0, -5, Number.NaN, Infinity]) {
      expect(moveZoneEnd(keys, 0, 'to', 40, len)).toBe(keys);
    }
    expect(moveZoneEnd(keys, 0, 'middle' as 'to', 40, L)).toBe(keys);
    expect(moveZoneEnd(keys, 9, 'to', 40, L)).toBe(keys);
    expect(moveZoneEnd(keys, 0, 'to', 30, L)).toBe(keys);
  });
});

describe('the gap is exact where a sum rounds', () => {
  /** Places where `a + gap` is not exact: just below a power of two, and below 1, and ordinary ones. */
  const places = (): number[] => {
    const out: number[] = [];
    for (const k of [1, 2, 3, 4, 5, 6, 7]) {
      const edge = 2 ** k - 1;
      const ulp = 2 ** (k - 1 - 52);
      for (const j of [1, 2, 3, 5, 7]) out.push(edge + j * ulp);
    }
    for (let i = 1; i <= 60; i++) out.push(i * 0.0173, 1 + i * 0.0191, 17.3 + i * 2.713);
    return out;
  };

  it('holds a key a whole gap after the key before it, as the difference is computed', () => {
    for (const a of places()) {
      const keys = [key(a, R1), key(a + 50, R2)];
      const next = moveZoneEnd(keys, 1, 'from', a - 5, 400);
      expect(next[1]!.x - a, `after ${a}`).toBeGreaterThanOrEqual(G);
      expect(next[1]!.x - a, `after ${a}`).toBeLessThan(G + 1e-9);
    }
  });

  it('holds a key a whole gap before the key after it', () => {
    for (const b of places()) {
      const keys = [key(b - 50 > 0 ? b - 50 : 0, R1), key(b, R2)];
      // a list that starts out illegal has no room to move in: only places a gap from the tail count
      if (b < G) continue;
      const next = moveZoneEnd(keys, 0, 'to', b + 5, 400);
      expect(b - next[0]!.x, `before ${b}`).toBeGreaterThanOrEqual(G);
    }
  });

  it('keeps the gap inside a zone of the least length when it slides', () => {
    for (const a of places()) {
      const base = [key(a, R1), key(a + 40, R1)];
      const least = moveZoneEnd(base, 0, 'to', a, 600);
      expect(least[1]!.x - least[0]!.x).toBeGreaterThanOrEqual(G);
      for (const dx of [0.1, 0.37, 1.1, 3.7, 13.3, 77.7]) {
        const slid = moveZone(least, 0, dx, 600);
        expectLegalKeys(slid, 600, `${a} + ${dx}`);
      }
    }
  });
});

describe('moveZone', () => {
  it('slides every key of the zone, its length unchanged, and leaves the others', () => {
    const keys = three();
    const next = moveZone(keys, 2, -10, L);
    expect(xs(next)).toEqual([10, 30, 60, 70, 80]);
    expect(next[0]).toBe(keys[0]);
    expect(xs(moveZone(keys, 1, 12.5, L))).toEqual([10, 30, 72.5, 80, 90]);
  });

  it('holds the zone a gap from its neighbours and inside the board', () => {
    const keys = three();
    expect(xs(moveZone(keys, 0, -50, L))).toEqual([0, 20, 60, 80, 90]);
    expect(xs(moveZone(keys, 0, 500, L))).toEqual([
      10 + (60 - G - 30),
      30 + (60 - G - 30),
      60,
      80,
      90,
    ]);
    expect(xs(moveZone(keys, 2, 500, L))).toEqual([10, 30, 60, 90, 100]);
    expect(xs(moveZone(keys, 2, -500, L))[3]).toBe(60 + G);
    expect(xs(moveZone(keys, 1, 500, L))[2]).toBe(80 - G);
    expect(xs(moveZone(keys, 1, -500, L))[2]).toBe(30 + G);
    for (const dx of [-1e9, -37, -1, 0.3, 5, 1e9]) {
      for (const z of [0, 1, 2]) expectLegalKeys(moveZone(keys, z, dx, L), L, `${z} ${dx}`);
    }
  });

  it('returns the list itself for no slide, a slide that is not a number, no room, a bad zone', () => {
    const keys = three();
    expect(moveZone(keys, 0, 0, L)).toBe(keys);
    for (const dx of [Number.NaN, Infinity, -Infinity]) expect(moveZone(keys, 0, dx, L)).toBe(keys);
    expect(moveZone(keys, 0, 5, 0)).toBe(keys);
    expect(moveZone(keys, 5, 5, L)).toBe(keys);
    const packed = [key(0, R1), key(G, R2), key(2 * G, R3)];
    expect(moveZone(packed, 1, 0.25, 2 * G)).toBe(packed);
    // a lone zone that fills the board cannot slide
    const whole = [key(0, R1), key(L, R1)];
    expect(moveZone(whole, 0, 10, L)).toBe(whole);
  });
});

describe('splitZoneAt', () => {
  const one = (): RailKey[] => deepFreeze([key(10, R1), key(90, R1)]);

  it('inside a zone of length puts a pair of keys a gap apart either side of the place, same rail', () => {
    const keys = one();
    const next = splitZoneAt(keys, 50, L);
    expect(xs(next)).toEqual([10, 50 - G / 2, 50 + G / 2, 90]);
    expect(next.every((k) => k.rail === keys[0]!.rail)).toBe(true);
    expectLegalKeys(next, L);
    // equal keys are one zone to the zones; a rail that differs makes them two
    expect(shape(next)).toEqual([[0, 3]]);
  });

  it('drops the redundant interior keys of the zone', () => {
    const keys = [key(10, R1), key(40, R1), key(52, R1), key(90, R1)];
    expect(xs(splitZoneAt(keys, 50, L))).toEqual([10, 50 - G / 2, 50 + G / 2, 90]);
    expect(xs(splitZoneAt(keys, 50, L)).length).toBeLessThan(keys.length + 2);
  });

  it('keeps the pair inside the zone: at an end the end key stands in for one of them', () => {
    const keys = one();
    expect(xs(splitZoneAt(keys, 10, L))).toEqual([10, 10 + G, 90]);
    expect(xs(splitZoneAt(keys, 10.2, L))).toEqual([10, 10 + G, 90]);
    expect(xs(splitZoneAt(keys, 90, L))).toEqual([10, 90 - G, 90]);
    expect(xs(splitZoneAt(keys, 89.8, L))).toEqual([10, 90 - G, 90]);
    expect(xs(splitZoneAt(keys, 11, L))).toEqual([10, 11, 90]);
    expect(xs(splitZoneAt(keys, 12, L))).toEqual([10, 11.5, 12.5, 90]);
    for (const x of [10, 10.4, 10.9, 11, 12, 50, 88.9, 89, 89.5, 90]) {
      expectLegalKeys(splitZoneAt(keys, x, L), L, String(x));
    }
  });

  it('on a short zone makes the nearest legal pair, and changes nothing when the keys are the pair', () => {
    const short = [key(10, R1), key(11.5, R1)];
    expect(splitZoneAt(short, 10.8, L)).toBe(short);
    const exact = [key(10, R1), key(10 + G, R1)];
    expect(splitZoneAt(exact, 10.5, L)).toBe(exact);
    const mid = [key(10, R1), key(15, R1)];
    expect(xs(splitZoneAt(mid, 12, L))).toEqual([10, 11.5, 12.5, 15]);
  });

  it('with a rail, gives the part after the place that rail, so the zone is two', () => {
    const keys = one();
    const next = splitZoneAt(keys, 50, L, rail(R2));
    expect(xs(next)).toEqual([10, 50 - G / 2, 50 + G / 2, 90]);
    expect(next.map((k) => k.rail.band)).toEqual([1, 1, 2, 2]);
    expect(shape(next)).toEqual([
      [0, 1],
      [2, 3],
    ]);
    expect(railAt(next, 70).band).toBe(2);
    expect(railAt(next, 30).band).toBe(1);
    // a rail equal to the zone's changes nothing the zones can tell
    expect(shape(splitZoneAt(keys, 50, L, { ...keys[0]!.rail }))).toEqual([[0, 3]]);
    // a rail is held to its range like any other
    expect(splitZoneAt(keys, 50, L, rail({ apex: 9 }))[3]!.rail.apex).toBe(RAIL_LIMITS.apex[1]);
  });

  it('in a blend adds a zone of no length holding the rail the laws give there', () => {
    const keys = three();
    const next = splitZoneAt(keys, 45, L);
    expect(xs(next)).toEqual([10, 30, 45, 60, 80, 90]);
    expect(next[2]!.rail).toEqual(railAt(keys, 45));
    expect(next[2]!.rail.band).toBeGreaterThan(1);
    expect(next[2]!.rail.band).toBeLessThan(2);
    expect(shape(next)).toEqual([
      [0, 1],
      [2, 2],
      [3, 3],
      [4, 5],
    ]);
    expectLegalKeys(next, L);
  });

  it('in a blend holds the new key a gap from the zones either side, or does nothing if there is no room', () => {
    const keys = three();
    expect(xs(splitZoneAt(keys, 30.2, L))[2]).toBe(30 + G);
    expect(xs(splitZoneAt(keys, 59.9, L))[2]).toBe(60 - G);
    const narrow = [key(10, R1), key(11.5, R2)];
    expect(splitZoneAt(narrow, 10.7, L)).toBe(narrow);
    expect(xs(splitZoneAt([key(10, R1), key(12, R2)], 11, L))).toEqual([10, 11, 12]);
  });

  it('with a rail, the zone added in a blend holds it', () => {
    const next = splitZoneAt(three(), 45, L, rail(R3));
    expect(next[2]!.rail).toEqual(rail(R3));
  });

  it('on a zone of no length changes nothing', () => {
    const keys = three();
    expect(splitZoneAt(keys, 60, L)).toBe(keys);
    expect(splitZoneAt(keys, 60, L, rail(R3))).toBe(keys);
  });

  it('beyond the first or last key adds a key there: the end rail, or the one given', () => {
    const keys = three();
    const tail = splitZoneAt(keys, 4, L);
    expect(xs(tail)).toEqual([4, 10, 30, 60, 80, 90]);
    expect(tail[0]!.rail).toEqual(keys[0]!.rail);
    expect(shape(tail)).toEqual([
      [0, 2],
      [3, 3],
      [4, 5],
    ]);
    const nose = splitZoneAt(keys, 97, L, rail(R1));
    expect(xs(nose)).toEqual([10, 30, 60, 80, 90, 97]);
    expect(nose[5]!.rail).toEqual(rail(R1));
    expect(xs(splitZoneAt(keys, 90.4, L))[5]).toBe(90 + G);
    expect(xs(splitZoneAt(keys, 9.7, L))[0]).toBe(10 - G);
    expect(xs(splitZoneAt(keys, 1e9, L))[5]).toBe(L);
    expect(xs(splitZoneAt(keys, -1e9, L))[0]).toBe(0);
    const edge = [key(0, R1), key(L, R2)];
    expect(xs(splitZoneAt(edge, 0, L))).toEqual(xs(edge));
  });

  it('returns the list itself for a place that is not a number, a board with no length, no keys', () => {
    const keys = three();
    expect(splitZoneAt(keys, Number.NaN, L)).toBe(keys);
    expect(splitZoneAt(keys, 40, 0)).toBe(keys);
    expect(splitZoneAt([], 40, L)).toEqual([]);
  });
});

describe('removeZone', () => {
  it('removes the keys of the zone so its neighbours blend', () => {
    const keys = three();
    expect(xs(removeZone(keys, 1))).toEqual([10, 30, 80, 90]);
    expect(xs(removeZone(keys, 0))).toEqual([60, 80, 90]);
    expect(xs(removeZone(keys, 2))).toEqual([10, 30, 60]);
    const next = removeZone(keys, 1);
    expect(next[0]).toBe(keys[0]);
    // the laws now blend straight from R1 at 30 to R3 at 80
    expect(railAt(next, 55).band).toBeGreaterThan(1);
    expect(railAt(next, 55).band).toBeLessThan(3);
  });

  it('joins neighbours that hold one rail, and never removes the last zone', () => {
    const flat = [key(10, R1), key(40, R2), key(70, R1)];
    expect(shape(removeZone(flat, 1))).toEqual([[0, 1]]);
    const lone = [key(10, R1), key(40, R1)];
    expect(removeZone(lone, 0)).toBe(lone);
    const single = [key(10, R1)];
    expect(removeZone(single, 0)).toBe(single);
  });

  it('returns the list itself for a zone that is not one', () => {
    const keys = three();
    for (const zone of [-1, 3, 0.5, Number.NaN]) expect(removeZone(keys, zone)).toBe(keys);
    expect(removeZone([], 0)).toEqual([]);
  });
});

describe('tidyRails', () => {
  it('at tolerance 0 drops only the interior keys of a flat run, and changes no rail anywhere', () => {
    const keys = [key(10, R1), key(20, R1), key(30, R1), key(60, R2), key(70, R2)];
    const next = tidyRails(keys, 0, L);
    expect(xs(next)).toEqual([10, 30, 60, 70]);
    for (let x = 0; x <= L; x += 0.5) {
      const a = railAt(keys, x);
      const b = railAt(next, x);
      for (const name of Object.keys(a) as (keyof typeof a)[])
        expect(b[name]).toBeCloseTo(a[name], 12);
    }
  });

  it('returns the list itself when there is nothing to tidy', () => {
    const keys = three();
    expect(tidyRails(keys, 0, L)).toBe(keys);
    expect(tidyRails(keys, 0.001, L)).toBe(keys);
  });

  it('gives neighbours within the tolerance their mean rail, keeping the first and last of the run', () => {
    const keys = [
      key(10, { band: 2 }),
      key(30, { band: 2.0625 }),
      key(50, { band: 2.125 }),
      key(80, { band: 3 }),
    ];
    const next = tidyRails(keys, 0.125, L);
    expect(xs(next)).toEqual([10, 50, 80]);
    expect(next[0]!.rail.band).toBeCloseTo((2 + 2.0625 + 2.125) / 3, 12);
    expect(next[1]!.rail).toBe(next[0]!.rail);
    expect(next[2]).toBe(keys[3]);
    expect(shape(next)).toEqual([
      [0, 1],
      [2, 2],
    ]);
  });

  it('moves no key further than the tolerance, for a run its first pass settles', () => {
    const keys = [
      key(10, { band: 2 }),
      key(30, { band: 2.05 }),
      key(50, { band: 2.1 }),
      key(90, { band: 5 }),
    ];
    const next = tidyRails(keys, 0.1, L);
    for (const k of keys) {
      expect(Math.abs(railAt(next, k.x).band - k.rail.band)).toBeLessThanOrEqual(0.1 + 1e-12);
    }
  });

  it('is idempotent, though one pass is not: means of runs can come within tolerance of each other', () => {
    // bands 0, 0.5, 1 | 1.5 at tolerance 1: the first pass leaves 0.5 and 1.5, which are within 1
    const keys = [
      key(10, { band: 1 }),
      key(20, { band: 1.5 }),
      key(30, { band: 2 }),
      key(40, { band: 2.5 }),
    ];
    const once = tidyRails(keys, 1, L);
    expect(shape(once)).toEqual([[0, 1]]);
    expect(tidyRails(once, 1, L)).toBe(once);
    for (const tol of [0, 0.01, 0.1, 0.5, 1, 3, 1e6]) {
      const t = tidyRails(keys, tol, L);
      expect(tidyRails(t, tol, L), String(tol)).toBe(t);
    }
  });

  it('joins everything when the tolerance is large, leaving one zone of two keys', () => {
    const next = tidyRails(three(), 1e6, L);
    expect(xs(next)).toEqual([10, 90]);
    expect(shape(next)).toEqual([[0, 1]]);
  });

  it('reads a tolerance that is not a positive number as 0', () => {
    const keys = [key(10, R1), key(20, R1), key(30, R1)];
    for (const tol of [Number.NaN, -3, Infinity])
      expect(xs(tidyRails(keys, tol, L))).toEqual([10, 30]);
  });

  it('makes a list that breaks the invariants obey them: held in the board, sorted, a gap apart', () => {
    const bad = [
      key(50, R2),
      key(-3, R1),
      key(0.2, R1),
      key(150, R3),
      key(50.3, R2),
      key(Number.NaN, R3),
    ];
    const next = tidyRails(bad, 0, L);
    expectLegalKeys(next, L);
    expect(xs(next)).toEqual([0, 50, 100]);
    expect(next[0]!.rail.band).toBeCloseTo(1, 12);
    expect(tidyRails(next, 0, L)).toBe(next);
    // a list that is legal is untouched, whatever its rails
    const fine = three();
    expect(tidyRails(fine, 0, L)).toBe(fine);
    // without a usable length there is nothing to hold keys inside, and the list is left as it is
    expect(xs(tidyRails(bad, 0, 0))).toEqual(xs(bad));
  });

  it('never empties a list', () => {
    const none = [key(Number.NaN, R1), key(Number.NaN, R2)];
    expect(tidyRails(none, 0, L)).toBe(none);
    expect(tidyRails([], 0, L)).toEqual([]);
  });
});

describe('the two sides', () => {
  const plus: RailKey[] = [key(10, R1), key(50, R2)];
  const mirror: RailsBoard['rails'] = { plus };

  it('unlockSide gives the minus side the plus keys, the same list', () => {
    const open = unlockSide(mirror);
    expect(open.plus).toBe(plus);
    expect(open.minus).toBe(plus);
    expect(unlockSide(open)).toBe(open);
  });

  it('linkSides drops the minus side, the plus side taking the minus keys when asked', () => {
    const minus: RailKey[] = [key(10, R3), key(50, R2)];
    const own: RailsBoard['rails'] = { plus, minus };
    expect(linkSides(own, 'plus', false)).toEqual({ plus });
    expect(linkSides(own, 'plus', false).plus).toBe(plus);
    expect(linkSides(own, 'minus', false).plus).toBe(minus);
    expect('minus' in linkSides(own, 'minus', false)).toBe(false);
    expect(linkSides(mirror, 'minus', false)).toBe(mirror);
  });

  it('linkSides on an asymmetric board keeps both sides, sharing the keys, which the engine needs', () => {
    const minus: RailKey[] = [key(10, R3), key(50, R2)];
    const own: RailsBoard['rails'] = { plus, minus };
    const kept = linkSides(own, 'minus', true);
    expect(kept.plus).toBe(minus);
    expect(kept.minus).toBe(minus);
    expect(linkSides(own, 'plus', true).minus).toBe(plus);
    const same = { plus, minus: plus };
    expect(linkSides(same, 'plus', true)).toBe(same);
    const copy = { plus, minus: plus.map((k) => ({ ...k })) };
    expect(linkSides(copy, 'plus', true)).toBe(copy);
  });

  it('sidesLinked reads linked by value, so a saved board whose minus is a copy still reads linked', () => {
    expect(sidesLinked(mirror)).toBe(true);
    expect(sidesLinked({ plus, minus: plus })).toBe(true);
    expect(sidesLinked({ plus, minus: JSON.parse(JSON.stringify(plus)) as RailKey[] })).toBe(true);
    expect(sidesLinked({ plus, minus: [key(10, R3), key(50, R2)] })).toBe(false);
    expect(sidesLinked({ plus, minus: [key(10, R1)] })).toBe(false);
  });

  it('sameRailSides compares both sides by value, and whether there is a minus side', () => {
    expect(sameRailSides(mirror, { plus: [...plus] })).toBe(true);
    expect(sameRailSides(mirror, { plus, minus: plus })).toBe(false);
    expect(sameRailSides({ plus, minus: plus }, { plus, minus: [...plus] })).toBe(true);
    expect(sameRailSides({ plus, minus: plus }, { plus, minus: [key(1, R1)] })).toBe(false);
    expect(sameRailKeys(plus, [...plus])).toBe(true);
    expect(sameRailKeys(plus, [plus[0]!])).toBe(false);
  });

  const paint = (keys: readonly RailKey[]): readonly RailKey[] => setZoneRail(keys, 0, rail(R3));

  it('editSides plus on a board with no minus edits the one side', () => {
    const next = editSides(mirror, 'plus', paint);
    expect(next.minus).toBeUndefined();
    expect(next.plus[0]!.rail.band).toBe(3);
  });

  it('editSides both on a board with no minus is the same edit; minus first unlocks', () => {
    expect(editSides(mirror, 'both', paint)).toEqual(editSides(mirror, 'plus', paint));
    const next = editSides(mirror, 'minus', paint);
    expect(next.plus).toBe(plus);
    expect(next.minus![0]!.rail.band).toBe(3);
    expect(next.minus![1]).toBe(plus[1]);
  });

  it('editSides on one side of an unlocked board leaves the other side the list it was', () => {
    const open = unlockSide(mirror);
    const next = editSides(open, 'minus', paint);
    expect(next.plus).toBe(plus);
    const other = editSides(open, 'plus', paint);
    expect(other.minus).toBe(plus);
    expect(other.plus).not.toBe(plus);
  });

  it('editSides both keeps a shared list shared, and edits each of two different sides', () => {
    const open = unlockSide(mirror);
    const next = editSides(open, 'both', paint);
    expect(next.plus).toBe(next.minus);
    expect(next.plus[0]!.rail.band).toBe(3);
    const minus: RailKey[] = [key(10, R2), key(70, R3)];
    const apart = editSides({ plus, minus }, 'both', paint);
    expect(apart.plus[0]!.rail.band).toBe(3);
    expect(apart.minus![0]!.rail.band).toBe(3);
    expect(apart.minus![1]).toBe(minus[1]);
    expect(apart.plus[1]).toBe(plus[1]);
  });

  it('editSides applies a zone index to the zone of that index on each side, where the side has one', () => {
    const minus: RailKey[] = [key(10, R2)];
    const next = editSides({ plus, minus }, 'both', (keys) => setZoneNumber(keys, 1, 'apex', 0.2));
    expect(next.plus[1]!.rail.apex).toBe(0.2);
    expect(next.minus).toBe(minus);
  });

  it('editSides returns the rails themselves when no side changes', () => {
    const same = (keys: readonly RailKey[]): readonly RailKey[] => keys;
    for (const side of ['plus', 'minus', 'both'] as const) {
      expect(editSides(mirror, side, same), side).toBe(mirror);
      expect(editSides(unlockSide(mirror), side, same), side).toEqual(unlockSide(mirror));
    }
    const open = unlockSide(mirror);
    expect(editSides(open, 'both', same)).toBe(open);
  });
});
