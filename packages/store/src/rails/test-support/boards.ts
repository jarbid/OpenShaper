// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Test-only: rails boards converted from the section store's test documents (a mirror golden
 * shortboard, an asymmetric board, a swallow and a fish), and the engine's verdict on a document:
 * whether `buildRails` accepts it and its mesh is closed.
 */
import type { RailsBoard } from '@openshaper/board2';
import { buildRails, convertSections, meshRails } from '@openshaper/board2';
import { asymmetricBoard, fishBoard, swallowBoard } from '@openshaper/board2/testing';
import { goldenDoc } from '../../sections/test-support/docs';

const cache = new Map<string, RailsBoard>();

function converted(name: string, make: () => Parameters<typeof convertSections>[0]): RailsBoard {
  let b = cache.get(name);
  if (b === undefined) {
    const r = convertSections(make());
    if (!r.ok) throw new Error(`${name}: ${r.issues.map((i) => i.message).join('; ')}`);
    b = r.value.board;
    cache.set(name, b);
  }
  return b;
}

/** The test boards, by name: each call returns the same converted object. */
export const railsBoards: readonly [string, () => RailsBoard][] = [
  ['mirror', () => converted('mirror', () => goldenDoc('shortboard'))],
  ['asymmetric', () => converted('asymmetric', asymmetricBoard)],
  ['swallow', () => converted('swallow', swallowBoard)],
  ['fish', () => converted('fish', fishBoard)],
];

export const railsBoard = (name: string): RailsBoard => railsBoards.find(([n]) => n === name)![1]();

/**
 * Open edges of a mesh, its vertices welded by exact position (board2's `checkClosed`, over the
 * mesh `meshRails` returns).
 */
export function openEdges(positions: Float32Array, indices: Uint32Array): number {
  const nv = positions.length / 3;
  const place = new Map<string, number>();
  const id = new Uint32Array(nv);
  for (let i = 0; i < nv; i++) {
    const key = `${positions[3 * i]!},${positions[3 * i + 1]!},${positions[3 * i + 2]!}`;
    const first = place.get(key);
    if (first === undefined) place.set(key, i);
    id[i] = first ?? i;
  }
  const edges = new Map<number, number>();
  for (let i = 0; i < indices.length; i += 3) {
    const a = id[indices[i]!]!;
    const b = id[indices[i + 1]!]!;
    const c = id[indices[i + 2]!]!;
    for (const key of [a * nv + b, b * nv + c, c * nv + a])
      edges.set(key, (edges.get(key) ?? 0) + 1);
  }
  let open = 0;
  for (const [key, uses] of edges) {
    const u = Math.floor(key / nv);
    const v = key - u * nv;
    if (uses !== 1 || edges.get(v * nv + u) !== 1) open++;
  }
  return open;
}

/** Whether the engine builds `doc` without issues and meshes it closed (draft quality); the reason if not. */
export function engineVerdict(doc: RailsBoard): { ok: boolean; why: string; volume: number } {
  const r = buildRails(doc);
  if (!r.ok) return { ok: false, why: r.issues.map((i) => i.code).join(','), volume: 0 };
  const m = meshRails(r.value, { draft: true });
  const open = openEdges(m.positions, m.indices);
  return { ok: open === 0, why: open === 0 ? '' : `${open} open edges`, volume: m.volume };
}
