// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The CI-only OCCT validator (docs/design/geom-core.md §15): our STEP files
 * through `occt-wasm` 5.3.5 (OpenCascade compiled to WebAssembly). Run by
 * `pnpm --filter @openshaper/geom test:occt` (`vitest.occt.config.ts`), a
 * required CI step on this branch, not part of `pnpm test`.
 *
 * `occt-wasm` is a devDependency of this package only and is imported by tests
 * and by the protocol module `testing/occt/` only (the `./testing/occt`
 * subpath, which other packages' `*.occt.test.ts` run on their own solids;
 * `occt-isolation.test.ts`). The protocol's runners (`pathB`, `pathA`,
 * `orientationControls`) measure; this file asserts.
 *
 * OCCT's STEP reader heals silently (box missing a face imports as a valid
 * 5-face shell; §15.2), so "imports without error" proves little. Each corpus
 * solid is built in memory, passes `checkBrep`, is written, and is imported;
 * then the checks of §15.3 Path B run:
 *
 * - B1 the shape is one solid; B2 `isValid` (BRepCheck_Analyzer);
 * - B3 one shell, and face / edge / vertex counts equal `StepStats`;
 * - B4 no tolerance growth: the largest vertex and edge tolerance in OCCT's own
 *   BREP text is at most twice the uncertainty the file declares (the writer
 *   measures its edge gaps, so a healed gap or a dropped weight shows here);
 * - B5 edge encoding: OCCT's edge curves equal ours at sampled parameters, in
 *   our parameterisation (millimetres);
 * - B6 surface encoding: `pointOnSurface` equals our `surfacePoint` at sampled
 *   (u, v), so degrees, knots, weights and unit scaling all arrived intact;
 * - B8 volume. OCCT's `getVolume` (GProp without an epsilon) is coarse on
 *   B-spline solids (0.4 to 0.8 % measured), so it is only a 1 % sanity check.
 *   The accuracy oracle is the volume of OCCT's own triangulation, whose
 *   deficit from the true volume is bounded by `area × deflection` (every
 *   mesh point is within the deflection of the surface); we also check it
 *   against our exact `massProperties` and the closed form.
 *
 * Path A (§15.3) is the independent orientation oracle: the same solid as
 * OCCT's native BREP text (`toOcctBrepText`), loaded by `fromBREP`, which runs
 * no healing, so `BRepCheck_Analyzer` and the sign of the volume judge the
 * orientation exactly as we built it. B7 then asks both paths for GProp's
 * volume of one solid: whatever GProp's own error, the same geometry must give
 * the same number. Negative controls show the gap Path A closes: a flipped
 * face, a flipped edge use or a solid turned inside out is healed (or let
 * through) by the STEP reader and refused by the unhealed path. A mutation
 * suite pins what OCCT does with deliberately wrong STEP files.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkBrep, GeomError, makeBrep, massProperties, transformBrep, writeStep } from '../index';
import type { Affine3, Brep, StepWriteOptions } from '../index';
import { real } from './part21';
import { unwrapBrep } from '../brep/brep';
import {
  boxSolid,
  CURVED_PUCK_BOARD,
  curvedPuckOracle,
  curvedPuckSolid,
  cylinderSolid,
  plateWithHoleSolid,
  ellipticPuckExact,
  ellipticPuckSolid,
  MUTATIONS,
  readStepSubset,
  sphericalZoneSolid,
  toOcctBrepText,
  toOcctBrepTextUnchecked,
  torusSolid,
} from '../testing';
import {
  ANGULAR_DEFLECTION,
  B7_REL,
  DEFLECTION_MM,
  FLOAT32_EPS,
  flipSubShape,
  GPROP_SANITY_REL,
  maxShapeTolerance,
  MESH_BOUND_MAX_REL,
  meshVolume,
  MM_PER_FILE_UNIT,
  OcctKernel,
  occtVerdict,
  orientationControls,
  pathA,
  pathB,
  refused,
} from '../testing/occt';
import type {
  ImportFacts,
  MeshVolumeCheck,
  OcctSolid,
  OcctVerdict,
  ShapeHandle,
} from '../testing/occt';

let kernel: OcctKernel;
let mark = 0;
beforeAll(async () => {
  kernel = await OcctKernel.init();
  mark = kernel.checkpoint();
});
afterAll(() => {
  kernel.releaseSince(mark);
});

const corpusDir = fileURLToPath(new URL('../../.occt-corpus/', import.meta.url));
mkdirSync(corpusDir, { recursive: true });

// --- transforms (row-major 3×4) ---------------------------------------------

/** Rotation by `angle` about the unit `axis` (Rodrigues), then translation `t`. */
function rotation(
  axis: readonly [number, number, number],
  angle: number,
  t: readonly [number, number, number],
): Affine3 {
  const n = Math.hypot(...axis);
  const [x, y, z] = axis.map((a) => a / n) as [number, number, number];
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = 1 - c;
  return [
    c + x * x * k,
    x * y * k - z * s,
    x * z * k + y * s,
    t[0],
    y * x * k + z * s,
    c + y * y * k,
    y * z * k - x * s,
    t[1],
    z * x * k - y * s,
    z * y * k + x * s,
    c + z * z * k,
    t[2],
  ];
}
const MIRROR_X: Affine3 = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

// --- the corpus (geom-core.md §15.3; volumes are closed forms, in cm³) --------

/**
 * A corpus solid: the protocol's {@link OcctSolid} (exact measures, inside point, fitted-edge
 * leak, extent) with its builder; `extent` defaults to {@link SMALL_EXTENT}.
 */
type Solid = Omit<OcctSolid, 'extent'> & {
  readonly brep: () => Brep;
  readonly extent?: number;
};

/** Default {@link Solid.extent}: beyond every coordinate of the small corpus solids (cm). */
const SMALL_EXTENT = 5 + Math.hypot(5, 3, 2);

/** The protocol's view of a corpus solid. */
const occt = (s: Solid): OcctSolid => ({ ...s, extent: s.extent ?? SMALL_EXTENT });

const PI = Math.PI;
/** Closed forms of a sphere zone `|z| ≤ r sin φ` with planar caps. */
const zone = (r: number, phi: number): Pick<Solid, 'volume' | 'area' | 'curved'> => {
  const h = 2 * r * Math.sin(phi);
  const rho = r * Math.cos(phi);
  return {
    volume: PI * (r * r * h - (h * h * h) / 12),
    area: 2 * PI * r * h + 2 * PI * rho * rho,
    curved: 2 * PI * r * h,
  };
};
const CYL = { r: 1.5, h: 4 };
const cylinder: Pick<Solid, 'volume' | 'area' | 'curved'> = {
  volume: PI * CYL.r * CYL.r * CYL.h,
  area: 2 * PI * CYL.r * CYL.h + 2 * PI * CYL.r * CYL.r,
  curved: 2 * PI * CYL.r * CYL.h,
};
const BOX = { volume: 30, area: 62, curved: 0 } as const;
/** `plateWithHoleSolid(6, 5, 2, 1)`: the box 6 × 5 × 2 minus a through-hole of radius 1 (holes in faces). */
const PLATE = {
  volume: 60 - 2 * PI,
  area: 104 + 2 * PI,
  curved: 2 * PI * 1 * 2,
} as const;
const TOR = { R: 3, r: 1 };
const rot = rotation([1, 2, 3], 0.6, [5, -3, 2]);
const place = (p: readonly [number, number, number], m: Affine3): [number, number, number] => [
  m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
  m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
  m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
];

/** The V5 puck, semi-axes 3 × 2 cm and 1 cm high (30 × 20 × 10 mm), deck slope 0.1 when fitted. */
const PUCK = { a: 3, b: 2, h: 1, tilt: 0.1 } as const;
const puckForms = (tilt: number): Pick<Solid, 'volume' | 'area' | 'curved'> => {
  const e = ellipticPuckExact(PUCK.a, PUCK.b, PUCK.h, tilt);
  return { volume: e.volume, area: e.area, curved: e.area - PI * PUCK.a * PUCK.b };
};

/**
 * A board-sized three-face solid (the board's topology: band, bottom, deck): the V5 puck at
 * 180 × 54 × 6 cm with the fitted bicubic deck tilted along x (rising 3.6 cm towards +x), so
 * it is not symmetric front to back, and its edge gap is a real fit residual.
 */
const BOARD = { a: 90, b: 27, h: 6, tilt: 0.04 } as const;
const board = (): Brep =>
  ellipticPuckSolid(BOARD.a, BOARD.b, BOARD.h, { bicubicDeck: true, tilt: BOARD.tilt });
const boardForms = (): Pick<Solid, 'volume' | 'area' | 'curved' | 'fitted' | 'extent'> => {
  const { a, b, h, tilt } = BOARD;
  const e = ellipticPuckExact(a, b, h, tilt);
  return {
    volume: e.volume,
    area: e.area,
    curved: e.area - PI * a * b,
    // Perimeter: π √(2 (a² + b²)) bounds an ellipse's from above, × √(1 + tilt²) for the
    // tilted top; reach from the deck's control-net corner (the V5 entry's formula).
    fitted: {
      perimeter: PI * Math.sqrt(2 * (a * a + b * b)) * Math.sqrt(1 + tilt * tilt),
      reach: Math.hypot(2.5 * a, 2.5 * b, h + 2.5 * tilt * a),
    },
    // |p| ≤ hypot(a, b, h + tilt · a) on the solid; a rigid motion adds at most |translation|.
    extent: Math.hypot(a, b, h + tilt * a) + Math.hypot(5, 3, 2),
  };
};

/**
 * V5b (Phase 2 step G2, `testing/curved-puck.ts`): the board's three faces all curved: a
 * degree 6 × 4 trimmed deck and a bicubic trimmed bottom (both `approximateSurface`, interior
 * knots, fitted pcurves) and a `skinCurves` band (rational, clamped or periodic in u). Its
 * "exact" volume and area are the independent oracle's (divergence theorem over the exact
 * ellipse and the band's definition, from the spec alone: no NURBS, no trims, no
 * `integrate.ts`; error estimates below 1e-12 relative).
 */
const curvedBoard = (periodicBand: boolean): Brep =>
  curvedPuckSolid(CURVED_PUCK_BOARD, { periodicBand });
const curvedForms = (
  periodicBand: boolean,
): Pick<Solid, 'volume' | 'area' | 'curved' | 'fitted' | 'extent' | 'deflectionMm'> => {
  const b = curvedBoard(periodicBand);
  const o = curvedPuckOracle(CURVED_PUCK_BOARD);
  // Every point of the solid lies in its control box; the moments' reference is that box's
  // corner, so the reach is at most its diagonal, and for any rigid motion at most √3 × it
  // (the diagonal of an axis box of a set is at most √3 × the set's diameter).
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  for (const f of b.faces) {
    for (let i = 0; i < f.surface.cw.length; i += 4) {
      const p = [0, 1, 2].map((k) => f.surface.cw[i + k]! / f.surface.cw[i + 3]!);
      lo = lo.map((x, k) => Math.min(x, p[k]!));
      hi = hi.map((x, k) => Math.max(x, p[k]!));
    }
  }
  const diagonal = Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!);
  return {
    volume: o.volume.value,
    area: o.area.value,
    curved: o.area.value,
    fitted: { perimeter: o.fittedEdgeLength, reach: Math.sqrt(3) * diagonal },
    extent: diagonal + Math.hypot(5, 3, 2),
    // 0.01 mm meshes the 380 cm band into 391k triangles (19 s); 0.03 mm keeps the bound
    // at 1.2e-3 of the volume (the bound's own test: < 5e-3) in 4 s.
    deflectionMm: 0.03,
  };
};

const CORPUS: readonly Solid[] = [
  {
    name: 'V5b-curved-puck',
    brep: () => curvedBoard(false),
    ...curvedForms(false),
    inside: [40, 5, 3],
  },
  {
    name: 'V5b-curved-puck-periodic-band',
    brep: () => curvedBoard(true),
    ...curvedForms(true),
    inside: [40, 5, 3],
  },
  {
    name: 'mirrored-V5b',
    brep: () => transformBrep(curvedBoard(false), MIRROR_X),
    ...curvedForms(false),
    inside: [-40, 5, 3],
  },
  { name: 'board-three-face', brep: board, ...boardForms(), inside: [40, 5, 3] },
  {
    name: 'rotated-board',
    brep: () => transformBrep(board(), rot),
    ...boardForms(),
    inside: place([40, 5, 3], rot),
  },
  {
    name: 'mirrored-board',
    brep: () => transformBrep(board(), MIRROR_X),
    ...boardForms(),
    inside: [-40, 5, 3],
  },
  {
    name: 'V5-elliptic-puck',
    brep: () => ellipticPuckSolid(PUCK.a, PUCK.b, PUCK.h),
    ...puckForms(0),
    inside: [0.2, 0.1, 0.5],
  },
  {
    // The deck's pcurve is the fit's: edge gaps are measured, not rounding (design §15.3 V5).
    name: 'V5-elliptic-puck-fitted-deck',
    brep: () => ellipticPuckSolid(PUCK.a, PUCK.b, PUCK.h, { bicubicDeck: true, tilt: PUCK.tilt }),
    ...puckForms(PUCK.tilt),
    inside: [0.2, 0.1, 0.5],
    // Perimeter of a 3 × 2 ellipse is 15.87 (rounded up) · √(1 + tilt²); reach from the
    // control-net corner: hypot(2.5 a, 2.5 b, h + 2.5 tilt a) = 9.2 (rounded up).
    fitted: { perimeter: 16, reach: 9.3 },
  },
  { name: 'V1-box', brep: () => boxSolid(2, 3, 5), ...BOX, inside: [1, 1.5, 2.5] },
  {
    name: 'V1-box-trimmed',
    brep: () => boxSolid(2, 3, 5, { trimmed: true }),
    ...BOX,
    inside: [1, 1.5, 2.5],
  },
  {
    name: 'V2-cylinder',
    brep: () => cylinderSolid(CYL.r, CYL.h),
    ...cylinder,
    inside: [0.2, 0.1, 2],
  },
  {
    name: 'V3-torus',
    brep: () => torusSolid(TOR.R, TOR.r),
    volume: 2 * PI * PI * TOR.R * TOR.r * TOR.r,
    area: 4 * PI * PI * TOR.R * TOR.r,
    curved: 4 * PI * PI * TOR.R * TOR.r,
    inside: [3, 0, 0],
  },
  { name: 'V4-zone', brep: () => sphericalZoneSolid(2, 1), ...zone(2, 1), inside: [0.1, 0.2, 0.3] },
  {
    name: 'V4-zone-split',
    brep: () => sphericalZoneSolid(2, 1, { split: true }),
    ...zone(2, 1),
    inside: [0.1, 0.2, 0.3],
  },
  {
    name: 'mirrored-cylinder',
    brep: () => transformBrep(cylinderSolid(CYL.r, CYL.h), MIRROR_X),
    ...cylinder,
    inside: [-0.2, 0.1, 2],
  },
  {
    name: 'mirrored-zone',
    brep: () => transformBrep(sphericalZoneSolid(2, 1), MIRROR_X),
    ...zone(2, 1),
    inside: [-0.1, 0.2, 0.3],
  },
  {
    name: 'V5-plate-with-hole',
    brep: () => plateWithHoleSolid(6, 5, 2, 1),
    ...PLATE,
    inside: [0.5, 0.5, 1],
  },
  {
    name: 'mirrored-plate-with-hole',
    brep: () => transformBrep(plateWithHoleSolid(6, 5, 2, 1), MIRROR_X),
    ...PLATE,
    inside: [-0.5, 0.5, 1],
  },
  {
    name: 'rotated-cylinder',
    brep: () => transformBrep(cylinderSolid(CYL.r, CYL.h), rot),
    ...cylinder,
    inside: place([0.2, 0.1, 2], rot),
  },
  {
    name: 'rotated-box-trimmed',
    brep: () => transformBrep(boxSolid(2, 3, 5, { trimmed: true }), rot),
    ...BOX,
    inside: place([1, 1.5, 2.5], rot),
  },
];

/**
 * B1–B4 asserted on a Path A or Path B report: one solid in one shell, counts equal to
 * ours, no tolerance growth beyond twice the declared uncertainty (B4; Path A asserts
 * the exact written tolerance itself), B5 and B6 encodings, the inside / outside probes.
 */
function expectImport(r: ImportFacts, counts: { faces: number; edges: number; vertices: number }) {
  expect(r.type).toBe('solid');
  expect(r.valid, 'BRepCheck_Analyzer').toBe(true);
  expect(r.solids).toBe(1);
  expect(r.shells).toBe(1);
  expect(r.faces).toBe(counts.faces);
  expect(r.edges).toBe(counts.edges);
  expect(r.vertices).toBe(counts.vertices);
  expect(r.unmatchedEdges, 'B5: OCCT edges equal ours parameter by parameter').toEqual([]);
  expect(r.unmatchedFaces, 'B6: OCCT faces equal ours parameter by parameter').toBe(0);
  expect(r.contains).toEqual({ inside: true, outside: false });
}

/** B8's oracle: OCCT's mesh volume within its bound of the exact volume, and the bound tight. */
function expectMesh(m: MeshVolumeCheck): void {
  expect(m.volume, 'a negative mesh volume means an inside-out solid').toBeGreaterThan(0);
  expect(Math.abs(m.volume - m.exact), `mesh ${m.volume} vs exact ${m.exact}`).toBeLessThanOrEqual(
    m.bound,
  );
  expect(m.bound / m.exact, 'the bound must be tight enough to mean something').toBeLessThan(
    MESH_BOUND_MAX_REL,
  );
}

for (const fileUnit of ['mm', 'cm'] as const) {
  describe(`OCCT imports our STEP files (file unit ${fileUnit})`, () => {
    for (const solid of CORPUS) {
      it(`${solid.name}: one valid solid, exact encoding, volume within its bound`, () => {
        const b = solid.brep();
        const r = pathB(kernel, b, occt(solid), fileUnit, { timestamp: '2026-01-01T00:00:00' });
        writeFileSync(`${corpusDir}${solid.name}.${fileUnit}.step`, r.text);

        // B1–B6.
        expectImport(r, r.stats);
        expect(r.grownMm, `tolerance grown to ${r.grownMm} mm`).toBeLessThanOrEqual(
          2 * r.declaredMm,
        );

        // B8: volume. 1 % sanity for GProp; the oracle is the mesh volume.
        const exactMm3 = solid.volume * 1000;
        const ours = massProperties(b);
        const gapMm = 10 * r.check.maxEdgeGap;
        if (solid.fitted === undefined) {
          expect(ours.volume.value * 1000).toBeCloseTo(exactMm3, 6); // exact rules: ~1e-12 relative
        } else {
          const leakMm3 =
            (1000 * r.check.maxEdgeGap * solid.fitted.perimeter * solid.fitted.reach) / 3;
          expect(Math.abs(ours.volume.value * 1000 - exactMm3)).toBeLessThanOrEqual(
            leakMm3 + 1e-9 * exactMm3,
          );
          expect(gapMm, 'a fitted deck has a real gap').toBeGreaterThan(1e-9);
        }
        expect(Math.abs(r.gpropVolume / exactMm3 - 1)).toBeLessThan(GPROP_SANITY_REL);
        expectMesh(r.mesh);
      });
    }
  });
}

describe('Path A: our native BREP, unhealed (fromBREP), and B7', () => {
  for (const solid of CORPUS) {
    it(`${solid.name}: valid as built, exact encoding, outward, and GProp agrees with Path B (B7)`, () => {
      const b = solid.brep();
      const r = pathA(kernel, b, occt(solid));
      writeFileSync(`${corpusDir}${solid.name}.brep`, r.text);
      // Both paths carry the same declared uncertainty, so they are compared on equal terms.
      expect(r.tolerance).toBe(r.stepUncertainty);
      expect(r.shapeType).toBe('solid');
      expectImport(r, {
        faces: b.faces.length,
        edges: b.edges.length,
        vertices: b.vertices.length,
      });
      // Nothing was healed: every tolerance is the one written (OCCT prints 17 digits).
      expect(r.grownMm).toBeCloseTo(r.tolerance, 15);

      const vA = r.gpropVolume;
      const exactMm3 = solid.volume * 1000;
      expect(vA, 'outward: the unhealed volume keeps its sign').toBeGreaterThan(0);
      expect(Math.abs(vA / exactMm3 - 1)).toBeLessThan(GPROP_SANITY_REL);
      // B7: the same integrator on the same solid through the other path, in both file units.
      for (const fileUnit of ['mm', 'cm'] as const) {
        const vB = r.b7[fileUnit];
        expect(Math.abs(vB - vA), `B7 (${fileUnit}): ${vB} vs ${vA}`).toBeLessThanOrEqual(
          B7_REL * vA,
        );
      }
      expectMesh(r.mesh);
    });
  }
});

describe('Path A sees the orientation errors the STEP reader heals', () => {
  /** OCCT's verdict on a shape: `isValid` and GProp's signed volume. */
  const verdict = (shape: ShapeHandle): OcctVerdict => occtVerdict(kernel, shape);

  const SOLIDS: readonly (readonly [string, () => Brep])[] = [
    ['V5b-curved-puck', () => curvedBoard(false)],
    ['V5b-curved-puck-periodic-band', () => curvedBoard(true)],
    ['board-three-face', board],
    ['mirrored-board', () => transformBrep(board(), MIRROR_X)],
    ['V5-plate-with-hole', () => plateWithHoleSolid(6, 5, 2, 1)],
    ['V3-torus', () => torusSolid(TOR.R, TOR.r)],
  ];

  for (const [name, make] of SOLIDS) {
    it(`${name}: every face flipped in the shell, every edge use flipped, inside out, every checkBrep mutation: refused`, () => {
      const b = make();
      const c = orientationControls(kernel, b);
      const ref = c.reference;
      expect(refused(ref)).toBe(false);
      // The control of the control: the unchecked writer at the same tolerance is the same text.
      expect(c.uncheckedSameText).toBe(true);

      expect(c.faceFlips.length).toBe(b.faces.length);
      c.faceFlips.forEach((v, k) => {
        if (b.faces.length > 1) {
          // BRepCheck_Shell's orientation check refuses it, pinned as such: some flips also make
          // GProp's volume negative, so a sign test alone would not show the check ran.
          expect(v.valid, `face ${k} flipped: ${JSON.stringify(v)}`).toBe(false);
        } else {
          // One face (the torus): flipping it turns the whole shell inside out, coherently; only
          // the sign tells (as for flipBrep below).
          expect(v.valid, `the only face flipped: ${JSON.stringify(v)}`).toBe(true);
          expect(v.volume).toBeLessThan(0);
        }
        // A flipped face changes GProp's volume: the defect is visible, not just flagged.
        expect(Math.abs(v.volume - ref.volume)).toBeGreaterThan(B7_REL * ref.volume);
      });
      expect(c.edgeFlips.length).toBe(b.faces[0]!.outer.coedges.length);
      c.edgeFlips.forEach((v, k) => {
        expect(v.valid, `edge use ${k} of the first wire flipped`).toBe(false);
      });

      // Turned inside out: pinned, BRepCheck accepts a coherent inside-out shell and only the
      // sign tells; the STEP reader orients it outward again (nothing to see there).
      expect(c.insideOutCheckOk).toBe(false);
      expect(c.insideOut.valid).toBe(true);
      expect(c.insideOut.volume).toBe(-ref.volume);
      expect(refused(c.insideOut)).toBe(true);
      expect(c.insideOutStep.valid).toBe(true);
      expect(Math.abs(c.insideOutStep.volume - ref.volume)).toBeLessThanOrEqual(
        B7_REL * ref.volume,
      );

      // Every orientation or geometry mutation checkBrep refuses, OCCT unhealed refuses too.
      // Pinned route: BRepCheck refuses every one (measured: none relies on the volume's sign,
      // which stays positive for all but the torus's reversed loop).
      for (const m of c.mutations) {
        expect(m.checkBrepOk, m.name).toBe(false);
        expect(m.verdict.valid, `${m.name}: ${JSON.stringify(m.verdict)}`).toBe(false);
      }
      expect(c.mutations.length, 'the orientation mutations at least').toBeGreaterThanOrEqual(2);
    });
  }

  it('the same defects on the board: STEP calls them valid, the native BREP refuses them', () => {
    const b = board();
    // Face 0 (the band) keeps its surface's sense, so the first ORIENTED_EDGE of the STEP
    // file and the first edge use of the first BREP wire are the same coedge.
    expect(b.faces[0]!.sameSense).toBe(true);
    const step = writeStep(b).text;
    const good = toOcctBrepText(b);
    const m0 = kernel.checkpoint();
    const ref = verdict(kernel.fromBREP(good.text));

    // A face whose sense is flipped (ADVANCED_FACE same_sense; in BREP, the same B-rep): healed
    // to the same volume, so only Path A can see it.
    const flippedFace = MUTATIONS.find((m) => m.name === 'flip a face sense')!;
    const stepFace = step.replace(/(ADVANCED_FACE\([^\n]*,)\.T\.\);/, '$1.F.);');
    expect(stepFace).not.toBe(step);
    const healedFace = verdict(kernel.importStep(stepFace));
    expect(healedFace.valid).toBe(true);
    expect(Math.abs(healedFace.volume - ref.volume)).toBeLessThanOrEqual(B7_REL * ref.volume);
    const brepFace = toOcctBrepTextUnchecked(unwrapBrep(makeBrep(flippedFace.apply(b))), {
      tolerance: good.tolerance,
    }).text;
    expect(verdict(kernel.fromBREP(brepFace)).valid).toBe(false);

    // An edge use flipped in its loop (ORIENTED_EDGE orientation; in BREP, the wire's sign).
    // On the band's closed bottom edge the STEP reader returns a "valid" solid with a wrong
    // volume (pinned: 46 % off, measured): isValid misses it, B7 against Path A would not.
    const stepEdge = step.replace(
      /(ORIENTED_EDGE\([^\n]*,)\.(T|F)\.\);/,
      (_, head: string, o) => `${head}.${o === 'T' ? 'F' : 'T'}.);`,
    );
    expect(stepEdge).not.toBe(step);
    const healedEdge = verdict(kernel.importStep(stepEdge));
    expect(healedEdge.valid).toBe(true);
    expect(Math.abs(healedEdge.volume / ref.volume - 1)).toBeGreaterThan(0.01);
    expect(verdict(kernel.fromBREP(flipSubShape(good.text, 'Wi', 0))).valid).toBe(false);
    kernel.releaseSince(m0);
  });
});

describe('OCCT imports other writer options', () => {
  const variants: readonly (readonly [string, StepWriteOptions])[] = [
    ['trimmedOnly pcurves', { pcurves: 'trimmedOnly' }],
    ['inch file unit', { fileUnit: 'in' }],
    ['9 significant digits', { precision: 9 }],
  ];
  for (const [label, opts] of variants) {
    for (const solid of CORPUS.filter((s) =>
      ['V1-box', 'V2-cylinder', 'V4-zone-split'].includes(s.name),
    )) {
      it(`${solid.name}, ${label}: one valid solid, counts, tolerance, volume within the bound`, () => {
        const out = writeStep(solid.brep(), opts);
        writeFileSync(`${corpusDir}${solid.name}.${label.replace(/\W+/g, '-')}.step`, out.text);
        const m0 = kernel.checkpoint();
        const shape = kernel.importStep(out.text);
        expect(kernel.isValid(shape)).toBe(true);
        expect(kernel.subShapeCount(shape, 'solid')).toBe(1);
        // B3 and B4 against the stats and the uncertainty declared for this write.
        expect(kernel.subShapeCount(shape, 'shell')).toBe(1);
        expect(kernel.subShapeCount(shape, 'face')).toBe(out.stats.faces);
        expect(kernel.subShapeCount(shape, 'edge')).toBe(out.stats.edges);
        expect(kernel.subShapeCount(shape, 'vertex')).toBe(out.stats.vertices);
        const declaredMm = out.stats.uncertainty * MM_PER_FILE_UNIT[opts.fileUnit ?? 'mm'];
        expect(maxShapeTolerance(kernel.toBREP(shape))).toBeLessThanOrEqual(2 * declaredMm);
        const exactMm3 = solid.volume * 1000;
        const mesh = kernel.tessellate(shape, {
          linearDeflection: DEFLECTION_MM,
          angularDeflection: ANGULAR_DEFLECTION,
        });
        // 9 digits write 1e-9 relative: ≤ 1e-7 mm on 100 mm coordinates; the mesh bound dominates.
        expect(Math.abs(meshVolume(mesh.positions, mesh.indices) - exactMm3)).toBeLessThanOrEqual(
          solid.curved * 100 * DEFLECTION_MM + solid.area * 100 * 100 * FLOAT32_EPS,
        );
        kernel.releaseSince(m0);
      });
    }
  }
});

describe('what OCCT does with wrong files (pinned, so an upstream change is noticed)', () => {
  // §15.2: orientation errors import as a valid, healed solid with unchanged
  // volume; gaps and wrong weights surface only as grown tolerance. The writer's
  // gate (`checkBrep`) exists because of this: none of these can come out of
  // `writeStep`, and our own reader + `checkBrep` rejects each one.
  function oracle(text: string): { valid: boolean; volume: number; tol: number } {
    const shape = kernel.importStep(text);
    return {
      valid: kernel.isValid(shape),
      volume: kernel.getVolume(shape),
      tol: maxShapeTolerance(kernel.toBREP(shape)),
    };
  }
  /** Replaces the first line matching `re` with `edit(line)`; fails if there is none. */
  function editLine(text: string, re: RegExp, edit: (line: string) => string): string {
    const lines = text.split('\n');
    const i = lines.findIndex((l) => re.test(l));
    expect(i, `no line matches ${re}`).toBeGreaterThanOrEqual(0);
    lines[i] = edit(lines[i]!);
    return lines.join('\n');
  }
  /**
   * How our own pipeline judges a file: `'rejected'` if the subset reader's
   * structural validation (`makeBrep`, code `brep-invalid`) or `checkBrep` refuses
   * it; `'read-error'` if the file is malformed (lexical, arity or any other
   * reader failure); else `'accepted'`. A mutation must be `'rejected'`: a lexer
   * error would pass a bare "it throws" test while saying nothing about the checks.
   */
  function ourVerdict(text: string): 'read-error' | 'accepted' | 'rejected' {
    let b: Brep;
    try {
      b = readStepSubset(text);
    } catch (e) {
      return e instanceof GeomError && e.code === 'brep-invalid' ? 'rejected' : 'read-error';
    }
    return checkBrep(b).ok ? 'accepted' : 'rejected';
  }

  it('a flipped same_sense on one face is healed: a valid solid, same volume; we reject it', () => {
    const good = writeStep(boxSolid(2, 3, 5));
    const m0 = kernel.checkpoint();
    const ref = oracle(good.text);
    const bad = editLine(good.text, /ADVANCED_FACE/, (l) => {
      expect(l.endsWith('.T.);')).toBe(true);
      return `${l.slice(0, -5)}.F.);`;
    });
    const r = oracle(bad);
    expect(r.valid).toBe(true);
    expect(r.volume).toBeCloseTo(ref.volume, 6);
    kernel.releaseSince(m0);
    expect(ourVerdict(good.text)).toBe('accepted');
    expect(ourVerdict(bad)).toBe('rejected');
  });

  it('a flipped ORIENTED_EDGE is healed: a valid solid, same volume; we reject it', () => {
    const good = writeStep(boxSolid(2, 3, 5));
    const m0 = kernel.checkpoint();
    const ref = oracle(good.text);
    const bad = editLine(good.text, /ORIENTED_EDGE/, (l) =>
      l.endsWith('.T.);') ? `${l.slice(0, -5)}.F.);` : `${l.slice(0, -5)}.T.);`,
    );
    const r = oracle(bad);
    expect(r.valid).toBe(true);
    expect(r.volume).toBeCloseTo(ref.volume, 6);
    kernel.releaseSince(m0);
    expect(ourVerdict(bad)).toBe('rejected');
  });

  it('a vertex moved 0.5 mm off its edges is healed by growing the tolerance; we reject it', () => {
    const good = writeStep(boxSolid(2, 3, 5));
    const m0 = kernel.checkpoint();
    // Point the first VERTEX_POINT at a new point 0.5 mm away; its edges' curves stay.
    const lines = good.text.split('\n');
    const vi = lines.findIndex((l) => /^#\d+=VERTEX_POINT/.test(l));
    const pointId = /VERTEX_POINT\('',#(\d+)\)/.exec(lines[vi]!)![1]!;
    const pi = lines.findIndex((l) => l.startsWith(`#${pointId}=CARTESIAN_POINT`));
    const [x, y, z] = /\(([^()]*)\)\);$/.exec(lines[pi]!)![1]!.split(',').map(Number);
    const fresh = Number(/#(\d+)=/.exec(lines[lines.length - 4]!)![1]) + 1000;
    lines[vi] = lines[vi]!.replace(`#${pointId}`, `#${fresh}`);
    // Part 21 REALs through the writer's own formatter (a bare `0` or `0.5.` is not one).
    lines.splice(
      vi,
      0,
      `#${fresh}=CARTESIAN_POINT('',(${real(x! + 0.5)},${real(y!)},${real(z!)}));`,
    );
    const bad = lines.join('\n');
    const r = oracle(bad);
    expect(r.tol).toBeGreaterThan(2 * good.stats.uncertainty * 1);
    expect(oracle(good.text).tol).toBeLessThanOrEqual(2 * good.stats.uncertainty);
    kernel.releaseSince(m0);
    expect(ourVerdict(bad)).toBe('rejected');
  });

  it('a wrong rational weight on an edge is healed by growing the tolerance; we reject it', () => {
    const good = writeStep(cylinderSolid(1.5, 4));
    const m0 = kernel.checkpoint();
    // The first rational weight list (a ring edge's circle): 0.7071… becomes 0.6.
    const bad = editLine(good.text, /RATIONAL_B_SPLINE_CURVE\(\(1\.,0\.7071/, (l) =>
      l.replace('0.7071067811865476', '0.6'),
    );
    expect(bad).not.toBe(good.text);
    expect(oracle(bad).tol).toBeGreaterThan(2 * good.stats.uncertainty);
    expect(oracle(good.text).tol).toBeLessThanOrEqual(2 * good.stats.uncertainty);
    kernel.releaseSince(m0);
    expect(ourVerdict(bad)).toBe('rejected');
  });
});
