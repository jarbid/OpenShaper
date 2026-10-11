// SPDX-License-Identifier: GPL-3.0-or-later
import type { BoardMesh } from '@openshaper/kernel';
import { describe, expect, it } from 'vitest';
import type { CurvatureMesh } from './curvature-mesh';
import { handleWorkerRequest } from './worker-protocol';
import { stationBoard, swallowBoard } from './test-support/boards';

/**
 * Send a reply the way `postMessage` would: structured clone with the transfer
 * list. That throws on a duplicated or non-transferable buffer, and detaches every
 * buffer listed — so this proves the list is complete as well as legal.
 */
const deliver = <T>({ reply, transfer }: { reply: T; transfer: ArrayBuffer[] }) => {
  const received = structuredClone(reply, { transfer });
  for (const b of transfer) expect(b.byteLength).toBe(0);
  return received;
};

describe('tessellation worker protocol', () => {
  it('answers a mesh request with the mesh, every array transferred', () => {
    const handled = handleWorkerRequest({
      kind: 'mesh',
      id: 4,
      board: stationBoard(),
      targetFaceSize: 3,
    });
    expect(handled.transfer).toHaveLength(3);
    const reply = deliver(handled) as { id: number; result: BoardMesh };
    expect(reply.id).toBe(4);
    expect(reply.result.positions.length).toBeGreaterThan(0);
    expect(reply.result.indices.length % 3).toBe(0);
  });

  it('answers a curvature request with the analysis mesh, every array transferred', () => {
    const handled = handleWorkerRequest({ kind: 'curvature', id: 9, board: stationBoard() });
    expect(handled.transfer).toHaveLength(6);
    const reply = deliver(handled) as { id: number; result: CurvatureMesh };
    expect(reply.id).toBe(9);
    const m = reply.result;
    const verts = m.positions.length / 3;
    for (const a of [m.mean, m.gaussian, m.minRadius]) expect(a.length).toBe(verts);
    expect(m.scale.mean).toBeGreaterThan(0);
    expect(m.hullIndexCount).toBeGreaterThan(0);
  });

  it('reports a concave tail as an error for that job, so the queue moves on', () => {
    const handled = handleWorkerRequest({ kind: 'curvature', id: 11, board: swallowBoard() });
    expect(handled.transfer).toEqual([]);
    expect(handled.reply).toEqual({ id: 11, error: expect.stringMatching(/concave/) });
  });

  it('reports a board too degenerate to fit as an error', () => {
    const b = stationBoard();
    const flat = { ...b, crossSections: [] };
    const handled = handleWorkerRequest({ kind: 'curvature', id: 12, board: flat });
    expect('error' in handled.reply).toBe(true);
    expect(handled.reply.id).toBe(12);
  });
});
