// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Periodic → clamped conversion of surfaces (`clamp.ts`; design §4.4). The
 * oracles:
 *
 * - **Analytic.** The cylinder's clamped form is the cylinder: distance from
 *   the axis `r`, angle `2πu`, height `h·v`, at every sampled point. The
 *   sphere and torus likewise.
 * - **Shape invariance.** On random periodic surfaces (degrees 2 to 4,
 *   multiplicities up to the degree, random weights, periodic in u, in v and
 *   in both), the clamped surface equals the periodic one at random
 *   parameters including both ends of every period. Knot insertion is exact;
 *   the arithmetic is a few affine combinations per point, so the tolerance is
 *   `1e-12 × extent` (design: `64 ε` per primitive evaluation, times the
 *   handful of insertions and the rational quotient; the failure it must
 *   catch, a wrong knot or index, moves points by ≥ 1e-3 of the extent).
 * - **Structure.** Both bases clamped, domain `[t_0, t_0 + T]`, the two end
 *   rows of a closed direction coincide, an unchanged direction keeps its
 *   basis object, a clamped input comes back as itself, inputs are untouched.
 */
import { describe, expect, it } from 'vitest';
import { cylinder, sphere, surfacePoint, torus } from '../index';
import type { NurbsSurface } from '../index';
import { checksum, mulberry32, randomSurface } from '../testing';
import { clampSurface } from './clamp';

/** Parameters across a period, ends included. */
const grid = (a: number, b: number, n: number): number[] =>
  Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));

/** Largest distance between two surfaces over a parameter grid (the second evaluated at the same (u, v)). */
function maxDeviation(a: NurbsSurface, b: NurbsSurface, us: number[], vs: number[]): number {
  let max = 0;
  for (const u of us) {
    for (const v of vs) {
      const p = surfacePoint(a, u, v);
      const q = surfacePoint(b, u, v);
      max = Math.max(max, Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z));
    }
  }
  return max;
}

describe('clampSurface on exact primitives', () => {
  it('the clamped cylinder is the cylinder (periodic u becomes clamped on [0, 1])', () => {
    const r = 1.5;
    const h = 4;
    const c = clampSurface(cylinder({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, r, h));
    expect(c.u.kind).toBe('clamped');
    expect(c.v.kind).toBe('clamped');
    expect(c.u.domain).toEqual([0, 1]);
    let worst = 0;
    for (const u of grid(0, 1, 49)) {
      for (const v of grid(0, 1, 9)) {
        const p = surfacePoint(c, u, v);
        worst = Math.max(worst, Math.abs(Math.hypot(p.x, p.y) - r), Math.abs(p.z - h * v));
      }
    }
    // A rational quadratic arc is not angle-uniform, so only the radius and the height
    // are exact everywhere; the knots (quarters) sit at the exact angles k·π/2.
    // Rational quotient of ≤ 9 terms of size ≤ 4: ~20 ε |S| ≈ 2e-14; 1e-13 leaves margin,
    // and a wrong weight (e.g. 0.7 for √½) errs by ~1e-2.
    expect(worst).toBeLessThan(1e-13);
    for (let k = 0; k <= 4; k++) {
      const p = surfacePoint(c, k / 4, 0.5);
      expect(Math.abs(p.x - r * Math.cos((k * Math.PI) / 2))).toBeLessThan(1e-13);
      expect(Math.abs(p.y - r * Math.sin((k * Math.PI) / 2))).toBeLessThan(1e-13);
    }
  });

  it('the clamped cylinder closes: the two end rows of control points coincide', () => {
    const c = clampSurface(cylinder({ x: 1, y: 2, z: 3 }, { x: 0, y: 0, z: 1 }, 2, 5));
    const nv = c.v.count;
    for (let j = 0; j < nv; j++) {
      for (let k = 0; k < 4; k++) {
        expect(c.cw[(c.u.count - 1) * nv * 4 + j * 4 + k]).toBeCloseTo(c.cw[j * 4 + k]!, 14);
      }
    }
  });

  it('keeps the clamped direction of a sphere (same basis object) and clamps the periodic one', () => {
    const s = sphere({ x: 0, y: 0, z: 0 }, 2);
    const c = clampSurface(s);
    expect(c.v).toBe(s.v);
    expect(c.u.kind).toBe('clamped');
    let worst = 0;
    for (const u of grid(0, 1, 33)) {
      for (const v of grid(0, 1, 33)) {
        const p = surfacePoint(c, u, v);
        worst = Math.max(worst, Math.abs(Math.hypot(p.x, p.y, p.z) - 2));
      }
    }
    expect(worst).toBeLessThan(1e-13); // 64 ε · scale, as the primitive's own test
  });

  it('clamps both directions of a torus: points stay at distance r from the tube circle', () => {
    const R = 3;
    const r = 1;
    const c = clampSurface(torus({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, R, r));
    expect(c.u.kind).toBe('clamped');
    expect(c.v.kind).toBe('clamped');
    let worst = 0;
    for (const u of grid(0, 1, 25)) {
      for (const v of grid(0, 1, 25)) {
        const p = surfacePoint(c, u, v);
        const rho = Math.hypot(p.x, p.y);
        worst = Math.max(worst, Math.abs(Math.hypot(rho - R, p.z) - r));
      }
    }
    expect(worst).toBeLessThan(1e-13);
  });

  it('returns a clamped surface unchanged (the same object)', () => {
    const c = clampSurface(cylinder({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 1, 1));
    expect(clampSurface(c)).toBe(c);
  });
});

describe('clampSurface on random periodic surfaces (shape invariance)', () => {
  const kinds = [
    ['u', 'periodic', 'clamped'],
    ['v', 'clamped', 'periodic'],
    ['uv', 'periodic', 'periodic'],
  ] as const;
  for (const [name, kindU, kindV] of kinds) {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      it(`periodic in ${name}, seed ${seed}`, () => {
        const rng = mulberry32(seed * 7919);
        const pu = 2 + (seed % 3);
        const pv = 2 + ((seed + 1) % 3);
        const s = randomSurface(rng, {
          degreeU: pu,
          degreeV: pv,
          countU: pu + 3 + (seed % 3),
          countV: pv + 3 + (seed % 2),
          kindU,
          kindV,
          basis: { maxMult: 1 + (seed % pu), domain: [0.25, 1.75] },
          weightRange: seed % 2 === 0 ? [0.5, 2] : undefined,
          extent: 3,
        });
        const before = checksum(s);
        const c = clampSurface(s);
        expect(checksum(s), 'the input was written').toBe(before);
        expect(c.u.kind).toBe('clamped');
        expect(c.v.kind).toBe('clamped');
        const ext = (b: NurbsSurface['u']): [number, number] =>
          b.kind === 'periodic'
            ? [b.domain[0], b.domain[0] + b.period]
            : [b.domain[0], b.domain[1]];
        expect([c.u.domain[0], c.u.domain[1]]).toEqual(ext(s.u));
        expect([c.v.domain[0], c.v.domain[1]]).toEqual(ext(s.v));
        if (s.u.kind === 'clamped') expect(c.u).toBe(s.u);
        if (s.v.kind === 'clamped') expect(c.v).toBe(s.v);
        // Both ends of each period are included in the grids.
        const [u0, u1] = ext(s.u);
        const [v0, v1] = ext(s.v);
        const dev = maxDeviation(s, c, grid(u0, u1, 37), grid(v0, v1, 37));
        expect(dev, `periodic and clamped differ by ${dev}`).toBeLessThan(1e-12 * 3);
      });
    }
  }

  it('the comparison can fail: a perturbed control point is seen', () => {
    const rng = mulberry32(99);
    const s = randomSurface(rng, {
      degreeU: 3,
      degreeV: 3,
      countU: 7,
      countV: 6,
      kindU: 'periodic',
      extent: 3,
    });
    const c = clampSurface(s);
    const cw = Float64Array.from(c.cw);
    cw[4 * 10] = cw[4 * 10]! + 1e-3;
    const broken = { ...c, cw } as unknown as NurbsSurface;
    expect(maxDeviation(s, broken, grid(0, 1, 37), grid(0, 1, 37))).toBeGreaterThan(1e-5);
  });
});
