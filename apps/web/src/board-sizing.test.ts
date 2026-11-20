// SPDX-License-Identifier: GPL-3.0-or-later
import type { RailsBoard } from '@openshaper/board2';
import { defaultFinConfig, type FinConfig } from '@openshaper/kernel';
import {
  halfWidthFn,
  scaleRailWidths,
  scaleRailsLength,
  thicknessAt,
} from '@openshaper/store/rails';
import { describe, expect, it } from 'vitest';
import { measureRails, sizeRailsBoard } from './board-sizing';
import { BOARD_TYPES, greatestSize, leastSize, type BoardSize } from './board-types';
import { templateRails } from './test/template-rails';

/**
 * The board's size read in ways that share no code with `measureRails` (the kernel's specs): the length is the
 * outline's last knot, the thickness is the engine's chain evaluator at mid-length, and the width is twice the
 * greatest half width of the engine's half-width function over a fine sweep.
 */
const lengthOf = (b: RailsBoard): number =>
  b.outline.plus.knots[b.outline.plus.knots.length - 1]!.p[0];
const thicknessOf = (b: RailsBoard): number => thicknessAt(b.rocker, b.deck, lengthOf(b) / 2);
const widthOf = (b: RailsBoard): number => {
  const half = halfWidthFn(b.outline);
  const length = lengthOf(b);
  let widest = 0;
  for (let i = 0; i <= 4000; i++) widest = Math.max(widest, half((length * i) / 4000));
  return 2 * widest;
};

/** 0.1 mm, in cm. */
const TENTH_MM = 0.01;

const midSize = (t: (typeof BOARD_TYPES)[number]): BoardSize => ({
  length: (t.ranges.length.least + t.ranges.length.greatest) / 2,
  width: (t.ranges.width.least + 3 * t.ranges.width.greatest) / 4,
  thickness: (3 * t.ranges.thickness.least + t.ranges.thickness.greatest) / 4,
});

describe('measureRails', () => {
  it.each(BOARD_TYPES.map((t) => t.name))('%s: reads what the sidebar reads', async (name) => {
    const board = await templateRails(name);
    const size = measureRails(board);
    expect(size.length).toBeCloseTo(lengthOf(board), 9);
    expect(size.thickness).toBeCloseTo(thicknessOf(board), 3);
    expect(size.width).toBeCloseTo(widthOf(board), 3);
  });
});

describe('sizeRailsBoard', () => {
  it.each(BOARD_TYPES.map((t) => t.name))(
    '%s: the size it is drawn at opens the board itself',
    async (name) => {
      const board = await templateRails(name);
      expect(sizeRailsBoard(board, measureRails(board))).toBe(board);
      // a size that was rounded to be stored (a micrometre) is the same size
      const rounded = BOARD_TYPES.find((t) => t.name === name)!.drawn;
      expect(sizeRailsBoard(board, rounded)).toBe(board);
    },
  );

  describe.each(BOARD_TYPES.map((t) => [t.name, t] as const))('%s', (name, type) => {
    const sizes: readonly (readonly [string, BoardSize])[] = [
      ['the least size', leastSize(type)],
      ['the greatest size', greatestSize(type)],
      ['a size between', midSize(type)],
      ['one dimension changed', { ...type.drawn, length: type.ranges.length.greatest }],
    ];

    it.each(sizes)(
      '%s has the length, width and thickness asked for, to 0.1 mm',
      async (_, size) => {
        const board = await templateRails(name);
        const made = sizeRailsBoard(board, size);
        // by the specs the sidebar shows
        const read = measureRails(made);
        expect(Math.abs(read.length - size.length)).toBeLessThan(TENTH_MM);
        expect(Math.abs(read.width - size.width)).toBeLessThan(TENTH_MM);
        expect(Math.abs(read.thickness - size.thickness)).toBeLessThan(TENTH_MM);
        // and by code that shares none of it
        expect(Math.abs(lengthOf(made) - size.length)).toBeLessThan(TENTH_MM);
        expect(Math.abs(widthOf(made) - size.width)).toBeLessThan(TENTH_MM);
        expect(Math.abs(thicknessOf(made) - size.thickness)).toBeLessThan(TENTH_MM);
      },
    );

    it.each(sizes)('%s keeps the tail at x = 0 and never ends in a point', async (_, size) => {
      const board = await templateRails(name);
      const made = sizeRailsBoard(board, size);
      expect(Math.min(...made.outline.plus.knots.map((k) => k.p[0]))).toBe(0);
      expect(Math.min(...made.stations.map((s) => s.x))).toBeGreaterThan(0);
      expect(Math.max(...made.stations.map((s) => s.x))).toBeLessThan(lengthOf(made));
      // the board has a thickness at both ends, and the corners that round them are as they were
      expect(thicknessAt(made.rocker, made.deck, 0)).toBeGreaterThan(0.1);
      expect(thicknessAt(made.rocker, made.deck, lengthOf(made))).toBeGreaterThan(0.1);
      expect(made.corners).toBe(board.corners);
      expect(made.corners.nose).toBeGreaterThan(0);
      expect(made.corners.tail).toBeGreaterThan(0);
    });

    it('follows the scale as the Resize section does: stations, rail keys, band and tuck', async () => {
      const board = await templateRails(name);
      const size = greatestSize(type);
      const drawn = measureRails(board);
      const fL = size.length / drawn.length;
      const fW = size.width / drawn.width;
      const made = sizeRailsBoard(board, size);
      // the two pure edits the Resize section is made of, applied to the drawn board
      const expected = scaleRailWidths(scaleRailsLength(board, fL), fW);

      expect(made.stations.map((s) => s.id)).toEqual(board.stations.map((s) => s.id));
      made.stations.forEach((s, i) => {
        expect(s.x).toBeCloseTo(expected.stations[i]!.x, 9);
        // the curves are normalised to the station's own half width and thickness: they are the same objects
        expect(s.plus).toBe(board.stations[i]!.plus);
        expect(s.minus).toBe(board.stations[i]!.minus);
      });
      expect(made.rails.plus).toHaveLength(board.rails.plus.length);
      made.rails.plus.forEach((key, i) => {
        const was = board.rails.plus[i]!;
        const want = expected.rails.plus[i]!;
        expect(key.x).toBeCloseTo(want.x, 9);
        expect(key.rail.band).toBeCloseTo(want.rail.band, 9);
        expect(key.rail.tuck).toBeCloseTo(want.rail.tuck, 9);
        // the band and the tuck grew with the width; the other five numbers did not
        expect(key.rail.band).toBeCloseTo(was.rail.band * fW, 9);
        expect(key.rail.tuck).toBeCloseTo(was.rail.tuck * fW, 9);
        for (const n of ['hardness', 'tuckShape', 'bottomEdge', 'deckEdge', 'apex'] as const) {
          expect(key.rail[n]).toBe(was.rail[n]);
        }
      });
      expect(made.features).toHaveLength(board.features.length);
    });

    it('stretches the outline by the length and the width, and the two lines by the length and the thickness', async () => {
      const board = await templateRails(name);
      const size = leastSize(type);
      const drawn = measureRails(board);
      const [fL, fW, fT] = [
        size.length / drawn.length,
        size.width / drawn.width,
        size.thickness / drawn.thickness,
      ];
      const made = sizeRailsBoard(board, size);
      const near = (a: readonly number[], b: readonly number[], fx: number, fy: number) => {
        expect(a[0]!).toBeCloseTo(b[0]! * fx, 7);
        expect(a[1]!).toBeCloseTo(b[1]! * fy, 7);
      };
      made.outline.plus.knots.forEach((k, i) => {
        const was = board.outline.plus.knots[i]!;
        near(k.p, was.p, fL, fW);
        near(k.in, was.in, fL, fW);
        near(k.out, was.out, fL, fW);
      });
      made.rocker.knots.forEach((k, i) => near(k.p, board.rocker.knots[i]!.p, fL, fT));
      made.deck.knots.forEach((k, i) => near(k.p, board.deck.knots[i]!.p, fL, fT));
    });
  });

  it('scales a fin setup with the board, as Resize does (the starter templates have none)', async () => {
    const board = await templateRails('Shortboard');
    const fins = defaultFinConfig('thruster', 'fcs-ii');
    const withFins = { ...board, fins: fins as unknown as RailsBoard['fins'] } as RailsBoard;
    const drawn = measureRails(withFins);
    const size = { ...drawn, length: drawn.length * 1.1, thickness: drawn.thickness * 1.2 };
    const made = sizeRailsBoard(withFins, size);
    const after = made.fins as unknown as FinConfig;
    after.fins.forEach((f, i) => {
      const was = fins.fins[i]!;
      expect(f.trailingFromTail).toBeCloseTo(was.trailingFromTail * 1.1, 9);
      expect(f.base).toBeCloseTo(was.base * 1.1, 9);
      expect(f.depth).toBeCloseTo(was.depth * 1.2, 9);
    });
  });
});
