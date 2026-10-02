// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Characterization snapshot of the loft/tessellation pipeline.
 *
 * Unlike the golden tests (which pin the port to BoardCAD-LE within a tolerance),
 * this locks in what the kernel produces TODAY, so a refactor that is meant to be
 * behaviour-neutral can prove it is. Every number is rounded to 8 significant
 * digits: tight enough to catch any real change to the geometry, loose enough to
 * survive last-ulp differences in `Math.*` between Node versions.
 *
 * If a snapshot here changes, the change altered geometry output. That is a
 * behaviour change, not a refactor: revert it or record it as a deliberate
 * divergence (see docs/specs/divergences.md) and regenerate with `vitest -u`.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  getArea,
  getCenterOfMass,
  getInterpolatedCrossSection,
  getLength,
  getMaxThickness,
  getMaxWidth,
  getVolume,
  type BezierBoard,
} from './board';
import { splineFromKnots } from './bezier-spline';
import { crossSection } from './cross-section';
import { knot } from './knot';
import { loftRing } from './loft';
import { tessellateBoard, tessellationSteps } from './tessellate';
import { vec2 } from './vec2';
import { parseBrdGeometry } from './test-support/brd-geometry';
import { boxBoard, curvyBoard } from './test-support/synthetic-boards';

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = resolve(here, '../../../docs/specs/golden');
const loadGolden = (name: string): BezierBoard =>
  parseBrdGeometry(readFileSync(resolve(goldenDir, `${name}.brd`), 'utf8'));

const sig = (v: number): number => (Number.isFinite(v) ? Number(v.toPrecision(8)) : v);

/** Mesh fingerprint: counts, bounds and first moments of positions and normals. */
const meshDigest = (b: BezierBoard, targetFaceSize: number) => {
  const m = tessellateBoard(b, { targetFaceSize });
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const sum = [0, 0, 0];
  const nsum = [0, 0, 0];
  for (let i = 0; i < m.positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = m.positions[i + a]!;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
      sum[a]! += v;
      nsum[a]! += m.normals[i + a]!;
    }
  }
  // Index checksum catches a change of topology that keeps the counts.
  let isum = 0;
  for (let i = 0; i < m.indices.length; i++) isum += m.indices[i]! * ((i % 7) + 1);
  return {
    steps: tessellationSteps(b, targetFaceSize),
    vertices: m.positions.length / 3,
    triangles: m.indices.length / 3,
    min: min.map(sig),
    max: max.map(sig),
    positionSum: sum.map(sig),
    normalSum: nsum.map(sig),
    indexChecksum: isum,
  };
};

/** Scalar specs plus sampled sections and lofted rings at fixed stations. */
const shapeDigest = (b: BezierBoard) => {
  const length = getLength(b);
  const stations = [0.02, 0.25, 0.5, 0.75, 0.98].map((f) => {
    const x = f * length;
    const cs = getInterpolatedCrossSection(b, x);
    const ring = loftRing(b, x, 16);
    return {
      f,
      section: cs?.spline.knots.map((k) => [sig(k.end.x), sig(k.end.y)]) ?? null,
      ring: ring?.map((p) => [sig(p.y), sig(p.z)]) ?? null,
    };
  });
  return {
    length: sig(length),
    maxWidth: sig(getMaxWidth(b)),
    maxThickness: sig(getMaxThickness(b)),
    volume: sig(getVolume(b)),
    area: sig(getArea(b)),
    centerOfMass: sig(getCenterOfMass(b)),
    stations,
  };
};

/** Box board whose rocker climbs 60 cm over 100 — far past any real board. */
const extremeRocker = (): BezierBoard => boxBoard({ rockerSlope: 0.6 });

/** The curvy board with 3 mm-thick, knife-edge rail sections (under MIN_DIM). */
const thinRails = (): BezierBoard => {
  const b = curvyBoard();
  const thin = splineFromKnots([
    knot(vec2(0, 0), vec2(0, 0), vec2(12, 0)),
    knot(vec2(25, 0.15), vec2(25, 0.05), vec2(25, 0.25)),
    knot(vec2(0, 0.3), vec2(12, 0.3), vec2(0, 0.3)),
  ]);
  return {
    ...b,
    crossSections: b.crossSections.map((cs) => crossSection(cs.position, thin)),
  };
};

const CASES: [string, () => BezierBoard][] = [
  ['shortboard', () => loadGolden('shortboard')],
  ['funboard', () => loadGolden('funboard')],
  ['longboard', () => loadGolden('longboard')],
  ['shortboard (sLinear)', () => ({ ...loadGolden('shortboard'), interpolationType: 'sLinear' })],
  ['minimal control points (box)', () => boxBoard()],
  ['extreme rocker', extremeRocker],
  ['thin rails', thinRails],
  ['curvy', curvyBoard],
];

describe('characterization: lofting + tessellation', () => {
  for (const [name, make] of CASES) {
    it(`${name}: specs, sections and lofted rings`, () => {
      expect(shapeDigest(make())).toMatchSnapshot();
    });

    // Draft and fine bracket the range the 3D view actually requests.
    for (const face of [1.5, 0.5]) {
      it(`${name}: mesh at ${face} cm faces`, () => {
        expect(meshDigest(make(), face)).toMatchSnapshot();
      });
    }
  }

  it('default step counts (no target face size)', () => {
    const m = tessellateBoard(loadGolden('shortboard'));
    expect([m.positions.length / 3, m.indices.length / 3]).toMatchSnapshot();
  });
});
