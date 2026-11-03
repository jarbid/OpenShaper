// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The one OCCT check of the board's STEP export (docs/design/m3-exports.md, step 2): the files our export
 * writes, through `occt-wasm` (OpenCascade compiled to WebAssembly) by the protocol module of
 * `@openshaper/geom`. Run by `pnpm test:occt` (never by `pnpm test`). OCCT's STEP reader heals silently, so
 * "imports" proves little; each file is judged as the protocol does:
 *
 * - one solid, one shell, `isValid` (BRepCheck_Analyzer), and the face, edge and vertex counts of the B-rep;
 * - no tolerance growth: the largest vertex or edge tolerance OCCT ends up with is at most twice the
 *   uncertainty the file declares;
 * - the volume of OCCT's own fine triangulation within its bound of our exact mass-properties volume (GProp's
 *   own volume is coarse on B-spline solids, so it is a 1 % sanity check only);
 * - a point inside the board is inside and a point far outside is outside (the solid is outward).
 *
 * Boards: the shortboard golden, the swallow (vee and double concave, notched tail) and the asymmetric board
 * (channels, both halves different).
 */
import { massProperties, surfacePoint } from '@openshaper/geom';
import { maxShapeTolerance, OcctKernel, withCheckpoint } from '@openshaper/geom/testing/occt';
import type { ShapeHandle } from '@openshaper/geom/testing/occt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boardSolid, boardStep } from './step';
import { asymmetricBoard, swallowBoard } from './testing';
import { boardSet, buildOrThrow } from './test-support/board-set';

let kernel: OcctKernel;
let mark = 0;
beforeAll(async () => {
  kernel = await OcctKernel.init();
  mark = kernel.checkpoint();
});
afterAll(() => {
  kernel.releaseSince(mark);
});

const BOARDS = [
  ['shortboard', () => boardSet().find((b) => b.name === 'shortboard')!.doc],
  ['swallow', swallowBoard],
  ['asymmetric (channels)', asymmetricBoard],
] as const;

/** Deflection of the oracle mesh (mm) and the angular one (rad). */
const DEFLECTION_MM = 0.25;
const ANGULAR = 0.2;

const meshVolume = (positions: Float32Array, indices: Uint32Array): number => {
  let v = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 3;
    const b = indices[t + 1]! * 3;
    const c = indices[t + 2]! * 3;
    const [ax, ay, az] = [positions[a]!, positions[a + 1]!, positions[a + 2]!];
    const [bx, by, bz] = [positions[b]!, positions[b + 1]!, positions[b + 2]!];
    const [cx, cy, cz] = [positions[c]!, positions[c + 1]!, positions[c + 2]!];
    v += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
};

describe('OCCT reads the board STEP as one valid closed solid', () => {
  for (const [name, make] of BOARDS) {
    it(name, () => {
      const built = buildOrThrow(make());
      const solid = boardSolid(built);
      const out = boardStep(built, { name: 'board', timestamp: '2026-01-01T00:00:00' });
      const mp = massProperties(solid.brep);
      const volumeMm3 = mp.volume.value * 1000;
      const areaMm2 = mp.area.value * 100;
      // a point on the stringer in the middle of the board, midway through its thickness
      const mid = solid.plus.u.domain[1] * 0.5;
      const bottom = surfacePoint(solid.plus, mid, 0);
      const deck = surfacePoint(solid.plus, mid, 1);
      const inside = { x: 10 * bottom.x, y: 0, z: 10 * 0.5 * (bottom.z + deck.z) };

      const facts = withCheckpoint(kernel, () => {
        const shape: ShapeHandle = kernel.importStep(out.text);
        const valid0 = kernel.isValid(shape);
        const mesh = kernel.tessellate(shape, {
          linearDeflection: DEFLECTION_MM,
          angularDeflection: ANGULAR,
        });
        const body = kernel.getShapeType(shape) === 'solid' ? shape : null;
        return {
          type: kernel.getShapeType(shape),
          valid: valid0,
          solids: kernel.subShapeCount(shape, 'solid'),
          shells: kernel.subShapeCount(shape, 'shell'),
          faces: kernel.subShapeCount(shape, 'face'),
          edges: kernel.subShapeCount(shape, 'edge'),
          vertices: kernel.subShapeCount(shape, 'vertex'),
          grown: maxShapeTolerance(kernel.toBREP(shape)),
          gprop: kernel.getVolume(shape),
          mesh: meshVolume(mesh.positions, mesh.indices),
          inside: body ? kernel.containsPoint(body, inside) : null,
          outside: body ? kernel.containsPoint(body, { x: 1e4, y: 1e4, z: 1e4 }) : null,
        };
      });
      expect(facts.valid).toBe(true);
      expect(facts.solids).toBe(1);
      expect(facts.shells).toBe(1);
      expect(facts.faces).toBe(solid.brep.faces.length);
      expect(facts.vertices).toBe(solid.brep.vertices.length);
      expect(facts.edges).toBe(solid.brep.edges.length);
      // no healed gaps: OCCT's tolerances stay within twice the uncertainty the file declares (file units: mm)
      expect(facts.grown).toBeLessThanOrEqual(2 * out.stats.uncertainty);
      // GProp is coarse on B-splines: a 5 % sanity check (2.5 % measured on the channel board); the mesh is the oracle
      expect(Math.abs(facts.gprop - volumeMm3) / volumeMm3).toBeLessThan(0.05);
      // |mesh − exact| <= area × deflection (every mesh point is within the deflection of the surface)
      expect(Math.abs(facts.mesh - volumeMm3)).toBeLessThanOrEqual(areaMm2 * DEFLECTION_MM);
      if (facts.inside !== null) {
        expect(facts.inside).toBe(true);
        expect(facts.outside).toBe(false);
      }
    });
  }
});
