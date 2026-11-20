// SPDX-License-Identifier: GPL-3.0-or-later
import { INCH } from '@openshaper/units';
import { describe, expect, it } from 'vitest';
import { measureRails } from './board-sizing';
import {
  BOARD_TYPES,
  DIMENSIONS,
  boardTypeNamed,
  greatestSize,
  holdSize,
  holdToRange,
  leastSize,
} from './board-types';
import { NURBS_TEMPLATES } from './templates';
import { templateRails } from './test/template-rails';

describe('the kinds of board', () => {
  it('are the five starter templates, in the order the New menu lists them', () => {
    expect(BOARD_TYPES.map((t) => t.name)).toEqual([
      'Shortboard',
      'Funboard',
      'Longboard',
      'Swallow shortboard',
      'Fish shortboard',
    ]);
    expect(
      BOARD_TYPES.map((t) => t.name),
      'Each starter template is a kind of board and each kind is a template: add the kind to KINDS in ' +
        'board-types.ts, with its ranges, and write board-type-shapes.ts again ' +
        '(NURBS_TEMPLATES_WRITE=1 pnpm --filter @openshaper/web exec vitest run tools/make-nurbs-templates.test.ts).',
    ).toEqual(NURBS_TEMPLATES.map((t) => t.name));
  });

  it('describe themselves in one line each, and no two the same', () => {
    for (const t of BOARD_TYPES) {
      expect(t.description, t.name).toMatch(/^[A-Z][^\n]{40,160}\.$/);
    }
    expect(new Set(BOARD_TYPES.map((t) => t.description)).size).toBe(BOARD_TYPES.length);
  });

  it('are found by name', () => {
    expect(boardTypeNamed('Longboard')).toBe(BOARD_TYPES[2]);
    expect(boardTypeNamed('Gun')).toBeUndefined();
  });

  it.each(BOARD_TYPES.map((t) => t.name))(
    '%s: is drawn at the size of the board the template opens as',
    async (name) => {
      // the committed numbers are rounded to a micrometre; the board's own are read here from the template
      const type = boardTypeNamed(name)!;
      const read = measureRails(await templateRails(name));
      for (const d of DIMENSIONS) expect(Math.abs(type.drawn[d] - read[d]), d).toBeLessThan(1e-4);
    },
  );
});

describe('the ranges', () => {
  it.each(BOARD_TYPES.map((t) => [t.name, t] as const))(
    '%s: each runs from a least to a greater greatest, in sizes a board can have',
    (_name, type) => {
      for (const d of DIMENSIONS) {
        const { least, greatest } = type.ranges[d];
        expect(least, d).toBeLessThan(greatest);
      }
      const { length, width, thickness } = type.ranges;
      expect(length.least).toBeGreaterThan(120);
      expect(length.greatest).toBeLessThan(400);
      expect(width.least).toBeGreaterThan(35);
      expect(width.greatest).toBeLessThan(70);
      expect(thickness.least).toBeGreaterThan(3.5);
      expect(thickness.greatest).toBeLessThan(9);
      // a board is longer than it is wide and wider than it is thick, at every corner of the box
      expect(length.least).toBeGreaterThan(2 * width.greatest);
      expect(width.least).toBeGreaterThan(3 * thickness.greatest);
    },
  );

  it.each(BOARD_TYPES.map((t) => [t.name, t] as const))(
    '%s: hold the size it is drawn at',
    (_name, type) => {
      for (const d of DIMENSIONS) {
        expect(type.drawn[d], d).toBeGreaterThan(type.ranges[d].least);
        expect(type.drawn[d], d).toBeLessThan(type.ranges[d].greatest);
      }
      expect(holdSize(type, type.drawn)).toEqual(type.drawn);
    },
  );

  it('are set in the shaper’s inches', () => {
    const [shortboard, , longboard] = BOARD_TYPES;
    expect(shortboard!.ranges.length.least / INCH).toBeCloseTo(60, 9);
    expect(shortboard!.ranges.length.greatest / INCH).toBeCloseTo(86, 9);
    expect(longboard!.ranges.length.least / INCH).toBeCloseTo(102, 9);
    expect(longboard!.ranges.length.greatest / INCH).toBeCloseTo(132, 9);
    expect(shortboard!.ranges.thickness.least / INCH).toBeCloseTo(1.875, 9);
  });

  it('hold a number to the range, and never refuse one', () => {
    const range = { least: 10, greatest: 20 };
    expect(holdToRange(15, range)).toBe(15);
    expect(holdToRange(9.99, range)).toBe(10);
    expect(holdToRange(-5, range)).toBe(10);
    expect(holdToRange(20.01, range)).toBe(20);
    expect(holdToRange(1e9, range)).toBe(20);
    expect(holdToRange(10, range)).toBe(10);
    expect(holdToRange(20, range)).toBe(20);
  });

  it('hold each dimension of a size on its own', () => {
    const type = BOARD_TYPES[0]!;
    const held = holdSize(type, { length: 1, width: 1000, thickness: type.drawn.thickness });
    expect(held).toEqual({
      length: type.ranges.length.least,
      width: type.ranges.width.greatest,
      thickness: type.drawn.thickness,
    });
    expect(leastSize(type)).toEqual({
      length: type.ranges.length.least,
      width: type.ranges.width.least,
      thickness: type.ranges.thickness.least,
    });
    expect(greatestSize(type).length).toBe(type.ranges.length.greatest);
  });
});

describe('the plan outlines', () => {
  /** Every number in a path, as (x, y) pairs: the end points and the handles of its segments. */
  const points = (d: string): [number, number][] => {
    const n = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    return Array.from({ length: n.length / 2 }, (_, i) => [n[2 * i]!, n[2 * i + 1]!]);
  };

  it.each(BOARD_TYPES.map((t) => [t.name, t] as const))(
    '%s: is a few hundred bytes of one open path of cubic segments that spans the drawn board',
    (_name, type) => {
      expect(type.plan.length).toBeLessThan(400);
      expect(type.plan).toMatch(/^M[-\d. ]+(C[-\d. ]+)+$/);
      const p = points(type.plan);
      const xs = p.map(([x]) => x);
      const ys = p.map(([, y]) => y);
      // tail at x = 0, nose at the board's length, never below the stringer, as wide as the board
      expect(Math.min(...xs)).toBe(0);
      expect(Math.abs(Math.max(...xs) - type.drawn.length)).toBeLessThan(0.1);
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
      expect(Math.abs(2 * Math.max(...ys) - type.drawn.width)).toBeLessThan(0.2);
      // it ends at the nose, on the stringer
      expect(p[p.length - 1]![1]).toBe(0);
    },
  );
});
