// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The geometric B-rep check (`check.ts`; design §13). Oracles:
 *
 * - **Valid solids** report no issue, a zero-to-rounding gap (the edges are the
 *   surfaces' own iso-curves and rational circles), the exact signed volume of
 *   the closed form and a holding Euler count.
 * - **Measured gaps equal independently known gaps.** An edge curve shifted by
 *   a known vector `d` (below `fit`, so the B-rep stays valid) must read gap
 *   `|d|` at that edge, and the vertex gap `|d|`: for a straight edge on a plane
 *   the deviation is `|d|` at every parameter, so the largest sample is exact.
 * - **Defect injection** (`testing/mutations.ts`): each geometric mutation
 *   must fail with the issue that names it.
 * - **Outward orientation** by the sign of the measured volume.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BREP_CHECK_SAMPLING,
  checkBrep,
  isGeomError,
  makeBrep,
  transformCurve,
  DEFAULT_TOLERANCES,
} from '../index';
import type { Affine3, Brep, BrepSpec } from '../index';
import { boxSolid, cylinderSolid, MUTATIONS, sphericalZoneSolid, torusSolid } from '../testing';
import { checksum } from '../testing';

const PI = Math.PI;
const zoneVolume = (r: number, phi: number): number => {
  const h = 2 * r * Math.sin(phi);
  return PI * (r * r * h - (h * h * h) / 12);
};

const SOLIDS: readonly (readonly [string, () => Brep, number, number])[] = [
  // name, builder, exact volume, relative tolerance of the volume.
  // Polynomial faces use exact Gauss rules: rounding only (1e-13). Rational faces
  // use adaptive Gauss–Kronrod to quadRel = 1e-10 per integral: 1e-9 is the stated bound.
  ['box', () => boxSolid(2, 3, 5), 30, 1e-13],
  ['trimmed box', () => boxSolid(2, 3, 5, { trimmed: true }), 30, 1e-13],
  ['cylinder', () => cylinderSolid(1.5, 4), PI * 1.5 * 1.5 * 4, 1e-9],
  ['zone', () => sphericalZoneSolid(2, 1), zoneVolume(2, 1), 1e-9],
  ['split zone', () => sphericalZoneSolid(2, 1, { split: true }), zoneVolume(2, 1), 1e-9],
  ['torus', () => torusSolid(3, 1), 2 * PI * PI * 3 * 1, 1e-9],
];

describe('checkBrep on valid solids', () => {
  for (const [name, build, volume, rel] of SOLIDS) {
    it(`${name}: no issue, tiny gaps, the exact volume, Euler holds`, () => {
      const b = build();
      const before = checksum(b);
      const r = checkBrep(b);
      expect(checksum(b), 'the input was written').toBe(before);
      expect(r.issues).toEqual([]);
      expect(r.ok).toBe(true);
      // The edges are exact iso-curves and circles of the same rational parameterisation:
      // the only gap is rounding of rational evaluation (a few ε × coordinates ≤ 5).
      expect(r.maxEdgeGap).toBeLessThan(1e-13);
      expect(r.maxVertexGap).toBeLessThan(1e-13);
      expect(r.edgeGaps.length).toBe(b.edges.length);
      expect(Math.abs(r.signedVolume / volume - 1)).toBeLessThan(rel);
      expect(r.euler.holds).toBe(true);
      expect(Object.isFrozen(r)).toBe(true);
    });
  }

  it('genus: the torus is 1, the others 0 (declared, and derived when not declared)', () => {
    const t = checkBrep(torusSolid(3, 1)).euler;
    expect(t.G).toBe(1);
    const c = cylinderSolid(1.5, 4);
    const undeclared = makeBrep({
      vertices: c.vertices,
      edges: c.edges,
      faces: c.faces,
      shells: c.shells,
      solids: [{ outer: 0 }],
    });
    expect(undeclared.ok).toBe(true);
    if (undeclared.ok) {
      const e = checkBrep(undeclared.value).euler;
      expect(e.G).toBe(0); // derived: (2S − (V − E + F − (L − F)))/2 = (2 − 2)/2
      expect(e.holds).toBe(true);
    }
  });
});

describe('measured gaps equal known gaps', () => {
  // Shift edge 0 by d (|d| = 5e-5 cm, below fit = 1e-4): the B-rep stays valid.
  const D = 5e-5;
  const shift = (b: Brep, d: readonly [number, number, number]): Brep => {
    const m: Affine3 = [1, 0, 0, d[0], 0, 1, 0, d[1], 0, 0, 1, d[2]];
    const made = makeBrep({
      vertices: b.vertices,
      edges: b.edges.map((e, i) => (i === 0 ? { ...e, curve: transformCurve(e.curve, m) } : e)),
      faces: b.faces,
      shells: b.shells,
      solids: b.solids,
    });
    if (!made.ok) throw new Error(JSON.stringify(made.issues));
    return made.value;
  };

  it('a box edge (a line on two planes) shifted along its own faces by D reads gap D', () => {
    // Edge 0 is the line from corner 0 to corner 2, along y at (x, z) = (0, 0), on the faces
    // z = 0 and x = 0. Shifting it along y keeps it in both planes, so it is exactly D from
    // S(p(t)) (the pcurve's image at the same parameter) for every t.
    const b = shift(boxSolid(2, 3, 5), [0, D, 0]);
    const r = checkBrep(b);
    // Sampling is exact for a degree-1 pair, so the largest sample is the gap itself.
    // Rounding of the subtraction at coordinates ≤ 5: 5 ε ≈ 1e-15 absolute.
    expect(Math.abs(r.edgeGaps[0]! - D)).toBeLessThan(1e-14);
    expect(Math.abs(r.maxVertexGap - D)).toBeLessThan(1e-14);
    expect(r.ok, 'D < fit: valid, with the gap reported').toBe(true);
    expect(r.edgeGaps[1]!).toBeLessThan(1e-14);
  });

  it('the same shift above fit is an error naming the edge', () => {
    const big = DEFAULT_TOLERANCES.fit * 10;
    const r = checkBrep(shift(boxSolid(2, 3, 5), [0, big, 0]));
    expect(r.ok).toBe(false);
    const hit = r.issues.find((i) => i.at?.edge === 0 && i.message.includes('deviates'));
    expect(hit, JSON.stringify(r.issues)).toBeDefined();
    expect(Math.abs(hit!.value! - big)).toBeLessThan(1e-14);
  });

  it('a tighter fit tolerance turns the same B-rep invalid (tolerances are parameters)', () => {
    const b = shift(boxSolid(2, 3, 5), [0, D, 0]);
    expect(checkBrep(b).ok).toBe(true);
    expect(checkBrep(b, { fit: D / 2 }).ok).toBe(false);
  });

  it('a shifted rational circle is measured to the shift (cylinder ring)', () => {
    const c = cylinderSolid(1.5, 4);
    // Shift the bottom ring (edge 0) along z by D: it leaves the bottom cap plane and the band.
    const b = shift(c, [0, 0, D]);
    const r = checkBrep(b);
    // The circle is on the band (iso-v) and on the plane z = 0; shifting along z is D from
    // the cap plane everywhere and D from the band's v = 0 iso-curve everywhere.
    expect(Math.abs(r.edgeGaps[0]! - D)).toBeLessThan(1e-13);
  });

  it('the sampling can be set; the default needs no setting; bad values throw', () => {
    const b = boxSolid(2, 3, 5);
    expect(DEFAULT_BREP_CHECK_SAMPLING.refineSteps).toBe(40);
    expect(checkBrep(b, undefined, { samplesPerSpan: 2, refineSteps: 0 }).ok).toBe(true);
    try {
      checkBrep(b, undefined, { samplesPerSpan: 0 });
      expect.unreachable('expected a GeomError');
    } catch (e) {
      expect(isGeomError(e, 'unsupported')).toBe(true);
    }
  });
});

describe('defect injection (geometric mutations)', () => {
  const geometric = MUTATIONS.filter((m) => m.caughtBy(boxSolid(1, 1, 1)) === 'checkBrep');
  const expected: Record<string, (r: ReturnType<typeof checkBrep>) => boolean> = {
    'flip a face sense': (r) =>
      r.issues.some((i) => i.code === 'trim-orientation' && i.at?.face === 0),
    'move a vertex': (r) => r.maxVertexGap > 5e-3 && r.issues.some((i) => i.at?.vertex === 0),
    'corrupt a weight': (r) => r.maxEdgeGap > 1e-3,
    'offset an edge curve': (r) => r.maxEdgeGap > 5e-3 && r.maxVertexGap > 5e-3,
    'reverse a pcurve': (r) => r.issues.length > 0,
    'declare a wrong genus': (r) => !r.euler.holds,
  };

  for (const [name, build] of SOLIDS) {
    for (const m of geometric) {
      it(`${m.name} on ${name} is reported`, () => {
        const b = build();
        const made = makeBrep(m.apply(b));
        expect(made.ok, JSON.stringify(made.issues)).toBe(true);
        if (!made.ok) return;
        const r = checkBrep(made.value);
        expect(r.ok).toBe(false);
        const check = expected[m.name];
        expect(check, `no expectation for ${m.name}`).toBeDefined();
        expect(
          check!(r),
          `${m.name} on ${name}: ${JSON.stringify(r.issues.map((i) => i.message))}`,
        ).toBe(true);
      });
    }
  }
});

describe('outward orientation by measurement', () => {
  it('an inside-out shell has negative signed volume and is reported', () => {
    const b = cylinderSolid(1.5, 4);
    const everyFace: BrepSpec = {
      vertices: b.vertices,
      edges: b.edges,
      shells: b.shells,
      solids: b.solids,
      faces: b.faces.map((f) => ({
        ...f,
        sameSense: !f.sameSense,
        outer: {
          coedges: f.outer.coedges
            .slice()
            .reverse()
            .map((c) => ({ ...c, sense: !c.sense })),
        },
      })),
    };
    const made = makeBrep(everyFace);
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const r = checkBrep(made.value);
    expect(r.ok).toBe(false);
    expect(Math.abs(r.signedVolume / (PI * 1.5 * 1.5 * 4) + 1)).toBeLessThan(1e-9);
    expect(r.issues.some((i) => i.message.includes('inside-out'))).toBe(true);
  });
});
