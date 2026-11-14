// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * OCCT reads the rails board's STEP export (`trim/step.ts`) as one valid closed solid, judged as
 * `step.occt.test.ts` judges the sections board's: one solid, one shell, `isValid`, the B-rep's face,
 * edge and vertex counts; no tolerance growth past twice the declared uncertainty; GProp's volume a 5 %
 * sanity check (12 % on the asymmetric board, measured 10.8 %: see the test) and the volume of OCCT's own fine triangulation within area × deflection of our exact
 * one; a point inside the board inside and one far away outside. Run by `pnpm test:occt` (never by
 * `pnpm test`).
 *
 * Boards: the swallow (mirror, notch, vee and double concave), the asymmetric board (channels, both
 * halves different), the shortboard golden as it is and with a hard edge in the tail (a 0.5 mm tuck at
 * 30 degrees), the fish and the analytic board. The last three are also the default suite's slower
 * cases: their solids are checked here for the fit's tolerance and `checkBrep` too.
 */
import { checkBrep, massProperties, surfacePoint } from '@openshaper/geom';
import { maxShapeTolerance, OcctKernel, withCheckpoint } from '@openshaper/geom/testing/occt';
import type { ShapeHandle } from '@openshaper/geom/testing/occt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STEP_TOLERANCE } from '../params';
import { boardSet } from '../test-support/board-set';
import { analyticBoard, asymmetricBoard, fishBoard, swallowBoard } from '../testing';
import type { BuiltRails } from './native';
import { railsSolid, railsStep } from './step';
import { builtRails, hardTail, railsBoardOf } from './test-support/rails-step';

let kernel: OcctKernel;
let mark = 0;
beforeAll(async () => {
  kernel = await OcctKernel.init();
  mark = kernel.checkpoint();
});
afterAll(() => {
  kernel.releaseSince(mark);
});

const shortboard = () => railsBoardOf(boardSet().find((b) => b.name === 'shortboard')!.doc);

const BOARDS: readonly (readonly [string, () => BuiltRails])[] = [
  ['swallow', () => builtRails(railsBoardOf(swallowBoard()))],
  ['asymmetric (channels)', () => builtRails(railsBoardOf(asymmetricBoard()))],
  ['shortboard', () => builtRails(shortboard())],
  ['shortboard, hard edge in the tail', () => builtRails(hardTail(shortboard(), 60, 30))],
  ['fish', () => builtRails(railsBoardOf(fishBoard()))],
  ['analytic', () => builtRails(railsBoardOf(analyticBoard()))],
];

/** Deflection of the oracle mesh (mm) and the angular one (rad). */
const DEFLECTION_MM = 0.25;
const ANGULAR = 0.2;
/** GProp's volume against ours, as a fraction: the sanity bound, and the asymmetric board's (see below). */
const GPROP_SHARE = 0.05;
const GPROP_CHANNELS = 0.12;

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

describe('OCCT reads the rails board STEP as one valid closed solid', () => {
  for (const [name, make] of BOARDS) {
    it(name, () => {
      const built = make();
      const solid = railsSolid(built);
      expect(solid.report.withinTolerance).toBe(true);
      expect(solid.report.deviation).toBeLessThanOrEqual(STEP_TOLERANCE);
      expect(checkBrep(solid.brep).ok).toBe(true);
      const out = railsStep(built, { name: 'board', timestamp: '2026-01-01T00:00:00' });
      const mp = massProperties(solid.brep);
      const volumeMm3 = mp.volume.value * 1000;
      const areaMm2 = mp.area.value * 100;
      // a point in the middle of the board, midway between its deck and bottom panels
      const x = 0.5 * (built.xiMin + built.xiMax);
      const deck = surfacePoint(solid.deck, x, 0);
      const bottom = surfacePoint(solid.bottom, x, 0);
      const inside = { x: 10 * x, y: 0, z: 10 * 0.5 * (deck.z + bottom.z) };

      const facts = withCheckpoint(kernel, () => {
        const shape: ShapeHandle = kernel.importStep(out.text);
        const mesh = kernel.tessellate(shape, {
          linearDeflection: DEFLECTION_MM,
          angularDeflection: ANGULAR,
        });
        const body = kernel.getShapeType(shape) === 'solid' ? shape : null;
        return {
          valid: kernel.isValid(shape),
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
      // no healed gaps: OCCT's tolerances stay within twice the uncertainty the file declares (mm)
      expect(facts.grown).toBeLessThanOrEqual(2 * out.stats.uncertainty);
      // GProp is coarse on B-splines: a 5 % sanity check, as for the sections board. The asymmetric board's
      // channelled bottom (a 71 × 74 net, trimmed) reads 10.8 % over in GProp while OCCT's own fine mesh
      // is within 0.25 % of ours (the oracle, below): a known exception, held to what was measured.
      const gpropShare = name.startsWith('asymmetric') ? GPROP_CHANNELS : GPROP_SHARE;
      expect(Math.abs(facts.gprop - volumeMm3) / volumeMm3).toBeLessThan(gpropShare);
      // |mesh − exact| <= area × deflection (every mesh point is within the deflection of the surface)
      expect(Math.abs(facts.mesh - volumeMm3)).toBeLessThanOrEqual(areaMm2 * DEFLECTION_MM);
      expect(facts.inside).toBe(true);
      expect(facts.outside).toBe(false);
    });
  }
});
