// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The gate of the Tail step: every tail in the picker gives a good board at every size in the gallery. Each kind of
 * board is made at the least and at the greatest size it allows (`sizeRailsBoard`, the scaling a new board goes
 * through), every shape is applied to it at the least, a typical and the greatest width and, for a notch, the least and
 * the greatest depth, and the engine builds the result with no issue and no coarsening and its mesh is closed. Only the
 * two corners of each kind are built, as `board-types.gate.test.ts` does, and at draft quality, the one a drag is meshed at.
 *
 * A shape is read off the outline and the gallery makes a board at a size by stretching its length and its width
 * on their own, so a shape applied to a kind of board, and the tail of each kind as it is drawn, must read as the same shape
 * at every size, with its width scaled as the board's width is and its notch as its length is.
 */
import { buildRails, meshRails } from '@openshaper/board2';
import {
  TAIL_SHAPES,
  applyTailShape,
  isNotchedShape,
  tailNotchRange,
  tailShapeOf,
  tailWidthRange,
  type TailShapeId,
  type TailShapeRequest,
} from '@openshaper/store/rails';
import { describe, expect, it } from 'vitest';
import { measureRails, sizeRailsBoard } from './board-sizing';
import { BOARD_TYPES, greatestSize, leastSize } from './board-types';
import { openEdges } from './test/mesh-closed';
import { templateRails } from './test/template-rails';

const corners = BOARD_TYPES.flatMap((type) => [
  [type.name, 'least', leastSize(type)] as const,
  [type.name, 'greatest', greatestSize(type)] as const,
]);

/** The widths and depths a board is built at: the least, a typical (none asked: the shape's own) and the greatest. */
function requests(
  doc: Parameters<typeof tailWidthRange>[0],
  shape: TailShapeId,
): TailShapeRequest[] {
  const w = tailWidthRange(doc, shape);
  if (!isNotchedShape(shape)) return [{ shape, width: w.min }, { shape }, { shape, width: w.max }];
  const d = tailNotchRange(doc);
  return [
    { shape, width: w.min, notch: d.min },
    { shape, width: w.min, notch: d.max },
    { shape },
    { shape, width: w.max, notch: d.min },
    { shape, width: w.max, notch: d.max },
  ];
}

describe('every tail in the picker gives a closed board at every size in the gallery', () => {
  for (const [name, end, size] of corners) {
    describe(`${name} at its ${end} size`, () => {
      it.each(TAIL_SHAPES)('%s', async (shape) => {
        const board = sizeRailsBoard(await templateRails(name), size);
        for (const request of requests(board, shape)) {
          const label = `${name} ${end} ${shape} ${JSON.stringify(request)}`;
          const next = applyTailShape(board, request);
          const built = buildRails(next);
          expect(built.ok, label).toBe(true);
          if (!built.ok) return;
          expect(built.issues, label).toEqual([]);
          const mesh = meshRails(built.value, { draft: true });
          expect(mesh.coarsened, label).toBeUndefined();
          expect(openEdges(mesh.positions, mesh.indices), label).toBe(0);
          const read = tailShapeOf(next);
          expect(read.shape, label).toBe(shape);
          if (request.width !== undefined) expect(read.width, label).toBeCloseTo(request.width, 9);
          if (request.notch !== undefined) expect(read.notch, label).toBeCloseTo(request.notch, 9);
        }
      });
    });
  }
});

describe('a shape reads the same at every size', () => {
  it.each(BOARD_TYPES.map((t) => t.name))(
    'on the %s: applied and scaled, and as it is drawn',
    async (name) => {
      const type = BOARD_TYPES.find((t) => t.name === name)!;
      const drawn = await templateRails(name);
      const from = measureRails(drawn);
      for (const [, , size] of corners.filter(([n]) => n === name)) {
        const fL = size.length / from.length;
        const fW = size.width / from.width;
        // the tail as it is drawn
        const was = tailShapeOf(drawn);
        const now = tailShapeOf(sizeRailsBoard(drawn, size));
        expect(now.shape, `${name} as drawn`).toBe(was.shape);
        if (was.width !== null) expect(now.width! / was.width, `${name} width`).toBeCloseTo(fW, 6);
        if (was.notch !== null) expect(now.notch! / was.notch, `${name} notch`).toBeCloseTo(fL, 6);
        // every shape applied to it, and then the board made at the size
        for (const shape of TAIL_SHAPES) {
          const applied = applyTailShape(drawn, { shape });
          const sized = tailShapeOf(sizeRailsBoard(applied, size));
          const before = tailShapeOf(applied);
          const label = `${name} ${shape} at ${size.length.toFixed(0)} long`;
          // the factors are those of this board's own measure, which is sampled and so differs a little from the drawn one's
          const own = measureRails(applied);
          expect(sized.shape, label).toBe(shape);
          expect(sized.width! / before.width!, label).toBeCloseTo(size.width / own.width, 9);
          if (before.notch !== null) {
            expect(sized.notch! / before.notch, label).toBeCloseTo(size.length / own.length, 9);
          }
        }
      }
      expect(type.name).toBe(name);
    },
  );

  it('reads the tails of the five kinds as the project draws them', async () => {
    const reads = await Promise.all(
      BOARD_TYPES.map(
        async (t) => [t.name, tailShapeOf(await templateRails(t.name)).shape] as const,
      ),
    );
    // the shortboard and the longboard draw their tail end soft, in the curve of one smooth knot, so they read Custom
    expect(Object.fromEntries(reads)).toEqual({
      Shortboard: 'custom',
      Funboard: 'round',
      Longboard: 'custom',
      'Swallow shortboard': 'swallow',
      'Fish shortboard': 'fish',
    });
  });
});
