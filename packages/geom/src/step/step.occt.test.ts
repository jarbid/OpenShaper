// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The CI-only OCCT validator (docs/design/geom-core.md §15): our STEP files
 * through `occt-wasm` 5.3.5 (OpenCascade compiled to WebAssembly). Run by
 * `pnpm --filter @openshaper/geom test:occt` (`vitest.occt.config.ts`), a
 * required CI step on this branch, not part of `pnpm test`.
 *
 * `occt-wasm` is a devDependency of this package only and is imported by tests
 * only; ESLint forbids it in `src` and nothing outside geom imports geom yet.
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
 * B7 (two OCCT volumes of the same solid through different paths) needs the
 * native BREP writer of Path A, not built in this step (geom-core.md §15.4).
 * An inside/outside probe (`containsPoint`) stands in for orientation, and a
 * mutation suite pins what OCCT does with deliberately wrong files.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OcctKernel } from 'occt-wasm';
import type { ShapeHandle } from 'occt-wasm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkBrep,
  curvePoint,
  massProperties,
  surfacePoint,
  transformBrep,
  writeStep,
} from '../index';
import type { Affine3, Brep, StepWriteOptions } from '../index';
import {
  boxSolid,
  cylinderSolid,
  plateWithHoleSolid,
  readStepSubset,
  sphericalZoneSolid,
  torusSolid,
} from '../testing';

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

interface Solid {
  readonly name: string;
  readonly brep: () => Brep;
  /** Exact volume (cm³), total area (cm²) and the area of its curved faces (cm²). */
  readonly volume: number;
  readonly area: number;
  readonly curved: number;
  /** A point strictly inside the solid (cm). */
  readonly inside: readonly [number, number, number];
}

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

const CORPUS: readonly Solid[] = [
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

// --- helpers over OCCT results ----------------------------------------------

/** Largest vertex and edge tolerance in OCCT's BREP text (`Ve` / `Ed` entries: tolerance first). */
function maxShapeTolerance(brep: string): number {
  const lines = brep.split('\n');
  let max = 0;
  for (let i = 0; i + 1 < lines.length; i++) {
    if (lines[i] === 'Ve' || lines[i] === 'Ed') {
      const tol = Number(lines[i + 1]!.trim().split(/\s+/)[0]);
      expect(Number.isFinite(tol), `tolerance line after ${lines[i]}: ${lines[i + 1]}`).toBe(true);
      max = Math.max(max, tol);
    }
  }
  return max;
}

/** Signed volume of a triangle mesh (divergence theorem), relative to its first vertex. */
function meshVolume(positions: Float32Array, indices: Uint32Array): number {
  const ox = positions[0]!;
  const oy = positions[1]!;
  const oz = positions[2]!;
  let v = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 3;
    const b = indices[t + 1]! * 3;
    const c = indices[t + 2]! * 3;
    const ax = positions[a]! - ox,
      ay = positions[a + 1]! - oy,
      az = positions[a + 2]! - oz;
    const bx = positions[b]! - ox,
      by = positions[b + 1]! - oy,
      bz = positions[b + 2]! - oz;
    const cx = positions[c]! - ox,
      cy = positions[c + 1]! - oy,
      cz = positions[c + 2]! - oz;
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}

function solidOf(shape: ShapeHandle): ShapeHandle {
  const type = kernel.getShapeType(shape);
  if (type === 'solid') return shape;
  expect(type, 'a compound must hold exactly one solid').toBe('compound');
  expect(kernel.subShapeCount(shape, 'solid')).toBe(1);
  return kernel.getSubShapes(shape, 'solid')[0]!;
}

/** `n × n` parameters across `[a, b]`, ends included. */
const grid = (a: number, b: number, n: number): number[] =>
  Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));

// Deflection of the oracle mesh (mm): 0.01 mm, about a hundredth of a CNC pass.
const DEFLECTION_MM = 0.01;
const ANGULAR = 0.05;
/** Relative rounding of a Float32 coordinate (2⁻²³ bounds the error with margin). */
const FLOAT32_EPS = 2 ** -23;

for (const fileUnit of ['mm', 'cm'] as const) {
  describe(`OCCT imports our STEP files (file unit ${fileUnit})`, () => {
    for (const solid of CORPUS) {
      it(`${solid.name}: one valid solid, exact encoding, volume within its bound`, () => {
        const b = solid.brep();
        const report = checkBrep(b);
        expect(report.ok, JSON.stringify(report.issues)).toBe(true);
        const out = writeStep(b, { fileUnit, name: solid.name, timestamp: '2026-01-01T00:00:00' });
        writeFileSync(`${corpusDir}${solid.name}.${fileUnit}.step`, out.text);

        const m0 = kernel.checkpoint();
        const shape = kernel.importStep(out.text);
        const body = solidOf(shape);

        // B1, B2, B3.
        expect(kernel.getShapeType(body)).toBe('solid');
        expect(kernel.isValid(shape), 'BRepCheck_Analyzer').toBe(true);
        expect(kernel.subShapeCount(shape, 'solid')).toBe(1);
        expect(kernel.subShapeCount(shape, 'shell')).toBe(1);
        expect(kernel.subShapeCount(shape, 'face')).toBe(out.stats.faces);
        expect(kernel.subShapeCount(shape, 'edge')).toBe(out.stats.edges);
        expect(kernel.subShapeCount(shape, 'vertex')).toBe(out.stats.vertices);

        // B4: tolerance growth against the declared uncertainty (in mm).
        const declaredMm = out.stats.uncertainty * (fileUnit === 'mm' ? 1 : 10);
        const grown = maxShapeTolerance(kernel.toBREP(shape));
        expect(grown, `tolerance grown to ${grown} mm; declared ${declaredMm}`).toBeLessThanOrEqual(
          2 * declaredMm,
        );

        // B5: edge curves, in our parameterisation, in mm. Every one of our edges
        // is found among OCCT's, with the same parameter range and points.
        const occtEdges = kernel.getSubShapes(shape, 'edge');
        const edgeTol = 1e-6; // mm: ~10³ above the float64 rounding of coordinates ≤ 100 mm
        b.edges.forEach((e, ei) => {
          const [a, z] = e.curve.basis.domain;
          const found = occtEdges.some((oe) => {
            const { first, last } = kernel.curveParameters(oe);
            if (Math.abs(first - a) > 1e-9 || Math.abs(last - z) > 1e-9) return false;
            return grid(a, z, 9).every((t) => {
              const p = curvePoint(e.curve, t);
              const q = kernel.curvePointAtParam(oe, t);
              return Math.hypot(q.x - 10 * p.x, q.y - 10 * p.y, q.z - 10 * p.z) <= edgeTol;
            });
          });
          expect(found, `no OCCT edge equals our edge ${ei} parameter by parameter`).toBe(true);
        });

        // B6: surfaces, in mm: some OCCT face equals each of ours at sampled (u, v)
        // over the uv bounds OCCT reports for it.
        const occtFaces = kernel.getSubShapes(shape, 'face');
        const surfTol = 1e-6; // mm
        for (const of of occtFaces) {
          const bounds = kernel.uvBounds(of);
          const matched = b.faces.some((f) => {
            const uExt =
              f.surface.u.kind === 'periodic'
                ? [f.surface.u.domain[0], f.surface.u.domain[0] + f.surface.u.period]
                : f.surface.u.domain;
            const vExt =
              f.surface.v.kind === 'periodic'
                ? [f.surface.v.domain[0], f.surface.v.domain[0] + f.surface.v.period]
                : f.surface.v.domain;
            if (bounds.uMin < uExt[0]! - 1e-9 || bounds.uMax > uExt[1]! + 1e-9) return false;
            if (bounds.vMin < vExt[0]! - 1e-9 || bounds.vMax > vExt[1]! + 1e-9) return false;
            return grid(bounds.uMin, bounds.uMax, 5).every((u) =>
              grid(bounds.vMin, bounds.vMax, 5).every((v) => {
                const p = surfacePoint(f.surface, u, v);
                const q = kernel.pointOnSurface(of, u, v);
                return Math.hypot(q.x - 10 * p.x, q.y - 10 * p.y, q.z - 10 * p.z) <= surfTol;
              }),
            );
          });
          expect(matched, 'an OCCT face matches none of our surfaces parameter by parameter').toBe(
            true,
          );
        }

        // B8: volume. 1 % sanity for GProp; the oracle is the mesh volume.
        const exactMm3 = solid.volume * 1000;
        const ours = massProperties(b);
        expect(ours.volume.value * 1000).toBeCloseTo(exactMm3, 6); // exact rules: ~1e-12 relative
        expect(Math.abs(kernel.getVolume(shape) / exactMm3 - 1)).toBeLessThan(0.01);
        const mesh = kernel.tessellate(shape, {
          linearDeflection: DEFLECTION_MM,
          angularDeflection: ANGULAR,
        });
        const vMesh = meshVolume(mesh.positions, mesh.indices);
        // |ΔV| ≤ (curved area) × deflection: every point of the mesh is within the
        // deflection of the surface, and planar faces are meshed exactly. Plus the
        // Float32 rounding of the returned positions: 2⁻²³ per coordinate on
        // coordinates up to the solid's extent, over its whole area.
        const extentMm = 10 * (5 + Math.hypot(5, 3, 2)); // beyond every corpus coordinate
        const bound =
          solid.curved * 100 * DEFLECTION_MM + solid.area * 100 * extentMm * FLOAT32_EPS;
        expect(vMesh, 'a negative mesh volume means an inside-out import').toBeGreaterThan(0);
        expect(
          Math.abs(vMesh - exactMm3),
          `mesh ${vMesh} vs exact ${exactMm3}`,
        ).toBeLessThanOrEqual(bound);
        expect(bound / exactMm3, 'the bound must be tight enough to mean something').toBeLessThan(
          5e-3,
        );

        // Orientation, as OCCT sees the solid.
        const [ix, iy, iz] = solid.inside;
        expect(kernel.containsPoint(body, { x: 10 * ix, y: 10 * iy, z: 10 * iz })).toBe(true);
        expect(kernel.containsPoint(body, { x: 1e4, y: 1e4, z: 1e4 })).toBe(false);
        kernel.releaseSince(m0);
      });
    }
  });
}

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
      it(`${solid.name}, ${label}: one valid solid, volume within the bound`, () => {
        const out = writeStep(solid.brep(), opts);
        writeFileSync(`${corpusDir}${solid.name}.${label.replace(/\W+/g, '-')}.step`, out.text);
        const m0 = kernel.checkpoint();
        const shape = kernel.importStep(out.text);
        expect(kernel.isValid(shape)).toBe(true);
        expect(kernel.subShapeCount(shape, 'solid')).toBe(1);
        expect(kernel.subShapeCount(shape, 'face')).toBe(out.stats.faces);
        const exactMm3 = solid.volume * 1000;
        const mesh = kernel.tessellate(shape, {
          linearDeflection: DEFLECTION_MM,
          angularDeflection: ANGULAR,
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
  /** True if our own pipeline rejects the file: the reader throws or `checkBrep` reports a problem. */
  function weReject(text: string): boolean {
    try {
      return !checkBrep(readStepSubset(text)).ok;
    } catch {
      return true;
    }
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
    expect(weReject(good.text)).toBe(false);
    expect(weReject(bad)).toBe(true);
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
    expect(weReject(bad)).toBe(true);
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
    lines.splice(
      vi,
      0,
      `#${fresh}=CARTESIAN_POINT('',(${x! + 0.5}.,${y!},${z!}));`.replace('..', '.'),
    );
    const bad = lines.join('\n');
    const r = oracle(bad);
    expect(r.tol).toBeGreaterThan(2 * good.stats.uncertainty * 1);
    expect(oracle(good.text).tol).toBeLessThanOrEqual(2 * good.stats.uncertainty);
    kernel.releaseSince(m0);
    expect(weReject(bad)).toBe(true);
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
    expect(weReject(bad)).toBe(true);
  });
});
