// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The patch of every vertex, from the rails engine's faces to the mesh the 3D view gets: which
 * jobs carry it, what its ids are, that it travels with the other buffers, and that the rail
 * keys the Patches look draws its zones from come with it.
 */
import { FACE, convertSections, type BoardDoc } from '@openshaper/board2';
import { analyticBoard, asymmetricBoard, swallowBoard } from '@openshaper/board2/testing';
import { PATCH } from '@openshaper/render3d/patches';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { meshDocument, resetCore } from './nurbs-core';
import { meshTransferables, type JobOptions } from './nurbs-protocol';
import { patchesOfFaces, patchTable, railKeyPlaces } from './patch-map';

vi.setConfig({ testTimeout: 30_000 });

const DRAG: JobOptions = { curvature: false, deviation: false, reuseLadders: true };

const meshOf = (doc: BoardDoc, engine?: 'rails') => {
  const out = meshDocument(doc, null, { ...DRAG, ...(engine ? { engine } : {}) });
  if (!out.ok) throw new Error(out.error);
  return out.mesh;
};

beforeEach(() => resetCore());

describe('patchesOfFaces', () => {
  it('maps every face of the engine to a patch, a rail blend and its tuck being one patch', () => {
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
      PATCH.rail,
      PATCH.tailEdge,
      PATCH.tailEdge,
      PATCH.corner,
      PATCH.corner,
    ]);
  });
});

describe('railKeyPlaces', () => {
  it('lists the x of each key per side, the minus side only when there is one', () => {
    expect(railKeyPlaces({ plus: [{ x: 1 }, { x: 5 }] })).toEqual({ plus: [1, 5] });
    expect(railKeyPlaces({ plus: [{ x: 1 }], minus: [{ x: 2 }] })).toEqual({
      plus: [1],
      minus: [2],
    });
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
    for (const p of seen) expect(p).toBeLessThanOrEqual(PATCH.corner);
  });

  it('puts the deck above the bottom and a rail between them', () => {
    const m = meshOf(make(), 'rails');
    const zAt = (patch: number): number => {
      let sum = 0;
      let n = 0;
      m.patch!.forEach((p, i) => {
        if (p === patch) {
          sum += m.positions[3 * i + 2]!;
          n++;
        }
      });
      return sum / n;
    };
    expect(zAt(PATCH.deck)).toBeGreaterThan(zAt(PATCH.rail));
    expect(zAt(PATCH.rail)).toBeGreaterThan(zAt(PATCH.bottom));
  });

  it("gives the rail keys of the rails board, as the document's keys sit", () => {
    const doc = make();
    const m = meshOf(doc, 'rails');
    const c = convertSections(doc);
    if (!c.ok) throw new Error('not convertible');
    expect(m.railKeys).toEqual(railKeyPlaces(c.value.board.rails));
    expect(m.railKeys!.plus.length).toBeGreaterThan(0);
  });

  it('has none from the sections engine', () => {
    const m = meshOf(make());
    expect(m.patch).toBeNull();
    expect(m.railKeys).toBeNull();
  });

  it('transfers the patch with the other buffers', () => {
    const m = meshOf(make(), 'rails');
    expect(meshTransferables(m)).toContain(m.patch!.buffer);
    expect(meshTransferables(meshOf(make()))).toHaveLength(3);
  });
});
