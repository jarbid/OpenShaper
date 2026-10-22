// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The board through OpenCascade (docs/design/board2.md §7, step S4): geom's
 * OCCT protocol (`@openshaper/geom/testing/occt`, geom-core.md §15.3, §15.6)
 * on the built stadium board. Run by `pnpm --filter @openshaper/board2
 * test:occt` (and the root `pnpm test:occt`), not by `pnpm test`.
 *
 * - **Path B** (our STEP file through OCCT's STEP reader, file units mm and
 *   cm): B1 one solid, B2 `isValid`, B3 counts equal to `StepStats`, B4 no
 *   tolerance growth beyond twice the declared uncertainty, B5 / B6 every edge
 *   and surface equal to ours parameter by parameter, B8 volume.
 * - **Volume against an independent oracle.** The exact volume is
 *   `flatBoardVolume` (`testing/volume.ts`: the divergence theorem on the flat
 *   stadium, Gauss–Legendre exact per patch, point evaluations only, nothing of
 *   geom's trimmed integration). Two judges compare with it: OCCT's own
 *   triangulation of the imported solid (its error bounded by the band's area ×
 *   the deflection, planar faces meshing exactly), and our `massProperties`
 *   (1e-10 relative). GProp's `getVolume` is a 1 % sanity check only (§15.2).
 * - **Path A** (the unhealed native BREP, `fromBREP`): valid as built, every
 *   tolerance the one written, encodings, outward volume; **B7**: GProp's
 *   volume of Path A equals that of Path B in mm and in cm to 1e-9 relative.
 * - **Orientation oracles** (§15.6): every face flipped in the shell and every
 *   edge use of the first wire flipped is refused by `BRepCheck`; the board
 *   turned inside out is "valid" with exactly the negated volume (and the STEP
 *   reader re-orients it); every geometry or orientation mutation `checkBrep`
 *   refuses, OCCT refuses unhealed too.
 */
import { checkBrep, massProperties } from '@openshaper/geom';
import {
  B7_REL,
  MESH_BOUND_MAX_REL,
  OcctKernel,
  orientationControls,
  pathA,
  pathB,
  refused,
} from '@openshaper/geom/testing/occt';
import type { ImportFacts, MeshVolumeCheck, OcctSolid } from '@openshaper/geom/testing/occt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildBoard } from './build';
import { bandArea, flatBoardVolume, stadiumBoard, stadiumFacts } from './testing';
import type { BuiltBoard } from './types';

let kernel: OcctKernel;
let mark = 0;
beforeAll(async () => {
  kernel = await OcctKernel.init();
  mark = kernel.checkpoint();
});
afterAll(() => {
  kernel.releaseSince(mark);
});

/** The stadium: 188.7 × 50 cm plan, flat deck 6 cm above a flat bottom, default laws. */
const THICKNESS = 6;
const board: BuiltBoard = (() => {
  const r = buildBoard(stadiumBoard({ thickness: THICKNESS }));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
})();

/**
 * The board as a protocol solid. Volume: the independent oracle. Areas (for the mesh
 * bound only): the flat faces are the plan areas inside the rows; the band, the only
 * curved face, by 16-point Gauss–Legendre per patch (smooth integrand: converged far
 * below the bound's needs). Extent: |p| ≤ hypot(length, half-width, thickness).
 */
const solid: OcctSolid = (() => {
  const o = flatBoardVolume(board, THICKNESS, 0);
  const curved = bandArea(board.band, 16);
  const f = stadiumFacts();
  return {
    name: 'board2-stadium',
    volume: o.volume,
    area: o.deckArea + o.bottomArea + curved,
    curved,
    inside: [90, 0, THICKNESS / 2],
    extent: Math.hypot(f.length, f.width / 2, THICKNESS),
    // 0.01 mm meshes the 4,000 cm² band into far more triangles than the bound needs;
    // 0.03 mm keeps the bound near 2e-4 of the volume (geom's V5b setting).
    deflectionMm: 0.03,
  };
})();

/**
 * GProp's own volume (`getVolume`, no epsilon) is a sanity check only (§15.2): the
 * protocol's 1 % (`GPROP_SANITY_REL`) held on geom's corpus, but on the board GProp is
 * 2.23 % high (measured, both paths and units alike, which B7 pins), so the check here is
 * 3 %: GProp integrates the trimmed planar deck and bottom with a fixed rule per surface
 * span, and their trims (the rows, ~200 control points) cross every span. The accuracy
 * oracles are the mesh volume and massProperties against the independent volume; S4
 * deviation 8 in board2.md records this.
 */
const GPROP_BOARD_REL = 0.03;

/**
 * The one checkBrep mutation OCCT's unhealed check misses on the board (pinned):
 * `corrupt a weight` scales the deck's far-corner control point. On the flat deck that
 * moves surface points only within the plane and only in the corner patch, which the deck
 * edge crosses near the nose for a few percent of its 4 m. `BRepCheck` samples the
 * same-parameter deviation of an edge at 23 parameters (geom-core.md §15.7), so it does not
 * land there; our dense, knot-aware check does.
 */
const OCCT_MISSES = new Set(['corrupt a weight']);

function expectImport(r: ImportFacts): void {
  expect(r.type).toBe('solid');
  expect(r.valid, 'BRepCheck_Analyzer').toBe(true);
  expect(r.solids).toBe(1);
  expect(r.shells).toBe(1);
  expect([r.faces, r.edges, r.vertices]).toEqual([3, 3, 2]);
  expect(r.unmatchedEdges, 'B5').toEqual([]);
  expect(r.unmatchedFaces, 'B6').toBe(0);
  expect(r.contains).toEqual({ inside: true, outside: false });
}

function expectMesh(m: MeshVolumeCheck): void {
  expect(m.volume, 'a negative mesh volume means an inside-out solid').toBeGreaterThan(0);
  expect(Math.abs(m.volume - m.exact), `mesh ${m.volume} vs exact ${m.exact}`).toBeLessThanOrEqual(
    m.bound,
  );
  expect(m.bound / m.exact).toBeLessThan(MESH_BOUND_MAX_REL);
}

describe('the stadium board through OCCT', () => {
  it('our own volume agrees with the independent oracle (1e-10 relative)', () => {
    expect(checkBrep(board.brep).ok).toBe(true);
    const m = massProperties(board.brep);
    expect(Math.abs(m.volume.value - solid.volume)).toBeLessThanOrEqual(1e-10 * solid.volume);
  });

  for (const fileUnit of ['mm', 'cm'] as const) {
    it(`Path B (${fileUnit}): one valid solid, exact encoding, volume within the mesh bound`, () => {
      const r = pathB(kernel, board.brep, solid, fileUnit);
      expectImport(r);
      expect([r.stats.faces, r.stats.edges, r.stats.vertices]).toEqual([3, 3, 2]);
      expect(r.grownMm, 'B4').toBeLessThanOrEqual(2 * r.declaredMm);
      expect(Math.abs(r.gpropVolume / (solid.volume * 1000) - 1)).toBeLessThan(GPROP_BOARD_REL);
      expectMesh(r.mesh);
    });
  }

  it('Path A: valid unhealed, as written, outward; B7 equal to Path B in mm and cm', () => {
    const r = pathA(kernel, board.brep, solid);
    expect(r.tolerance).toBe(r.stepUncertainty);
    expect(r.shapeType).toBe('solid');
    expectImport(r);
    expect(r.grownMm, 'nothing healed: every tolerance is the one written').toBeCloseTo(
      r.tolerance,
      15,
    );
    expect(r.gpropVolume, 'outward').toBeGreaterThan(0);
    expect(Math.abs(r.gpropVolume / (solid.volume * 1000) - 1)).toBeLessThan(GPROP_BOARD_REL);
    for (const unit of ['mm', 'cm'] as const) {
      expect(Math.abs(r.b7[unit] - r.gpropVolume), `B7 ${unit}`).toBeLessThanOrEqual(
        B7_REL * r.gpropVolume,
      );
    }
    expectMesh(r.mesh);
  });

  it('orientation oracles: flipped faces and edge uses refused, inside out only by its sign', () => {
    const c = orientationControls(kernel, board.brep);
    const ref = c.reference;
    expect(refused(ref)).toBe(false);
    expect(c.uncheckedSameText).toBe(true);
    expect(c.faceFlips.length).toBe(3);
    c.faceFlips.forEach((v, k) => {
      expect(v.valid, `face ${k} flipped: ${JSON.stringify(v)}`).toBe(false);
      expect(Math.abs(v.volume - ref.volume)).toBeGreaterThan(B7_REL * ref.volume);
    });
    // The first wire is the deck's: one closed edge use.
    expect(c.edgeFlips.length).toBe(board.brep.faces[0]!.outer.coedges.length);
    c.edgeFlips.forEach((v, k) => expect(v.valid, `edge use ${k} flipped`).toBe(false));
    expect(c.insideOutCheckOk).toBe(false);
    expect(c.insideOut.valid).toBe(true);
    expect(c.insideOut.volume).toBe(-ref.volume);
    expect(refused(c.insideOut)).toBe(true);
    expect(c.insideOutStep.valid).toBe(true);
    expect(Math.abs(c.insideOutStep.volume - ref.volume)).toBeLessThanOrEqual(B7_REL * ref.volume);
    expect(c.mutations.length).toBeGreaterThanOrEqual(2);
    for (const m of c.mutations) {
      expect(m.checkBrepOk, m.name).toBe(false);
      expect(m.verdict.valid, `${m.name}: ${JSON.stringify(m.verdict)}`).toBe(
        OCCT_MISSES.has(m.name),
      );
    }
    expect(c.mutations.map((m) => m.name)).toEqual(expect.arrayContaining([...OCCT_MISSES]));
  });
});
