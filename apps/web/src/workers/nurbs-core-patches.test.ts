// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The patch of every vertex, from the rails engine's faces to the mesh the 3D view gets: which
 * jobs carry it, what its ids are, that it travels with the other buffers, and that the seam
 * lines it draws over the surface come with it.
 */
import { FACE, type BoardDoc } from '@openshaper/board2';
import { analyticBoard, asymmetricBoard, swallowBoard } from '@openshaper/board2/testing';
import { PATCH, TUCK, isTuckId, patchOfId } from '@openshaper/render3d/patches';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { meshDocument, resetCore } from './nurbs-core';
import { meshTransferables, type JobOptions } from './nurbs-protocol';
import { patchesOfFaces, patchTable } from './patch-map';

vi.setConfig({ testTimeout: 30_000 });

const DRAG: JobOptions = { curvature: false, deviation: false, reuseLadders: true };

const meshOf = (doc: BoardDoc, engine?: 'rails') => {
  const out = meshDocument(doc, null, { ...DRAG, ...(engine ? { engine } : {}) });
  if (!out.ok) throw new Error(out.error);
  return out.mesh;
};

beforeEach(() => resetCore());

describe('patchesOfFaces', () => {
  it('maps every face of the engine to a patch id, a tuck being its blend with the tuck bit added', () => {
    const faces = Uint8Array.from([
      FACE.deck,
      FACE.bottom,
      FACE.rail,
      FACE.rail + FACE.tuck,
      FACE.tail,
      FACE.tail + FACE.tuck,
      FACE.corner,
      FACE.corner + FACE.tuck,
    ]);
    expect([...patchesOfFaces(faces, patchTable(FACE))]).toEqual([
      PATCH.deck,
      PATCH.bottom,
      PATCH.rail,
      PATCH.rail + TUCK,
      PATCH.tailEdge,
      PATCH.tailEdge + TUCK,
      PATCH.corner,
      PATCH.corner + TUCK,
    ]);
  });
});

describe.each([
  ['swallow', swallowBoard],
  ['analytic', analyticBoard],
  ['asymmetric', asymmetricBoard],
])('the mesh job on the %s board', (_name, make) => {
  it('carries a patch for every vertex from the rails engine, and the board has all of them', () => {
    const m = meshOf(make(), 'rails');
    expect(m.patch).not.toBeNull();
    expect(m.patch!.length).toBe(m.positions.length / 3);
    const seen = new Set(m.patch);
    for (const p of [PATCH.deck, PATCH.bottom, PATCH.rail, PATCH.corner]) {
      expect(seen.has(p), `patch ${p}`).toBe(true);
    }
    for (const p of seen) expect(patchOfId(p)).toBeLessThanOrEqual(PATCH.corner);
  });

  it('marks the tuck of a rail and of a corner, and only of those that have one', () => {
    const m = meshOf(make(), 'rails');
    const seen = new Set(m.patch);
    expect(seen.has(PATCH.rail + TUCK)).toBe(true);
    expect(seen.has(PATCH.corner + TUCK)).toBe(true);
    // the panels have no tuck
    expect(seen.has(PATCH.deck + TUCK)).toBe(false);
    expect(seen.has(PATCH.bottom + TUCK)).toBe(false);
    // a strip's tuck rows lie below its blend rows: rail tuck vertices are lower on average
    const meanZ = (pick: (id: number) => boolean): number => {
      let sum = 0;
      let n = 0;
      m.patch!.forEach((id, i) => {
        if (pick(id)) {
          sum += m.positions[3 * i + 2]!;
          n++;
        }
      });
      return sum / n;
    };
    const rail = (id: number) => patchOfId(id) === PATCH.rail;
    expect(meanZ((id) => rail(id) && isTuckId(id))).toBeLessThan(
      meanZ((id) => rail(id) && !isTuckId(id)),
    );
  });

  it('puts the deck above the bottom and a rail between them', () => {
    const m = meshOf(make(), 'rails');
    const zAt = (patch: number): number => {
      let sum = 0;
      let n = 0;
      m.patch!.forEach((p, i) => {
        if (patchOfId(p) === patch) {
          sum += m.positions[3 * i + 2]!;
          n++;
        }
      });
      return sum / n;
    };
    expect(zAt(PATCH.deck)).toBeGreaterThan(zAt(PATCH.rail));
    expect(zAt(PATCH.rail)).toBeGreaterThan(zAt(PATCH.bottom));
  });

  it('has none from the sections engine', () => {
    const m = meshOf(make());
    expect(m.patch).toBeNull();
  });

  it('transfers the patch with the other buffers', () => {
    const m = meshOf(make(), 'rails');
    expect(meshTransferables(m)).toContain(m.patch!.buffer);
    expect(meshTransferables(meshOf(make()))).toHaveLength(3);
  });

  it("carries the engine's seams, every endpoint a vertex of the mesh, and none from the sections engine", () => {
    const m = meshOf(make(), 'rails');
    const seams = m.seams!;
    expect(seams.positions.length).toBeGreaterThan(0);
    expect(seams.positions.length % 6).toBe(0);
    expect(seams.bandEdges).toBeGreaterThan(0);
    expect(6 * seams.bandEdges).toBeLessThan(seams.positions.length);
    const vertices = new Set<string>();
    for (let i = 0; i < m.positions.length; i += 3) {
      vertices.add(`${m.positions[i]},${m.positions[i + 1]},${m.positions[i + 2]}`);
    }
    let strays = 0;
    for (let i = 0; i < seams.positions.length; i += 3) {
      const key = `${seams.positions[i]},${seams.positions[i + 1]},${seams.positions[i + 2]}`;
      if (!vertices.has(key)) strays++;
    }
    expect(strays).toBe(0);
    expect(meshOf(make()).seams).toBeNull();
  });

  it('transfers the seams with the other buffers', () => {
    const m = meshOf(make(), 'rails');
    expect(meshTransferables(m)).toContain(m.seams!.positions.buffer);
  });
});

describe('the tail edge', () => {
  it("is a patch of its own, with its tuck, on a board with a swallow's notch", () => {
    const seen = new Set(meshOf(swallowBoard(), 'rails').patch);
    expect(seen.has(PATCH.tailEdge)).toBe(true);
    expect(seen.has(PATCH.tailEdge + TUCK)).toBe(true);
  });
});
