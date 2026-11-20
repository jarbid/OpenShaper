// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The gate of the New board gallery: every kind of board opens at the least and at the greatest size it
 * allows, and the board that results is a good one. Each is built and meshed as the app does (rails engine,
 * view quality), so a corner takes a fraction of a second; only these two corners of each kind are built
 * here, and `board-types.measure.test.ts` studies the rest of the box.
 *
 * A good board is one the engine builds with no issue and no coarsening, whose mesh is closed, and whose
 * volume is what the scale predicts: the drawn volume times the three factors (the three scale the board's
 * three dimensions and nothing else, so the sum of what is cut is the product), and a share of its box that
 * a foam board has.
 */
import { buildRails, meshRails } from '@openshaper/board2';
import { describe, expect, it } from 'vitest';
import { measureRails, sizeRailsBoard } from './board-sizing';
import { BOARD_TYPES, DIMENSIONS, greatestSize, leastSize, type BoardType } from './board-types';
import { openEdges } from './test/mesh-closed';
import { templateRails } from './test/template-rails';

/** The share of its length by width by thickness a board's volume is: 0.52 to 0.55 for the starter templates. */
const FILL = { least: 0.45, greatest: 0.62 };

/** How far the volume may be from the scale's prediction. The measured difference is 0.1%. */
const VOLUME_TOLERANCE = 0.03;

const corners = BOARD_TYPES.flatMap((type) => [
  [type.name, 'least', type, leastSize(type)] as const,
  [type.name, 'greatest', type, greatestSize(type)] as const,
]);

describe('every kind of board opens at the least and the greatest size it allows', () => {
  it.each(corners)('%s at its %s size', async (name, _end, type: BoardType, size) => {
    const drawn = await templateRails(name);
    const drawnSize = measureRails(drawn);
    const built0 = buildRails(drawn);
    expect(built0.ok).toBe(true);
    if (!built0.ok) return;
    const drawnVolume = meshRails(built0.value).volume;

    const board = sizeRailsBoard(drawn, size);
    // the three numbers are the ones asked for
    const read = measureRails(board);
    for (const d of DIMENSIONS) expect(Math.abs(read[d] - size[d]), d).toBeLessThan(0.01);

    // it builds, with no issue and no coarsening
    const built = buildRails(board);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.issues).toEqual([]);
    const mesh = meshRails(built.value);
    expect(mesh.coarsened).toBeUndefined();

    // its mesh is closed, with every edge used once each way
    expect(openEdges(mesh.positions, mesh.indices)).toBe(0);

    // its volume is plausible
    const predicted =
      drawnVolume *
      (size.length / drawnSize.length) *
      (size.width / drawnSize.width) *
      (size.thickness / drawnSize.thickness);
    expect(Math.abs(mesh.volume / predicted - 1), `${type.name} volume`).toBeLessThan(
      VOLUME_TOLERANCE,
    );
    const fill = mesh.volume / (size.length * size.width * size.thickness);
    expect(fill).toBeGreaterThan(FILL.least);
    expect(fill).toBeLessThan(FILL.greatest);
  });
});
