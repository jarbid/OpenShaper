// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The fast open-edge count against the string-keyed one the store's tests already use, on closed
 * meshes and on the same meshes with triangles taken out.
 */
import { buildRails, meshRails } from '@openshaper/board2';
import { describe, expect, it } from 'vitest';
import { openEdges, railsBoards } from './boards';
import { closedVerdict, openEdgeCount } from './closed';

describe('openEdgeCount', () => {
  it.each(railsBoards)('agrees with openEdges on the %s board, closed and opened', (_n, make) => {
    const board = make();
    const built = buildRails(board);
    if (!built.ok) throw new Error('build');
    const mesh = meshRails(built.value, { draft: true });
    expect(openEdgeCount(mesh.positions, mesh.indices)).toBe(0);
    expect(openEdges(mesh.positions, mesh.indices)).toBe(0);
    // take triangles out: the two counts must agree on how many edges that opens
    for (const every of [997, 211, 53]) {
      const kept: number[] = [];
      for (let t = 0; t < mesh.indices.length; t += 3) {
        if ((t / 3) % every === 0) continue;
        kept.push(mesh.indices[t]!, mesh.indices[t + 1]!, mesh.indices[t + 2]!);
      }
      const holes = Uint32Array.from(kept);
      const slow = openEdges(mesh.positions, holes);
      expect(slow).toBeGreaterThan(0);
      expect(openEdgeCount(mesh.positions, holes)).toBe(slow);
    }
    // a vertex stored twice at one place is one vertex; at -0 and +0 too
    const doubled = new Float32Array(mesh.positions.length + 3);
    doubled.set(mesh.positions);
    doubled.set(mesh.positions.subarray(0, 3), mesh.positions.length);
    expect(openEdgeCount(doubled, mesh.indices)).toBe(0);
  });

  it('says why a board is not accepted', () => {
    const board = railsBoards[0]![1]();
    expect(closedVerdict(board).ok).toBe(true);
    const bad = closedVerdict({ ...board, rails: { plus: [] } });
    expect(bad.ok).toBe(false);
    expect(bad.why).toMatch(/^build:/);
  });
});
