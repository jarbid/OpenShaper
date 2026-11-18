// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The seams (`seams.ts`): their blocks and count on a small mesh worked by hand, and on the made
 * boards at the qualities the app meshes at, where every endpoint is checked against the mesh's
 * own vertex at the row it names, and the rows against the faces the engine gave them.
 */
import { describe, expect, it } from 'vitest';
import { analyticBoard, asymmetricBoard, fishBoard, swallowBoard } from '../testing';
import type { BoardDoc } from '../types';
import { convertSections } from './convert';
import { buildRails, meshRails, trimMeshOf } from './native';
import type { BuiltRails, MeshRailsOptions } from './native';
import { trimSeams } from './seams';
import type { SeamsSource } from './seams';
import { FACE } from './solid';

describe('the seams of a mesh worked by hand', () => {
  // 4 samples, 2 deck rows and 1 tuck row: a strip is 4 vertices (deck 0 and 1, tuck 2, apex 3),
  // so sample i's row r is vertex 4 * i + r. Vertex v sits at (3v + .5, 3v + 1.5, 3v + 2.5).
  const positions = Float32Array.from({ length: 48 }, (_, k) => k + 0.5);
  const source = (seg: readonly number[]): SeamsSource => ({
    positions,
    loop: { n: seg.length, seg: Uint16Array.from(seg) },
    deckRows: 2,
    tuckRows: 1,
  });
  const lines = (pairs: readonly (readonly [number, number])[]): Float32Array =>
    Float32Array.from(
      pairs.flatMap(([a, b]) => [
        ...[3 * a, 3 * a + 1, 3 * a + 2].map((k) => positions[k]!),
        ...[3 * b, 3 * b + 1, 3 * b + 2].map((k) => positions[k]!),
      ]),
    );

  it('runs the three rows round the closed loop, then a cross-seam down the last strip of each stretch', () => {
    // stretches 0 0 1 1: it changes after sample 1 and, round the loop, after sample 3
    const s = trimSeams(source([0, 0, 1, 1]));
    expect(s.bandEdges).toBe(8);
    expect(s.positions).toEqual(
      lines([
        // the deck's band edge (row 0), the tuck's (row 2), the apex line (row 3)
        [0, 4],
        [4, 8],
        [8, 12],
        [12, 0],
        [2, 6],
        [6, 10],
        [10, 14],
        [14, 2],
        [3, 7],
        [7, 11],
        [11, 15],
        [15, 3],
        // sample 1: the deck chain 0, 1, apex, then the tuck chain 2, apex
        [4, 5],
        [5, 7],
        [6, 7],
        // sample 3
        [12, 13],
        [13, 15],
        [14, 15],
      ]),
    );
    // 3n + c * (deckRows + tuckRows) segments
    expect(s.positions.length / 6).toBe(3 * 4 + 2 * (2 + 1));
  });

  it('is the three rows alone on a loop of one stretch', () => {
    const s = trimSeams(source([0, 0, 0, 0]));
    expect(s.positions.length / 6).toBe(12);
    expect(s.bandEdges).toBe(8);
  });

  it('marks the stretch that ends where the loop closes', () => {
    // 0 0 0 1: the change is between the last sample and the first, and between 2 and 3
    const s = trimSeams(source([0, 0, 0, 1]));
    expect(s.positions.length / 6).toBe(12 + 2 * 3);
  });

  it('draws nothing for a loop that encloses nothing', () => {
    expect(trimSeams(source([0, 1])).positions).toHaveLength(0);
    expect(trimSeams(source([])).bandEdges).toBe(0);
  });
});

const QUALITIES: readonly [string, MeshRailsOptions][] = [
  ['view', {}],
  ['draft', { draft: true }],
  ['stl 1 cm', { maxEdge: 1 }],
];

function builtOf(doc: BoardDoc): BuiltRails {
  const converted = convertSections(doc);
  if (!converted.ok) throw new Error(converted.issues.map((i) => i.message).join('; '));
  const built = buildRails(converted.value.board);
  if (!built.ok) throw new Error(built.issues.map((i) => i.message).join('; '));
  return built.value;
}

const BOARDS: readonly [string, () => BoardDoc, minChanges: number][] = [
  ['analytic', analyticBoard, 0],
  ['swallow', swallowBoard, 1],
  ['fish', fishBoard, 1],
  ['asymmetric', asymmetricBoard, 0],
];

describe.each(BOARDS)('the seams of the %s board', (_name, make, minChanges) => {
  const built = builtOf(make());

  it.each(QUALITIES)(
    '%s: its count, and every endpoint a vertex of the mesh at the row named',
    (_q, opts) => {
      const mesh = trimMeshOf(built, opts);
      const { positions: p, loop, deckRows: nt, tuckRows: nb } = mesh;
      const n = loop.n;
      const per = nt + nb + 1;
      // the stretch changes, counted here from the loop's own stretches
      const ends: number[] = [];
      for (let i = 0; i < n; i++) if (loop.seg[i] !== loop.seg[(i + 1) % n]) ends.push(i);
      expect(ends.length).toBeGreaterThanOrEqual(minChanges);

      const seams = trimSeams(mesh);
      const out = seams.positions;
      expect(out.length).toBe(6 * (3 * n + ends.length * (nt + nb)));
      expect(seams.bandEdges).toBe(2 * n);

      // segment `s` runs from vertex `a` to vertex `b`: its six numbers are the mesh's, to the bit
      let wrong = 0;
      const check = (s: number, a: number, b: number): void => {
        for (let k = 0; k < 3; k++) {
          if (out[6 * s + k] !== p[3 * a + k]) wrong++;
          if (out[6 * s + 3 + k] !== p[3 * b + k]) wrong++;
        }
      };
      [0, nt, nt + nb].forEach((row, block) => {
        for (let i = 0; i < n; i++) {
          check(block * n + i, per * i + row, per * ((i + 1) % n) + row);
        }
      });
      ends.forEach((i, k) => {
        let s = 3 * n + k * (nt + nb);
        for (let j = 0; j < nt; j++)
          check(s++, per * i + j, per * i + (j + 1 < nt ? j + 1 : nt + nb));
        for (let j = 0; j < nb; j++) {
          check(s++, per * i + nt + j, per * i + (j + 1 < nb ? nt + j + 1 : nt + nb));
        }
      });
      expect(wrong).toBe(0);

      // the rows are what the seams say they are: a blend on the deck side down to the apex, the tuck
      // below it, and the apex takes the blend's face
      let misplaced = 0;
      for (let i = 0; i < n; i++) {
        const blend = mesh.vertexFace[per * i]!;
        if (blend !== FACE.rail && blend !== FACE.tail && blend !== FACE.corner) misplaced++;
        for (let r = 0; r < nt; r++) if (mesh.vertexFace[per * i + r] !== blend) misplaced++;
        for (let r = nt; r < nt + nb; r++) {
          if (mesh.vertexFace[per * i + r] !== blend + FACE.tuck) misplaced++;
        }
        if (mesh.vertexFace[per * i + nt + nb] !== blend) misplaced++;
      }
      expect(misplaced).toBe(0);
    },
  );

  it('come with the mesh `meshRails` returns, and leave the rest of it alone', () => {
    const m = meshRails(built, { draft: true });
    const mesh = trimMeshOf(built, { draft: true });
    expect(m.seams).toEqual(trimSeams(mesh));
    expect(m.positions).toEqual(mesh.positions);
    expect(m.indices).toEqual(mesh.indices);
    expect(m.face).toEqual(mesh.vertexFace);
  });
});
