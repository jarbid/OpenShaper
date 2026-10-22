// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * V5b, the curved puck (Phase 2 step G2), judged by OCCT beyond the corpus
 * protocol of `step.occt.test.ts` (where it also passes Path B, Path A, B7 and
 * the orientation negative controls). Run by `pnpm --filter @openshaper/geom
 * test:occt`.
 *
 * - **The pcurve fit on the curved faces.** OCCT's `BRepCheck` (unhealed, Path
 *   A) checks each edge's same-parameter deviation `|C(t) − S(P(t))|` at 23
 *   equally spaced parameters (`BRepLib_ValidateEdge`'s default) against the
 *   edge tolerance written in the file, with its own evaluators of our curve,
 *   pcurve and degree-6 × 4 / bicubic surfaces. So writing the file with the
 *   tolerance just below and just above our own 23-point maximum must flip its
 *   verdict: an independent evaluation of the fit, to the digits of the flip.
 *   OCCT's STEP healer, which sets an edge tolerance to the deviation it
 *   measures, must land on the same number.
 * - **Volume and area against the independent oracle** (`curvedPuckOracle`:
 *   divergence theorem over the exact ellipse and the band's definition, from
 *   the spec alone: no NURBS, no trims, no `integrate.ts`):
 *   OCCT's own triangulation at two deflections (its error bounded by
 *   `area × deflection` and shrinking with it) and GProp face by face.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkBrep,
  curveOnSurfacePoint,
  curvePoint,
  DEFAULT_TOLERANCES,
  surfacePoint,
  writeStep,
} from '../index';
import type { Brep } from '../index';
import {
  CURVED_PUCK_BOARD,
  curvedPuckOracle,
  curvedPuckSolid,
  toOcctBrepText,
  toOcctBrepTextUnchecked,
} from '../testing';
import { maxShapeTolerance, OcctKernel } from '../testing/occt';
import type { ShapeHandle } from '../testing/occt';

let kernel: OcctKernel;
let mark = 0;
beforeAll(async () => {
  kernel = await OcctKernel.init();
  mark = kernel.checkpoint();
});
afterAll(() => {
  kernel.releaseSince(mark);
});

/** Control points per edge in OCCT's same-parameter check (`BRepLib_ValidateEdge`, default). */
const OCCT_EDGE_SAMPLES = 23;
/**
 * Width of the bracket around the flip (relative). The deviation is about 4e-4 mm and the
 * coordinates about 1e3 mm, so rounding moves it by ~1e-13 mm (≈ 3e-10 relative); 1e-6 is
 * far above that and far below any real difference of evaluation.
 */
const FLIP_REL = 1e-6;
/** OCCT's healer stores what it measured with a small margin of its own (measured 1.00001×). */
const HEALER_MARGIN_REL = 1e-4;

/** The largest same-parameter deviation over every coedge at `n` equally spaced parameters (cm). */
function sampledDeviation(b: Brep, n: number): number {
  let worst = 0;
  for (const f of b.faces) {
    for (const loop of [f.outer, ...f.holes]) {
      for (const ce of loop.coedges) {
        const e = b.edges[ce.edge]!;
        const [t0, t1] = e.curve.basis.domain;
        for (let i = 0; i < n; i++) {
          const t = t0 + ((t1 - t0) * i) / (n - 1);
          const p = curvePoint(e.curve, t);
          const q = curveOnSurfacePoint({ surface: f.surface, pcurve: ce.pcurve }, t);
          worst = Math.max(worst, Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z));
        }
      }
    }
  }
  return worst;
}

/** Signed volume and area of a triangle mesh (mm³, mm²). */
function meshVolumeArea(positions: Float32Array, indices: Uint32Array): [number, number] {
  let v = 0;
  let a = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const [i, j, k] = [indices[t]! * 3, indices[t + 1]! * 3, indices[t + 2]! * 3];
    const ax = positions[i]!;
    const ay = positions[i + 1]!;
    const az = positions[i + 2]!;
    const bx = positions[j]! - ax;
    const by = positions[j + 1]! - ay;
    const bz = positions[j + 2]! - az;
    const cx = positions[k]! - ax;
    const cy = positions[k + 1]! - ay;
    const cz = positions[k + 2]! - az;
    const nx = by * cz - bz * cy;
    const ny = bz * cx - bx * cz;
    const nz = bx * cy - by * cx;
    v += (ax * nx + ay * ny + az * nz) / 6;
    a += 0.5 * Math.hypot(nx, ny, nz);
  }
  return [v, a];
}

describe('V5b: OCCT judges the pcurve fit on the curved deck and bottom', () => {
  for (const fit of [1e-3, 1e-4, 1e-5]) {
    it(`fit ${fit} cm: BRepCheck's verdict flips at our 23-point deviation; the healer measures it too`, () => {
      const b = curvedPuckSolid(CURVED_PUCK_BOARD, { tol: { fit } });
      // Judged at the fit it was built with (the default, 1e-4 cm, when tighter).
      const tol = { fit: Math.max(fit, DEFAULT_TOLERANCES.fit) };
      const report = checkBrep(b, tol);
      expect(report.ok).toBe(true);
      // mm: the files are written in mm from the cm model.
      const ours23 = 10 * sampledDeviation(b, OCCT_EDGE_SAMPLES);
      const dense = 10 * report.maxEdgeGap;
      // A real fit residual, which our dense check bounds from above.
      expect(ours23).toBeGreaterThan(1e-7);
      expect(ours23).toBeLessThanOrEqual(dense);
      const m0 = kernel.checkpoint();
      const verdict = (tolMm: number): boolean =>
        kernel.isValid(kernel.fromBREP(toOcctBrepTextUnchecked(b, { tolerance: tolMm }).text));
      expect(verdict(ours23 * (1 - FLIP_REL)), 'just below our deviation').toBe(false);
      expect(verdict(ours23 * (1 + FLIP_REL)), 'just above our deviation').toBe(true);
      // The checked writer declares 2 × the dense gap: valid with room.
      const a = toOcctBrepText(b, { tol });
      expect(a.tolerance).toBeCloseTo(2 * dense, 12);
      expect(kernel.isValid(kernel.fromBREP(a.text))).toBe(true);
      // The STEP healer computes the same-parameter tolerance itself, from the same samples.
      const healed = maxShapeTolerance(
        kernel.toBREP(kernel.importStep(writeStep(b, { tol }).text)),
      );
      expect(healed).toBeGreaterThanOrEqual(ours23);
      expect(healed).toBeLessThanOrEqual(ours23 * (1 + HEALER_MARGIN_REL));
      kernel.releaseSince(m0);
    });
  }
});

describe('V5b: OCCT measures the oracle volume and area', () => {
  const b = curvedPuckSolid(CURVED_PUCK_BOARD);
  const o = curvedPuckOracle(CURVED_PUCK_BOARD);
  const exactMm3 = 1000 * o.volume.value;
  const areaMm2 = 100 * o.area.value;
  const gapMm = 10 * checkBrep(b).maxEdgeGap;

  /** Which of our faces an OCCT face is: the one it equals at the middle of its uv bounds. */
  function faceIndex(face: ShapeHandle): number {
    const bounds = kernel.uvBounds(face);
    const u = 0.5 * (bounds.uMin + bounds.uMax);
    const v = 0.5 * (bounds.vMin + bounds.vMax);
    const q = kernel.pointOnSurface(face, u, v);
    const hits = b.faces
      .map((f, i) => {
        const p = surfacePoint(f.surface, u, v);
        return Math.hypot(q.x - 10 * p.x, q.y - 10 * p.y, q.z - 10 * p.z) < 1e-6 ? i : -1;
      })
      .filter((i) => i >= 0);
    expect(hits).toHaveLength(1);
    return hits[0]!;
  }

  it('the triangulation volume converges to the oracle within area × deflection', () => {
    const m0 = kernel.checkpoint();
    const shape = kernel.fromBREP(toOcctBrepText(b).text);
    const errors: number[] = [];
    for (const deflection of [0.1, 0.03]) {
      const mesh = kernel.tessellate(shape, {
        linearDeflection: deflection,
        angularDeflection: 0.05,
      });
      const [vMesh] = meshVolumeArea(mesh.positions, mesh.indices);
      // Every mesh point within the deflection of the surface; Float32 positions (2⁻²³ of
      // ≤ 1200 mm coordinates over the area); the trims off the edges by the gap.
      const bound = areaMm2 * (deflection + 1200 * 2 ** -23 + gapMm);
      expect(Math.abs(vMesh - exactMm3)).toBeLessThanOrEqual(bound);
      errors.push(Math.abs(vMesh - exactMm3));
    }
    // First order in the deflection (measured 3.4× for 3.3× finer): at least 2× here.
    expect(errors[1]!).toBeLessThan(0.5 * errors[0]!);
    // GProp's default volume is coarse on B-spline solids (§15.2): a 1 % sanity check only.
    expect(Math.abs(kernel.getVolume(shape) / exactMm3 - 1)).toBeLessThan(0.01);
    kernel.releaseSince(m0);
  });

  it('every face has the oracle area: GProp per face, the triangulation in total', () => {
    const m0 = kernel.checkpoint();
    const shape = kernel.fromBREP(toOcctBrepText(b).text);
    const oracleFaces = [o.faces.bandArea, o.faces.bottomArea, o.faces.deckArea];
    const seen = new Set<number>();
    for (const face of kernel.getSubShapes(shape, 'face')) {
      const i = faceIndex(face);
      seen.add(i);
      // GProp's fixed rules (measured 2.8e-5 on the deck and bottom, 2.5e-4 on the band);
      // a wrong trim region would be off by orders more (the trimmed deck is a third of its
      // untrimmed surface).
      const rel = kernel.getSurfaceArea(face) / (100 * oracleFaces[i]!.value) - 1;
      expect(Math.abs(rel), `face ${i}`).toBeLessThan(1e-3);
    }
    expect(seen.size).toBe(3);
    // An inscribed triangle within the angular deflection θ of the surface normal has an area
    // within 1 − cos θ of the patch it spans; and the error shrinks with the deflection.
    const errors: number[] = [];
    for (const deflection of [0.1, 0.03]) {
      const mesh = kernel.tessellate(shape, {
        linearDeflection: deflection,
        angularDeflection: 0.05,
      });
      const [, aMesh] = meshVolumeArea(mesh.positions, mesh.indices);
      expect(Math.abs(aMesh / areaMm2 - 1)).toBeLessThanOrEqual(1 - Math.cos(0.05));
      errors.push(Math.abs(aMesh - areaMm2));
    }
    expect(errors[1]!).toBeLessThan(0.5 * errors[0]!);
    kernel.releaseSince(m0);
  });
});
