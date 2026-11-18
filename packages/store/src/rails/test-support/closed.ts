// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Test-only: the engine's verdict on a rails document at either mesh quality, counting open edges
 * with a hash of the vertices where `boards.ts` builds a string for each. The count is the same
 * (`closed.test.ts` holds the two to each other): the vertices are welded on exact position and an
 * edge is open unless it is used once in each direction.
 */
import type { RailsBoard } from '@openshaper/board2';
import { buildRails, meshRails } from '@openshaper/board2';
import type { RailRecipe } from '../types';

/** Open edges of a mesh whose vertices are welded by exact position (board2's `checkClosed`). */
export function openEdgeCount(positions: Float32Array, indices: Uint32Array): number {
  const nv = positions.length / 3;
  // an open-addressing table of vertex ids by position; -0 and +0 are one place, as in a string key
  const size = 2 ** Math.ceil(Math.log2(Math.max(16, 2 * nv)));
  const table = new Int32Array(size).fill(-1);
  const probe = new Float32Array(3);
  const words = new Uint32Array(probe.buffer);
  const id = new Uint32Array(nv);
  for (let i = 0; i < nv; i++) {
    probe[0] = positions[3 * i]! + 0;
    probe[1] = positions[3 * i + 1]! + 0;
    probe[2] = positions[3 * i + 2]! + 0;
    let h =
      Math.imul(words[0]!, 0x9e3779b1) ^
      Math.imul(words[1]!, 0x85ebca6b) ^
      Math.imul(words[2]!, 0xc2b2ae35);
    h = (h ^ (h >>> 15)) >>> 0;
    let slot = h & (size - 1);
    for (;;) {
      const at = table[slot]!;
      if (at < 0) {
        table[slot] = i;
        id[i] = i;
        break;
      }
      if (
        positions[3 * at]! === positions[3 * i]! &&
        positions[3 * at + 1]! === positions[3 * i + 1]! &&
        positions[3 * at + 2]! === positions[3 * i + 2]!
      ) {
        id[i] = at;
        break;
      }
      slot = (slot + 1) & (size - 1);
    }
  }
  const edges = new Map<number, number>();
  for (let i = 0; i < indices.length; i += 3) {
    const a = id[indices[i]!]!;
    const b = id[indices[i + 1]!]!;
    const c = id[indices[i + 2]!]!;
    for (const key of [a * nv + b, b * nv + c, c * nv + a]) {
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  let open = 0;
  for (const [key, uses] of edges) {
    const u = Math.floor(key / nv);
    const v = key - u * nv;
    if (uses !== 1 || edges.get(v * nv + u) !== 1) open++;
  }
  return open;
}

/**
 * Whether the engine builds `doc` without issues (`buildRails`) and meshes it closed, at view
 * quality or with `draft`, with every vertex a number; and why not.
 */
export function closedVerdict(doc: RailsBoard, draft = false): { ok: boolean; why: string } {
  const built = buildRails(doc);
  if (!built.ok || built.issues.length > 0) {
    return { ok: false, why: `build: ${built.issues.map((i) => i.code).join(',')}` };
  }
  const mesh = meshRails(built.value, draft ? { draft: true } : {});
  for (let i = 0; i < mesh.positions.length; i++) {
    if (!Number.isFinite(mesh.positions[i]!)) return { ok: false, why: 'a vertex is not a number' };
  }
  const open = openEdgeCount(mesh.positions, mesh.indices);
  return { ok: open === 0, why: open === 0 ? '' : `${open} open edges` };
}

/**
 * `board` with `rail` held along its whole length, on both sides: one zone of two equal keys, at the
 * tail end and the nose end of the board.
 */
export function withRailAlong(board: RailsBoard, rail: RailRecipe): RailsBoard {
  const length = board.outline.plus.knots.at(-1)!.p[0]!;
  const keys = [
    { x: 0, rail },
    { x: length, rail },
  ];
  return {
    ...board,
    rails: board.rails.minus === undefined ? { plus: keys } : { plus: keys, minus: keys },
  };
}
