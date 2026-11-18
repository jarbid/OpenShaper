// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `zones.ts` against the engine it mirrors: `railAt` against the laws a built board holds at every
 * loop sample, and `RAIL_LIMITS` against what the engine does to a number outside them (the store
 * may not import engine code, so the numbers are copied there and pinned here); and the engine's
 * reading of zones: equal keys hold a rail flat, and a blend between different rails runs without
 * overshoot.
 */
import type { RailsBoard } from '@openshaper/board2';
import { buildRails, meshRails, probeRails } from '@openshaper/board2';
import { describe, expect, it } from 'vitest';
import { railsBoard } from './test-support/boards';
import { between, rail, randomRail, seeded } from './test-support/zone-kit';
import type { RailKey, RailRecipe } from './types';
import {
  RAIL_LIMITS,
  ZONE_MIN_GAP,
  moveZoneEnd,
  railAt,
  railZones,
  setZoneRail,
  tidyRails,
} from './zones';

const clamp = (v: number, [lo, hi]: readonly [number, number]): number =>
  Math.min(hi, Math.max(lo, v));
const RAD = Math.PI / 180;
const lengthOf = (b: RailsBoard): number => b.outline.plus.knots.at(-1)!.p[0];

function built(board: RailsBoard) {
  const r = buildRails(board);
  if (!r.ok) throw new Error(r.issues.map((i) => i.message).join('; '));
  return r.value;
}

/** Keys at random places along a board of `length`, a random rail each, a flat pair now and then. */
function randomKeys(rng: () => number, length: number): RailKey[] {
  const n = 3 + Math.floor(between(rng, 0, 5));
  const keys: RailKey[] = [];
  let x = between(rng, 0, 0.1 * length);
  for (let i = 0; i < n && x <= length; i++) {
    keys.push({ x, rail: i > 0 && rng() < 0.3 ? keys[i - 1]!.rail : randomRail(rng) });
    x += ZONE_MIN_GAP + between(rng, 0, (0.9 * length) / n);
  }
  return keys;
}

const uniform = (board: RailsBoard, rail: Partial<RailRecipe>): RailsBoard => {
  const base = board.rails.plus[0]!.rail;
  const keys = [
    { x: 0, rail: { ...base, ...rail } },
    { x: lengthOf(board), rail: { ...base, ...rail } },
  ];
  return { ...board, rails: { plus: keys } };
};

describe('railAt against the laws of a built board', () => {
  const rng = seeded(7);
  const cases: [string, RailsBoard][] = [
    ['mirror', railsBoard('mirror')],
    ['asymmetric (its own minus keys)', railsBoard('asymmetric')],
    ['swallow', railsBoard('swallow')],
  ];
  const mirror = railsBoard('mirror');
  cases.push(
    [
      'mirror with random plus keys',
      { ...mirror, rails: { plus: randomKeys(rng, lengthOf(mirror)) } },
    ],
    [
      'mirror with unlocked, different minus keys',
      {
        ...mirror,
        rails: {
          plus: randomKeys(rng, lengthOf(mirror)),
          minus: randomKeys(rng, lengthOf(mirror)),
        },
      },
    ],
  );

  it.each(cases)(
    '%s: every number the engine only clamps agrees at every loop sample',
    (_n, board) => {
      const { loop, laws } = built(board);
      const plus = board.rails.plus;
      const minus = board.rails.minus ?? plus;
      let seen = 0;
      for (let i = 0; i < loop.n; i++) {
        const r = railAt(loop.y[i]! >= 0 ? plus : minus, loop.x[i]!);
        expect(laws.apex[i]).toBeCloseTo(clamp(r.apex, RAIL_LIMITS.apex), 12);
        expect(laws.deckRho[i]).toBeCloseTo(clamp(r.hardness, RAIL_LIMITS.hardness), 12);
        expect(laws.tuckRho[i]).toBeCloseTo(clamp(r.tuckShape, RAIL_LIMITS.tuckShape), 12);
        expect(laws.deckEdge[i]).toBeCloseTo(Math.tan(r.deckEdge * RAD), 12);
        expect(laws.bottomEdge[i]).toBeCloseTo(Math.tan(r.bottomEdge * RAD), 12);
        // the engine only ever narrows a band, down to the floor: never wider than the rail says
        expect(laws.deckWidth[i]!).toBeLessThanOrEqual(
          Math.max(RAIL_LIMITS.band[0], r.band) + 1e-9,
        );
        expect(laws.tuckWidth[i]!).toBeLessThanOrEqual(
          Math.max(RAIL_LIMITS.tuck[0], r.tuck) + 1e-9,
        );
        seen++;
      }
      expect(seen).toBeGreaterThan(100);
    },
  );
});

describe('RAIL_LIMITS against the engine', () => {
  const board = railsBoard('mirror');
  const maxOf = (a: Float64Array): number => a.reduce((m, v) => Math.max(m, v), -Infinity);
  const minOf = (a: Float64Array): number => a.reduce((m, v) => Math.min(m, v), Infinity);

  it('is the floor of a band and of a tuck: the narrowest blend the engine builds', () => {
    const { laws } = built(uniform(board, { band: 0, tuck: 0 }));
    expect(maxOf(laws.deckWidth)).toBe(RAIL_LIMITS.band[0]);
    expect(maxOf(laws.tuckWidth)).toBe(RAIL_LIMITS.tuck[0]);
    const wide = built(uniform(board, { band: 1000, tuck: 1000 })).laws;
    // far above the range, the engine's own limit on the board takes over: no band exceeds the top
    expect(maxOf(wide.deckWidth)).toBeLessThanOrEqual(RAIL_LIMITS.band[1]);
    expect(maxOf(wide.tuckWidth)).toBeLessThanOrEqual(RAIL_LIMITS.tuck[1]);
  });

  it('is the inset of both rho and of the apex', () => {
    const low = built(uniform(board, { hardness: 0, tuckShape: 0, apex: 0 })).laws;
    expect(maxOf(low.deckRho)).toBe(RAIL_LIMITS.hardness[0]);
    expect(minOf(low.deckRho)).toBe(RAIL_LIMITS.hardness[0]);
    expect(minOf(low.tuckRho)).toBe(RAIL_LIMITS.tuckShape[0]);
    expect(minOf(low.apex)).toBe(RAIL_LIMITS.apex[0]);
    const high = built(uniform(board, { hardness: 1, tuckShape: 1, apex: 1 })).laws;
    expect(minOf(high.deckRho)).toBe(RAIL_LIMITS.hardness[1]);
    expect(maxOf(high.deckRho)).toBe(RAIL_LIMITS.hardness[1]);
    expect(maxOf(high.tuckRho)).toBe(RAIL_LIMITS.tuckShape[1]);
    expect(maxOf(high.apex)).toBe(RAIL_LIMITS.apex[1]);
  });

  it('reads an edge only through its tangent: finite across the range, none at 0', () => {
    const { laws } = built(
      uniform(board, { bottomEdge: RAIL_LIMITS.bottomEdge[1], deckEdge: RAIL_LIMITS.deckEdge[1] }),
    );
    // the tangent is steep at 89 degrees, so an ulp in the angle is a few parts in 1e14 of it
    const tan = Math.tan(RAIL_LIMITS.bottomEdge[1] * RAD);
    expect(Math.abs(maxOf(laws.bottomEdge) / tan - 1)).toBeLessThan(1e-12);
    expect(Number.isFinite(maxOf(laws.deckEdge))).toBe(true);
    expect(RAIL_LIMITS.bottomEdge[1]).toBeLessThan(90);
    expect(maxOf(built(uniform(board, { bottomEdge: 0, deckEdge: 0 })).laws.bottomEdge)).toBe(0);
  });
});

describe('equal keys hold flat', () => {
  const board = railsBoard('mirror');
  const length = lengthOf(board);
  const FLAT = rail({
    band: 1,
    hardness: 0.6,
    tuck: 0.3,
    tuckShape: 0.8,
    bottomEdge: 35,
    deckEdge: 12,
    apex: 0.35,
  });
  /** The mirror board's keys with the zone at 92.71 drawn out to 130 and given the rail `FLAT`. */
  const zoned = (): readonly RailKey[] =>
    setZoneRail(moveZoneEnd(board.rails.plus, 2, 'to', 130, length), 2, FLAT);

  it('a zone built by setZoneRail across two keys reads one rail at every place between them', () => {
    const keys = zoned();
    const z = railZones(keys).zones[2]!;
    expect([z.first, z.last]).toEqual([2, 3]);
    expect(z.to - z.from).toBeGreaterThan(30);
    for (let i = 0; i <= 400; i++) {
      expect(railAt(keys, z.from + ((z.to - z.from) * i) / 400)).toEqual(FLAT);
    }
  });

  it('and a built board holds that rail at every loop sample inside it, bands as wide as the rail says', () => {
    const keys = zoned();
    const z = railZones(keys).zones[2]!;
    const { loop, laws } = built({ ...board, rails: { plus: keys } });
    let inside = 0;
    for (let i = 0; i < loop.n; i++) {
      const x = loop.x[i]!;
      if (x < z.from || x > z.to) continue;
      inside++;
      expect(laws.apex[i]).toBeCloseTo(FLAT.apex, 12);
      expect(laws.deckRho[i]).toBeCloseTo(FLAT.hardness, 12);
      expect(laws.tuckRho[i]).toBeCloseTo(FLAT.tuckShape, 12);
      expect(laws.deckEdge[i]).toBeCloseTo(Math.tan(FLAT.deckEdge * RAD), 12);
      expect(laws.bottomEdge[i]).toBeCloseTo(Math.tan(FLAT.bottomEdge * RAD), 12);
      // the engine only softens a band by the board's own width, a few parts in a thousand mid-board
      expect(laws.deckWidth[i]!).toBeGreaterThan(0.99 * FLAT.band);
      expect(laws.deckWidth[i]!).toBeLessThanOrEqual(FLAT.band + 1e-12);
      expect(laws.tuckWidth[i]!).toBeGreaterThan(0.99 * FLAT.tuck);
      expect(laws.tuckWidth[i]!).toBeLessThanOrEqual(FLAT.tuck + 1e-12);
    }
    expect(inside).toBeGreaterThan(100);
  });

  it('an interior key on the flat run changes nothing the engine reads: sections and mesh', () => {
    const keys = zoned();
    const padded: RailKey[] = [...keys.slice(0, 3), { x: 110, rail: FLAT }, ...keys.slice(3)];
    const tidied = tidyRails(padded, 0, length);
    expect(tidied.map((k) => k.x)).toEqual(keys.map((k) => k.x));
    const a = built({ ...board, rails: { plus: padded } });
    const b = built({ ...board, rails: { plus: tidied } });
    for (const side of [0, 1] as const) {
      for (const x of [95, 105, 112, 125]) {
        const pa = probeRails(a, side, x, 24);
        const pb = probeRails(b, side, x, 24);
        expect(pb).toHaveLength(pa.length);
        pa.forEach((v, i) => expect(pb[i]).toBeCloseTo(v, 9));
      }
    }
    const ma = meshRails(a, { draft: true });
    const mb = meshRails(b, { draft: true });
    expect(mb.vertexCount).toBe(ma.vertexCount);
    expect(mb.indices).toEqual(ma.indices);
    let far = 0;
    ma.positions.forEach((v, i) => (far = Math.max(far, Math.abs(v - mb.positions[i]!))));
    expect(far).toBeLessThan(1e-4);
    expect(mb.volume).toBeCloseTo(ma.volume, 3);
  });
});

describe('a blend runs from one rail to the next without overshoot', () => {
  const board = railsBoard('mirror');
  const A = rail({
    band: 2,
    hardness: 0.5,
    tuck: 1.4,
    tuckShape: 0.45,
    bottomEdge: 0,
    deckEdge: 0,
    apex: 0.5,
  });
  const B = rail({
    band: 1,
    hardness: 0.7,
    tuck: 0.3,
    tuckShape: 0.8,
    bottomEdge: 35,
    deckEdge: 15,
    apex: 0.3,
  });

  it('in the laws of a built board: every number between its two ends, and monotone along the board', () => {
    const keys: RailKey[] = [
      { x: 20, rail: A },
      { x: 40, rail: A },
      { x: 120, rail: B },
      { x: 140, rail: B },
    ];
    const { loop, laws } = built({ ...board, rails: { plus: keys } });
    const names = ['apex', 'deckRho', 'tuckRho', 'deckEdge', 'bottomEdge'] as const;
    const ends = {
      apex: [A.apex, B.apex],
      deckRho: [A.hardness, B.hardness],
      tuckRho: [A.tuckShape, B.tuckShape],
      deckEdge: [Math.tan(A.deckEdge * RAD), Math.tan(B.deckEdge * RAD)],
      bottomEdge: [Math.tan(A.bottomEdge * RAD), Math.tan(B.bottomEdge * RAD)],
    } as const;
    const samples: number[] = [];
    for (let i = 0; i < loop.n; i++) {
      if (loop.y[i]! >= 0 && loop.x[i]! >= 40 && loop.x[i]! <= 120) samples.push(i);
    }
    samples.sort((p, q) => loop.x[p]! - loop.x[q]!);
    expect(samples.length).toBeGreaterThan(100);
    for (const name of names) {
      const [from, to] = ends[name];
      const lo = Math.min(from, to) - 1e-12;
      const hi = Math.max(from, to) + 1e-12;
      const sign = Math.sign(to - from);
      let last = laws[name][samples[0]!]!;
      for (const i of samples) {
        const v = laws[name][i]!;
        expect(v, name).toBeGreaterThanOrEqual(lo);
        expect(v, name).toBeLessThanOrEqual(hi);
        expect(sign * (v - last), name).toBeGreaterThanOrEqual(-1e-12);
        last = v;
      }
      // it does travel, from one end to the other: the nearest loop sample to a key is up to half
      // the coarsest spacing (0.55 cm) from it, and a cubic leaves a key flat, so it has moved by
      // 3t^2 of the span there, t being that distance over the blend's 80 cm
      const reach = 2e-3 * Math.abs(to - from);
      expect(Math.abs(laws[name][samples[0]!]! - from), name).toBeLessThan(reach);
      expect(Math.abs(laws[name][samples[samples.length - 1]!]! - to), name).toBeLessThan(reach);
    }
  });
});
