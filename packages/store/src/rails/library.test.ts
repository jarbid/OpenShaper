// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The built-in rails: their numbers as the design table gives them, that the engine keeps each as
 * a closed board when it is the one zone across a whole test board, and how a rail is named.
 */
import { describe, expect, it } from 'vitest';
import { apexLabel } from './dials';
import { BUILT_IN_RAILS, NAME_TOLERANCE, railName } from './library';
import { railsBoards } from './test-support/boards';
import { closedVerdict, withRailAlong } from './test-support/closed';
import { rail } from './test-support/zone-kit';
import { RAIL_LIMITS, RAIL_NUMBERS, setZoneRail } from './zones';

/** The design table: id, name, then band, hardness, tuck, tuck shape, bottom edge, deck edge, apex. */
const TABLE: readonly [string, string, ...number[]][] = [
  ['round', 'Round', 2.0, 0.5, 1.4, 0.45, 0, 0, 0.5],
  ['soft', 'Soft 60/40', 2.2, 0.5, 1.2, 0.45, 0, 0, 0.4],
  ['down', 'Down rail 80/20', 2.4, 0.55, 0.8, 0.5, 10, 0, 0.22],
  ['tucked', 'Tucked', 2.0, 0.5, 2.2, 0.4, 0, 0, 0.5],
  ['boxy', 'Boxy', 1.2, 0.7, 1.0, 0.7, 0, 0, 0.5],
  ['hard', 'Hard edge', 1.0, 0.6, 0.3, 0.8, 35, 0, 0.35],
  ['tip', 'Fine tip', 0.15, 0.45, 0.05, 0.9, 0, 0, 0.4],
];

describe('BUILT_IN_RAILS', () => {
  it('are the seven rails of the design table, with their numbers', () => {
    expect(BUILT_IN_RAILS.map((b) => [b.id, b.name])).toEqual(
      TABLE.map(([id, name]) => [id, name]),
    );
    TABLE.forEach(([, , ...numbers], i) => {
      const r = BUILT_IN_RAILS[i]!.rail;
      expect(RAIL_NUMBERS.map((n) => r[n])).toEqual(numbers);
    });
  });

  it('have distinct ids and names, and a summary that is one sentence', () => {
    expect(new Set(BUILT_IN_RAILS.map((b) => b.id)).size).toBe(7);
    expect(new Set(BUILT_IN_RAILS.map((b) => b.name)).size).toBe(7);
    for (const b of BUILT_IN_RAILS) {
      expect(b.summary, b.id).toMatch(/^[A-Z][^.\n]+\.$/);
      expect(b.summary.length, b.id).toBeLessThan(200);
    }
  });

  it('are frozen, and inside the range the engine holds a number to, so giving one to a zone changes no number', () => {
    for (const b of BUILT_IN_RAILS) {
      expect(Object.isFrozen(b), b.id).toBe(true);
      expect(Object.isFrozen(b.rail), b.id).toBe(true);
      for (const n of RAIL_NUMBERS) {
        expect(b.rail[n], `${b.id} ${n}`).toBeGreaterThanOrEqual(RAIL_LIMITS[n][0]);
        expect(b.rail[n], `${b.id} ${n}`).toBeLessThanOrEqual(RAIL_LIMITS[n][1]);
      }
      const keys = [
        { x: 10, rail: rail() },
        { x: 50, rail: rail({ band: 3 }) },
      ];
      expect(setZoneRail(keys, 1, b.rail)[1]!.rail).toEqual(b.rail);
    }
  });

  it('name an apex that reads as the ratio in their name', () => {
    expect(apexLabel(BUILT_IN_RAILS[1]!.rail.apex)).toBe('60/40');
    expect(apexLabel(BUILT_IN_RAILS[2]!.rail.apex)).toBe('80/20');
    expect(apexLabel(BUILT_IN_RAILS[0]!.rail.apex)).toBe('50/50');
  });
});

describe('each built-in rail across a whole board', () => {
  const cases = BUILT_IN_RAILS.flatMap((b) =>
    railsBoards.map(([name, make]) => [b.id, name, b, make] as const),
  );
  it.each(cases)(
    '%s on the %s board builds without issues and meshes closed, at view and at draft quality',
    (_id, _board, builtIn, make) => {
      const doc = withRailAlong(make(), builtIn.rail);
      for (const draft of [false, true]) {
        const v = closedVerdict(doc, draft);
        expect(v.why, draft ? 'draft' : 'view').toBe('');
        expect(v.ok).toBe(true);
      }
    },
    30_000,
  );
});

describe('railName', () => {
  it('finds the name of each built-in rail', () => {
    for (const b of BUILT_IN_RAILS) expect(railName(b.rail), b.id).toBe(b.name);
  });

  it('calls a rail moved by a dial or a number Custom', () => {
    for (const b of BUILT_IN_RAILS) {
      for (const [n, d] of [
        ['band', 0.2],
        ['hardness', 0.05],
        ['tuck', 0.1],
        ['tuckShape', 0.05],
        ['bottomEdge', 2],
        ['deckEdge', 1],
        ['apex', 0.04],
      ] as const) {
        expect(railName({ ...b.rail, [n]: b.rail[n] + d }), `${b.id} ${n}`).toBe('Custom');
      }
    }
    expect(railName(rail({ band: 2.5, apex: 0.45 }))).toBe('Custom');
  });

  it('still finds the name of a rail that has been rounded', () => {
    for (const b of BUILT_IN_RAILS) {
      const rounded = { ...b.rail, band: b.rail.band + 0.004, apex: b.rail.apex - 0.004 };
      expect(railName(rounded), b.id).toBe(b.name);
    }
    expect(NAME_TOLERANCE).toBeGreaterThan(0);
  });

  it('finds the name of a saved rail, and takes the nearest of the rails within the tolerance', () => {
    const mine = [
      { name: 'My step-down', rail: rail({ band: 1.7, apex: 0.3, bottomEdge: 15 }) },
      { name: 'My other', rail: rail({ band: 1.7, apex: 0.3, bottomEdge: 15.05 }) },
    ];
    expect(railName(mine[0]!.rail, mine)).toBe('My step-down');
    expect(railName(mine[1]!.rail, mine)).toBe('My other');
    expect(railName(rail({ band: 1.7, apex: 0.3, bottomEdge: 15.004 }), mine)).toBe('My step-down');
    // 0.02 from one and 0.03 from the other is within the default tolerance of neither
    expect(railName(rail({ band: 1.7, apex: 0.3, bottomEdge: 15.02 }), mine)).toBe('Custom');
    // with room, the nearer of the two takes it
    expect(railName(rail({ band: 1.7, apex: 0.3, bottomEdge: 15.02 }), mine, 0.1)).toBe(
      'My step-down',
    );
    expect(railName(rail({ band: 1.7, apex: 0.3, bottomEdge: 15.03 }), mine, 0.1)).toBe('My other');
    // with no saved rails, or ones that are not near, it is Custom
    expect(railName(mine[0]!.rail)).toBe('Custom');
    expect(railName(mine[0]!.rail, [])).toBe('Custom');
    expect(railName(rail({ band: 5 }), mine)).toBe('Custom');
  });

  it('puts the built-in rails first when a saved rail has the same numbers', () => {
    const round = BUILT_IN_RAILS[0]!;
    expect(railName(round.rail, [{ name: 'Mine', rail: { ...round.rail } }])).toBe('Round');
  });

  it('takes a tolerance, so a converted board rails can be named for the nearest rail', () => {
    const converted = rail({ band: 2.3, hardness: 0.52, tuck: 1.2, tuckShape: 0.44, apex: 0.53 });
    expect(railName(converted)).toBe('Custom');
    expect(railName(converted, [], 0.5)).toBe('Soft 60/40');
    // the nearest, not the first, of those within it
    expect(railName(rail({ band: 2.0, apex: 0.5, tuck: 1.3 }), [], 0.5)).toBe('Round');
  });

  it('reads a tolerance that is not a positive number as exact equality, and a rail that is not numbers as Custom', () => {
    const near = { ...BUILT_IN_RAILS[0]!.rail, band: 2.001 };
    for (const t of [0, -1, Number.NaN, Infinity]) expect(railName(near, [], t)).toBe('Custom');
    expect(railName({ ...BUILT_IN_RAILS[0]!.rail, band: Number.NaN })).toBe('Custom');
  });
});
