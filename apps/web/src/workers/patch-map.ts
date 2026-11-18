// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The rails engine's faces as the 3D view's patches. The engine marks each mesh vertex with the
 * part of the board it belongs to (`FACE`: the deck panel, the bottom panel, and a deck blend
 * or a tuck each along a side, a tail's straight edge or round a corner); to a shaper those are
 * five patches (render3d `patches.ts`). A rail's deck blend and its tuck are one patch, and the
 * tuck's id says so with the `TUCK` bit, which the Patches look shades.
 *
 * Only the worker modules import board2 at run time, so `FACE` is passed in by `nurbs-core.ts`.
 */
import type { FACE as BoardFaces } from '@openshaper/board2';
import { PATCH, TUCK } from '@openshaper/render3d/patches';

/** The patch id of every face value, built from the engine's `FACE` table: a tuck's is its blend's plus `TUCK`. */
export const patchTable = (FACE: typeof BoardFaces): ReadonlyMap<number, number> =>
  new Map([
    [FACE.deck, PATCH.deck],
    [FACE.bottom, PATCH.bottom],
    [FACE.rail, PATCH.rail],
    [FACE.rail + FACE.tuck, PATCH.rail + TUCK],
    [FACE.tail, PATCH.tailEdge],
    [FACE.tail + FACE.tuck, PATCH.tailEdge + TUCK],
    [FACE.corner, PATCH.corner],
    [FACE.corner + FACE.tuck, PATCH.corner + TUCK],
  ]);

/** The patch id of every vertex, from the engine's per-vertex faces. A face with no patch reads as the rail. */
export function patchesOfFaces(face: Uint8Array, table: ReadonlyMap<number, number>): Uint8Array {
  const out = new Uint8Array(face.length);
  for (let i = 0; i < face.length; i++) out[i] = table.get(face[i]!) ?? PATCH.rail;
  return out;
}
